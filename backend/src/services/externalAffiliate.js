'use strict';

/**
 * externalAffiliate.js — External Affiliate Network integrations (Taager / Safqa).
 * ─────────────────────────────────────────────────────────────────────────────
 * EXCLUSIVE to the "affiliate" SaaS plan.
 *
 * Safqa  → REAL integration via the OFFICIAL PUBLIC API (api-safka-key header).
 *          Fetches the paginated orders list and aggregates the metrics ourselves
 *          (Total Revenue / Orders / Confirmed Rate / Delivered Rate). The private
 *          cookie-authenticated dashboard stats route is intentionally NOT used.
 * Taager → REAL integration. Paginated orders endpoint (Authorization: Bearer),
 *          aggregated the same way as Safqa; orderProfit is summed as commission.
 *
 * MULTI-TENANT: each business configures THREE values per network from the
 * dashboard UI — API URL, Merchant ID, and API Token. Everything is read from
 * the tenant-scoped `settings` table (business_id bound). No global env URLs —
 * nothing is hard-coded here, and no token is ever returned to the client by
 * this module.
 */

const axios = require('axios');
const pool  = require('../config/db');

/* ── Per-network settings keys (3 per network) ───────────────────────────────
   Stored in the generic `settings` table, scoped by business_id.              */
const NETWORK_KEYS = {
  taager: {
    url:      'taager_api_url',
    merchant: 'taager_merchant_id',
    token:    'taager_api_token',
  },
  safqa: {
    url:      'safqa_api_url',
    merchant: 'safqa_merchant_id',
    token:    'safqa_api_token',
  },
};

/* Flat list of every affiliate settings key (used by reads/deletes). */
const AFFILIATE_KEYS = Object.values(NETWORK_KEYS)
  .flatMap((n) => [n.url, n.merchant, n.token]);

const HTTP_TIMEOUT_MS = 10_000;

/* ── Small numeric coercer ───────────────────────────────────────────────── */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Empty/disconnected stat shape — single source of truth for the contract.
 *  Carries the full 20-metric affiliate-dashboard contract so a disconnected
 *  network still renders a clean zeroed grid. */
function emptyStat(connected = false) {
  return {
    connected,
    revenue:       0,
    orders:        0,
    confirmed:     0,
    delivered:     0,
    confirmedRate: 0,   // %
    deliveredRate: 0,   // %
    returned:      0,
    commission:    0,
    ndr:           0,
    /* ── 20-metric affiliate dashboard contract ─────────────────────────── */
    profit:               0,   // Σ total of ALL orders
    profitConfirmed:      0,   // Σ total of confirmed (incl. delivered) orders
    profitDelivered:      0,   // Σ total of delivered orders
    inProgressOrders:     0,   // confirmed − delivered − returned
    pending:              0,   // status_class = 'pending'
    onHold:               0,   // raw status = 'holding'
    profitInProgress:     0,   // Σ total of confirmed-not-delivered orders
    cr:                   0,   // confirmation rate %
    dr:                   0,   // delivery rate %
    futureBalance:        0,   // F.B = profitInProgress × DR
    avgProfit:            0,   // profitDelivered ÷ delivered
    maxCpp:               0,   // avgProfit × DR
    ads:                  0,   // total Meta ad spend
    cpp:                  0,   // ads ÷ orders
    netProfit:            0,   // profitDelivered − ads
    forecastedNetProfit:  0,   // netProfit + F.B
  };
}

/**
 * Load the full affiliate config (url + merchantId + token per network) for one
 * tenant. Returns empty strings for anything unset.
 * Strictly scoped — the read is bound by WHERE business_id = $1.
 */
async function loadAffiliateCreds(businessId) {
  const blank = {
    taager: { url: '', merchant: '', token: '' },
    safqa:  { url: '', merchant: '', token: '' },
  };
  if (businessId == null) return blank;

  const { rows } = await pool.query(
    `SELECT key, value FROM settings
      WHERE key = ANY($1::text[]) AND business_id = $2::integer`,
    [AFFILIATE_KEYS, businessId]
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, (r.value || '').trim()]));

  const pick = (net) => ({
    url:      map[NETWORK_KEYS[net].url]      || '',
    merchant: map[NETWORK_KEYS[net].merchant] || '',
    token:    map[NETWORK_KEYS[net].token]    || '',
  });

  return { taager: pick('taager'), safqa: pick('safqa') };
}

/* ════════════════════════════════════════════════════════════════════════════
   SAFQA — WEBHOOK (PUSH) ARCHITECTURE
   ────────────────────────────────────────────────────────────────────────────
   Safqa's public API has NO GET orders/stats endpoint to pull from. It PUSHES
   real-time order updates to our `orderHook` URL (event "order.status.updated").
   We persist each pushed order per-tenant in `external_affiliate_orders` and the
   dashboard aggregates from THAT table — no outbound HTTP at read time.
   ════════════════════════════════════════════════════════════════════════════ */

/* Per-tenant store of Safqa-pushed orders. Idempotent migration (runs on require). */
pool.query(`
  CREATE TABLE IF NOT EXISTS external_affiliate_orders (
    id            SERIAL        PRIMARY KEY,
    network       VARCHAR(20)   NOT NULL DEFAULT 'safqa',
    external_id   VARCHAR(80)   NOT NULL,
    business_id   INTEGER       NOT NULL,
    status        VARCHAR(40),
    status_ar     VARCHAR(120),
    status_class  VARCHAR(20)   NOT NULL DEFAULT 'pending',
    total         NUMERIC(12,2) NOT NULL DEFAULT 0,
    marketer      VARCHAR(80),
    raw           JSONB,
    created_at    TIMESTAMPTZ   DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   DEFAULT NOW()
  )
`)
  /* Back-fill columns on tables created by EARLIER builds that predate them.
     CREATE TABLE IF NOT EXISTS never adds columns to an existing table, so a
     live `external_affiliate_orders` from before created_at/updated_at existed
     would be MISSING those columns. The date-range filter references
     created_at — without this ALTER the aggregation query throws, which
     getExternalAffiliateStats swallows → every metric silently reads 0.
     Existing rows get NOW() (the migration instant), so they stay visible in
     recent date ranges. */
  .then(() => pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`))
  .then(() => pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`))
  /* Product / logistics fields captured from BOTH the webhook payload and the CSV
     backfill, so the affiliate dashboard's lower widgets (products table, AI
     insights, governorates, rejection reasons, daily chart) can aggregate from
     this table the same way the e-commerce dashboard does off the orders table. */
  .then(() => pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS product_name TEXT`))
  .then(() => pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS sku          VARCHAR(120)`))
  .then(() => pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS governorate  VARCHAR(120)`))
  .then(() => pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS note         TEXT`))
  .then(() => pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS quantity     INTEGER DEFAULT 1`))
  .then(() => pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS external_affiliate_orders_uidx
      ON external_affiliate_orders (network, external_id, business_id)
  `))
  .then(() => console.log('✅  external_affiliate_orders table ready'))
  .catch((err) => console.warn('⚠️   external_affiliate_orders migration:', err.message));

