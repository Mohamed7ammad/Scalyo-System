'use strict';

const express          = require('express');
const pool             = require('../config/db');
const authenticate     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

/* ── Safe price extraction (mirrors accounting.js) ──────────────────────────
   ProductPrice is VARCHAR and may contain currency text ("350 ج.م").
   Strip everything except digits and decimal points before casting.          */
const PRICE_EXPR = `
  COALESCE(
    NULLIF(
      REGEXP_REPLACE(COALESCE("ProductPrice"::text, ''), '[^0-9.]', '', 'g'),
      ''
    )::numeric,
    0
  )
`;

/* ── Idempotent schema bootstrap ──────────────────────────────────────────
   treasury.js owns the full migration chain for treasury_transactions.
   All statements use IF NOT EXISTS — safe to run on every restart.

   After the schema is in place we run backfillTreasury() to populate
   historical deposits + commissions from existing orders.  That step is
   ALSO idempotent — it relies on the partial unique indexes below to
   silently skip rows that are already journaled.                            */
pool.query(`
  CREATE TABLE IF NOT EXISTS treasury_transactions (
    id               SERIAL        PRIMARY KEY,
    order_id         INTEGER,
    amount           NUMERIC(12,2) NOT NULL,
    type             VARCHAR(50)   NOT NULL,
    source           VARCHAR(50)   NOT NULL,
    description      TEXT,
    transaction_date DATE          NOT NULL DEFAULT CURRENT_DATE,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  )
`)
.then(() => pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS treasury_bosta_cod_order_uidx
    ON treasury_transactions (order_id)
    WHERE source = 'bosta_cod'
`))
.then(() => pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS treasury_deposit_order_uidx
    ON treasury_transactions (order_id)
    WHERE source = 'deposit'
`))
.then(() => pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS treasury_comm_conf_uidx
    ON treasury_transactions (order_id)
    WHERE source = 'comm_confirmed'
`))
.then(() => pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS treasury_comm_del_uidx
    ON treasury_transactions (order_id)
    WHERE source = 'comm_delivered'
`))
.then(() => pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS treasury_comm_rej_uidx
    ON treasury_transactions (order_id)
    WHERE source = 'comm_rejected'
`))
.then(() => pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS treasury_comm_na_uidx
    ON treasury_transactions (order_id)
    WHERE source = 'comm_no_answer'
`))
.then(() => console.log('✅  Treasury: table + all partial indexes ready'))
.then(() => backfillTreasury())
.catch((err) => console.warn('⚠️   Treasury schema migration:', err.message));

/* ══════════════════════════════════════════════════════════════════════════
   backfillTreasury()
   ══════════════════════════════════════════════════════════════════════════

   Replays historical orders into treasury_transactions so the ledger
   reflects real numbers from day-one — not only orders touched AFTER the
   hooks in orders.js were installed.

   Idempotency:
     Every INSERT below is bounded by  ON CONFLICT (order_id) WHERE source=…
     DO NOTHING, matching the partial unique indexes created above.  That
     means a fresh row is written only the FIRST time backfill encounters
     an un-journaled order; subsequent restarts insert 0 new rows.

   Strategy:
     1. Deposits   — every order with depositAmount > 0
                     (revenue, source='deposit', dated by createdAt)
     2. Commissions — one row per order, keyed by current Status:
                     'تم التأكيد' | 'تم الشحن'      → comm_confirmed
                     'تم التوصيل' | 'تم الإرجاع'  → comm_delivered
                     'تم الرفض'                     → comm_rejected
                     'لا يرد'     | 'مؤجل'         → comm_no_answer

   Note on overlap:
     A delivered order was also confirmed at some point — but we can't
     reconstruct prior status transitions, so the backfill assigns ONE
     commission per order based on its current terminal state.  Live
     hooks in orders.js handle every future status change separately.

   On error:  logs and exits cleanly — never blocks server startup.
   ══════════════════════════════════════════════════════════════════════════ */
