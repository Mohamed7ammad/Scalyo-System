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

/* ── Manual transaction categories (the "corporate vault" ledger) ───────────
   Each manual entry the admin adds is tagged with one of these category codes
   in treasury_transactions.source.  The category is the single source of truth
   for whether the entry is money IN (revenue / credit) or money OUT
   (expense / debit) — the client never decides the sign on its own, the server
   derives `type` from the category below.  Codes are stored, Arabic labels are
   for display only.  source is VARCHAR(50) so every code fits comfortably.

   Mirrored on the frontend in:
     • frontend/src/lib/api.ts          (MANUAL_CATEGORIES type)
     • dashboard/treasury/page.tsx      (AddEntryModal dropdown + SOURCE_META)  */
const MANUAL_CATEGORIES = {
  OPENING_BALANCE:               { type: 'revenue', label: 'رصيد افتتاحي'      },
  PACKAGING_COST:                { type: 'expense', label: 'تغليف'             },
  AD_SPEND:                      { type: 'expense', label: 'مصاريف إعلانات'    },
  SHIPPING_PACKAGE_SUBSCRIPTION: { type: 'expense', label: 'باقة شحن'          },
  OPERATIONAL_EXPENSE:           { type: 'expense', label: 'مصروفات تشغيلية'   },
  /* Stock CapEx: deducts cash from the drawer like any expense, but is EXCLUDED
     from the dashboard P&L OPEX (analytics.js) — inventory becomes COGS on
     delivery, it is not an operating cost. Still counted in the cash balance.  */
  INVENTORY_PURCHASE:            { type: 'expense', label: 'شراء مخزون'        },
};

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
/* Link to the inventory supply batch (purchase_orders.id is a UUID). Auto-
   generated INVENTORY_PURCHASE rows carry this so the UI/API can LOCK them
   (employees can't hand-edit a system-posted stock purchase). The partial
   unique index also makes the auto-insert idempotent (one treasury row per
   shipment, ON CONFLICT DO NOTHING). */