/* Map Safqa's status → our class. delivered ⊂ confirmed (a delivered order was
   necessarily confirmed). Revenue is realised on delivered only.
     pending/skip                                  → pending
     preparing/printing/shipped/holding/ask_to_exchange → confirmed (in pipeline)
     available/collected                           → delivered (realised)
     returned1/2, ask_to_return, returned_exchange,
       declined1/2                                 → returned                     */
const SAFQA_STATUS_CLASS = {
  pending:           'pending',
  skip:              'pending',
  preparing:         'confirmed',
  printing:          'confirmed',
  shipped:           'confirmed',
  holding:           'confirmed',
  ask_to_exchange:   'confirmed',
  available:         'delivered',
  collected:         'delivered',
  returned1:         'returned',
  returned2:         'returned',
  ask_to_return:     'returned',
  returned_exchange: 'returned',
  declined1:         'returned',
  declined2:         'returned',
};
function classifySafqaStatus(status) {
  return SAFQA_STATUS_CLASS[String(status || '').trim().toLowerCase()] || 'pending';
}

/* ── Primary ("hero/hook") product attribution ──────────────────────────────
   Safqa concatenates multi-item orders — SKUs as "A, B" and product names as
   "(1) Product A -- (1) Product B" — yet bills ONE commission per ORDER (no
   per-item split). Splitting an order across items would force us to invent a
   commission allocation AND double-count order counts/revenue, breaking the
   invariant that Σ per-product revenue == Σ order revenue (== the top KPI). So
   we attribute the WHOLE order to its FIRST item (the product the ad targeted).
   The full original strings stay in `raw` for any future upsell analysis. */
function primarySku(s) {
  if (s == null) return null;
  const first = String(s).split(',')[0].trim();          // SKUs are comma-separated
  return first || null;
}
function primaryProductName(s) {
  if (s == null) return null;
  /* Item separator is "--" / "—" (NOT a single hyphen, so "IPL-PRO-01" survives). */
  let first = String(s).split(/\s*(?:--+|—)\s*/)[0];
  first = first.replace(/^\s*\(\s*\d+\s*\)\s*/, '').trim();   // strip a leading "(n) " qty prefix
  return first || null;
}

/**
 * Upsert ONE Safqa order (from an `order.status.updated` webhook) for a tenant.
 * Idempotent on (network, external_id, business_id) — status updates overwrite.
 * Returns { ok, inserted?, externalId?, statusClass?, reason? }.
 */
