/* ════════════════════════════════════════════════════════════════════════════
   Return Collection Management  (إدارة تحصيل المرتجعات)
   ════════════════════════════════════════════════════════════════════════════

   Agents call customers whose parcels came back (Bosta "returning" bucket) to
   collect a return fee. This module owns the persistent workflow + the
   accrual-based commission accounting:

     • return_collections      — one persistent row per returned parcel. Rows are
                                 materialized by syncing the Bosta returning bucket
                                 and SURVIVE any later change to the order. Agents
                                 work them through a 4-state queue.
     • agent_commission_ledger — admin → agent commission payouts (settlements).

   Financial model (NO immediate cash split):
     • Mark-paid  → 100% of the collected amount is posted to the treasury as
       'return_collection' REVENUE, and 40% is ACCRUED on the row as the agent's
       employee_commission (earned, not yet paid).
     • Settle     → admin pays an agent (partial allowed). Writes a ledger row AND
       an 'agent_commission_payout' EXPENSE to the treasury so the company's net
       balance stays accurate.
   ════════════════════════════════════════════════════════════════════════════ */

const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin, requireAdminOrPermission } = require('../middleware/roleGuard');
const { hasRole } = require('../utils/roles');
const { fetchReturningParcels } = require('./bosta');

const router = express.Router();

/* Fixed 40% agent commission on every collected return fee (accrued → settled). */
const RETURN_COMMISSION_RATE = 0.40;
/* Flat commission (EGP) awarded to a Returns Reviewer each time THEY collect a
   return. Unlike the agent's accrued 40%, this is PAID IMMEDIATELY: it books a
   treasury expense at collection time (no later settlement). */
const REVIEWER_COMMISSION = 20;

/* Workflow states the queue is bucketed into. 'paid' is terminal; 'refused'
   is an archive state for customers who refuse to pay (kept for CRM/accounting
   history instead of hard-deleting). 'reason_known' (تم معرفة السبب) replaced the
   old 'follow_up' bucket — legacy rows are migrated in the schema bootstrap. */
const VALID_STATUSES   = ['pending', 'no_answer', 'reason_known', 'paid', 'refused'];
/* Statuses set via PATCH (paid goes through POST /:id/pay). Reverting a paid row
   back to one of these is allowed and unwinds its financials (see PATCH). */
const PATCHABLE_STATUSES = ['pending', 'no_answer', 'reason_known', 'refused'];

/* Access to this module: admins, holders of the shipping-followups permission
   (agents who work the queue), OR the dedicated Returns Reviewer (role/perm). */
function allowReturns(req, res, next) {
  if (hasRole(req.user, 'admin')) return next();
  const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
  if (perms.includes('shipping_followups') || perms.includes('return_review')) return next();
  if (hasRole(req.user, 'returns_reviewer')) return next();
  return res.status(403).json({ error: 'مطلوب صلاحيات المدير' });
}

/* True when the caller is acting purely as a Returns Reviewer (not an admin) —
   drives the flat-20-EGP immediate-expense commission path instead of the 40%
   accrual path. */
function isReviewer(user) {
  return hasRole(user, 'returns_reviewer') && !hasRole(user, 'admin');
}

/* ── Idempotent schema bootstrap (runs once at module load) ─────────────────
   Same pattern as products.js / treasury.js — every statement is IF NOT EXISTS. */
