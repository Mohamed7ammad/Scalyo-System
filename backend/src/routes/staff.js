const express      = require('express');
const bcrypt       = require('bcryptjs');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const { sendWelcomeOTP } = require('../utils/mailer');
const { checkAndSendStaffAlerts } = require('../services/alerts');

/** Cryptographically-simple 6-digit OTP as a zero-padded string. */
function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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
  const otp = generateOTP();   // 6-digit verification code

  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users
         (name, email, password_hash, role, is_active, is_absent,
          permissions, commission_rate, comm_confirmed, comm_delivered, comm_rejected, comm_no_answer,
          email_verified, otp_code, business_id)
       VALUES ($1,$2,$3,$4,true,false,$5,$6,$7,$8,$9,$10,false,$11,$12)
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
        otp,                       // $11 — stored OTP
        req.user.business_id,
      ]
    );

    /* Fire the welcome OTP email — best-effort, never blocks/breaks creation.
       (Awaited so we can surface delivery status, but mailer never throws.) */
    const mail = await sendWelcomeOTP(cleanEmail, otp);

    res.status(201).json({ ...result.rows[0], email_sent: mail.sent });
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

module.exports = router;