async function recordSafqaOrder(order, businessId) {
  const externalId = String(order?._id ?? order?.id ?? '').trim();
  if (!externalId) return { ok: false, reason: 'missing order _id' };
  if (businessId == null) return { ok: false, reason: 'missing tenant' };

  const status      = String(order?.status ?? '').trim().toLowerCase();
  const statusAr    = order?.status_ar != null ? String(order.status_ar) : null;
  const statusClass = classifySafqaStatus(status);
  const total       = num(order?.total);
  const marketer    = order?.marketer != null ? String(order.marketer) : null;
  /* Product / logistics fields — tolerant of the various keys Safqa (webhook) and
     the CSV backfill use. Feed the affiliate dashboard's lower widgets. */
  const pick = (...keys) => {
    for (const k of keys) {
      const v = order?.[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  };
  /* PRIMARY product attribution: reduce concatenated multi-item strings to their
     first ("hero") item so the products table has one clean row per base product
     and per-product revenue still sums to the order total. raw keeps the full strings. */
  const productName = primaryProductName(pick('product_name', 'products', 'product', 'productName'));
  const sku         = primarySku(pick('sku', 'SKU'));
  const governorate = pick('governorate', 'city', 'province', 'state');
  const note        = pick('note', 'rejection_reason', 'rejectionReason', 'notes');
  const qtyRaw      = order?.quantity ?? order?.qty ?? order?.Qty;
  const quantity    = Number.isFinite(parseInt(qtyRaw, 10)) ? parseInt(qtyRaw, 10) : null;

  const { rows } = await pool.query(
    `INSERT INTO external_affiliate_orders
       (network, external_id, business_id, status, status_ar, status_class, total, marketer,
        product_name, sku, governorate, note, quantity, raw, updated_at)
     VALUES ('safqa', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW())
     ON CONFLICT (network, external_id, business_id)
     DO UPDATE SET status       = EXCLUDED.status,
                   status_ar    = EXCLUDED.status_ar,
                   status_class = EXCLUDED.status_class,
                   total        = EXCLUDED.total,
                   marketer     = COALESCE(EXCLUDED.marketer,     external_affiliate_orders.marketer),
                   product_name = COALESCE(EXCLUDED.product_name, external_affiliate_orders.product_name),
                   sku          = COALESCE(EXCLUDED.sku,          external_affiliate_orders.sku),
                   governorate  = COALESCE(EXCLUDED.governorate,  external_affiliate_orders.governorate),
                   note         = COALESCE(EXCLUDED.note,         external_affiliate_orders.note),
                   quantity     = COALESCE(EXCLUDED.quantity,     external_affiliate_orders.quantity),
                   raw          = EXCLUDED.raw,
                   updated_at   = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [externalId, businessId, status, statusAr, statusClass, total, marketer,
     productName, sku, governorate, note, quantity, JSON.stringify(order ?? {})]
  );
  return { ok: true, inserted: rows[0]?.inserted === true, externalId, statusClass };
}

/**
 * Aggregate the tenant's webhook-ingested Safqa orders into our dashboard stat
 * shape. STRICT ISOLATION: reads ONLY external_affiliate_orders for this tenant
 * (network='safqa') — zero mixing with ad accounts, Meta spend, or pixels. Every
 * metric (Total Orders, Confirmed, Delivered, Rejected, Commission, NDR) is a
 * pure mirror of the Safqa rows. `connected` is true when Safqa is configured OR
 * any order has ever been pushed.
 *
 * Commission/Profits = Σ Safqa `total` of DELIVERED orders (Safqa sends the
 * marketer's earnings inside `total`; there is NO separate commission field).
 */
async function aggregateSafqaFromDb(businessId, connected = false, opts = {}) {
  if (businessId == null) return emptyStat(false);

  /* Optional date-range filter (global Date Picker). Only accept strict
     YYYY-MM-DD; anything else → null (skips that bound). Both the Safqa orders
     (created_at) AND the Meta ad spend (expense_date) honour the same window so
     ADS/CPP/Net react to the selected range exactly like the rest of the page. */
  const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
  const startDate = DATE_RE.test(String(opts.startDate || '')) ? opts.startDate : null;
  const endDate   = DATE_RE.test(String(opts.endDate   || '')) ? opts.endDate   : null;
  /* Global Product Filter — the dropdown passes the product_name; we match it
     against product_name OR sku. NULL = all products. */
  const product   = (opts.product && opts.product !== 'كل المنتجات') ? String(opts.product).trim() : null;
  /* Reusable product predicate; $n is the product param position in each call. */
  const prodPred  = (n) => ` AND ($${n}::text IS NULL OR product_name = $${n} OR UPPER(TRIM(COALESCE(sku,''))) = UPPER(TRIM($${n})))`;

  /* Two tenant-scoped reads:
       1) the pure Safqa-order buckets (counts + revenue by status_class)
       2) total Meta ad spend (expenses.meta_sync = TRUE) — drives ADS/CPP/Net.
     Safqa pushes the marketer's earnings inside `total`, so every "profit" here
     is a sum of `total` over the relevant status bucket (no separate field). */
  const ORDER_AGG_SELECT = `
    SELECT
      COUNT(*)::int                                            AS total,
      COUNT(*) FILTER (WHERE status_class = 'delivered')::int  AS delivered,
      COUNT(*) FILTER (WHERE status_class = 'confirmed')::int  AS confirmed_only,
      COUNT(*) FILTER (WHERE status_class = 'returned')::int   AS returned,
      COUNT(*) FILTER (WHERE status_class = 'pending')::int    AS pending,
      COUNT(*) FILTER (WHERE LOWER(status) = 'holding')::int   AS on_hold,
      COALESCE(SUM(total), 0)                                                          AS revenue_all,
      COALESCE(SUM(total) FILTER (WHERE status_class IN ('confirmed','delivered')), 0) AS revenue_confirmed,
      COALESCE(SUM(total) FILTER (WHERE status_class = 'delivered'), 0)                AS revenue_delivered
    FROM external_affiliate_orders
    WHERE business_id = $1 AND network = 'safqa'`;

  /* The order-bucket read is the single most likely silent failure point (e.g. a
     live external_affiliate_orders table created BEFORE the created_at column
     existed → the date predicate throws). Run it explicitly so we can LOG the
     full error AND degrade gracefully to an UNFILTERED read, so the grid shows
     the tenant's real orders instead of a misleading 0. */
  let aggRes;
  try {
    aggRes = await pool.query(
      `${ORDER_AGG_SELECT}
         AND ($2::date IS NULL OR COALESCE(created_at, updated_at)::date >= $2::date)
         AND ($3::date IS NULL OR COALESCE(created_at, updated_at)::date <= $3::date)
         ${prodPred(4)}`,
      [businessId, startDate, endDate, product]
    );
  } catch (err) {
    console.error(
      `[aggregateSafqaFromDb] ❌ date-filtered order query FAILED for business ${businessId} ` +
      `(range ${startDate || '—'}..${endDate || '—'}). This is the swallowed error that ` +
      `zeroes the grid. Most likely the created_at column is missing — restart the backend ` +
      `to run the boot migration. Falling back to an UNFILTERED read so data still renders.\n`,
      err
    );
    /* Fallback: drop the date bounds but KEEP the product filter ($2 here). */
    aggRes = await pool.query(`${ORDER_AGG_SELECT}${prodPred(2)}`, [businessId, product]);
  }

  /* Ad spend is non-fatal: degrade ADS to 0 on any error, but LOG it (no longer
     silent). When a product is selected, narrow spend to THAT product's SKUs
     (resolved from the Safqa orders) so CPP / NET PROFIT match the filtered
     orders; a product with no SKU → no attributable ad spend (0). */
  const adsRes = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS ad_spend
       FROM expenses
      WHERE business_id = $1::integer AND meta_sync = TRUE
        AND ($2::date IS NULL OR expense_date >= $2::date)
        AND ($3::date IS NULL OR expense_date <= $3::date)
        AND ($4::text IS NULL OR UPPER(TRIM(COALESCE(sku,''))) IN (
              SELECT UPPER(TRIM(COALESCE(o.sku,'')))
                FROM external_affiliate_orders o
               WHERE o.business_id = $1::integer AND o.network = 'safqa'
                 AND COALESCE(o.sku,'') <> ''
                 AND (o.product_name = $4 OR UPPER(TRIM(COALESCE(o.sku,''))) = UPPER(TRIM($4)))
            ))`,
    [businessId, startDate, endDate, product]
  ).catch((err) => {
    console.error(`[aggregateSafqaFromDb] ⚠️  ad-spend query failed for business ${businessId} (ADS→0):`, err.message);
    return { rows: [{ ad_spend: 0 }] };
  });

  const r = aggRes.rows[0] || {};

  /* Lightweight diagnostic (gate off with SAFQA_DEBUG=false): confirms whether
     rows actually matched for this tenant + range, so a "0" can be traced to
     either no data (check the webhook URL's businessId) or a date exclusion. */
  if (process.env.SAFQA_DEBUG !== 'false') {
    console.log(
      `[aggregateSafqaFromDb] business ${businessId} | range ${startDate || 'all'}..${endDate || 'all'} ` +
      `→ ${num(r.total)} order(s) matched, revenue_all=${num(r.revenue_all)}`
    );
  }
  const r0 = (x) => Math.round(num(x));
  const r1 = (x) => Math.round(num(x) * 10) / 10;
  const r2 = (x) => Math.round(num(x) * 100) / 100;

  /* ── Raw buckets ─────────────────────────────────────────────────────── */
  const orders        = num(r.total);
  const delivered     = num(r.delivered);
  const returned      = num(r.returned);                 // returned AFTER shipping
  const confirmedOnly = num(r.confirmed_only);
  const pending       = num(r.pending);
  const onHold        = num(r.on_hold);                  // raw status = 'holding'
  const confirmed     = delivered + confirmedOnly;       // delivered is a subset of confirmed

  /* ── Profits (Σ Safqa `total`) ───────────────────────────────────────── */
  const profit          = r0(r.revenue_all);                              // PROFIT
  const profitConfirmed = r0(r.revenue_confirmed);                        // PROFIT (CONFIRMED)
  const profitDelivered = r0(r.revenue_delivered);                        // PROFIT (DELIVERED)
  const profitInProgress = r0(num(r.revenue_confirmed) - num(r.revenue_delivered)); // confirmed − delivered

  /* ── Pipeline counts ─────────────────────────────────────────────────── */
  const inProgressOrders = Math.max(0, confirmed - delivered - returned); // ORDERS (IN PROGRESS)

  /* ── Rates ───────────────────────────────────────────────────────────── */
  const resolved = delivered + returned;                 // shipments with a final outcome
  const cr  = orders   > 0 ? r2((confirmed / orders) * 100)   : 0;        // CR
  const ndr = resolved > 0 ? r2((returned / resolved) * 100)  : 0;        // NDR (returns)
  const dr  = resolved > 0 ? r2((delivered / resolved) * 100) : 0;        // DR = 100 − NDR

  /* ── Derived money metrics (global DR; Safqa has no product-level data) ── */
  const futureBalance = r0(profitInProgress * (dr / 100));               // F.B (IN PROGRESS)
  const avgProfit     = delivered > 0 ? r2(profitDelivered / delivered) : 0; // AVG PROFIT
  const maxCpp        = r2(avgProfit * (dr / 100));                      // MAX CPP
  const ads           = r0(adsRes.rows[0]?.ad_spend);                    // ADS (Meta spend)
  const cpp           = orders > 0 ? r2(ads / orders) : 0;               // CPP
  const netProfit     = r0(profitDelivered - ads);                      // NET PROFIT
  const forecastedNetProfit = r0(netProfit + futureBalance);            // FORECASTED NET PROFIT

  return {
    connected:     Boolean(connected) || orders > 0,
    /* ── Legacy contract (kept for existing cards / aggregates) ─────────── */
    revenue:       profitDelivered,   // realised earnings = Σ total of delivered
    commission:    profitDelivered,
    orders,
    confirmed,
    delivered,
    returned,                          // "Rejected" / المرتجعات
    confirmedRate: cr,
    deliveredRate: orders > 0 ? r1((delivered / orders) * 100) : 0,
    ndr,
    /* ── 20-metric affiliate dashboard contract ────────────────────────── */
    profit,                            // ORDERS-wide profit
    profitConfirmed,
    profitDelivered,
    inProgressOrders,
    pending,
    onHold,
    profitInProgress,
    cr,
    dr,
    futureBalance,
    avgProfit,
    maxCpp,
    ads,
    cpp,
    netProfit,
    forecastedNetProfit,
  };
}

/**
 * Per-dimension breakdowns of the tenant's Safqa orders, in the SAME shapes the
 * e-commerce dashboard produces off the `orders` table — so the affiliate
 * dashboard's lower widgets (daily chart, governorates, rejection reasons,
 * products table → which also feeds AI Insights & Champions League) render with
 * real data. Respects the global date range AND the product filter.
 *
 * Returns { daily, governorates, rejections, products }.
 */
async function aggregateSafqaBreakdowns(businessId, opts = {}) {
  const empty = { daily: [], governorates: [], rejections: [], products: [] };
  if (businessId == null) return empty;

  const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
  const startDate = DATE_RE.test(String(opts.startDate || '')) ? opts.startDate : null;
  const endDate   = DATE_RE.test(String(opts.endDate   || '')) ? opts.endDate   : null;
  const product   = (opts.product && opts.product !== 'كل المنتجات') ? String(opts.product).trim() : null;

  /* $1 tenant · $2 start · $3 end · $4 product (NULL = all). created_at is the
     order-placement date (back-dated from the CSV / set by the webhook). */
  const params = [businessId, startDate, endDate, product];
  const where = `
    FROM external_affiliate_orders
    WHERE network = 'safqa' AND business_id = $1
      AND ($2::date IS NULL OR COALESCE(created_at, updated_at)::date >= $2::date)
      AND ($3::date IS NULL OR COALESCE(created_at, updated_at)::date <= $3::date)
      AND ($4::text IS NULL OR product_name = $4 OR UPPER(TRIM(COALESCE(sku,''))) = UPPER(TRIM($4)))`;

  const CONF = `status_class IN ('confirmed','delivered')`;
  const DELV = `status_class = 'delivered'`;
  const RET  = `status_class = 'returned'`;
  const REV  = `COALESCE(SUM(total) FILTER (WHERE ${DELV}), 0)`;

  try {
    const [dailyR, govR, rejR, prodR] = await Promise.all([
      pool.query(`
        SELECT TO_CHAR(COALESCE(created_at, updated_at)::date, 'YYYY-MM-DD') AS date,
               COUNT(*)::int                              AS orders,
               COUNT(*) FILTER (WHERE ${CONF})::int       AS confirmed,
               COUNT(*) FILTER (WHERE ${DELV})::int       AS delivered,
               ${REV}                                     AS revenue
        ${where}
        GROUP BY 1 ORDER BY 1 ASC`, params),
      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(governorate), ''), 'غير محدد') AS governorate,
               COUNT(*)::int                              AS total_orders,
               COUNT(*) FILTER (WHERE ${CONF})::int       AS confirmed,
               COUNT(*) FILTER (WHERE ${DELV})::int       AS delivered,
               COUNT(*) FILTER (WHERE ${RET})::int        AS returned,
               ${REV}                                     AS revenue
        ${where}
        GROUP BY 1 ORDER BY delivered DESC, total_orders DESC LIMIT 50`, params),
      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(note), ''), 'غير محدد')        AS reason,
               COUNT(*)::int                              AS count
        ${where} AND ${RET}
        GROUP BY 1 ORDER BY count DESC`, params),
      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(product_name), ''), 'غير محدد') AS product_name,
               MAX(COALESCE(NULLIF(TRIM(sku), ''), ''))   AS sku,
               COUNT(*)::int                              AS total_orders,
               COUNT(*) FILTER (WHERE ${CONF})::int       AS confirmed,
               COUNT(*) FILTER (WHERE ${DELV})::int       AS delivered,
               COUNT(*) FILTER (WHERE ${RET})::int        AS returned,
               ${REV}                                     AS delivered_revenue
        ${where}
        GROUP BY 1 ORDER BY delivered_revenue DESC`, params),
    ]);

    const daily = dailyR.rows.map((r) => ({
      date:       r.date,
      orders:     num(r.orders),
      erp_orders: num(r.orders),
      confirmed:  num(r.confirmed),
      delivered:  num(r.delivered),
      revenue:    Math.round(num(r.revenue)),
      ads_spend:  0,                        // affiliate ad spend is shown in the 20-grid (ADS), not per-day here
    }));

    const governorates = govR.rows.map((r) => ({
      governorate:  r.governorate,
      total_orders: num(r.total_orders),
      confirmed:    num(r.confirmed),
      delivered:    num(r.delivered),
      returned:     num(r.returned),
      revenue:      Math.round(num(r.revenue)),
    }));

    const rejections = rejR.rows.map((r) => ({ reason: r.reason, count: num(r.count) }));

    const products = prodR.rows.map((r) => {
      const delivered = num(r.delivered);
      const returned  = num(r.returned);
      const resolved  = delivered + returned;
      const revenue   = Math.round(num(r.delivered_revenue));   // commission realised on delivery
      return {
        product_id:          r.sku || r.product_name,
        product_name:        r.product_name,
        sku:                 r.sku || '',
        cost_price:          0,
        units_delivered:     delivered,
        units_shipped:       resolved,                                   // DR denominator (resolved shipments)
        delivery_rate:       resolved > 0 ? Math.round((delivered / resolved) * 1000) / 10 : 0,
        total_orders:        num(r.total_orders),
        confirmed_orders:    num(r.confirmed),
        erp_orders:          num(r.confirmed),
        delivered_revenue:   revenue,
        attributed_ad_spend: 0,             // affiliate: no per-product ad attribution (no local SKU bridge)
        cogs:                0,             // affiliate holds no stock
        shipping_cost:       0,
        opex_allocated:      0,
        net_profit:          revenue,       // affiliate profit = commission of delivered orders
        cpa:                 null,
        meta_orders:         0,
      };
    });

    return { daily, governorates, rejections, products };
  } catch (err) {
    console.error('[aggregateSafqaBreakdowns] failed for business', businessId, '—', err.message);
    return empty;
  }
}

/* ── Taager orders-aggregation ───────────────────────────────────────────────
   Taager exposes a clean, paginated orders endpoint:
     GET https://merchant.api.taager.com/api/orders   (Authorization: Bearer)
     params : page (1-indexed), pageSize
     payload: { count, orders: [ { orderId, status, orderProfit, … } ] }
   Statuses seen: delivered, cancelled, return_verified, customer_rejected.
   `orderProfit` is the exact merchant commission, so we sum it directly.       */
const TAAGER_DEFAULT_URL          = 'https://merchant.api.taager.com/api/orders';
const TAAGER_PRODUCTS_DEFAULT_URL = 'https://merchant.api.taager.com/api/products';
const TAAGER_PAGE_SIZE   = 100;
const TAAGER_MAX_PAGES   = 50;   // safety cap → up to 5,000 rows/tenant per refresh

/** Derive the products endpoint from the saved orders URL (…/orders → …/products),
 *  falling back to the documented default when nothing usable is configured. */
function taagerProductsUrl(ordersUrl) {
  const u = (ordersUrl || '').trim();
  if (u && /\/orders\b/i.test(u)) return u.replace(/\/orders\b/i, '/products');
  return TAAGER_PRODUCTS_DEFAULT_URL;
}

/**
 * Aggregate a flat list of Taager orders into our dashboard stat shape.
 *   Total Orders  = orders.length
 *   Delivered     = #orders whose status === 'delivered' (strict)
 *   Confirmed     = total − (cancelled + returned + rejected)  → everything not
 *                   explicitly bad counts as confirmed
 *   Total Revenue = Σ orderProfit of DELIVERED orders (realised commission)
 */
function aggregateTaagerOrders(orders) {
  const total = orders.length;
  let delivered = 0, bad = 0, revenue = 0;

  for (const o of orders) {
    const s = String(o.status ?? '').trim().toLowerCase();
    /* cancelled / return_verified / customer_rejected → not confirmed */
    const isBad = STATUS_RETURNED.some((kw) => s.includes(kw.toLowerCase()));
    if (s === 'delivered') {
      delivered += 1;
      revenue   += num(o.orderProfit);   // exact merchant commission, realised on delivery
    }
    if (isBad) bad += 1;
  }
  const confirmed = Math.max(0, total - bad);

  return {
    connected:     true,
    revenue:       Math.round(revenue),
    orders:        total,
    confirmed,
    delivered,
    confirmedRate: total > 0 ? Math.round((confirmed / total) * 1000) / 10 : 0,
    deliveredRate: total > 0 ? Math.round((delivered / total) * 1000) / 10 : 0,
  };
}

/**
 * REAL: fetch live stats for a Taager merchant via their paginated orders API.
 *
 * Params (per-tenant, configured from the dashboard UI):
 *   apiUrl     — orders endpoint; defaults to TAAGER_DEFAULT_URL when left blank
 *   merchantId — optional; sent as a query param if present
 *   apiToken   — the bearer token (Authorization: Bearer …) — REQUIRED to call
 *
 * `connected` is true once a token is configured. On any failure we keep
 * connected=true (card still renders) but degrade to zero and flag `error`.
 */
/**
 * Fetch RAW Taager orders (paginated) — the single source used by BOTH the
 * lightweight stats card (fetchTaagerStats) and the deep DB synchroniser
 * (services/taagerSync). Returns the flat array of order objects.
 * Throws on HTTP error so callers decide how to handle it.
 */
async function fetchTaagerOrders(apiUrl, merchantId, apiToken, { maxPages = TAAGER_MAX_PAGES } = {}) {
  if (!apiToken) return [];

  const baseUrl = (apiUrl || '').trim() || TAAGER_DEFAULT_URL;
  const headers = {
    Accept:        'application/json',
    Authorization: `Bearer ${apiToken}`,
  };

  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await axios.get(baseUrl, {
      timeout: HTTP_TIMEOUT_MS,
      headers,
      params: {
        page,
        pageSize: TAAGER_PAGE_SIZE,
        ...(merchantId ? { merchant_id: merchantId } : {}),
      },
    });

    /* Documented shape is { count, orders: [...] }; fall back to the generic
       envelope extractor just in case the wrapper ever changes. */
    const batch = Array.isArray(data?.orders) ? data.orders : extractOrdersArray(data);
    all.push(...batch);

    /* Stop on a short/empty page — no more data to fetch. */
    if (batch.length < TAAGER_PAGE_SIZE) break;
  }
  return all;
}

async function fetchTaagerStats(apiUrl, merchantId, apiToken) {
  /* Taager authenticates with the bearer token — without it we cannot call. */
  if (!apiToken) return emptyStat(false);

  try {
    const orders = await fetchTaagerOrders(apiUrl, merchantId, apiToken);
    return aggregateTaagerOrders(orders);
  } catch (err) {
    const status = err.response?.status;
    console.warn(
      `[externalAffiliate] Taager fetch failed (merchant ${merchantId || '—'}` +
      `${status ? `, HTTP ${status}` : ''}):`, err.message
    );
    return { ...emptyStat(true), error: true };
  }
}

/**
 * Fetch RAW Taager products catalog (paginated). Used by the deep synchroniser
 * (services/taagerSync) to backfill cost_price / selling_price / image_url onto
 * the product stubs. Endpoint is derived from the tenant's orders URL.
 * Returns the flat array of product objects. Throws on HTTP error.
 */
async function fetchTaagerProducts(apiUrl, merchantId, apiToken, { maxPages = TAAGER_MAX_PAGES } = {}) {
  if (!apiToken) return [];

  const baseUrl = taagerProductsUrl(apiUrl);
  const headers = {
    Accept:        'application/json',
    Authorization: `Bearer ${apiToken}`,
  };

  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await axios.get(baseUrl, {
      timeout: HTTP_TIMEOUT_MS,
      headers,
      params: {
        page,
        pageSize: TAAGER_PAGE_SIZE,
        ...(merchantId ? { merchant_id: merchantId } : {}),
      },
    });

    /* Likely shape { count, products: [...] }; fall back through common wrappers. */
    const batch = Array.isArray(data?.products) ? data.products
      : Array.isArray(data?.data) ? data.data
      : Array.isArray(data) ? data
      : extractOrdersArray(data);
    all.push(...batch);

    if (batch.length < TAAGER_PAGE_SIZE) break;
  }
  return all;
}

/* ── Safqa orders-aggregation tuning knobs ───────────────────────────────────
   Safqa's PUBLIC API exposes the orders list (authenticated with `api-safka-key`),
   NOT a pre-aggregated stats blob — the old `/dashboard/get_statistics` route is
   a PRIVATE, cookie-authenticated dashboard route and rightly rejects API tokens
   with 401. So we fetch the orders list and compute the metrics ourselves.

   The exact JSON field names / status strings below are best-effort candidates
   (Safqa is an Egyptian COD platform → Arabic statuses likely). After you see one
   real order object in the logs, trim these arrays to the exact keys — the logic
   never changes.                                                               */
const SAFQA_PAGE_SIZE = 100;   // orders requested per page
const SAFQA_MAX_PAGES = 50;    // safety cap → up to 5,000 orders/tenant per refresh

/* ── Safqa official public-API endpoint builder ──────────────────────────────
   Per Safqa's docs (https://public-api-docs.safka-eg.com/) ALL public endpoints
   live on the host `https://api.safka-eg.com` under the base path `api/v1/public/`,
   authenticated with the `api-safka-key` header. The orders/profits list is
   `api/v1/public/orders` (verified live: that path returns 401 "needs key", a
   bogus path also 401s — the gateway authenticates every route).

   Merchants paste this field inconsistently — a full URL, a bare host
   ("api.safka-eg.com"), a RELATIVE path ("/api/v1/public"), just a resource
   ("orders"), or nothing. This builder is bulletproof: it injects the official
   HOST whenever one is missing, forces the `api/v1/public/` base, defaults the
   resource to `orders`, and preserves an explicit host/resource/query when the
   merchant supplied a complete URL. */
const SAFQA_API_HOST     = 'https://api.safka-eg.com';   // official public-API host
const SAFQA_PUBLIC_BASE  = 'api/v1/public';
const SAFQA_DEFAULT_RES  = 'orders';
function withSafqaPublicBase(rawUrl) {
  const raw = (rawUrl || '').trim();

  let origin = SAFQA_API_HOST;   // default to the official host
  let path   = '';
  let search = '';

  if (raw) {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);          // http(s)://…
    const bareHost  = !hasScheme && /^[^/?#]+\.[^/?#]+/.test(raw);   // dot before first / ? #
    if (hasScheme || bareHost) {
      try {
        const u = new URL(hasScheme ? raw : `https://${raw}`);
        origin = u.origin; path = u.pathname; search = u.search;
      } catch { origin = SAFQA_API_HOST; }     // unparseable → official host + default path
    } else {
      // Relative path ("/api/v1/public") or a bare resource ("orders") → keep the
      // official host, use whatever path/query the merchant typed.
      const q = raw.indexOf('?');
      path   = q >= 0 ? raw.slice(0, q) : raw;
      search = q >= 0 ? raw.slice(q)    : '';
    }
  }

  path = path.replace(/^\/+|\/+$/g, '');                              // strip surrounding slashes
  const underBase = new RegExp(`^${SAFQA_PUBLIC_BASE}(/|$)`, 'i').test(path);
  if (!underBase) {
    path = `${SAFQA_PUBLIC_BASE}/${path || SAFQA_DEFAULT_RES}`;       // inject base (+ default resource)
  } else if (path.toLowerCase() === SAFQA_PUBLIC_BASE) {
    path = `${SAFQA_PUBLIC_BASE}/${SAFQA_DEFAULT_RES}`;               // base given but NO resource → add it
  }
  return `${origin}/${path}${search}`;
}

/* Where the array of orders may live in the response body. */
const ORDERS_ARRAY_KEYS = ['data', 'orders', 'results', 'items', 'rows', 'list'];
/* Per-order monetary field candidates (first numeric match wins). */
const ORDER_REVENUE_KEYS = ['total', 'totalPrice', 'total_price', 'order_total', 'grandTotal', 'amount', 'price', 'cod', 'value'];
/* Per-order status field candidates. */
const ORDER_STATUS_KEYS  = ['status', 'orderStatus', 'order_status', 'state', 'shipping_status'];
/* Substring keywords (lowercased) used to CLASSIFY an order's status.
   delivered ⊂ confirmed (a delivered order was necessarily confirmed). */
const STATUS_DELIVERED = ['deliver', 'تم التوصيل', 'تم التسليم', 'توصيل', 'تسليم', 'collected', 'done', 'تم الاستلام'];
const STATUS_RETURNED  = ['return', 'مرتجع', 'إرجاع', 'ارجاع', 'reject', 'مرفوض', 'cancel', 'ملغ', 'فشل'];
const STATUS_CONFIRMED = ['confirm', 'تأكيد', 'مؤكد', 'shipped', 'تم الشحن', 'شحن', 'process', 'قيد', 'out for'];

/** Pull the orders array out of whatever envelope the API used. */
function extractOrdersArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const k of ORDERS_ARRAY_KEYS) {
    if (Array.isArray(payload[k])) return payload[k];
    /* one level of nesting, e.g. { data: { orders: [...] } } */
    if (payload[k] && typeof payload[k] === 'object') {
      for (const k2 of ORDERS_ARRAY_KEYS) {
        if (Array.isArray(payload[k][k2])) return payload[k][k2];
      }
    }
  }
  return [];
}