pool.query(`
  CREATE TABLE IF NOT EXISTS return_collections (
    id                  SERIAL        PRIMARY KEY,
    business_id         INTEGER,
    order_id            INTEGER,
    customer_name       TEXT,
    phone               VARCHAR(50),
    tracking_number     VARCHAR(100),
    product_name        TEXT,
    status              VARCHAR(20)   NOT NULL DEFAULT 'pending',
    collected_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
    employee_commission NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes               TEXT,
    handled_by          VARCHAR(255),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  )
`)
  /* Upsert key for the Bosta sync — one row per parcel per tenant. */
  .then(() => pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS return_collections_tracking_uidx
      ON return_collections (business_id, tracking_number)
      WHERE tracking_number IS NOT NULL
  `))
  .then(() => pool.query(`
    CREATE INDEX IF NOT EXISTS return_collections_handler_idx
      ON return_collections (business_id, handled_by)
  `))
  /* Returns-Reviewer accountability columns (multi-role feature). A reviewer's
     flat commission is paid immediately as a treasury expense — these columns
     make the award idempotent and reversible:
       reviewer_id                → which reviewer collected (for attribution)
       reviewer_commission        → flat EGP awarded (0 when an agent collected)
       reviewer_commission_tx_id  → the treasury expense row; NULL ⇒ not yet awarded */
  .then(() => pool.query(`ALTER TABLE return_collections ADD COLUMN IF NOT EXISTS reviewer_id VARCHAR(255)`))
  .then(() => pool.query(`ALTER TABLE return_collections ADD COLUMN IF NOT EXISTS reviewer_commission NUMERIC(12,2) NOT NULL DEFAULT 0`))
  .then(() => pool.query(`ALTER TABLE return_collections ADD COLUMN IF NOT EXISTS reviewer_commission_tx_id INTEGER`))
  /* One-time status rename: the old 'follow_up' bucket is now 'reason_known'. */
  .then(() => pool.query(`UPDATE return_collections SET status = 'reason_known' WHERE status = 'follow_up'`))
  .then((r) => console.log(`✅  return_collections table ready (migrated ${r?.rowCount ?? 0} follow_up → reason_known)`))
  .catch((err) => console.warn('⚠️   return_collections schema check:', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS agent_commission_ledger (
    id                      SERIAL        PRIMARY KEY,
    business_id             INTEGER,
    agent_user_id           VARCHAR(255)  NOT NULL,
    amount                  NUMERIC(12,2) NOT NULL,
    notes                   TEXT,
    created_by              VARCHAR(255),
    treasury_transaction_id INTEGER,
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  )
`)
  .then(() => pool.query(`
    CREATE INDEX IF NOT EXISTS agent_commission_ledger_agent_idx
      ON agent_commission_ledger (business_id, agent_user_id)
  `))
  .then(() => console.log('✅  agent_commission_ledger table ready'))
  .catch((err) => console.warn('⚠️   agent_commission_ledger schema check:', err.message));

/* Display name for a handler/agent — same convention used in staff.js/analytics. */
const AGENT_NAME_SQL = `COALESCE(NULLIF(TRIM(u.name), ''), SPLIT_PART(u.email, '@', 1))`;

/* ════════════════════════════════════════════════════════════════════════════
   GET /api/return-collections?status=…&confirmation_agent=<email>
   Shared pool: every worker (and admin) sees all of the tenant's rows. The
   per-agent split lives in the analytics endpoint, not here.

   ACCOUNTABILITY: for admins we JOIN the ORIGINAL order to surface which agent
   confirmed the (now-returned) order — orders."AssignedTo" holds that agent's
   email (there is no separate confirmed_by column). This is exposed to ADMINS
   ONLY; a Returns Reviewer must never learn who confirmed the order.
   ════════════════════════════════════════════════════════════════════════════ */
