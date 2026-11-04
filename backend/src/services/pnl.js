'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Profit treatment of treasury categories — ONE definition (2026-11-04)
   ════════════════════════════════════════════════════════════════════════════
   The treasury stays a pure CASH ledger: every payment keeps its real amount
   and date, and nothing here ever changes the cash balance. This module only
   decides which PROFIT VIEW a treasury row belongs to:

     daily        «ربح الطلبات» — the dashboard + product profitability. Charged
                  on the payment day, shared across products by delivered-order
                  count (packaging, transport, daily workers, EasyOrder fees…).
     commission   Also daily, but EXACT per product: each row carries the order
                  it was earned on.
     monthly      Fixed costs (salaries, subscriptions, rent…). NEVER in daily or
                  product profit — only in the monthly statement, in the month
                  the cost belongs to (period_month, default = payment month).
     distribution Profit paid out (management / partner shares). Monthly
                  statement only, BELOW operating profit: a use of profit, not a
                  cost of earning it.
     excluded     Not a profit line: capital (opening balance), stock purchases
                  (they become COGS when the order is delivered), ad spend typed
                  into the treasury (ads are counted from the Meta-synced
                  expenses table), revenue-side cash rows (deposits, COD, fees).
     order_refund A refund paid back to a customer AFTER delivery
                  (CUSTOMER_REFUND, posted only by services/orderRefunds.js). Not
                  a daily cost: the analytics queries take it from order_refunds
                  and charge it to the refunded ORDER's placement day + product.

   An expense source that is not listed (a custom free-text category) counts as
   daily — exactly how every non-ads, non-stock expense counted before.

   Readers: routes/treasury.js (categories, period_month, reclassification),
   routes/analytics.js (/dashboard + /products-profitability daily OPEX) and
   routes/monthlyStatement.js. The manual categories are mirrored on the
   frontend in lib/api.ts (MANUAL_CATEGORIES) + dashboard/treasury/page.tsx.

   No DB handle is created here — every query helper takes the caller's pool or
   client — so this module loads (and is unit-tested) without a database.
   ════════════════════════════════════════════════════════════════════════════ */

const T = Object.freeze({
  DAILY:        'daily',
  COMMISSION:   'commission',
  MONTHLY:      'monthly',
  DISTRIBUTION: 'distribution',
  EXCLUDED:     'excluded',
  ORDER_REFUND: 'order_refund',
});

/* Categories the admin picks by hand. `type` fixes the sign (the server derives
   it — the client never decides revenue vs expense); `treatment` fixes where the
   row counts in profit. Codes are stored in treasury_transactions.source. */
const MANUAL_CATEGORIES = Object.freeze({
  OPENING_BALANCE:               { type: 'revenue', label: 'رصيد افتتاحي',        treatment: T.EXCLUDED },
  OPERATIONAL_EXPENSE:           { type: 'expense', label: 'مصاريف تشغيل يومية',   treatment: T.DAILY },
  PACKAGING_COST:                { type: 'expense', label: 'تغليف',               treatment: T.DAILY },
  SHIPPING_PACKAGE_SUBSCRIPTION: { type: 'expense', label: 'باقة شحن',            treatment: T.DAILY },
  SALARIES:                      { type: 'expense', label: 'رواتب',               treatment: T.MONTHLY },
  SUBSCRIPTIONS:                 { type: 'expense', label: 'اشتراكات وسيستمات',    treatment: T.MONTHLY },
  FIXED_OPEX:                    { type: 'expense', label: 'مصاريف ثابتة أخرى',    treatment: T.MONTHLY },
  PROFIT_DISTRIBUTION:           { type: 'expense', label: 'توزيع أرباح',          treatment: T.DISTRIBUTION },
  AD_SPEND:                      { type: 'expense', label: 'مصاريف إعلانات',       treatment: T.EXCLUDED },
  INVENTORY_PURCHASE:            { type: 'expense', label: 'شراء مخزون',           treatment: T.EXCLUDED },
});