/** Detect the last page number from common pagination meta shapes (else null). */
function extractLastPage(payload) {
  const sources = [payload, payload?.meta, payload?.pagination, payload?.data];
  const keys = ['last_page', 'lastPage', 'total_pages', 'totalPages', 'pages', 'pageCount'];
  for (const src of sources) {
    if (src && typeof src === 'object') {
      for (const k of keys) {
        const v = num(src[k]);
        if (v > 0) return v;
      }
    }
  }
  return null;
}

/** First numeric monetary field on an order, else 0. */
function orderRevenue(order) {
  for (const k of ORDER_REVENUE_KEYS) {
    if (order[k] != null && order[k] !== '') {
      const v = Number(String(order[k]).replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(v)) return v;
    }
  }
  return 0;
}

/** Classify one order → 'delivered' | 'returned' | 'confirmed' | 'pending'. */
function classifyOrder(order) {
  let raw = '';
  for (const k of ORDER_STATUS_KEYS) {
    if (order[k] != null) { raw = String(order[k]); break; }
  }
  const s = raw.toLowerCase();
  const hit = (arr) => arr.some((kw) => s.includes(kw.toLowerCase()));
  if (hit(STATUS_DELIVERED)) return 'delivered';
  if (hit(STATUS_RETURNED))  return 'returned';
  if (hit(STATUS_CONFIRMED)) return 'confirmed';
  return 'pending';
}