router.get('/', authenticate, allowReturns, async (req, res) => {
  const businessId = req.user.business_id;
  const isAdmin    = hasRole(req.user, 'admin');
  const { status, confirmation_agent } = req.query;

  const params = [businessId];
  let where = 'rc.business_id = $1';
  if (status && VALID_STATUSES.includes(String(status))) {
    params.push(String(status));
    where += ` AND rc.status = $${params.length}`;
  }
  /* Admin-only: filter every return caused by a specific confirmation agent. */
  if (isAdmin && confirmation_agent) {
    params.push(String(confirmation_agent));
    where += ` AND o."AssignedTo" = $${params.length}`;
  }

  /* Confirmation-agent columns are added to the projection for admins only. */
  const confCols = isAdmin
    ? `, o."AssignedTo" AS confirmation_agent_email,
         COALESCE(NULLIF(TRIM(ca.name), ''), SPLIT_PART(ca.email, '@', 1)) AS confirmation_agent_name`
    : '';

  try {
    const { rows } = await pool.query(
      `SELECT rc.*,
              ${AGENT_NAME_SQL} AS handler_name,
              u.email           AS handler_email${confCols}
       FROM   return_collections rc
       LEFT   JOIN users  u  ON u.id = rc.handled_by
       LEFT   JOIN orders o  ON o.id = rc.order_id AND o.business_id = rc.business_id
       LEFT   JOIN users  ca ON ca.email = o."AssignedTo" AND ca.business_id = rc.business_id
       WHERE  ${where}
       ORDER  BY rc.created_at DESC, rc.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[return-collections GET]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   PATCH /api/return-collections/:id   { status?, notes? }
   Move a record through the pending → no_answer → follow_up queue and/or edit
   notes. Claim-on-action: the first agent to act takes ownership (handled_by).
   ════════════════════════════════════════════════════════════════════════════ */
router.patch('/:id', authenticate, allowReturns, async (req, res) => {
  const businessId = req.user.business_id;
  const { id }     = req.params;
  const hasStatus  = Object.prototype.hasOwnProperty.call(req.body, 'status');
  const hasNotes   = Object.prototype.hasOwnProperty.call(req.body, 'notes');

  if (!hasStatus && !hasNotes) {
    return res.status(400).json({ error: 'لا توجد حقول للتحديث' });
  }
  if (hasStatus && !PATCHABLE_STATUSES.includes(String(req.body.status))) {
    return res.status(400).json({ error: 'حالة غير صالحة (الدفع يتم من زر تم الدفع)' });
  }

  try {
    /* Read the current row first so we can detect a REVERT away from 'paid'
       (which must unwind the treasury revenue AND any reviewer commission before
       we overwrite the row), and to prevent duplicate-commission exploits. */
    const cur = await pool.query(
      `SELECT * FROM return_collections WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'السجل غير موجود' });
    const row = cur.rows[0];

    const isRevert = hasStatus && row.status === 'paid' && String(req.body.status) !== 'paid';
    if (isRevert) {
      /* Only REVIEWER collections are reversible here — their commission is an
         immediate expense that unwinds cleanly. An agent's 40% is accrued and may
         already be settled, so those paid rows stay terminal (delete instead). */
      if (!row.reviewer_commission_tx_id) {
        return res.status(400).json({ error: 'لا يمكن التراجع عن تحصيل موظف بعمولة نسبية' });
      }
      /* Only an admin, or the reviewer who collected it, may reverse it. */
      if (!hasRole(req.user, 'admin') && String(row.handled_by) !== String(req.user.id)) {
        return res.status(403).json({ error: 'لا يمكنك التراجع عن تحصيل موظف آخر' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        /* The collected fee is no longer held → drop its treasury revenue row. */
        await client.query(
          `DELETE FROM treasury_transactions
           WHERE return_collection_id = $1 AND business_id = $2 AND source = 'return_collection'`,
          [id, businessId]
        );
        /* Drop the reviewer's immediate commission expense, if one was booked. */
        if (row.reviewer_commission_tx_id) {
          await client.query(
            `DELETE FROM treasury_transactions WHERE id = $1 AND business_id = $2`,
            [row.reviewer_commission_tx_id, businessId]
          );
        }
        const notes = hasNotes ? (req.body.notes == null ? '' : String(req.body.notes)) : row.notes;
        const upd = await client.query(
          `UPDATE return_collections
             SET status = $1, notes = $2,
                 collected_amount = 0, employee_commission = 0,
                 reviewer_commission = 0, reviewer_commission_tx_id = NULL, reviewer_id = NULL,
                 updated_at = NOW()
           WHERE id = $3 AND business_id = $4
           RETURNING *`,
          [String(req.body.status), notes, id, businessId]
        );
        await client.query('COMMIT');
        return res.json(upd.rows[0]);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    /* Normal path — dynamic SET over the allowlisted fields only. Claim ownership
       for the acting worker if the row is still unhandled. */
    const sets   = [];
    const params = [];
    if (hasStatus) { params.push(String(req.body.status)); sets.push(`status = $${params.length}`); }
    if (hasNotes)  { params.push(req.body.notes == null ? '' : String(req.body.notes)); sets.push(`notes = $${params.length}`); }
    params.push(req.user.id);
    sets.push(`handled_by = COALESCE(handled_by, $${params.length})`);
    sets.push('updated_at = NOW()');

    params.push(id, businessId);
    const { rows } = await pool.query(
      `UPDATE return_collections SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND business_id = $${params.length}
       RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'السجل غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[return-collections PATCH]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/return-collections/:id/pay   { collected_amount }
   Mark a return as collected. 100% of the fee → treasury revenue (idempotent per
   row). The commission depends on WHO collected:
     • Agent / admin   → 40% ACCRUED on the row (employee_commission), settled later.
     • Returns Reviewer → flat 20 EGP paid IMMEDIATELY as a treasury EXPENSE
       (source='return_review_commission'), booked exactly once per row.
   ════════════════════════════════════════════════════════════════════════════ */
router.post('/:id/pay', authenticate, allowReturns, async (req, res) => {
  const businessId = req.user.business_id;
  const { id }     = req.params;

  const amount = Math.round((parseFloat(req.body.collected_amount) || 0) * 100) / 100;
  if (!(amount > 0)) {
    return res.status(400).json({ error: 'المبلغ المُحصّل يجب أن يكون أكبر من صفر' });
  }

  const reviewer   = isReviewer(req.user);
  /* Reviewer collections carry NO 40% accrual — their reward is the flat expense. */
  const commission = reviewer ? 0 : Math.round(amount * RETURN_COMMISSION_RATE * 100) / 100;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* Lock the row + read its current reviewer-commission state (idempotency). */
    const pre = await client.query(
      `SELECT reviewer_commission_tx_id FROM return_collections
       WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [id, businessId]
    );
    if (!pre.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'السجل غير موجود' });
    }
    let reviewerTxId = pre.rows[0].reviewer_commission_tx_id;

    const upd = await client.query(
      `UPDATE return_collections
         SET status              = 'paid',
             collected_amount    = $1,
             employee_commission = $2,
             handled_by          = COALESCE(handled_by, $3),
             updated_at          = NOW()
       WHERE id = $4 AND business_id = $5
       RETURNING *`,
      [amount, commission, req.user.id, id, businessId]
    );
    const row = upd.rows[0];

    /* 100% of the collected fee → treasury as incoming revenue. Idempotent:
       re-paying the same record corrects the amount instead of duplicating. */
    await client.query(
      `INSERT INTO treasury_transactions
         (order_id, amount, type, source, description, transaction_date, business_id, return_collection_id)
       VALUES ($1, $2, 'revenue', 'return_collection', $3, CURRENT_DATE, $4, $5)
       ON CONFLICT (return_collection_id) WHERE return_collection_id IS NOT NULL
       DO UPDATE SET amount = EXCLUDED.amount, description = EXCLUDED.description`,
      [
        row.order_id,
        amount.toFixed(2),
        `تحصيل مرتجع${row.tracking_number ? ' #' + row.tracking_number : ''}` +
          (row.customer_name ? ` — ${row.customer_name}` : ''),
        businessId,
        row.id,
      ]
    );

    /* Reviewer flat commission → immediate treasury EXPENSE, booked exactly ONCE
       per row (guarded by reviewer_commission_tx_id). A re-pay corrects the
       revenue above but never books a second expense — no duplicate-commission. */
    if (reviewer && !reviewerTxId) {
      const exp = await client.query(
        `INSERT INTO treasury_transactions
           (order_id, amount, type, source, description, transaction_date, business_id)
         VALUES ($1, $2, 'expense', 'return_review_commission', $3, CURRENT_DATE, $4)
         RETURNING id`,
        [
          row.order_id,
          REVIEWER_COMMISSION.toFixed(2),
          `عمولة تحصيل مرتجع${row.tracking_number ? ' #' + row.tracking_number : ''}` +
            (row.customer_name ? ` — ${row.customer_name}` : ''),
          businessId,
        ]
      );
      reviewerTxId = exp.rows[0].id;
      const upd2 = await client.query(
        `UPDATE return_collections
           SET reviewer_id = $1, reviewer_commission = $2, reviewer_commission_tx_id = $3
         WHERE id = $4 AND business_id = $5
         RETURNING *`,
        [req.user.id, REVIEWER_COMMISSION, reviewerTxId, id, businessId]
      );
      await client.query('COMMIT');
      return res.json(upd2.rows[0]);
    }

    await client.query('COMMIT');
    res.json(row);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[return-collections pay]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/return-collections/sync
   Materialize/refresh rows from the authoritative Bosta returning bucket. Never
   touches agent work (status / amounts / commission / handled_by) on existing
   rows — only refreshes contact + product fields → rows persist permanently.
   ════════════════════════════════════════════════════════════════════════════ */
router.post('/sync', authenticate, allowReturns, async (req, res) => {
  const businessId = req.user.business_id;

  let parcels;
  try {
    parcels = await fetchReturningParcels(businessId);
  } catch (err) {
    if (err.code === 'BOSTA_NOT_CONFIGURED') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[return-collections sync] Bosta fetch failed:', err.message);
    return res.status(502).json({ error: 'تعذّر جلب المرتجعات من Bosta. تحقّق من التوكن في الإعدادات.' });
  }

  let upserted = 0;
  try {
    for (const p of parcels) {
      const tracking = (p.trackingNumber || '').trim();
      if (!tracking) continue;   // can't dedupe a parcel with no tracking number
      const r = await pool.query(
        `INSERT INTO return_collections
           (business_id, order_id, customer_name, phone, tracking_number, product_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         ON CONFLICT (business_id, tracking_number) WHERE tracking_number IS NOT NULL
         DO UPDATE SET
           order_id      = EXCLUDED.order_id,
           customer_name = EXCLUDED.customer_name,
           phone         = EXCLUDED.phone,
           product_name  = EXCLUDED.product_name,
           updated_at    = NOW()`,
        [
          businessId,
          p.order_id ?? null,
          p.customer || null,
          p.phone || null,
          tracking,
          p.product || null,
        ]
      );
      upserted += r.rowCount;
    }
    console.log(`[return-collections sync] upserted ${upserted}/${parcels.length} returning parcels`);
    res.json({ synced: upserted, fetched: parcels.length });
  } catch (err) {
    console.error('[return-collections sync] upsert failed:', err);
    res.status(500).json({ error: 'خطأ في الخادم أثناء حفظ المرتجعات' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   GET /api/return-collections/analytics
   Per-agent settlement view. Agents see only their own row; admins see every
   agent plus grand totals. earned = Σ accrued commission, paid = Σ ledger,
   remaining = earned − paid.
   ════════════════════════════════════════════════════════════════════════════ */
router.get('/analytics', authenticate, requireAdminOrPermission('shipping_followups'), async (req, res) => {
  const businessId = req.user.business_id;
  const isAdmin    = hasRole(req.user, 'admin');

  /* Agents are scoped to their own handled_by; admins see all handlers. */
  const params = [businessId];
  let handlerFilter = '';
  if (!isAdmin) {
    params.push(req.user.id);
    handlerFilter = `AND rc.handled_by = $${params.length}`;
  }

  try {
    /* Earned/collected per agent from return_collections. */
    const collected = await pool.query(
      `SELECT rc.handled_by                                            AS agent_user_id,
              ${AGENT_NAME_SQL}                                        AS agent_name,
              u.email                                                  AS agent_email,
              COALESCE(SUM(rc.collected_amount) FILTER (WHERE rc.status = 'paid'), 0)::float AS total_collected,
              COALESCE(SUM(rc.employee_commission), 0)::float          AS total_commission_earned
       FROM   return_collections rc
       LEFT   JOIN users u ON u.id = rc.handled_by
       WHERE  rc.business_id = $1 AND rc.handled_by IS NOT NULL ${handlerFilter}
       GROUP  BY rc.handled_by, u.name, u.email`,
      params
    );

    /* Paid-out per agent from the settlement ledger. */
    const paidParams = [businessId];
    let paidFilter = '';
    if (!isAdmin) { paidParams.push(req.user.id); paidFilter = `AND agent_user_id = $${paidParams.length}`; }
    const paid = await pool.query(
      `SELECT agent_user_id, COALESCE(SUM(amount), 0)::float AS total_paid
       FROM   agent_commission_ledger
       WHERE  business_id = $1 ${paidFilter}
       GROUP  BY agent_user_id`,
      paidParams
    );
    const paidByAgent = new Map(paid.rows.map((r) => [r.agent_user_id, r.total_paid]));

    /* Returns-Reviewer flat commissions — already PAID (immediate treasury
       expense), so they are informational only (no settlement). Admin sees the
       whole tenant; a reviewer sees only their own. */
    const revParams = [businessId];
    let revFilter = '';
    if (!isAdmin) { revParams.push(req.user.id); revFilter = `AND reviewer_id = $${revParams.length}`; }
    const rev = await pool.query(
      `SELECT COALESCE(SUM(reviewer_commission), 0)::float AS total_reviewer_commission
       FROM   return_collections
       WHERE  business_id = $1 ${revFilter}`,
      revParams
    );
    const totalReviewerCommission = Math.round((rev.rows[0].total_reviewer_commission || 0) * 100) / 100;

    const agents = collected.rows.map((r) => {
      const earned     = Math.round(r.total_commission_earned * 100) / 100;
      const totalPaid  = Math.round((paidByAgent.get(r.agent_user_id) || 0) * 100) / 100;
      return {
        agent_user_id:           r.agent_user_id,
        agent_name:              r.agent_name,
        agent_email:             r.agent_email,
        total_collected:         Math.round(r.total_collected * 100) / 100,
        total_commission_earned: earned,
        total_paid:              totalPaid,
        remaining_balance:       Math.round((earned - totalPaid) * 100) / 100,
      };
    });

    const totals = agents.reduce((acc, a) => ({
      total_collected:         acc.total_collected + a.total_collected,
      total_commission_earned: acc.total_commission_earned + a.total_commission_earned,
      total_paid:              acc.total_paid + a.total_paid,
      remaining_balance:       acc.remaining_balance + a.remaining_balance,
    }), { total_collected: 0, total_commission_earned: 0, total_paid: 0, remaining_balance: 0 });
    for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;
    totals.total_reviewer_commission = totalReviewerCommission;

    res.json({ is_admin: isAdmin, agents, totals });
  } catch (err) {
    console.error('[return-collections analytics]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/return-collections/settle   { agent_user_id, amount, notes? }
   Admin pays an agent (partial allowed). Writes a ledger row AND an outgoing
   'agent_commission_payout' treasury expense so the company net balance stays
   accurate. Rejects over-payment beyond the agent's remaining balance.
   ════════════════════════════════════════════════════════════════════════════ */
router.post('/settle', authenticate, requireAdmin, async (req, res) => {
  const businessId            = req.user.business_id;
  const { agent_user_id, notes } = req.body;
  const amount = Math.round((parseFloat(req.body.amount) || 0) * 100) / 100;

  if (!agent_user_id) return res.status(400).json({ error: 'يجب تحديد الموظف' });
  if (!(amount > 0))  return res.status(400).json({ error: 'المبلغ يجب أن يكون أكبر من صفر' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* Compute the agent's remaining balance under a fresh read so two concurrent
       settlements can't both overdraw. */
    const earnedQ = await client.query(
      `SELECT COALESCE(SUM(employee_commission), 0)::float AS earned
       FROM   return_collections
       WHERE  business_id = $1 AND handled_by = $2`,
      [businessId, agent_user_id]
    );
    const paidQ = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS paid
       FROM   agent_commission_ledger
       WHERE  business_id = $1 AND agent_user_id = $2`,
      [businessId, agent_user_id]
    );
    const remaining = Math.round((earnedQ.rows[0].earned - paidQ.rows[0].paid) * 100) / 100;
    if (amount > remaining + 0.001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `المبلغ يتجاوز الرصيد المتبقي (${remaining.toFixed(2)} ج.م)` });
    }

    /* Outgoing treasury expense — keeps the company net balance accurate. */
    const tx = await client.query(
      `INSERT INTO treasury_transactions
         (order_id, amount, type, source, description, transaction_date, business_id)
       VALUES (NULL, $1, 'expense', 'agent_commission_payout', $2, CURRENT_DATE, $3)
       RETURNING id`,
      [amount.toFixed(2), `تسديد عمولة مرتجعات — ${String(agent_user_id).slice(0, 8)}`, businessId]
    );

    const led = await client.query(
      `INSERT INTO agent_commission_ledger
         (business_id, agent_user_id, amount, notes, created_by, treasury_transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [businessId, agent_user_id, amount.toFixed(2), notes == null ? null : String(notes), req.user.id, tx.rows[0].id]
    );

    await client.query('COMMIT');
    res.status(201).json({ ledger: led.rows[0], remaining_after: Math.round((remaining - amount) * 100) / 100 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[return-collections settle]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   DELETE /api/return-collections/:id
   Permanently remove a record (e.g. customer refused to pay). If the record was
   already marked paid it carries a 'return_collection' treasury revenue row — we
   delete that in the same transaction so the company balance stays accurate.
   The settlement ledger is a per-agent aggregate and is left untouched.

   Admin-only: agents archive via PATCH status='refused' instead of hard-deleting.
   ════════════════════════════════════════════════════════════════════════════ */
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const { id }     = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* Drop any linked treasury revenue first (no-op for unpaid records). */
    await client.query(
      `DELETE FROM treasury_transactions
       WHERE return_collection_id = $1 AND business_id = $2 AND source = 'return_collection'`,
      [id, businessId]
    );

    const del = await client.query(
      `DELETE FROM return_collections WHERE id = $1 AND business_id = $2 RETURNING id`,
      [id, businessId]
    );
    if (!del.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'السجل غير موجود' });
    }

    await client.query('COMMIT');
    res.json({ message: 'تم حذف السجل نهائياً', id: del.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[return-collections DELETE]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

module.exports = router;