/* Sources the system posts by itself (never picked by hand). */
const AUTO_SOURCES = Object.freeze({
  comm_confirmed:           { label: 'عمولات تأكيد',       treatment: T.COMMISSION },
  comm_delivered:           { label: 'عمولات توصيل',       treatment: T.COMMISSION },
  comm_rejected:            { label: 'عمولات رفض',         treatment: T.COMMISSION },
  comm_no_answer:           { label: 'عمولات عدم رد',      treatment: T.COMMISSION },
  return_review_commission: { label: 'عمولة تحصيل مرتجع',  treatment: T.DAILY },
  agent_commission_payout:  { label: 'صرف عمولات التحصيل', treatment: T.DAILY },
  bosta_cod:                { label: 'Bosta COD',          treatment: T.EXCLUDED },
  deposit:                  { label: 'عربون',              treatment: T.EXCLUDED },
  return_collection:        { label: 'تحصيل مرتجع',        treatment: T.EXCLUDED },
  return_shipping_fee:      { label: 'رسوم شحن مرتجع',     treatment: T.EXCLUDED },
  CUSTOMER_REFUND:          { label: 'رد فلوس مرتجع',      treatment: T.ORDER_REFUND },
});

const ALL_SOURCES = Object.freeze({ ...MANUAL_CATEGORIES, ...AUTO_SOURCES });

const treatmentOf = (source) => (ALL_SOURCES[source] ? ALL_SOURCES[source].treatment : T.DAILY);
const labelOf     = (source) => (ALL_SOURCES[source] ? ALL_SOURCES[source].label : String(source ?? ''));

const codesWhere = (pred) => Object.freeze(Object.keys(ALL_SOURCES).filter((c) => pred(ALL_SOURCES[c].treatment)));

/* Expense sources kept OUT of daily / product profit. */
const NON_DAILY_SOURCES    = codesWhere((t) => t !== T.DAILY && t !== T.COMMISSION);
const MONTHLY_SOURCES      = codesWhere((t) => t === T.MONTHLY);
const DISTRIBUTION_SOURCES = codesWhere((t) => t === T.DISTRIBUTION);
const COMMISSION_SOURCES   = codesWhere((t) => t === T.COMMISSION);
/* Manual expense categories that feed daily profit (what the review list scans). */
const DAILY_MANUAL_SOURCES = Object.freeze(Object.keys(MANUAL_CATEGORIES)
  .filter((c) => MANUAL_CATEGORIES[c].type === 'expense' && MANUAL_CATEGORIES[c].treatment === T.DAILY));

/* Categories that carry «يخص شهر» (period_month). */
const usesPeriodMonth = (source) => {
  const t = MANUAL_CATEGORIES[source]?.treatment;
  return t === T.MONTHLY || t === T.DISTRIBUTION;
};

/* ── Dates ──────────────────────────────────────────────────────────────────── */
const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const cairoToday = () => CAIRO_DAY.format(new Date());                 // 'YYYY-MM-DD'
const monthOf = (ymd) => String(ymd).slice(0, 7);                         // 'YYYY-MM'
const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const ymFromIndex = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

/* Validate «يخص شهر». Accepts 'YYYY-MM' or 'YYYY-MM-DD' (any day → that month);
   empty → the payment month. Must sit within 12 months of the payment date
   (catches a mistyped year). Returns { ok, value: 'YYYY-MM-01' } or { ok:false, error }. */
function normalizePeriodMonth(input, transactionDate) {
  const txDay = /^\d{4}-\d{2}-\d{2}$/.test(String(transactionDate || '')) ? String(transactionDate) : cairoToday();
  const raw = input == null ? '' : String(input).trim();
  if (!raw) return { ok: true, value: `${monthOf(txDay)}-01` };
  const m = raw.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  const mm = m ? Number(m[2]) : 0;
  if (!m || mm < 1 || mm > 12) return { ok: false, error: 'الشهر اللي يخصه المصروف غير صالح (YYYY-MM)' };
  const ym = `${m[1]}-${m[2]}`;
  if (Math.abs(monthIndex(ym) - monthIndex(monthOf(txDay))) > 12) {
    return { ok: false, error: 'الشهر اللي يخصه المصروف بعيد أكتر من 12 شهر عن تاريخ الدفع' };
  }
  return { ok: true, value: `${ym}-01` };
}

/* ── Review-list suggestions ───────────────────────────────────────────────────
   Past fixed costs were typed as «مصروفات تشغيلية». These rules only SUGGEST a
   category for the admin's review screen — nothing is moved automatically.
   Deliberately conservative: EasyOrder fees («ايزي») scale with orders and stay
   daily; «غلطه / لغبطه سيستم» are cash corrections, not subscriptions. */
const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const toLatinDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => AR_DIGITS[d]);

/* Word boundary for Arabic text (JS \b only knows ASCII letters). */
const W = '(?:^|[\\s،,.\\-_/\\\\()+])';
const E = '(?=$|[\\s،,.\\-_/\\\\()+])';