/**
 * Aggregate a flat list of orders into our dashboard stat shape.
 *   Total Orders   = orders.length
 *   Delivered      = #delivered
 *   Confirmed      = #delivered + #confirmed  (delivered implies confirmed)
 *   Total Revenue  = Σ revenue of DELIVERED orders (realised revenue)
 *   confirmedRate  = confirmed / total × 100
 *   deliveredRate  = delivered / total × 100
 */
function aggregateOrders(orders) {
  const total = orders.length;
  let delivered = 0, confirmedOnly = 0, revenue = 0;

  for (const o of orders) {
    const cls = classifyOrder(o);
    if (cls === 'delivered') {
      delivered += 1;
      revenue   += orderRevenue(o);   // realised revenue = delivered orders
    } else if (cls === 'confirmed') {
      confirmedOnly += 1;
    }
  }
  const confirmed = delivered + confirmedOnly;

  return {
    connected:     true,
    revenue:       Math.round(revenue),
    orders:        total,
    confirmed,
    delivered,
    confirmedRate: total > 0 ? Math.round((confirmed / total) * 1000) / 10 : 0,
    deliveredRate: total > 0 ? Math.round((delivered / total) * 1000) / 10 : 0,
  };
}

/** Parse a pre-aggregated stats blob (kept for backward-compat / stats URLs). */
function parseSafqaStatsBlob(p) {
  const orders       = num(p.totalOrders);
  const doneRequests = num(p.totalDoneRequests);
  const deliveredRatio = orders > 0 ? doneRequests / orders : 0;
  const confirmedRatio = num(p.percent) / 100;
  return {
    connected:     true,
    revenue:       num(p.totalIncome),
    orders,
    confirmed:     Math.round(orders * confirmedRatio),
    delivered:     Math.round(orders * deliveredRatio),
    confirmedRate: Math.round(confirmedRatio * 1000) / 10,
    deliveredRate: Math.round(deliveredRatio * 1000) / 10,
  };
}

