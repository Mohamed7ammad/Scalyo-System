const express      = require('express');
const bcrypt       = require('bcryptjs');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const { checkAndSendStaffAlerts } = require('../services/alerts');
const { EARNED_COMMISSION_SQL } = require('../utils/commission');

const router = express.Router();

/* Roles the system recognises. 'media_buyer' (ميديا باير) owns Meta ad accounts
   and sees a data-scoped analytics dashboard. */
const VALID_ROLES = ['agent', 'admin', 'media_buyer'];

/* ── Idempotent column migrations ───────────────────────────────────────────
   Each ALTER is fire-and-forget; a failure just logs a warning.              */
const migrations = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS name            VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active       BOOLEAN       DEFAULT true`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_absent       BOOLEAN       DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions     TEXT[]        DEFAULT '{orders}'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(10,2) DEFAULT 0`,
  /* ── Granular commission matrix ── */
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS comm_confirmed  NUMERIC(10,2) DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS comm_delivered  NUMERIC(10,2) DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS comm_rejected   NUMERIC(10,2) DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS comm_no_answer  NUMERIC(10,2) DEFAULT 0`,
  /* ── Email verification (OTP) ── */
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN       DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code        VARCHAR(6)`,
  /* ── Persisted auto-distribution weight (%) — drives weighted round-robin
        assignment of incoming EasyOrder webhook orders. 0 = excluded. ── */
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS distribution_percentage NUMERIC(5,2) NOT NULL DEFAULT 0`,
  /* ── Presence heartbeat — last time the user pinged while logged in. Powers
        the Online/Offline badge in the staff table. ── */
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ`,
  /* ── Employee payout ledger ──────────────────────────────────────────────
        Records cash settlements paid against an employee's EARNED commission.
        Deliberately a STANDALONE table (not treasury_transactions): commissions
        are already booked as accrued expenses in the treasury, so a payout is a
        liability settlement — logging it as another treasury expense would
        double-count it in Net Profit and the company balance. Partial payments
        are simply multiple rows; outstanding = lifetime earned − Σ payouts. */
  `CREATE TABLE IF NOT EXISTS employee_payouts (
     id          SERIAL        PRIMARY KEY,
     user_id     VARCHAR       NOT NULL,
     business_id INTEGER       NOT NULL,
     amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
     note        TEXT,
     paid_by     VARCHAR,
     paid_at     DATE          NOT NULL DEFAULT CURRENT_DATE,
     created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS employee_payouts_user_idx
     ON employee_payouts (user_id, business_id)`,
];

migrations.forEach((sql) =>
  pool.query(sql)
    .then(() => console.log(`✅  staff migration: ${sql.slice(0, 60)}…`))
    .catch((err) => console.warn(`⚠️   staff migration skipped: ${err.message}`))
);

/* ── Shared RETURNING fragment ───────────────────────────────────────────── */
const RETURNING = `
  RETURNING id,
    COALESCE(name, '')                          AS name,
    email, role,
    COALESCE(is_active, true)                   AS is_active,
    COALESCE(is_absent, false)                  AS is_absent,
    COALESCE(permissions, '{orders}'::TEXT[])   AS permissions,
    COALESCE(commission_rate, 0)                AS commission_rate,
    COALESCE(comm_confirmed, 0)                 AS comm_confirmed,
    COALESCE(comm_delivered, 0)                 AS comm_delivered,
    COALESCE(comm_rejected,  0)                 AS comm_rejected,
    COALESCE(comm_no_answer, 0)                 AS comm_no_answer,
    created_at
`;