const RULES = [
  { source: 'PROFIT_DISTRIBUTION', reason: 'أرباح',
    test: (d) => /(ارباح|أرباح|توزيع\s*(ال)?(ا|أ)رباح)/.test(d) },
  { source: 'SALARIES', reason: 'راتب',
    test: (d) => /(راتب|رواتب|مرتب|مرتبات|بونص|حافز|حوافز)/.test(d) },
  /* Staff commission paid by hand at month-end — but not transfer / card fees. */
  { source: 'SALARIES', reason: 'عمولة موظف',
    test: (d, amt) => /(كوميشن|عمولة|عموله)/.test(d) && amt >= 100
      && !/(انستا|تحويل|رسوم|فيزا|الفرش|الراجل)/.test(d) },
  { source: 'SUBSCRIPTIONS', reason: 'اشتراك / سيستم',
    test: (d) => /(كلود|claude|سيرفر|server|وينر|دومين|domain|gpt|اشتراك|كريدت|hosting|هوست)/i.test(d)
      || (/(سيستم|سستم)/.test(d) && !/(غلط|لغبط|مشكل)/.test(d)) },
  { source: 'FIXED_OPEX', reason: 'مصروف ثابت',
    test: (d) => /(ايجار|إيجار|تامين|تأمين|انترنت|إنترنت)/.test(d)
      || (/باق(ة|ه)/.test(d) && !/شحن/.test(d))
      || new RegExp(`${W}خط(ين|وط)?${E}`).test(d) },
];

/* «شهر 8» / «لشهر 10» → the period month, in the year that puts it nearest the payment month. */
function periodFromText(description, transactionDate) {
  const m = toLatinDigits(description).match(/شهر\s*(\d{1,2})(?!\d|\s*%)/);
  const tx = monthOf(transactionDate);
  if (!m) return tx;
  const mm = Number(m[1]);
  if (mm < 1 || mm > 12) return tx;
  const y = Number(tx.slice(0, 4));
  const txI = monthIndex(tx);
  let best = null;
  for (const yy of [y - 1, y, y + 1]) {
    const i = yy * 12 + mm - 1;
    if (best === null || Math.abs(i - txI) < Math.abs(best - txI)) best = i;
  }
  return ymFromIndex(best);
}

/* A manual expense that is really a customer refund («مرتجع» …) — it belongs to
   an ORDER (link it through the refund dialog), not to a category. */
const looksLikeRefund = (description) => {
  const d = String(description || '');
  return /(مرتجع|مررتجع|استرجاع|استرداد)/.test(d) && !/(راتب|عمول)/.test(d);
};

/* Suggest a category for a past manual row, or null when it looks like a real
   daily cost. Only rows filed under a DAILY manual category are candidates. */
function suggestCategory({ description, source, amount, transaction_date }) {
  if (!DAILY_MANUAL_SOURCES.includes(source)) return null;
  const d = toLatinDigits(String(description || '')).trim();
  if (!d) return null;
  const amt = Number(amount) || 0;
  const rule = RULES.find((r) => r.test(d, amt));
  if (!rule || rule.source === source) return null;
  return {
    source:       rule.source,
    period_month: periodFromText(d, transaction_date),   // 'YYYY-MM'
    reason:       rule.reason,
  };
}

/* ── Query helpers (db = pool or client) ──────────────────────────────────────
   start / end: validated 'YYYY-MM-DD' or null (open bound), matched against the
   payment day (transaction_date) — the same basis as ad spend.                */

/* Daily OPEX grouped by source: every expense except the non-daily categories.
   Commission rows are included (callers split them out by COMMISSION_SOURCES). */
function dailyOpexBySource(db, { businessId, start = null, end = null }) {
  return db.query(`
    SELECT source, COALESCE(SUM(amount), 0) AS amount
      FROM treasury_transactions
     WHERE business_id = $1::integer
       AND type = 'expense'
       AND source <> ALL($4::text[])
       AND ($2::text IS NULL OR TO_CHAR(transaction_date, 'YYYY-MM-DD') >= $2)
       AND ($3::text IS NULL OR TO_CHAR(transaction_date, 'YYYY-MM-DD') <= $3)
     GROUP BY source
  `, [businessId, start, end, NON_DAILY_SOURCES]);
}

/* Commissions attributed EXACTLY per product: the row's order → its product,
   SKU first, ProductName fallback only when the order's SKU matches no product. */
