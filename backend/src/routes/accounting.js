'use strict';

const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

/* ── Idempotent migration: expenses table ─────────────────────────────────
   Safe to run on every restart — IF NOT EXISTS guards it.                 */
pool.query(`
  CREATE TABLE IF NOT EXISTS expenses (
    id           SERIAL        PRIMARY KEY,
    amount       NUMERIC(10,2) NOT NULL,
    category     VARCHAR(50)   NOT NULL,
    description  TEXT,
    expense_date DATE          DEFAULT CURRENT_DATE,
    created_at   TIMESTAMPTZ   DEFAULT NOW()
  )
`)
  .then(() => console.log('✅  Accounting: expenses table ready'))
  .catch((err) => console.warn('⚠️   expenses table check:', err.message));

/* ── Safe price extraction ────────────────────────────────────────────────
   ProductPrice is VARCHAR and may contain currency text ("350 ج.م", "350").
   Strip everything except digits and decimal points before casting.       */
const PRICE_EXPR = `
  COALESCE(
    NULLIF(
      REGEXP_REPLACE(COALESCE("ProductPrice"::text, ''), '[^0-9.]', '', 'g'),
      ''
    )::numeric,
    0
  )
`;

/* ── Allowed expense categories (whitelist for validation) ────────────── */
const ALLOWED_CATEGORIES = new Set([
  'إعلانات ميتا وتيك توك',
  'تغليف ومطبوعات',
  'اشتراكات برامج',
  'مصاريف شحن',
  'أخرى',
]);

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/accounting/overview — Admin only
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/overview', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        /* ── 1. Collected deposits ─────────────────────────────────────── */
        COALESCE(SUM(COALESCE("depositAmount"::numeric, 0)), 0)
          AS total_deposits,

        COUNT(*) FILTER (WHERE COALESCE("depositAmount"::numeric, 0) > 0)
          AS count_with_deposit,

        /* ── 2. Bosta receivables (delivered, awaiting settlement) ──────── */
        COALESCE(SUM(
          ${PRICE_EXPR} - COALESCE("depositAmount"::numeric, 0)
        ) FILTER (WHERE "Status" = 'تم التوصيل'), 0)
          AS bosta_receivables,

        COUNT(*) FILTER (WHERE "Status" = 'تم التوصيل')
          AS count_delivered,

        /* ── 3. Cash in transit (shipped, courier collecting) ───────────── */
        COALESCE(SUM(
          ${PRICE_EXPR} - COALESCE("depositAmount"::numeric, 0)
        ) FILTER (WHERE "Status" = 'تم الشحن'), 0)
          AS cash_in_transit,

        COUNT(*) FILTER (WHERE "Status" = 'تم الشحن')
          AS count_in_transit,

        /* ── 4. Gross delivered sales (top-line revenue) ────────────────── */
        COALESCE(SUM(${PRICE_EXPR}) FILTER (WHERE "Status" = 'تم التوصيل'), 0)
          AS total_sales_delivered,

        /* ── 5. Confirmed pending dispatch ──────────────────────────────── */
        COALESCE(SUM(
          ${PRICE_EXPR} - COALESCE("depositAmount"::numeric, 0)
        ) FILTER (WHERE "Status" = 'تم التأكيد'), 0)
          AS confirmed_pending_ship,

        COUNT(*) FILTER (WHERE "Status" = 'تم التأكيد')
          AS count_confirmed,

        /* ── 6. Total logged expenses (scalar subquery, tenant-scoped) ───
              Joining cross-table aggregates via subquery avoids a cartesian
              product — both sides aggregate independently then combine.    */
        (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE business_id = $1)
          AS total_expenses

      FROM orders
      WHERE business_id = $1
    `, [req.user.business_id]);

    const r = rows[0];

    res.json({
      total_deposits:          parseFloat(r.total_deposits)          || 0,
      count_with_deposit:      parseInt(r.count_with_deposit, 10)    || 0,
      bosta_receivables:       parseFloat(r.bosta_receivables)       || 0,
      count_delivered:         parseInt(r.count_delivered, 10)       || 0,
      cash_in_transit:         parseFloat(r.cash_in_transit)         || 0,
      count_in_transit:        parseInt(r.count_in_transit, 10)      || 0,
      total_sales_delivered:   parseFloat(r.total_sales_delivered)   || 0,
      confirmed_pending_ship:  parseFloat(r.confirmed_pending_ship)  || 0,
      count_confirmed:         parseInt(r.count_confirmed, 10)       || 0,
      total_expenses:          parseFloat(r.total_expenses)          || 0,
    });

  } catch (err) {
    console.error('[accounting/overview] Error:', err.message, err.stack);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/accounting/expenses — Admin only
   Returns all expense rows newest-first.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/expenses', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, amount, category, description, expense_date, created_at
       FROM   expenses
       WHERE  business_id = $1
       ORDER  BY expense_date DESC, created_at DESC`,
      [req.user.business_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[accounting/expenses GET] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /api/accounting/expenses — Admin only
   Body: { amount, category, description?, expense_date? }
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/expenses', authenticate, requireAdmin, async (req, res) => {
  const { amount, category, description, expense_date } = req.body;

  /* ── Validation ──────────────────────────────────────────────────────── */
  const parsed = parseFloat(amount);
  if (!amount || isNaN(parsed) || parsed <= 0) {
    return res.status(400).json({ error: 'المبلغ مطلوب ويجب أن يكون رقماً موجباً' });
  }
  if (!category || !ALLOWED_CATEGORIES.has(String(category).trim())) {
    return res.status(400).json({ error: `التصنيف غير صالح. القيم المقبولة: ${[...ALLOWED_CATEGORIES].join('، ')}` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO expenses (amount, category, description, expense_date, business_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, amount, category, description, expense_date, created_at`,
      [
        parsed,
        String(category).trim(),
        description ? String(description).trim() || null : null,
        expense_date || null,   // NULL → DB DEFAULT CURRENT_DATE
        req.user.business_id,
      ]
    );

    console.log(`✅  Expense added: ${parsed} ج.م — "${category}"`);
    res.status(201).json(rows[0]);

  } catch (err) {
    console.error('[accounting/expenses POST] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