/* ── GET /api/staff ────────────────────────────────────────────────────── */
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        COALESCE(name, '')                          AS name,
        email, role,
        COALESCE(is_active, true)                   AS is_active,
        COALESCE(is_absent, false)                  AS is_absent,
        COALESCE(permissions, '{orders}'::TEXT[])   AS permissions,
        COALESCE(commission_rate, 0)                AS commission_rate,
        COALESCE(comm_confirmed, 0)                 AS comm_confirmed,
        COALESCE(comm_delivered, 0)                 AS comm_delivered,
        COALESCE(comm_rejected,  0)                 AS comm_rejected,
        COALESCE(comm_no_answer, 0)                 AS comm_no_answer,
        COALESCE(distribution_percentage, 0)        AS distribution_percentage,
        last_active_at,
        created_at
      FROM users
      WHERE business_id = $1
      ORDER BY created_at ASC
    `, [req.user.business_id]);
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /staff]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/staff ──────────────────────────────────────────────────── */
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const {
    name             = '',
    email,
    password,
    role             = 'agent',
    permissions,
    commission_rate  = 0,
    comm_confirmed   = 0,
    comm_delivered   = 0,
    comm_rejected    = 0,
    comm_no_answer   = 0,
  } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
  if (!VALID_ROLES.includes(role))
    return res.status(400).json({ error: 'الدور يجب أن يكون agent أو admin أو media_buyer' });
  if (password.length < 6)
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });

  const perms = Array.isArray(permissions) && permissions.length > 0
    ? permissions : ['orders'];

  const cleanEmail = email.trim().toLowerCase();

  try {
    const password_hash = await bcrypt.hash(password, 10);
    /* Admin-created staff are vouched-for by an authenticated admin, so they are
       PRE-VERIFIED (email_verified=true, no otp_code) and can log in immediately —
       the login OTP gate never fires for them. Only self-service signups via
       /api/auth/register go through email-OTP verification. */
    const result = await pool.query(
      `INSERT INTO users
         (name, email, password_hash, role, is_active, is_absent,
          permissions, commission_rate, comm_confirmed, comm_delivered, comm_rejected, comm_no_answer,
          email_verified, otp_code, business_id)
       VALUES ($1,$2,$3,$4,true,false,$5,$6,$7,$8,$9,$10,true,NULL,$11)
       ${RETURNING}`,
      [
        name.trim() || null,
        cleanEmail,
        password_hash,
        role,
        perms,
        parseFloat(commission_rate) || 0,
        parseFloat(comm_confirmed)  || 0,
        parseFloat(comm_delivered)  || 0,
        parseFloat(comm_rejected)   || 0,
        parseFloat(comm_no_answer)  || 0,
        req.user.business_id,        // $11
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[POST /staff]', err);
    if (err.code === '23505')
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل' });
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── PATCH /api/staff/:id ─────────────────────────────────────────────── */
router.patch('/:id', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    name, email, password, role, is_active,
    permissions, commission_rate,
    comm_confirmed, comm_delivered, comm_rejected, comm_no_answer,
  } = req.body;

  const sets = [];
  const vals = [];
  let   idx  = 1;

  if (name       !== undefined) { sets.push(`name      = $${idx++}`); vals.push(name.trim() || null); }
  if (email      !== undefined) { sets.push(`email     = $${idx++}`); vals.push(email.trim().toLowerCase()); }
  if (role       !== undefined) {
    if (!VALID_ROLES.includes(role))
      return res.status(400).json({ error: 'الدور يجب أن يكون agent أو admin أو media_buyer' });
    sets.push(`role = $${idx++}`); vals.push(role);
  }
  if (is_active      !== undefined) { sets.push(`is_active      = $${idx++}`); vals.push(Boolean(is_active)); }
  if (permissions    !== undefined && Array.isArray(permissions)) {
    sets.push(`permissions = $${idx++}`);
    vals.push(permissions.length > 0 ? permissions : ['orders']);
  }
  if (commission_rate !== undefined) { sets.push(`commission_rate = $${idx++}`); vals.push(parseFloat(commission_rate) || 0); }
  if (comm_confirmed  !== undefined) { sets.push(`comm_confirmed  = $${idx++}`); vals.push(parseFloat(comm_confirmed)  || 0); }
  if (comm_delivered  !== undefined) { sets.push(`comm_delivered  = $${idx++}`); vals.push(parseFloat(comm_delivered)  || 0); }
  if (comm_rejected   !== undefined) { sets.push(`comm_rejected   = $${idx++}`); vals.push(parseFloat(comm_rejected)   || 0); }
  if (comm_no_answer  !== undefined) { sets.push(`comm_no_answer  = $${idx++}`); vals.push(parseFloat(comm_no_answer)  || 0); }

  if (password !== undefined) {
    if (password.length < 6)
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    const hash = await bcrypt.hash(password, 10);
    sets.push(`password_hash = $${idx++}`); vals.push(hash);
  }

  if (!sets.length)
    return res.status(400).json({ error: 'لا توجد حقول صالحة للتحديث' });

  vals.push(id);
  const idPos = idx;
  vals.push(req.user.business_id);
  try {
    const result = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idPos} AND business_id = $${idPos + 1} ${RETURNING}`,
      vals
    );
    if (!result.rows.length)
      return res.status(404).json({ error: 'الموظف غير موجود' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[PATCH /staff/:id]', err);
    if (err.code === '23505')
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل' });
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/staff/trigger-alerts ──────────────────────────────────────────
   Admin-only manual trigger for the delayed-orders alert flow — lets an admin
   test instantly without waiting for the 12-hour cron.                         */
router.post('/trigger-alerts', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await checkAndSendStaffAlerts();
    if (result.error) {
      return res.status(500).json({ success: false, error: result.error });
    }
    res.json({ success: true, alerted_staff_count: result.alerted_staff_count });
  } catch (err) {
    console.error('[POST /staff/trigger-alerts]', err);
    res.status(500).json({ success: false, error: 'خطأ في الخادم' });
  }
});

