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
const { fetchReturningParcels } = require('./bosta');

const router = express.Router();

/* Fixed 40% agent commission on every collected return fee. */
const RETURN_COMMISSION_RATE = 0.40;

/* Workflow states the agent queue is bucketed into. 'paid' is terminal; 'refused'
   is an archive state for customers who refuse to pay (kept for CRM/accounting
   history instead of hard-deleting). */
const VALID_STATUSES   = ['pending', 'no_answer', 'follow_up', 'paid', 'refused'];
/* Statuses an agent may set via PATCH (paid goes through POST /:id/pay). */
const PATCHABLE_STATUSES = ['pending', 'no_answer', 'follow_up', 'refused'];

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
  .then(() => console.log('✅  return_collections table ready'))
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
   GET /api/return-collections?status=pending|no_answer|follow_up|paid
   Shared pool: every agent (and admin) sees all of the tenant's rows. The
   per-agent split lives in the analytics endpoint, not here.
   ════════════════════════════════════════════════════════════════════════════ */
router.get('/', authenticate, requireAdminOrPermission('shipping_followups'), async (req, res) => {
  const businessId = req.user.business_id;
  const { status } = req.query;

  const params = [businessId];
  let where = 'rc.business_id = $1';
  if (status && VALID_STATUSES.includes(String(status))) {
    params.push(String(status));
    where += ` AND rc.status = $${params.length}`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT rc.*,
              ${AGENT_NAME_SQL} AS handler_name,
              u.email           AS handler_email
       FROM   return_collections rc
       LEFT   JOIN users u ON u.id = rc.handled_by
       WHERE  ${where}
       ORDER  BY rc.updated_at DESC`,
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
router.patch('/:id', authenticate, requireAdminOrPermission('shipping_followups'), async (req, res) => {
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

  /* Build the SET list dynamically from the allowlisted fields only. */
  const sets   = [];
  const params = [];
  if (hasStatus) { params.push(String(req.body.status)); sets.push(`status = $${params.length}`); }
  if (hasNotes)  { params.push(req.body.notes == null ? '' : String(req.body.notes)); sets.push(`notes = $${params.length}`); }
  /* Claim ownership for the acting agent if the row is still unhandled. */
  params.push(req.user.id);
  sets.push(`handled_by = COALESCE(handled_by, $${params.length})`);
  sets.push('updated_at = NOW()');

  params.push(id, businessId);
  try {
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
   Mark a return as collected. 100% → treasury revenue; 40% accrued on the row.
   Idempotent on the treasury side via treasury_return_collection_uidx.
   ════════════════════════════════════════════════════════════════════════════ */
router.post('/:id/pay', authenticate, requireAdminOrPermission('shipping_followups'), async (req, res) => {
  const businessId = req.user.business_id;
  const { id }     = req.params;

  const amount = Math.round((parseFloat(req.body.collected_amount) || 0) * 100) / 100;
  if (!(amount > 0)) {
    return res.status(400).json({ error: 'المبلغ المُحصّل يجب أن يكون أكبر من صفر' });
  }
  const commission = Math.round(amount * RETURN_COMMISSION_RATE * 100) / 100;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
    if (!upd.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'السجل غير موجود' });
    }
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
router.post('/sync', authenticate, requireAdminOrPermission('shipping_followups'), async (req, res) => {
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
  const isAdmin    = req.user.role === 'admin';

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