function commissionByProduct(db, { businessId, start = null, end = null }) {
  return db.query(`
    SELECT p.name AS product_name, COALESCE(SUM(tt.amount), 0) AS commission
      FROM treasury_transactions tt
      JOIN orders   o ON o.id = tt.order_id AND o.business_id = $1::integer
      JOIN products p ON p.business_id = $1::integer
       AND (
         ( COALESCE(o.sku, '') <> '' AND UPPER(o.sku) = UPPER(p.sku) )
         OR
         ( UPPER(TRIM(COALESCE(o."ProductName", ''))) = UPPER(TRIM(p.name))
           AND NOT EXISTS (
             SELECT 1 FROM products px
              WHERE px.business_id = $1::integer
                AND COALESCE(o.sku, '') <> ''
                AND UPPER(px.sku) = UPPER(o.sku)
           ) )
       )
     WHERE tt.business_id = $1::integer
       AND tt.type = 'expense'
       AND tt.source = ANY($4::text[])
       AND ($2::text IS NULL OR TO_CHAR(tt.transaction_date, 'YYYY-MM-DD') >= $2)
       AND ($3::text IS NULL OR TO_CHAR(tt.transaction_date, 'YYYY-MM-DD') <= $3)
     GROUP BY p.id, p.name
  `, [businessId, start, end, COMMISSION_SOURCES]);
}

/* Fixed costs + distributions that BELONG to a month ('YYYY-MM'): period_month,
   or the payment month for a row that has none. */
function monthlyRows(db, { businessId, month }) {
  return db.query(`
    SELECT id, source, amount::float AS amount, description,
           TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date,
           (period_month IS NULL)                  AS period_defaulted
      FROM treasury_transactions
     WHERE business_id = $1::integer
       AND type = 'expense'
       AND source = ANY($2::text[])
       AND COALESCE(period_month, date_trunc('month', transaction_date)::date) = $3::date
     ORDER BY transaction_date, id
  `, [businessId, [...MONTHLY_SOURCES, ...DISTRIBUTION_SOURCES], `${month}-01`]);
}

/* ── After-delivery SQL fragments (Phase 2) ──────────────────────────────────
   Refunds, units back on the shelf and pickup/exchange fees, as correlated
   sub-selects on an orders alias. They read order_refunds / return_pickups,
   which the refund + pickup services create at startup — until both exist
   (first seconds after a deploy, or a DB without them) every fragment is a
   literal 0 / FALSE, so the dashboard keeps working exactly as before. */
let afterDeliveryOk = false;
async function afterDeliverySql(db) {
  if (!afterDeliveryOk) {
    try {
      const { rows: [r] } = await db.query(
        `SELECT (to_regclass('order_refunds') IS NOT NULL AND to_regclass('return_pickups') IS NOT NULL) AS ok`);
      afterDeliveryOk = Boolean(r && r.ok);
    } catch { afterDeliveryOk = false; }
  }
  const on = afterDeliveryOk;
  return {
    enabled: on,
    /* money paid back to the customer after delivery */
    refundOf:  (o) => (on ? `(SELECT COALESCE(SUM(rf.refund_amount), 0) FROM order_refunds rf WHERE rf.order_id = ${o}.id)` : '0'),
    hasRefund: (o) => (on ? `EXISTS (SELECT 1 FROM order_refunds rf WHERE rf.order_id = ${o}.id)` : 'FALSE'),
    /* units back on the shelf × the order's cost snapshot, minus an exchange's replacement */
    cogsBackOf: (o) => (on ? `(SELECT COALESCE(SUM(rp.return_qty * COALESCE(rp.unit_cost, 0)
                                  - rp.forward_qty * COALESCE(rp.forward_unit_cost, 0)), 0)
                                FROM return_pickups rp WHERE rp.order_id = ${o}.id AND rp.restocked_at IS NOT NULL)` : '0'),
    /* Bosta fee of the pickup / exchange, net of any COD it collected */
    returnShipOf: (o) => (on ? `(SELECT COALESCE(SUM(COALESCE(rp.pickup_fee, 0) - COALESCE(rp.collected_cod, 0)), 0)
                                  FROM return_pickups rp WHERE rp.order_id = ${o}.id
                                   AND rp.received_at IS NOT NULL AND rp.ignored_at IS NULL)` : '0'),
  };
}

module.exports = {
  T,
  afterDeliverySql,
  MANUAL_CATEGORIES,
  AUTO_SOURCES,
  treatmentOf,
  labelOf,
  usesPeriodMonth,
  NON_DAILY_SOURCES,
  MONTHLY_SOURCES,
  DISTRIBUTION_SOURCES,
  COMMISSION_SOURCES,
  DAILY_MANUAL_SOURCES,
  normalizePeriodMonth,
  suggestCategory,
  looksLikeRefund,
  periodFromText,
  cairoToday,
  dailyOpexBySource,
  commissionByProduct,
  monthlyRows,
};