/**
 * REAL: fetch live stats for a Safqa merchant via the OFFICIAL PUBLIC API.
 *
 * Strategy (see the architectural note above):
 *   • Auth is STRICTLY the `api-safka-key` header — no Bearer, no cookies. This
 *     is what the public API documents; the private dashboard stats route (which
 *     needs a session cookie) is intentionally NOT used.
 *   • If the configured URL is a `…/statistics` endpoint we parse its aggregate
 *     blob directly (parseSafqastatsBlob).
 *   • Otherwise the URL is treated as the ORDERS-LIST endpoint: we paginate
 *     through it (api-safka-key) and compute the metrics ourselves.
 *
 * Params (all per-tenant, configured from the dashboard UI — NO global env):
 *   apiUrl     — the orders-list endpoint (preferred) or a stats endpoint
 *   merchantId — optional Safqa merchant id (sent as a query param if present)
 *   apiToken   — the public API key, sent as `api-safka-key`
 *
 * `connected` reflects that the network is configured (merchant id OR token set).
 * On a missing URL or any failure we keep connected=true (card still renders) but
 * degrade numbers to zero and flag `error` — the dashboard never breaks.
 */
async function fetchSafqaStats(apiUrl, merchantId, apiToken) {
  /* Configured when we have at least an identifier or a token. */
  if (!merchantId && !apiToken) return emptyStat(false);

  /* Force the official `api/v1/public/` base onto whatever the merchant saved. */
  const baseUrl = withSafqaPublicBase(apiUrl);
  if (!baseUrl) {
    console.warn('[externalAffiliate] Safqa URL not configured for this tenant — skipping live fetch.');
    return { ...emptyStat(true), error: true };
  }

  /* Official public-API auth: api-safka-key header ONLY (no Bearer, no cookies). */
  const headers = { Accept: 'application/json' };
  if (apiToken) headers['api-safka-key'] = apiToken;

  try {
    /* ── Mode A: explicit stats endpoint → parse the aggregate blob ───────── */
    if (/statistic|stats/i.test(baseUrl)) {
      const { data } = await axios.get(baseUrl, {
        timeout: HTTP_TIMEOUT_MS,
        headers,
        params: merchantId ? { merchant_id: merchantId } : undefined,
      });
      const p = (data && typeof data === 'object' && data.data && typeof data.data === 'object')
        ? data.data : (data || {});
      return parseSafqaStatsBlob(p);
    }

    /* ── Mode B: orders-list endpoint → fetch all pages, then aggregate ───── */
    const all = [];
    let lastPage = null;
    for (let page = 1; page <= SAFQA_MAX_PAGES; page++) {
      const { data } = await axios.get(baseUrl, {
        timeout: HTTP_TIMEOUT_MS,
        headers,
        params: {
          page,
          limit:    SAFQA_PAGE_SIZE,   // send a few aliases; unknown ones are ignored
          per_page: SAFQA_PAGE_SIZE,
          ...(merchantId ? { merchant_id: merchantId } : {}),
        },
      });

      const batch = extractOrdersArray(data);
      all.push(...batch);

      /* ── ONE-SHOT DEBUG: dump the first real order object so we can map their
         exact JSON keys (status, commission/income, totals…) to our candidate
         arrays above. Fires on the first page only; set SAFQA_DEBUG=false in the
         backend env to silence once the mapping is finalised. ───────────────── */
      if (page === 1 && process.env.SAFQA_DEBUG !== 'false') {
        if (batch.length > 0) {
          console.log(
            '🔎 [Safqa DEBUG] First order object (map these keys, then trim the ' +
            'candidate arrays in externalAffiliate.js):\n' +
            JSON.stringify(batch[0], null, 2)
          );
        } else {
          /* No order rows found under the keys we tried — log the envelope so we
             can see where the array actually lives / whether auth really worked. */
          console.log(
            '🔎 [Safqa DEBUG] No orders array found under known keys. Raw response ' +
            'envelope (top-level keys help locate the list):\n' +
            JSON.stringify(data, null, 2).slice(0, 2000)
          );
        }
      }

      if (lastPage === null) lastPage = extractLastPage(data);

      /* Stop when we know we've hit the last page, or the API returned a short/
         empty page (no more data), whichever comes first. */
      if (lastPage !== null) { if (page >= lastPage) break; }
      else if (batch.length < SAFQA_PAGE_SIZE) break;
    }

    return aggregateOrders(all);
  } catch (err) {
    const status = err.response?.status;
    console.warn(
      `[externalAffiliate] Safqa fetch failed (merchant ${merchantId || '—'}` +
      `${status ? `, HTTP ${status}` : ''}):`, err.message
    );
    return { ...emptyStat(true), error: true };
  }
}