.then(() => pool.query(`
  ALTER TABLE treasury_transactions ADD COLUMN IF NOT EXISTS purchase_order_id UUID
`))
.then(() => pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS treasury_purchase_order_uidx
    ON treasury_transactions (purchase_order_id)
    WHERE purchase_order_id IS NOT NULL
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
      source:    'comm_confirmed',
      rateCol:   'comm_confirmed',
      predicate: `o."Status" IN ('تم التأكيد', 'تم الشحن')`,
      label:     'تأكيد',
    },
    {
      source:    'comm_delivered',
      rateCol:   'comm_delivered',
      predicate: `o."Status" IN ('تم التوصيل', 'تم الإرجاع')`,
      label:     'توصيل',
    },
    {
      source:    'comm_rejected',
      rateCol:   'comm_rejected',
      predicate: `o."Status" = 'تم الرفض'`,
      label:     'رفض',
    },
    {
      source:    'comm_no_answer',
      rateCol:   'comm_no_answer',
      /* 'لا يرد' earns this ONLY after 5 logged call attempts (anti-abuse rule).
         'مؤجل' grants NO automatic commission. Mirrors orders.js. */
      predicate: `(o."Status" = 'لا يرد' AND COALESCE(jsonb_array_length(o."no_answer_logs"), 0) >= 5)`,
      label:     'لا يرد',
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
        WHERE  ${c.predicate}
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
     pending_bosta_cash  — raw expected COD (price − deposit, > 0 only) for
                           in-transit orders (shipped / delayed / no-answer);
                           finalized orders (delivered / returned / cancelled)
                           are excluded.  Cash still pending collection at the
                           courier, NOT yet realized → excluded from net_balance.

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
          purchase_order_id,
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

      /* ── 3. Cash-in-transit: expected COD still pending collection at the
         courier.  STRICT rules:
           • In-transit statuses ONLY — 'تم الشحن' (shipped / out-for-delivery),
             'مؤجل' (delayed), 'لا يرد' (no-answer).  Finalized statuses are
             excluded: 'تم التوصيل' (delivered — already collected/settled),
             'تم الإرجاع' / 'جاري الإعادة' (returned), 'ملغي' (cancelled).
           • Expected COD = ProductPrice − depositAmount; the per-row filter
             keeps ONLY rows where that is > 0 (no money to collect otherwise,
             and it can't drag the total negative).
           • Raw expected COD — shipping fees are NOT subtracted.
         Deliberately NOT included in net_balance (unrealised).             */
      pool.query(`
        SELECT COALESCE(SUM(
          ${PRICE_EXPR} - COALESCE("depositAmount"::numeric, 0)
        ), 0)::float AS pending_bosta_cash
        FROM orders
        WHERE "Status" IN ('تم الشحن', 'مؤجل', 'لا يرد')
          AND business_id = $1
          AND (${PRICE_EXPR} - COALESCE("depositAmount"::numeric, 0)) > 0
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
    let openingBalance   = 0;   // seed capital injected via OPENING_BALANCE entries

    for (const row of rows) {
      const amt = parseFloat(row.amount) || 0;
      if (row.type === 'revenue') {
        totalRevenue += amt;
        if (row.source === 'bosta_cod')       bostaCodRevenue += amt;
        if (row.source === 'deposit')         depositsRevenue += amt;
        if (row.source === 'OPENING_BALANCE') openingBalance  += amt;
      } else {
        totalExpenses += amt;
        if (row.source.startsWith('comm_')) totalCommissions += amt;
      }
    }

    /* Current Total Balance (النقد الفعلي / net cash in the corporate vault):
         Σ opening balances + all incomes − all expenses & payouts.
       Opening balances are already counted inside totalRevenue, so the real
       cash on hand is simply total revenue − total expenses. We surface it as
       a dedicated, unambiguous metric so the dashboard can headline it.        */
    const currentTotalBalance = totalRevenue - totalExpenses;

    res.json({
      summary: {
        total_revenue:         parseFloat(totalRevenue.toFixed(2)),
        total_expenses:        parseFloat(totalExpenses.toFixed(2)),
        net_balance:           parseFloat((totalRevenue - totalExpenses).toFixed(2)),
        current_total_balance: parseFloat(currentTotalBalance.toFixed(2)),
        opening_balance:       parseFloat(openingBalance.toFixed(2)),
        count:                 rows.length,
        bosta_cod_revenue:     parseFloat(bostaCodRevenue.toFixed(2)),
        deposits_revenue:      parseFloat(depositsRevenue.toFixed(2)),
        total_commissions:     parseFloat(totalCommissions.toFixed(2)),
        deposits_live:         parseFloat(parseFloat(total_deposits_live).toFixed(2)),
        count_with_deposit:    parseInt(count_with_deposit, 10) || 0,
        pending_bosta_cash:    parseFloat(parseFloat(pending_bosta_cash || 0).toFixed(2)),
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
    const { startDate, endDate, agentEmail } = req.query;

    /* Build the WHERE clause dynamically; $1 is always the tenant. */
    const params = [req.user.business_id];
    let where = `tt.source LIKE 'comm_%' AND tt.business_id = $1`;

    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      params.push(startDate);
      where += ` AND tt.transaction_date >= $${params.length}::date`;
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      params.push(endDate);
      where += ` AND tt.transaction_date <= $${params.length}::date`;
    }
    if (agentEmail && String(agentEmail).trim()) {
      params.push(String(agentEmail).trim());
      where += ` AND LOWER(TRIM(o."AssignedTo")) = LOWER(TRIM($${params.length}))`;
    }

    const { rows } = await pool.query(`
      SELECT
        TO_CHAR(tt.transaction_date, 'YYYY-MM-DD')      AS transaction_date,
        COALESCE(o."AssignedTo", 'غير محدد')            AS agent_email,
        tt.source,
        COUNT(*)                                         AS entry_count,
        SUM(tt.amount)::float                            AS total_amount
      FROM   treasury_transactions tt
      LEFT   JOIN orders o ON o.id = tt.order_id
      WHERE  ${where}
      GROUP  BY tt.transaction_date, o."AssignedTo", tt.source
      ORDER  BY tt.transaction_date DESC, agent_email ASC
    `, params);

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
   Intended for the corporate-vault ledger: opening balance, packaging, ad
   spend, shipping subscriptions, and other operational expenses.

   Body: { amount, source, type?, description?, transaction_date? }

   `source` is the single source of truth for the sign of the entry:
     • If it matches a known category in MANUAL_CATEGORIES, the server forces
       `type` from that category (client-supplied `type` is ignored) — so an
       OPENING_BALANCE can never be miscategorised as an expense, etc.
     • Otherwise (free-text custom category) the client MUST pass a valid
       `type` of 'revenue' or 'expense', preserving backward compatibility.

   Admin only.
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { amount, type, source, description, transaction_date } = req.body;

  const parsed = parseFloat(amount);
  if (!amount || isNaN(parsed) || parsed <= 0) {
    return res.status(400).json({ error: 'المبلغ مطلوب ويجب أن يكون رقماً موجباً' });
  }
  if (!source || !String(source).trim()) {
    return res.status(400).json({ error: 'المصدر / التصنيف مطلوب' });
  }

  const sourceCode = String(source).trim();
  const category   = MANUAL_CATEGORIES[sourceCode];

  /* Derive the authoritative type: a known category dictates revenue/expense;
     a free-text source falls back to the validated client-supplied type.      */
  let resolvedType;
  if (category) {
    resolvedType = category.type;
  } else if (['revenue', 'expense'].includes(String(type))) {
    resolvedType = String(type);
  } else {
    return res.status(400).json({ error: 'النوع يجب أن يكون revenue أو expense' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO treasury_transactions
         (order_id, amount, type, source, description, transaction_date, business_id)
       VALUES (NULL, $1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6)
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
        resolvedType,
        sourceCode,
        description ? String(description).trim() || null : null,
        transaction_date || null,
        req.user.business_id,
      ]
    );

    console.log(`✅  Treasury manual entry: ${resolvedType} ${parsed.toFixed(2)} EGP — "${sourceCode}"`);
    res.status(201).json(rows[0]);

  } catch (err) {
    console.error('[treasury POST] Error:', err.message, err.stack);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── Auto-generated sources (reconciled from orders) — NEVER hand-editable ─────
   These rows are created/maintained by the order lifecycle + backfills and are
   keyed by order_id with partial-unique indexes. Editing or deleting them from
   the UI would corrupt reconciliation, so both endpoints below refuse them. A
   manual entry is identified by order_id IS NULL.                              */
const RESERVED_AUTO_SOURCES = new Set([
  'bosta_cod', 'deposit',
  'comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer',
]);

/* Load a tenant-scoped, MANUAL (order_id IS NULL) transaction or send the right
   error. Returns the row on success, or null after responding.                 */
async function loadEditableTxn(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'معرّف العملية غير صالح' });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT id, order_id, source, type, purchase_order_id FROM treasury_transactions
      WHERE id = $1 AND business_id = $2::integer`,
    [id, req.user.business_id]);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: 'العملية غير موجودة' });
    return null;
  }
  /* Locked when: linked to an order (commission/deposit/COD), a reserved auto
     source, OR linked to an inventory supply batch (purchase_order_id). These are
     system-posted and must be corrected at their source (the order / the shipment),
     never hand-edited in the ledger. */
  if (row.order_id !== null || row.purchase_order_id !== null || RESERVED_AUTO_SOURCES.has(row.source)) {
    res.status(409).json({
      error: 'لا يمكن تعديل أو حذف عملية مُولّدة تلقائياً (عمولة / تحصيل / عربون / شراء مخزون). عدّل المصدر الأصلي بدلاً من ذلك.',
    });
    return null;
  }
  return row;
}