/* ── DELETE /api/staff/:id ───────────────────────────────────────────────────
   Hard-deletes a staff member. Safe because:
     • orders."AssignedTo" is a loose email string (no FK) — we NULL it first so
       no orphaned assignment lingers.
     • meta_accounts.assigned_user_id is ON DELETE SET NULL (handled by the DB).
   Guards against lockout:
     • cannot delete your own account.
     • cannot delete the tenant's founding admin (earliest-created admin = owner).
   Strictly tenant-scoped (business_id) throughout.                            */
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  const { id }     = req.params;
  const businessId = req.user.business_id;

  try {
    /* 1. Resolve the target within the caller's tenant. */
    const { rows } = await pool.query(
      `SELECT id, email, role FROM users WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'الموظف غير موجود' });
    const target = rows[0];

    /* 2. Never let an admin delete themselves (prevents self-lockout). */
    if (String(target.id) === String(req.user.id)) {
      return res.status(403).json({ error: 'لا يمكنك حذف حسابك الخاص' });
    }

    /* 3. Protect the tenant's founding admin (the system owner). */
    const { rows: ownerRows } = await pool.query(
      `SELECT id FROM users
        WHERE business_id = $1 AND role = 'admin'
        ORDER BY created_at ASC NULLS FIRST, id ASC
        LIMIT 1`,
      [businessId]
    );
    const ownerId = ownerRows[0]?.id;
    if (ownerId != null && String(ownerId) === String(target.id)) {
      return res.status(403).json({ error: 'لا يمكن حذف حساب المدير الرئيسي للنظام' });
    }

    /* 4. Unassign their orders (AssignedTo holds the email). */
    await pool.query(
      `UPDATE orders SET "AssignedTo" = NULL WHERE "AssignedTo" = $1 AND business_id = $2`,
      [target.email, businessId]
    );

    /* 5. Hard delete. */
    await pool.query(`DELETE FROM users WHERE id = $1 AND business_id = $2`, [id, businessId]);

    console.log(`[Staff Delete] 🗑️  ${target.email} (${id}) removed from tenant ${businessId}`);
    res.json({ message: 'تم حذف الموظف بنجاح', id });
  } catch (err) {
    console.error('[DELETE /staff/:id]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/staff/:id/toggle-attendance ──────────────────────────────── */
router.post('/:id/toggle-attendance', authenticate, requireAdmin, async (req, res) => {
  const agentId  = Number(req.params.id);
  const isAbsent = Boolean(req.body.isAbsent);
  const businessId = req.user.business_id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const agentResult = await client.query(
      `SELECT id, COALESCE(name,'') AS name, email, role,
              COALESCE(is_active,true)                  AS is_active,
              COALESCE(is_absent,false)                 AS is_absent,
              COALESCE(permissions,'{orders}'::TEXT[])  AS permissions,
              COALESCE(commission_rate,0)               AS commission_rate,
              COALESCE(comm_confirmed,0)                AS comm_confirmed,
              COALESCE(comm_delivered,0)                AS comm_delivered,
              COALESCE(comm_rejected,0)                 AS comm_rejected,
              COALESCE(comm_no_answer,0)                AS comm_no_answer,
              created_at
       FROM users WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [agentId, businessId]
    );
    if (!agentResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الموظف غير موجود' });
    }

    const agent = agentResult.rows[0];

    const updatedResult = await client.query(
      `UPDATE users SET is_absent = $1 WHERE id = $2 AND business_id = $3
       RETURNING id, COALESCE(name,'') AS name, email, role,
                 COALESCE(is_active,true)                  AS is_active,
                 COALESCE(is_absent,false)                 AS is_absent,
                 COALESCE(permissions,'{orders}'::TEXT[])  AS permissions,
                 COALESCE(commission_rate,0)               AS commission_rate,
                 COALESCE(comm_confirmed,0)                AS comm_confirmed,
                 COALESCE(comm_delivered,0)                AS comm_delivered,
                 COALESCE(comm_rejected,0)                 AS comm_rejected,
                 COALESCE(comm_no_answer,0)                AS comm_no_answer,
                 created_at`,
      [isAbsent, agentId, businessId]
    );
    const updatedUser = updatedResult.rows[0];

    if (!isAbsent) {
      await client.query('COMMIT');
      return res.json({ user: updatedUser, redistributed: 0, presentAgentsCount: 0 });
    }

    const ordersResult = await client.query(
      `SELECT id FROM orders WHERE "AssignedTo" = $1 AND "Status" = 'جديد' AND business_id = $2`,
      [agent.email, businessId]
    );
    const orderIds = ordersResult.rows.map((r) => r.id);

    const presentResult = await client.query(
      `SELECT id, email FROM users
       WHERE role = 'agent'
         AND COALESCE(is_active, true)  = true
         AND COALESCE(is_absent, false) = false
         AND id != $1
         AND business_id = $2`,
      [agentId, businessId]
    );
    const presentAgents = presentResult.rows;
    let redistributed = 0;

    if (orderIds.length > 0 && presentAgents.length > 0) {
      for (let i = 0; i < orderIds.length; i++) {
        const target = presentAgents[i % presentAgents.length];
        await client.query(
          `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW() WHERE id = $2 AND business_id = $3`,
          [target.email, orderIds[i], businessId]
        );
        redistributed++;
      }
    }

    await client.query('COMMIT');
    console.log(`[Attendance] ✅ "${agent.email}" absent — redistributed ${redistributed} orders`);
    res.json({ user: updatedUser, redistributed, presentAgentsCount: presentAgents.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[toggle-attendance] Transaction error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

/* ── POST /api/staff/distribution ─────────────────────────────────────────────
   Persist per-agent auto-distribution weights (%). These drive the weighted
   round-robin assignment of incoming EasyOrder webhook orders.

   Body: { allocations: [{ agentId, percentage }, …] }
   • Each percentage is clamped to 0–100. Agents omitted from the payload are
     reset to 0 (excluded from auto-distribution) so the saved set is exactly
     what the admin configured.
   • Tenant-scoped: only the caller's own agents are updated. Admin only.        */
router.post('/distribution', authenticate, requireAdmin, async (req, res) => {
  const businessId  = req.user.business_id;
  const allocations = Array.isArray(req.body.allocations) ? req.body.allocations : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reset everyone to 0 first, then set the supplied weights — so de-selected
    // agents drop out cleanly.
    await client.query(
      `UPDATE users SET distribution_percentage = 0
        WHERE role = 'agent' AND business_id = $1`,
      [businessId]
    );

    for (const a of allocations) {
      const id  = parseInt(a.agentId, 10);
      const pct = Math.max(0, Math.min(100, Number(a.percentage) || 0));
      if (!id || isNaN(id)) continue;
      await client.query(
        `UPDATE users SET distribution_percentage = $1
          WHERE id::text = $2 AND role = 'agent' AND business_id = $3`,
        [pct, String(id), businessId]
      );
    }

    await client.query('COMMIT');

    const { rows } = await pool.query(
      `SELECT id, COALESCE(name,'') AS name, email,
              COALESCE(distribution_percentage, 0) AS distribution_percentage
         FROM users
        WHERE role = 'agent' AND business_id = $1
        ORDER BY created_at ASC`,
      [businessId]
    );
    console.log(`[Distribution] saved weights for tenant ${businessId} (${allocations.length} agent(s))`);
    res.json({ message: 'تم حفظ نسب التوزيع', agents: rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[POST /staff/distribution]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

/* ── POST /api/staff/heartbeat ────────────────────────────────────────────────
   Lightweight presence ping — stamps last_active_at = NOW() for the currently
   authenticated user. Any logged-in role may call it (the frontend pings every
   ~90s). Matched by email (case-insensitive) + tenant to dodge the users.id
   VARCHAR type drift.                                                          */
router.post('/heartbeat', authenticate, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET last_active_at = NOW()
        WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) AND business_id = $2`,
      [req.user.email, req.user.business_id]
    );
    res.json({ ok: true, at: new Date().toISOString() });
  } catch (err) {
    console.error('[POST /staff/heartbeat]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── Employee Ledger helper — compute one employee's GLOBAL balance ──────────
   Returns { exists, name, lifetime_commission, total_paid, outstanding }.
   lifetime_commission uses the SHARED earned-commission formula (all-time), so
   it always agrees with the period column on the staff page.                  */
async function getEmployeeBalance(userId, businessId) {
  const commRes = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(u.name), ''), SPLIT_PART(u.email, '@', 1)) AS name,
            ${EARNED_COMMISSION_SQL} AS lifetime_commission
       FROM users u
       LEFT JOIN orders o ON o."AssignedTo" = u.email AND o.business_id = $2::integer
      WHERE u.id = $1 AND u.business_id = $2::integer
      GROUP BY u.id, u.name, u.email,
               u.comm_confirmed, u.comm_delivered, u.comm_rejected, u.comm_no_answer`,
    [userId, businessId]
  );
  if (!commRes.rows.length) return { exists: false };

  const paidRes = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_paid
       FROM employee_payouts WHERE user_id = $1 AND business_id = $2::integer`,
    [userId, businessId]
  );

  const lifetime = parseFloat(commRes.rows[0].lifetime_commission) || 0;
  const paid     = parseFloat(paidRes.rows[0].total_paid)          || 0;
  return {
    exists: true,
    name: commRes.rows[0].name,
    lifetime_commission: parseFloat(lifetime.toFixed(2)),
    total_paid:          parseFloat(paid.toFixed(2)),
    outstanding:         parseFloat((lifetime - paid).toFixed(2)),
  };
}

/* ── GET /api/staff/:id/payouts — payout history for one employee (admin) ──── */
router.get('/:id/payouts', authenticate, requireAdmin, async (req, res) => {
  try {
    const bal = await getEmployeeBalance(req.params.id, req.user.business_id);
    if (!bal.exists) return res.status(404).json({ error: 'الموظف غير موجود' });

    const { rows } = await pool.query(
      `SELECT id, amount::float AS amount, note, paid_by, paid_at, created_at
         FROM employee_payouts
        WHERE user_id = $1 AND business_id = $2::integer
        ORDER BY paid_at DESC, id DESC`,
      [req.params.id, req.user.business_id]
    );

    res.json({
      employee:            bal.name,
      lifetime_commission: bal.lifetime_commission,
      total_paid:          bal.total_paid,
      outstanding_balance: bal.outstanding,
      payouts:             rows,
    });
  } catch (err) {
    console.error('[GET /staff/:id/payouts]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/staff/:id/payout — log a cash settlement (admin) ──────────────
   Body: { amount: number, note?: string }
   Validates 0 < amount ≤ current outstanding balance (computed server-side, so
   it can't be gamed and never drives the balance negative). Partial payments are
   allowed — the admin simply submits less than the defaulted full balance.     */
router.post('/:id/payout', authenticate, requireAdmin, async (req, res) => {
  const { amount, note } = req.body;
  const amt = parseFloat(amount);

  if (amount == null || isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'قيمة التسديد يجب أن تكون رقماً موجباً' });
  }

  try {
    const bal = await getEmployeeBalance(req.params.id, req.user.business_id);
    if (!bal.exists) return res.status(404).json({ error: 'الموظف غير موجود' });

    /* 0.01 epsilon so a full settlement of the exact balance isn't rejected by
       floating-point noise. */
    if (amt > bal.outstanding + 0.01) {
      return res.status(400).json({
        error: `المبلغ يتجاوز الرصيد المتبقي (${bal.outstanding.toFixed(2)} ج.م)`,
        outstanding_balance: bal.outstanding,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO employee_payouts (user_id, business_id, amount, note, paid_by)
       VALUES ($1, $2::integer, $3, $4, $5)
       RETURNING id, amount::float AS amount, note, paid_at, created_at`,
      [req.params.id, req.user.business_id, amt, (note || '').trim() || null, String(req.user.id)]
    );

    const newPaid        = parseFloat((bal.total_paid + amt).toFixed(2));
    const newOutstanding = parseFloat((bal.lifetime_commission - newPaid).toFixed(2));

    console.log(
      `[Payout] ${bal.name}: +${amt.toFixed(2)} | paid ${newPaid} / earned ` +
      `${bal.lifetime_commission} | outstanding ${newOutstanding}`
    );

    res.status(201).json({
      message:             `تم تسجيل تسديد ${amt.toFixed(2)} ج.م لـ ${bal.name}`,
      payout:              rows[0],
      lifetime_commission: bal.lifetime_commission,
      total_paid:          newPaid,
      outstanding_balance: newOutstanding,
    });
  } catch (err) {
    console.error('[POST /staff/:id/payout]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
