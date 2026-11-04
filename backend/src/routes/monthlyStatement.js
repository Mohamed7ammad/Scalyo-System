'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Monthly statement — «التقرير الشهري»  (2026-11-04)
   ════════════════════════════════════════════════════════════════════════════
   The month-level half of the P&L. Daily «ربح الطلبات» (dashboard + product
   profitability) deliberately leaves out salaries, subscriptions, other fixed
   costs and profit distributions; this endpoint returns exactly those for one
   month, grouped by the month they BELONG to (period_month «يخص شهر», or the
   payment month when none was set):

       ربح الطلبات            ← the dashboard's number for the same month
     − المصاريف الثابتة        ← fixed.total   (SALARIES, SUBSCRIPTIONS, FIXED_OPEX)
     = صافي الربح التشغيلي
     − توزيع أرباح             ← distributions.total (PROFIT_DISTRIBUTION)
     = المتبقي في الشركة

   The page takes «ربح الطلبات» from /api/analytics/dashboard +
   /products-profitability for the month's dates, so the statement and the
   dashboard can never disagree. Category treatment: services/pnl.js.

   GET /api/monthly-statement?month=YYYY-MM — admin only (default: this month).
   ════════════════════════════════════════════════════════════════════════════ */

const express          = require('express');
const pool             = require('../config/db');
const authenticate     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const pnl              = require('../services/pnl');

const router = express.Router();

/* Late deliveries of a month's orders and late fixed-cost entries keep moving
   the numbers for a while after the month ends. */
const SETTLE_DAYS = 21;

const lastDayOf = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const r2 = (n) => parseFloat((Number(n) || 0).toFixed(2));

router.get('/', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const today = pnl.cairoToday();
  const month = typeof req.query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)
    ? req.query.month
    : today.slice(0, 7);
  const start = `${month}-01`;
  const end   = lastDayOf(month);
  const finalFrom = addDays(end, SETTLE_DAYS);

  try {
    const [monthRes, reviewRes] = await Promise.all([
      pnl.monthlyRows(pool, { businessId, month }),
      /* Daily-category rows PAID this month that look like fixed costs — the
         review list would move them here (nudge on the statement page). */
      pool.query(
        `SELECT id, amount::float AS amount, source, description,
                TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date
           FROM treasury_transactions
          WHERE business_id = $1::integer AND type = 'expense'
            AND order_id IS NULL AND purchase_order_id IS NULL
            AND source = ANY($2::text[])
            AND transaction_date BETWEEN $3::date AND $4::date`,
        [businessId, pnl.DAILY_MANUAL_SOURCES, start, end]),
    ]);

    const lines = new Map();   // source → line
    const distributions = { total: 0, entries: [] };
    for (const r of monthRes.rows) {
      const entry = {
        id: r.id, transaction_date: r.transaction_date, amount: r2(r.amount),
        description: r.description, period_defaulted: r.period_defaulted,
      };
      if (pnl.treatmentOf(r.source) === pnl.T.DISTRIBUTION) {
        distributions.total += entry.amount;
        distributions.entries.push(entry);
        continue;
      }
      if (!lines.has(r.source)) {
        lines.set(r.source, { source: r.source, label: pnl.labelOf(r.source), amount: 0, entries: [] });
      }
      const line = lines.get(r.source);
      line.amount += entry.amount;
      line.entries.push(entry);
    }
    /* Fixed lines in category order (salaries first), then any other. */
    const order = pnl.MONTHLY_SOURCES;
    const fixedLines = [...lines.values()]
      .map((l) => ({ ...l, amount: r2(l.amount), count: l.entries.length }))
      .sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
    const fixedTotal = r2(fixedLines.reduce((s, l) => s + l.amount, 0));

    const suspects = reviewRes.rows.filter((r) => pnl.suggestCategory(r));

    res.json({
      month, start, end,
      provisional: today <= finalFrom,
      final_from:  finalFrom,
      fixed: { total: fixedTotal, lines: fixedLines },
      distributions: { total: r2(distributions.total), count: distributions.entries.length, entries: distributions.entries },
      review: {
        count:  suspects.length,
        amount: r2(suspects.reduce((s, r) => s + (Number(r.amount) || 0), 0)),
      },
    });
  } catch (err) {
    console.error('[monthly-statement] Error:', err.message, err.stack);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