/**
 * Public entry point used by the analytics dashboard.
 * Resolves the tenant's saved config, then returns aggregated external stats.
 *
 * Shape:
 *   {
 *     enabled, taagerRevenue, safqaRevenue, totalRevenue, totalOrders,
 *     taager: { connected, revenue, orders, confirmed, delivered, confirmedRate, deliveredRate, error? },
 *     safqa:  { ...same... },
 *   }
 *
 * Always resolves (never throws) so a flaky external network can't break the
 * core dashboard — failures degrade to zeros.
 */
async function getExternalAffiliateStats(businessId, opts = {}) {
  const empty = {
    enabled:       false,
    taagerRevenue: 0,
    safqaRevenue:  0,
    totalRevenue:  0,
    totalOrders:   0,
    taager:        emptyStat(false),
    safqa:         emptyStat(false),
  };

  try {
    const creds = await loadAffiliateCreds(businessId);
    /* Safqa is WEBHOOK-driven: aggregate from the orders it has PUSHED to us
       (external_affiliate_orders), NOT an outbound GET (Safqa has no such API).
       The Safqa grid honours the global Date Picker (opts.startDate/endDate);
       Taager's lightweight stats remain all-time (its own paginated API). */
    const safqaConnected = Boolean(creds.safqa.token || creds.safqa.merchant);
    const [taager, safqa] = await Promise.all([
      fetchTaagerStats(creds.taager.url, creds.taager.merchant, creds.taager.token),
      aggregateSafqaFromDb(businessId, safqaConnected, opts),
    ]);

    return {
      enabled:       taager.connected || safqa.connected,
      taagerRevenue: taager.revenue,
      safqaRevenue:  safqa.revenue,
      totalRevenue:  taager.revenue + safqa.revenue,
      totalOrders:   taager.orders  + safqa.orders,
      taager,
      safqa,
    };
  } catch (err) {
    /* Log the FULL error (stack + SQL detail), not just .message — this catch
       previously hid the real cause behind an all-zero `empty` object. */
    console.error('[externalAffiliate] ❌ stats fetch failed — returning empty (all-zero) stats:', err);
    return empty;
  }
}

module.exports = {
  NETWORK_KEYS,
  AFFILIATE_KEYS,
  loadAffiliateCreds,
  getExternalAffiliateStats,
  fetchTaagerOrders,
  fetchTaagerProducts,
  // Safqa webhook (push) architecture:
  recordSafqaOrder,
  aggregateSafqaFromDb,
  aggregateSafqaBreakdowns,
  classifySafqaStatus,
  primarySku,
  primaryProductName,
  // Legacy (Safqa has no GET API — kept only for reference, no longer called):
  fetchSafqaStats,
  withSafqaPublicBase,
};