async function backfillTreasury() {
  console.log('🔄  Treasury backfill: starting (idempotent, safe on restart)…');

  let depositsInserted    = 0;
  let commissionsInserted = 0;

  /* ── 1. Deposits ──────────────────────────────────────────────────────── */
  try {
    const dr = await pool.query(`
      INSERT INTO treasury_transactions
        (order_id, amount, type, source, description, transaction_date)
      SELECT
        o.id,
        COALESCE(
          NULLIF(
            REGEXP_REPLACE(COALESCE(o."depositAmount"::text, ''), '[^0-9.]', '', 'g'),
            ''
          )::numeric,
          0
        )                                                                AS amount,
        'revenue'                                                        AS type,
        'deposit'                                                        AS source,
        'عربون طلب #' || o.id
          || COALESCE(' — ' || NULLIF(TRIM(o."FullName"),    ''), '')
          || COALESCE(' | '  || NULLIF(TRIM(o."ProductName"), ''), '')
          || ' (backfill)'                                                AS description,
        COALESCE(o."createdAt"::date, CURRENT_DATE)                      AS transaction_date
      FROM orders o
      WHERE COALESCE(
              NULLIF(
                REGEXP_REPLACE(COALESCE(o."depositAmount"::text, ''), '[^0-9.]', '', 'g'),
                ''
              )::numeric,
              0
            ) > 0
      ON CONFLICT (order_id) WHERE source = 'deposit' DO NOTHING
    `);
    depositsInserted = dr.rowCount || 0;
  } catch (err) {
    console.error('⚠️   Treasury backfill (deposits) error:', err.message);
  }

  /* ── 2. Commissions, one source at a time ─────────────────────────────── */
  /* Each entry hardcodes its (source, rate column, status set, label).
     Hard-coded strings are interpolated into the SQL because PostgreSQL
     requires the ON CONFLICT WHERE predicate to be a constant expression,
     not a bind parameter.  These values come from this file, NOT user
     input — safe by construction.                                          */
  const COMM_BACKFILL = [
    {
      source:   'comm_confirmed',
      rateCol:  'comm_confirmed',
      statuses: [`'تم التأكيد'`, `'تم الشحن'`],
      label:    'تأكيد',
    },
    {
      source:   'comm_delivered',
      rateCol:  'comm_delivered',
      statuses: [`'تم التوصيل'`, `'تم الإرجاع'`],
      label:    'توصيل',
    },
    {
      source:   'comm_rejected',
      rateCol:  'comm_rejected',
      statuses: [`'تم الرفض'`],
      label:    'رفض',
    },
    {
      source:   'comm_no_answer',
      rateCol:  'comm_no_answer',
      statuses: [`'لا يرد'`, `'مؤجل'`],
      label:    'لا يرد',
    },
  ];

  for (const c of COMM_BACKFILL) {
    try {
      const r = await pool.query(`
        INSERT INTO treasury_transactions
          (order_id, amount, type, source, description, transaction_date)
        SELECT
          o.id,
          COALESCE(u."${c.rateCol}"::numeric, 0)                        AS amount,
          'expense'                                                      AS type,
          '${c.source}'                                                  AS source,
          'عمولة ${c.label} (backfill) — '
            || SPLIT_PART(o."AssignedTo", '@', 1)
            || ' — طلب #' || o.id
            || COALESCE(' | ' || NULLIF(TRIM(o."ProductName"), ''), '')  AS description,
          COALESCE(o."updatedAt"::date, o."createdAt"::date, CURRENT_DATE)
                                                                         AS transaction_date
        FROM   orders o
        JOIN   users  u
          ON   LOWER(TRIM(u.email)) = LOWER(TRIM(o."AssignedTo"))
        WHERE  o."Status" IN (${c.statuses.join(', ')})
          AND  o."AssignedTo" IS NOT NULL
          AND  TRIM(o."AssignedTo") <> ''
          AND  COALESCE(u."${c.rateCol}"::numeric, 0) > 0
        ON CONFLICT (order_id) WHERE source = '${c.source}' DO NOTHING
      `);
      commissionsInserted += (r.rowCount || 0);
    } catch (err) {
      console.error(`⚠️   Treasury backfill (${c.source}) error:`, err.message);
    }
  }

  console.log(
    `✅  Treasury backfill complete: +${depositsInserted} deposit row(s), ` +
    `+${commissionsInserted} commission row(s).  ` +
    `(Re-runs will insert 0 — partial unique indexes block duplicates.)`
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/treasury
   ══════════════════════════════════════════════════════════════════════════

   Returns every row in treasury_transactions (newest first) plus a rich
   pre-computed summary broken down by source.

   summary fields:
     total_revenue       — all type='revenue' entries
     total_expenses      — all type='expense' entries
     net_balance         — total_revenue − total_expenses
     count               — total transaction rows
     bosta_cod_revenue   — source='bosta_cod'
     deposits_revenue    — source='deposit' (logged by order PATCH hook + backfill)
     total_commissions   — all source starting with 'comm_'
     deposits_live       — live SUM(depositAmount) from orders table
     count_with_deposit  — orders with depositAmount > 0
     pending_bosta_cash  — net COD for orders shipped/snoozed/no-answer/delivered
                           (cash still held in Bosta's wallet, NOT yet realized
                            → excluded from net_balance intentionally)

   Admin only.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  try {
    const [txResult, depositResult, pendingResult] = await Promise.all([

      /* ── 1. All logged transactions (tenant-scoped) ─────────────────── */
      pool.query(`
        SELECT
          id,
          order_id,
          amount::float                            AS amount,
          type,
          source,
          description,
          TO_CHAR(transaction_date, 'YYYY-MM-DD')  AS transaction_date,
          created_at
        FROM   treasury_transactions
        WHERE  business_id = $1
        ORDER  BY created_at DESC
      `, [businessId]),

      /* ── 2. Live deposit aggregate from orders table (tenant-scoped) ── */
      pool.query(`
        SELECT
          COALESCE(SUM(COALESCE("depositAmount"::numeric, 0)), 0)
            AS total_deposits_live,
          COUNT(*) FILTER (WHERE COALESCE("depositAmount"::numeric, 0) > 0)
            AS count_with_deposit
        FROM orders
        WHERE business_id = $1
      `, [businessId]),

      /* ── 3. Cash-in-transit: orders whose COD is still held in Bosta's
         wallet (shipped, snoozed, no-answer, OR delivered-but-not-yet-
         settled).  Net = ProductPrice − depositAmount (already collected).
         Deliberately NOT included in net_balance (unrealised).             */
      pool.query(`
        SELECT COALESCE(SUM(
          ${PRICE_EXPR} - COALESCE("depositAmount"::numeric, 0)
        ), 0)::float AS pending_bosta_cash
        FROM orders
        WHERE "Status" IN ('تم الشحن', 'مؤجل', 'لا يرد', 'تم التوصيل')
          AND business_id = $1
      `, [businessId]),
    ]);

    const rows = txResult.rows;
    const { total_deposits_live, count_with_deposit } = depositResult.rows[0];
    const { pending_bosta_cash }                      = pendingResult.rows[0];

    /* One-pass aggregation */
    let totalRevenue     = 0;
    let totalExpenses    = 0;
    let bostaCodRevenue  = 0;
    let depositsRevenue  = 0;
    let totalCommissions = 0;

    for (const row of rows) {
      const amt = parseFloat(row.amount) || 0;
      if (row.type === 'revenue') {
        totalRevenue += amt;
        if (row.source === 'bosta_cod') bostaCodRevenue += amt;
        if (row.source === 'deposit')   depositsRevenue += amt;
      } else {
        totalExpenses += amt;
        if (row.source.startsWith('comm_')) totalCommissions += amt;
      }
    }

    res.json({
      summary: {
        total_revenue:      parseFloat(totalRevenue.toFixed(2)),
        total_expenses:     parseFloat(totalExpenses.toFixed(2)),
        net_balance:        parseFloat((totalRevenue - totalExpenses).toFixed(2)),
        count:              rows.length,
        bosta_cod_revenue:  parseFloat(bostaCodRevenue.toFixed(2)),
        deposits_revenue:   parseFloat(depositsRevenue.toFixed(2)),
        total_commissions:  parseFloat(totalCommissions.toFixed(2)),
        deposits_live:      parseFloat(parseFloat(total_deposits_live).toFixed(2)),
        count_with_deposit: parseInt(count_with_deposit, 10) || 0,
        pending_bosta_cash: parseFloat(parseFloat(pending_bosta_cash || 0).toFixed(2)),
      },
      transactions: rows,
    });

  } catch (err) {
    console.error('[treasury GET] Error:', err.message, err.stack);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/treasury/commissions-breakdown
   ══════════════════════════════════════════════════════════════════════════

   Returns commission expense entries grouped first by date then by agent,
   with a per-type breakdown (confirmed / delivered / rejected / no_answer).

   Response shape:
   [
     {
       date:       "YYYY-MM-DD",
       date_total: number,
       agents: [
         {
           agent_email:    string,
           total:          number,
           comm_confirmed: number,
           comm_delivered: number,
           comm_rejected:  number,
           comm_no_answer: number,
         }, …
       ]
     }, …
   ]

   Admin only.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/commissions-breakdown', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        TO_CHAR(tt.transaction_date, 'YYYY-MM-DD')      AS transaction_date,
        COALESCE(o."AssignedTo", 'غير محدد')            AS agent_email,
        tt.source,
        COUNT(*)                                         AS entry_count,
        SUM(tt.amount)::float                            AS total_amount
      FROM   treasury_transactions tt
      LEFT   JOIN orders o ON o.id = tt.order_id
      WHERE  tt.source LIKE 'comm_%'
        AND  tt.business_id = $1
      GROUP  BY tt.transaction_date, o."AssignedTo", tt.source
      ORDER  BY tt.transaction_date DESC, agent_email ASC
    `, [req.user.business_id]);

    const dateMap = new Map();

    for (const row of rows) {
      const date  = row.transaction_date;
      const agent = row.agent_email;
      const amt   = parseFloat(row.total_amount) || 0;

      if (!dateMap.has(date)) {
        dateMap.set(date, { date, agentMap: new Map(), date_total: 0 });
      }
      const dateObj = dateMap.get(date);
      dateObj.date_total += amt;

      if (!dateObj.agentMap.has(agent)) {
        dateObj.agentMap.set(agent, {
          agent_email:    agent,
          total:          0,
          comm_confirmed: 0,
          comm_delivered: 0,
          comm_rejected:  0,
          comm_no_answer: 0,
        });
      }
      const agentObj = dateObj.agentMap.get(agent);
      agentObj[row.source] = (agentObj[row.source] || 0) + amt;
      agentObj.total       += amt;
    }

    const result = [...dateMap.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([, d]) => ({
        date:       d.date,
        date_total: parseFloat(d.date_total.toFixed(2)),
        agents: [...d.agentMap.values()]
          .sort((a, b) => b.total - a.total)
          .map((a) => ({
            agent_email:    a.agent_email,
            total:          parseFloat(a.total.toFixed(2)),
            comm_confirmed: parseFloat((a.comm_confirmed || 0).toFixed(2)),
            comm_delivered: parseFloat((a.comm_delivered || 0).toFixed(2)),
            comm_rejected:  parseFloat((a.comm_rejected  || 0).toFixed(2)),
            comm_no_answer: parseFloat((a.comm_no_answer || 0).toFixed(2)),
          })),
      }));

    res.json(result);

  } catch (err) {
    console.error('[treasury/commissions-breakdown] Error:', err.message, err.stack);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /api/treasury
   ══════════════════════════════════════════════════════════════════════════

   Manually adds a revenue or expense entry (order_id = NULL).
   Intended for operational expenses like packaging, flyers, manual shipping.

   Body: { amount, type, source, description?, transaction_date? }

   Admin only.
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { amount, type, source, description, transaction_date } = req.body;

  const parsed = parseFloat(amount);
  if (!amount || isNaN(parsed) || parsed <= 0) {
    return res.status(400).json({ error: 'المبلغ مطلوب ويجب أن يكون رقماً موجباً' });
  }
  if (!['revenue', 'expense'].includes(String(type))) {
    return res.status(400).json({ error: 'النوع يجب أن يكون revenue أو expense' });
  }
  if (!source || !String(source).trim()) {
    return res.status(400).json({ error: 'المصدر / التصنيف مطلوب' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO treasury_transactions
         (order_id, amount, type, source, description, transaction_date, business_id)
       VALUES (NULL, $1, $2, $3, $4, $5, $6)
       RETURNING
         id,
         order_id,
         amount::float                            AS amount,
         type,
         source,
         description,
         TO_CHAR(transaction_date, 'YYYY-MM-DD')  AS transaction_date,
         created_at`,
      [
        parsed.toFixed(2),
        String(type).trim(),
        String(source).trim(),
        description ? String(description).trim() || null : null,
        transaction_date || null,
        req.user.business_id,
      ]
    );

    console.log(`✅  Treasury manual entry: ${type} ${parsed.toFixed(2)} EGP — "${source}"`);
    res.status(201).json(rows[0]);

  } catch (err) {
    console.error('[treasury POST] Error:', err.message, err.stack);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;