/* ── Edit a manual treasury transaction ───────────────────────────────────────
   PUT /api/treasury/:id  — admin only, tenant-scoped, manual rows only.
   Body: { amount, type, source, description, transaction_date } (same shape as
   POST). type is re-derived from a known category, else the supplied type.     */
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  const row = await loadEditableTxn(req, res);
  if (!row) return;

  const { amount, type, source, description, transaction_date } = req.body;

  const parsed = parseFloat(amount);
  if (amount === undefined || amount === null || isNaN(parsed) || parsed <= 0) {
    return res.status(400).json({ error: 'المبلغ مطلوب ويجب أن يكون رقماً موجباً' });
  }
  if (!source || !String(source).trim()) {
    return res.status(400).json({ error: 'المصدر / التصنيف مطلوب' });
  }
  const sourceCode = String(source).trim();
  if (RESERVED_AUTO_SOURCES.has(sourceCode)) {
    return res.status(400).json({ error: 'لا يمكن استخدام تصنيف مُولّد تلقائياً لعملية يدوية' });
  }

  const category = MANUAL_CATEGORIES[sourceCode];
  let resolvedType;
  if (category) {
    resolvedType = category.type;
  } else if (['revenue', 'expense'].includes(String(type))) {
    resolvedType = String(type);
  } else {
    return res.status(400).json({ error: 'النوع يجب أن يكون revenue أو expense' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE treasury_transactions
          SET amount           = $1,
              type             = $2,
              source           = $3,
              description      = $4,
              transaction_date = COALESCE($5::date, transaction_date)
        WHERE id = $6 AND business_id = $7::integer AND order_id IS NULL
        RETURNING
          id, order_id, amount::float AS amount, type, source, description,
          TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date, created_at`,
      [
        parsed.toFixed(2), resolvedType, sourceCode,
        description ? String(description).trim() || null : null,
        transaction_date || null,
        row.id, req.user.business_id,
      ]);
    if (!rows[0]) return res.status(404).json({ error: 'العملية غير موجودة' });
    console.log(`✏️   Treasury entry #${row.id} edited → ${resolvedType} ${parsed.toFixed(2)} EGP "${sourceCode}"`);
    res.json(rows[0]);
  } catch (err) {
    console.error('[treasury PUT] Error:', err.message, err.stack);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── Delete a manual treasury transaction ─────────────────────────────────────
   DELETE /api/treasury/:id  — admin only, tenant-scoped, manual rows only.     */
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  const row = await loadEditableTxn(req, res);
  if (!row) return;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM treasury_transactions
        WHERE id = $1 AND business_id = $2::integer AND order_id IS NULL`,
      [row.id, req.user.business_id]);
    if (!rowCount) return res.status(404).json({ error: 'العملية غير موجودة' });
    console.log(`🗑️   Treasury entry #${row.id} deleted (source "${row.source}")`);
    res.json({ success: true, id: row.id });
  } catch (err) {
    console.error('[treasury DELETE] Error:', err.message, err.stack);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;