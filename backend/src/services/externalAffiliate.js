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
  /* Customer phone — written by the EasyOrder creation webhook (double-webhook
     strategy) so the later Safqa status webhook (which has only phone + status,
     no marketer/sku) can MATCH the existing rich row by phone and update its
     status. Stored NORMALISED (digits-only, last 11) for reliable cross-source
     matching. NULL on legacy/CSV rows. */
  .then(() => pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS client_phone VARCHAR(50)`))
  /* calc_commission — the EXACT net commission computed at EasyOrder creation from
     the order's real costs (selling − base). It is HELD here (not in `total`) so an
     unsynced ghost never enters the financials; the Safqa-touch paths promote it
     into `total` the moment Safqa accepts the order. Default 0 = "not computed". */
  .then(() => pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS calc_commission NUMERIC(12,2) DEFAULT 0`))
  .then(() => pool.query(`
    CREATE INDEX IF NOT EXISTS external_affiliate_orders_phone_idx
      ON external_affiliate_orders (business_id, client_phone)
  `))
  .then(() => pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS external_affiliate_orders_uidx
      ON external_affiliate_orders (network, external_id, business_id)
  `))
  /* Reclassify EXISTING declined ("ملغي" / cancelled) rows that were stored under
     the old mapping (declined → 'returned'). They are call-center cancellations,
     NOT courier returns, so they must move to the 'cancelled' class and OUT of
     CONFIRMED/returned/NDR. Idempotent (guarded by status_class <> 'cancelled'). */
  .then(() => pool.query(
    `UPDATE external_affiliate_orders
        SET status_class = 'cancelled'
      WHERE network = 'safqa'
        AND LOWER(TRIM(status)) IN ('declined1','declined2')
        AND status_class <> 'cancelled'`
  ).then((res) => { if (res.rowCount) console.log(`✅  external_affiliate_orders: reclassified ${res.rowCount} declined→cancelled row(s)`); }))
  .then(() => console.log('✅  external_affiliate_orders table ready'))
  .catch((err) => console.warn('⚠️   external_affiliate_orders migration:', err.message));

/* Map Safqa's status → our class. delivered ⊂ confirmed (a delivered order was
   necessarily confirmed). Revenue is realised on delivered only.
     pending/skip                                  → pending
     preparing/printing/shipped/holding/ask_to_exchange → confirmed (in pipeline)
     available/collected                           → delivered (realised)
     returned1/2, ask_to_return, returned_exchange → returned  (genuine COURIER
       returns — these PASSED call-center confirmation, then failed at delivery,
       so they count toward CONFIRMED/CR)
     declined1/2 ("ملغي" / cancelled)              → cancelled (FAILED the call
       center — NOT confirmed; must NOT inflate CR)                              */
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
  declined1:         'cancelled',   // call-center cancellation — NOT confirmed
  declined2:         'cancelled',
  /* ── Completeness: additional English variants Safqa / EasyOrder also emit.
     Missing keys silently fell through to 'pending', so a 'processing' order was
     EXCLUDED from the CONFIRMED (in-progress) profit bucket — a real undercount. */
  processing:        'confirmed',
  confirmed:         'confirmed',
  out_for_delivery:  'confirmed',
  delivered:         'delivered',
  completed:         'delivered',
  received:          'delivered',
  returned:          'returned',
  return:            'returned',
  cancelled:         'cancelled',
  canceled:          'cancelled',
  declined:          'cancelled',
  rejected:          'cancelled',
  /* ── Arabic statuses — the CSV import and some webhook payloads send Arabic
     directly (e.g. 'جار التحضير', 'في الشحن'). Without these they fell to 'pending'
     and dropped out of the in-progress aggregation. */
  'جار التحضير':     'confirmed',
  'قيد التحضير':     'confirmed',
  'قيد التجهيز':     'confirmed',
  'في الشحن':        'confirmed',
  'قيد الشحن':       'confirmed',
  'تم الشحن':        'confirmed',
  'خرج للتوصيل':     'confirmed',
  'تم التحصيل':      'delivered',
  'تم التوصيل':      'delivered',
  'تم التسليم':      'delivered',
  'مرتجع':           'returned',
  'جار الاسترجاع':   'returned',
  'مرفوض':           'cancelled',
  'ملغي':            'cancelled',
  'ملغى':            'cancelled',
  'معلق':            'pending',
  'قيد المعالجة':    'pending',
  'قيد المراجعة':    'pending',
};
function classifySafqaStatus(status) {
  return SAFQA_STATUS_CLASS[String(status || '').trim().toLowerCase()] || 'pending';
}

/* Canonical Arabic label per Safqa status — used ONLY as a FALLBACK when the
   payload carries no status_ar (e.g. EasyOrder-created rows, or a webhook that
   omits it). Safqa's own status_ar always takes precedence when present, so this
   never overwrites a real value — it only fills blanks so the dashboard (rejection
   chart, status display) never shows "غير محدد" for a known status. */
const SAFQA_STATUS_AR = {
  pending:           'قيد المراجعة',
  skip:              'قيد المراجعة',
  preparing:         'قيد التحضير',
  printing:          'قيد الطباعة',
  shipped:           'تم الشحن',
  holding:           'معلّق',
  ask_to_exchange:   'طلب استبدال',
  available:         'متاح للتوصيل',
  collected:         'تم التوصيل',
  returned1:         'مرتجع',
  returned2:         'مرتجع',
  ask_to_return:     'جاري الاسترجاع',
  returned_exchange: 'مرتجع استبدال',
  declined1:         'ملغي',
  declined2:         'ملغي',
};
/* Resolve the Arabic label: prefer the payload's, fall back to the status map. */
function resolveStatusAr(rawAr, status) {
  const ar = rawAr == null ? '' : String(rawAr).trim();
  if (ar !== '') return ar;
  return SAFQA_STATUS_AR[String(status || '').trim().toLowerCase()] || null;
}

/* Canonical marketer code. Safqa uses '-' (or blank) for organic / own-store
   orders → the MAIN ACCOUNT. Normalise those to 'main_account' so the dashboard's
   "الحساب الأساسي" filter (marketer = 'main_account') aggregates them correctly.
   Any real marketer code/UTM/Sub-ID passes through unchanged. */
const MAIN_ACCOUNT_MARKETER = 'main_account';

/* Marketer-identity aliases — map a known alternative code to a canonical
   referral slug at ingest. Keys are UPPERCASED+trimmed.
   NOTE: the former '69D90AB4…→adham' entry was REMOVED — that Safqa moderator
   hash is NOT Adham. Adham (and every media buyer) is attributed solely from the
   EasyOrder `utm_campaign` field (see resolveMarketerCode in utils/referral.js),
   never from a Safqa hash. Left empty intentionally; add entries only for a
   genuinely verified second identity. */
const MARKETER_ALIASES = {};
function normalizeMarketer(raw) {
  const m = (raw == null ? '' : String(raw)).trim();
  if (m === '' || m === '-') return MAIN_ACCOUNT_MARKETER;
  return MARKETER_ALIASES[m.toUpperCase()] || m;
}

/* ════════════════════════════════════════════════════════════════════════════
   SKU-BASED AUTO-COMMISSION  —  ends the manual Safqa-CSV dependency.
   ────────────────────────────────────────────────────────────────────────────
   The Safqa webhook only sends GROSS COD, never the net affiliate commission, so
   commission used to come from a manually-uploaded CSV (العمولة). Instead we keep
   the FIXED per-product commission here and compute it automatically on every
   Safqa webhook: commission = COMMISSION_RATES[sku] × quantity.

   Keys are UPPER-CASED. Both the Safqa product code AND the EasyOrder slug map to
   the same rate (an order can arrive under either). Rates below the divider are
   user-confirmed; the rest are derived from the historical median commission/unit
   and SHOULD be verified against Safqa, then corrected here if needed.

   ⚠️ NOTE ON ACCURACY: real Safqa commission has some per-order spread (multi-unit,
   promos, variants), so a fixed rate is ~98% accurate, not cent-perfect. Existing
   orders KEEP their realized commission (see the COALESCE(NULLIF(existing,0),…)
   guards) — auto-commission only FILLS orders that have none yet, so historical
   figures stay exact while new orders no longer need a CSV. */
const COMMISSION_RATES = {
  /* ── User-confirmed fixed rates ─────────────────────────────────────────── */
  QSMEFF3: 273, BWTJZ:       273,   // بوتجاز / Stove
  OAOPRJR: 300, 'HZM-LTDFY': 300,   // حزام التدفئة / Heating belt
  YQASPQV: 266, 'FRSH-LTNZYF': 266, // فرشة التنظيف / Cleaning brush
  /* ── Derived from historical median commission/unit — VERIFY with Safqa ──── */
  EAADYOP: 490,   // سماعة miniso x33 / Headset
  B3MVO7Q: 440,   // كاميرا 1080p / Camera
  NUEXTPK: 199,   // جهاز التنظيف بالبخار / Steam cleaner
  BWKB7SE: 200,   // قطاعة سليزر / Slicer
};
/* Net commission for an order: rate(primary SKU) × quantity. Returns 0 when the
   SKU is unknown (so we NEVER fall back to writing the gross COD). */
function commissionFor(sku, quantity) {
  const code = String(sku == null ? '' : sku).split(',')[0].trim().toUpperCase();
  const rate = COMMISSION_RATES[code];
  if (!rate) return 0;
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  return rate * qty;
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

/* Normalise a phone to a stable cross-source matching key: digits only, last 11.
   This makes "+201001234567", "201001234567" and "01001234567" all collapse to
   "01001234567", so the EasyOrder-created row and the Safqa status webhook match. */
function normalizePhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 11 ? digits.slice(-11) : digits;
}

/**
 * Upsert ONE Safqa order (from an `order.status.updated` webhook) for a tenant.
 * Idempotent on (network, external_id, business_id) — status updates overwrite.
 * Returns { ok, inserted?, externalId?, statusClass?, reason? }.
 */
async function recordSafqaOrder(order, businessId, opts = {}) {
  /* FORENSICS: structured columns (marketer/sku/…) are still parsed from the
     `order` sub-object, but `raw` stores the FULL webhook envelope when the caller
     passes opts.fullBody — so any envelope-level tracking Safqa sends (sub-id, UTM,
     query params, metadata) is captured verbatim instead of being discarded.
     Falls back to `order` for callers that have no envelope (e.g. the CSV import). */
  const rawToStore = (opts.fullBody !== undefined && opts.fullBody !== null) ? opts.fullBody : order;
  /* STABLE external key — duplicate-proofing for live traffic:
     Safqa's `serial_number` ("sk-…") is the SAME order code the CSV export uses
     ("كود الطلب"), whereas the webhook's `_id` is a Mongo ObjectId. Keying on the
     serial makes every webhook status push (pending→confirmed→delivered…) UPSERT
     onto the one existing row instead of inserting an ObjectId-keyed duplicate.
     Falls back to _id/id when no serial is present. */
  const externalId = String(
    order?.serial_number ?? order?.serialNumber ?? order?.serial ?? order?._id ?? order?.id ?? ''
  ).trim();
  if (!externalId) return { ok: false, reason: 'missing order serial/_id' };
  if (businessId == null) return { ok: false, reason: 'missing tenant' };

  const status      = String(order?.status ?? '').trim().toLowerCase();
  const statusAr    = resolveStatusAr(order?.status_ar, status);
  const statusClass = classifySafqaStatus(status);
  /* The live Safqa orderHook's `total` is the GROSS COD value, NOT the marketer
     commission. Instead of storing it (or 0), AUTO-COMMISSION from the SKU:
     commission = COMMISSION_RATES[sku] × quantity (ends the manual-CSV dependency).
     totalIsGross marks the Safqa-webhook path → auto-calculate. The CSV import omits
     the flag and passes the already-correct العمولة, which still wins. Unknown SKU →
     0 (never the gross). The upsert/merge guards below PRESERVE any existing realized
     commission, so this only fills orders that have none yet. */
  const total       = opts.totalIsGross
    ? commissionFor(order?.sku ?? order?.SKU, order?.quantity ?? order?.qty ?? order?.Qty)
    : num(order?.total);
  /* Marketer normalisation — Safqa marks organic/own-store sales with a literal
     '-' (or leaves it blank). Those are the MAIN ACCOUNT's orders, so canonicalise
     '-'/empty/null → 'main_account' AT INGEST. Without this they accumulate as '-'
     and the "الحساب الأساسي" filter (marketer='main_account') misses them — the
     exact regression behind Main Account showing only 1 order. */
  const marketer    = normalizeMarketer(order?.marketer);
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
  /* Customer phone — the matching key for the Safqa status webhook. */
  const clientPhone = normalizePhone(pick('client_phone1', 'client_phone', 'phone', 'client_phone2', 'mobile'));
  /* EXACT pre-computed commission held from the EasyOrder creation (selling − base).
     Stored but NOT promoted to `total` here — it stays "held" until Safqa touches
     the order (so a ghost never enters the financials). 0 when not provided. */
  const calcCommission = num(order?.calc_commission);

  /* ── CROSS-CHANNEL DEDUP (EasyOrder UUID ⨯ Safqa serial) ─────────────────────
     The SAME physical order can arrive under two different keys: the EasyOrder
     creation webhook stores it keyed by EasyOrder's UUID, while Safqa's CSV/serial
     stores it keyed by the 'sk-…' serial. Because the upsert key is external_id,
     the two never collide → a DUPLICATE row (double-counted orders + money) — the
     exact regression that inflated the affiliate dashboard.
     Guard: when THIS external_id is NEW and an OPEN (pending/confirmed) row for the
     same tenant + phone already exists under a DIFFERENT key, UPDATE that row and
     SKIP the insert. Commission (total) is filled COALESCE-style so a real value
     never reverts to 0.

     IMPORTANT — only run this for SECONDARY arrivals (Safqa CSV/webhook landing on
     an order EasyOrder already created). It MUST be skipped on the EasyOrder
     CREATION path (opts.primaryCreate): EO fires first, so any open same-phone row
     is a DIFFERENT order (a genuine re-order by a repeat customer) and merging it
     would silently drop the new order + its commission. Phone alone cannot tell a
     re-order from a cross-channel duplicate (the SKU/product differ across channels
     too), so the source flag is the only safe discriminator. */
  if (clientPhone && !opts.primaryCreate) {
    const merged = await pool.query(
      `UPDATE external_affiliate_orders e
          SET status=$3, status_ar=$4, status_class=$5,
              /* Promote on Safqa touch: keep realized → else the EO-held exact
                 commission → else the new (fixed-rate) value. Never overwrites. */
              total        = COALESCE(NULLIF(e.total, 0), NULLIF(e.calc_commission, 0), $6::numeric),
              marketer     = COALESCE(NULLIF($7, 'main_account'), e.marketer),
              product_name = COALESCE($8, e.product_name),
              sku          = COALESCE($9, e.sku),
              governorate  = COALESCE($10, e.governorate),
              note         = COALESCE($11, e.note),
              quantity     = COALESCE($12, e.quantity),
              updated_at   = NOW()
        WHERE e.id = (
                SELECT id FROM external_affiliate_orders
                 WHERE business_id=$2 AND network='safqa' AND client_phone=$13
                   AND external_id <> $1 AND status_class IN ('pending','confirmed')
                 ORDER BY updated_at DESC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM external_affiliate_orders
                           WHERE business_id=$2 AND network='safqa' AND external_id=$1)
          AND (SELECT COUNT(*) FROM external_affiliate_orders
                WHERE business_id=$2 AND network='safqa' AND client_phone=$13
                  AND external_id <> $1 AND status_class IN ('pending','confirmed')) = 1
        RETURNING e.external_id`,
      [externalId, businessId, status, statusAr, statusClass, total, marketer,
       productName, sku, governorate, note, quantity, clientPhone]);
    if (merged.rows.length) {
      return { ok: true, inserted: false, deduped: true, externalId: merged.rows[0].external_id, statusClass };
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO external_affiliate_orders
       (network, external_id, business_id, status, status_ar, status_class, total, marketer,
        product_name, sku, governorate, note, quantity, client_phone, raw, calc_commission, updated_at)
     VALUES ('safqa', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, NOW())
     ON CONFLICT (network, external_id, business_id)
     DO UPDATE SET status       = EXCLUDED.status,
                   status_ar    = EXCLUDED.status_ar,
                   status_class = EXCLUDED.status_class,
                   /* PROMOTE on Safqa touch, never overwrite: keep a realized value,
                      else promote the EO-held exact commission, else take the new
                      (fixed-rate) value. So the order shows its EXACT commission the
                      moment Safqa accepts it, and is never clobbered afterwards. */
                   total        = COALESCE(NULLIF(external_affiliate_orders.total, 0),
                                           NULLIF(external_affiliate_orders.calc_commission, 0),
                                           EXCLUDED.total),
                   /* Keep the EO-held exact commission available for promotion. */
                   calc_commission = COALESCE(NULLIF(EXCLUDED.calc_commission, 0), external_affiliate_orders.calc_commission),
                   marketer     = COALESCE(NULLIF(EXCLUDED.marketer, 'main_account'), external_affiliate_orders.marketer),
                   product_name = COALESCE(EXCLUDED.product_name, external_affiliate_orders.product_name),
                   sku          = COALESCE(EXCLUDED.sku,          external_affiliate_orders.sku),
                   governorate  = COALESCE(EXCLUDED.governorate,  external_affiliate_orders.governorate),
                   note         = COALESCE(EXCLUDED.note,         external_affiliate_orders.note),
                   quantity     = COALESCE(EXCLUDED.quantity,     external_affiliate_orders.quantity),
                   client_phone = COALESCE(EXCLUDED.client_phone, external_affiliate_orders.client_phone),
                   raw          = EXCLUDED.raw,
                   updated_at   = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [externalId, businessId, status, statusAr, statusClass, total, marketer,
     productName, sku, governorate, note, quantity, clientPhone, JSON.stringify(rawToStore ?? {}), calcCommission]
  );
  return { ok: true, inserted: rows[0]?.inserted === true, externalId, statusClass };
}

/**
 * Safqa STATUS webhook — double-webhook strategy.
 * Safqa pushes only { status, status_ar, client_phone1 } (no marketer / sku /
 * product / governorate). Rather than create a new data-poor row (or guess a
 * marketer), MATCH the existing rich row that the EasyOrder creation webhook
 * already wrote, by normalised client phone (+ sku when Safqa happens to send
 * one), and update ONLY the status. Most-recent OPEN order wins.
 * Returns { ok, matched, externalId?, statusClass?, reason? }.
 */
async function updateSafqaStatusByPhone(order, businessId) {
  if (businessId == null) return { ok: false, matched: false, reason: 'missing tenant' };
  const phone = normalizePhone(
    order?.client_phone1 ?? order?.client_phone ?? order?.phone ?? order?.client_phone2 ?? order?.mobile
  );
  if (!phone) return { ok: false, matched: false, reason: 'missing client phone' };

  const status      = String(order?.status ?? '').trim().toLowerCase();
  const statusAr    = resolveStatusAr(order?.status_ar, status);
  const statusClass = classifySafqaStatus(status);
  const sku         = primarySku(order?.sku ?? order?.SKU ?? null);
  /* Safqa's webhook `total` is the GROSS COD, NOT commission — we IGNORE it and
     AUTO-COMMISSION the matched order from its own SKU (COMMISSION_RATES × qty), so
     no manual CSV is ever needed. We fill ONLY when the order still has no
     commission (COALESCE(NULLIF(total,0), …)) so a realized value is never lost. */

  const { rows } = await pool.query(
    `SELECT id, external_id, sku AS row_sku, quantity AS row_qty, calc_commission AS row_calc
       FROM external_affiliate_orders
      WHERE business_id = $1 AND network = 'safqa' AND client_phone = $2
        AND ($3::text IS NULL OR UPPER(TRIM(COALESCE(sku,''))) = UPPER(TRIM($3)))
      ORDER BY (status_class IN ('delivered','returned','cancelled')) ASC,  -- OPEN orders first
               created_at DESC
      LIMIT 1`,
    [businessId, phone, sku]
  );
  if (!rows.length) {
    return { ok: true, matched: false, reason: 'no matching EasyOrder-created row for phone' };
  }

  /* Commission to PROMOTE into total: prefer the EXACT EO-held value (selling −
     base, computed at creation); fall back to the fixed-rate dictionary when no
     base cost was provided. The UPDATE keeps any already-realized value. */
  const promoted = num(rows[0].row_calc) > 0
    ? num(rows[0].row_calc)
    : commissionFor(rows[0].row_sku, rows[0].row_qty);

  await pool.query(
    `UPDATE external_affiliate_orders
        SET status       = $1,
            status_ar    = COALESCE($2, status_ar),
            status_class = $3,
            total        = COALESCE(NULLIF(total, 0), $6::numeric),
            updated_at   = NOW()
      WHERE id = $4 AND business_id = $5`,
    [status, statusAr, statusClass, rows[0].id, businessId, promoted]
  );
  return { ok: true, matched: true, externalId: rows[0].external_id, statusClass };
}

/* ── Ghost-order auto-purge ──────────────────────────────────────────────────
   A "ghost" = an order that never synced to Safqa: NO Safqa serial (external_id
   not 'sk-…') AND NO commission (total=0), past the grace window. It can never
   earn a commission, so it must never appear in the financials — the SAFQA_BACKED
   predicate already EXCLUDES it from every dashboard query the instant it has no
   serial + no commission (so it isn't counted even as "pending"). This routine is
   the cleanup half: it TRANSITIONS aged ghosts to a `quarantined` state so the
   table stays clean and they're auditable/revivable. A ghost that LATER syncs to
   Safqa gains a serial/commission and is excluded from this purge automatically.
   Idempotent, all-tenant, safe to run on a schedule. */
async function purgeGhostOrders({ graceHours = 24 } = {}) {
  try {
    await pool.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT FALSE`);
    const { rowCount } = await pool.query(
      `UPDATE external_affiliate_orders
          SET quarantined = TRUE, updated_at = NOW()
        WHERE network = 'safqa' AND NOT quarantined
          AND external_id NOT LIKE 'sk-%' AND COALESCE(total, 0) = 0
          AND COALESCE(created_at, updated_at) < NOW() - ($1 || ' hours')::interval`,
      [String(graceHours)]
    );
    if (rowCount) console.log(`[ghostPurge] quarantined ${rowCount} ghost order(s) (no Safqa serial + no commission, > ${graceHours}h old)`);
    return rowCount;
  } catch (err) {
    console.error('[ghostPurge] failed:', err.message);
    return 0;
  }
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
  /* Canonical base product name — AGGRESSIVE so ONE physical product is ONE row
     even across EasyOrder-slug vs Safqa-code SKU differences:
       1. strip a leading "(N)" quantity tag and the "قطعة" (piece) word, then
       2. strip everything from the first " - " descriptor onward ("- مستورد",
          "- يد طويلة", multi-item "-- …", etc.).
     e.g. "(1) قطعة حزام… الشهرية - مستورد", "قطعة حزام… الشهرية" and the slug-SKU
     "حزام… الشهرية" all collapse to "حزام التدفئة الذكي لتخفيف آلام الدورة الشهرية". */
  const cleanName = (col) => `TRIM(regexp_replace(regexp_replace(${col}, '^\\s*(\\(\\s*\\d+\\s*\\)\\s*)?(قطعة\\s+)?', ''), '\\s+[-–—].*$', ''))`;
  /* Base SKU = first code when an order carries a comma-joined multi-item SKU. */
  const baseSku   = (col) => `UPPER(TRIM(split_part(${col}, ',', 1)))`;
  /* Reusable product predicate ($n = product param). The dropdown now sends a CLEAN
     base name (one per SKU), so resolve it back to EVERY row of the same product:
     match the clean name directly (covers no-SKU rows) OR any row whose base SKU is
     shared by a row with that clean name. Also still accepts a raw SKU/name. */
  const prodPred  = (n) => ` AND ($${n}::text IS NULL
       OR product_name = $${n}
       OR ${cleanName('product_name')} = $${n}
       OR ${baseSku('sku')} = UPPER(TRIM($${n}))
       OR ${baseSku('sku')} IN (
            SELECT ${baseSku('s2.sku')} FROM external_affiliate_orders s2
             WHERE s2.business_id = $1 AND s2.network = 'safqa'
               AND COALESCE(TRIM(s2.sku),'') <> '' AND ${cleanName('s2.product_name')} = $${n}))`;
  /* Global Campaign Filter — the dropdown passes a Meta campaign NAME. An order
     belongs to that campaign when the campaign name CONTAINS the order's SKU (the
     SAME naming convention the ad-spend attribution uses). Row-wise predicate —
     external_affiliate_orders.sku is on the order itself, so no resolution needed.
     NULL ('كل الحملات'/empty) = all campaigns. */
  const campaign  = (opts.campaign && opts.campaign !== 'كل الحملات') ? String(opts.campaign).trim() : null;
  /* Reusable campaign predicate; $n is the campaign param position in each call. */
  const campPred  = (n) => ` AND ($${n}::text IS NULL OR (COALESCE(TRIM(sku),'') <> '' AND UPPER($${n}::text) LIKE '%' || UPPER(TRIM(sku)) || '%'))`;
  /* ── AGENCY scope (Media-Buyer isolation) ───────────────────────────────────
     referralCodes → restrict Safqa orders to those marketers (the buyer's UTM/
       Sub-ID maps to external_affiliate_orders.marketer).
     adAccountIds  → restrict the ADS spend to the buyer's Meta ad accounts.
     CONVENTION (set by resolveAnalyticsScope): null = unscoped (admin sees all);
     [] = scoped-but-unconfigured → 0 rows; [..] = scoped. */
  const referralCodes = Array.isArray(opts.referralCodes) ? opts.referralCodes : null;
  const adAccountIds  = Array.isArray(opts.adAccountIds)  ? opts.adAccountIds  : null;
  /* Marketer predicate; $n is the referralCodes param position. */
  const refPred   = (n) => ` AND ($${n}::text[] IS NULL OR marketer = ANY($${n}::text[]))`;

  /* ── EXPECTED-COMMISSION VALUATION (root-cause fix for the regressing PROFIT) ──
     Safqa's webhook payload carries only the GROSS COD, never the marketer
     commission (verified: raw.total=694 gross, no commission/net field). The real
     commission arrives ONLY from the lagging Safqa CSV reconciliation (العمولة).
     So an order that flows through the LIVE pipeline (EasyOrder create → Safqa
     status webhook advances it to preparing/shipped) sits at total=0 until a CSV
     import lands — making PROFIT (IN PROGRESS / DELIVERED) undercount, and the gap
     GROWS as new orders arrive. THAT is the "regression".

     Fix: value every commission-earning order at COALESCE(realized total, EXPECTED
     commission). Expected = the product's median realized commission PER UNIT ×
     quantity (Safqa pays a fixed per-product marketer commission and shows exactly
     this expected value for in-progress orders in its wallet). Realized `total`
     always wins when present, so delivered/reconciled orders are unaffected and the
     figure converges to cent-exact as the CSV reconciles. Estimation is applied
     ONLY to confirmed/delivered orders (a cancelled/returned/pending order earns
     nothing, so it keeps its realized-or-zero value). Rates are computed tenant-
     wide (NOT date-filtered) so a narrow date range still values orders correctly. */
  const RATES_CTE = `
    WITH _rates AS (
      SELECT ${cleanName('product_name')} AS canon,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total / GREATEST(COALESCE(quantity,1),1)) AS unit_rate
        FROM external_affiliate_orders
       WHERE business_id = $1 AND network = 'safqa' AND total > 0
         AND ${cleanName('product_name')} IS NOT NULL AND ${cleanName('product_name')} <> ''
       GROUP BY 1
    ),
    _global AS (
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total / GREATEST(COALESCE(quantity,1),1)) AS unit_rate
        FROM external_affiliate_orders WHERE business_id = $1 AND network = 'safqa' AND total > 0
    )`;
  /* Effective commission per order: realized when present, else expected — but the
     expected fallback applies ONLY to genuine Safqa orders (external_id LIKE 'sk-%'
     OR an already-realized commission). An EasyOrder-only row that was never synced
     to Safqa (UUID, total=0 — a "ghost") must NEVER receive an expected Safqa
     commission, otherwise it inflates PROFIT. NULL when nothing applies → SUM skips. */
  const EFF = `COALESCE(NULLIF(o.total, 0),
      CASE WHEN o.status_class IN ('confirmed','delivered') AND o.external_id LIKE 'sk-%'
           THEN ROUND(COALESCE(_r.unit_rate, _g.unit_rate) * GREATEST(COALESCE(o.quantity,1),1))
           ELSE NULL END)`;
  /* ── GHOST EXCLUSION (Safqa-backed filter) ───────────────────────────────────
     The dashboard mirrors the Safqa wallet, so a row counts ONLY when it is backed
     by Safqa: it has a Safqa serial ('sk-…') OR a realized commission. EasyOrder
     rows that were never synced to Safqa (UUID + total=0 — test/unsynced "ghosts")
     are excluded from EVERY financial metric and order count. Permanent + self-
     maintaining: a ghost that later syncs to Safqa gains a serial/commission and is
     then automatically included. */
  const SAFQA_BACKED = `(o.external_id LIKE 'sk-%' OR COALESCE(o.total, 0) > 0)`;

  /* Two tenant-scoped reads:
       1) the pure Safqa-order buckets (counts + EFFECTIVE-commission revenue by class)
       2) total Meta ad spend (expenses.meta_sync = TRUE) — drives ADS/CPP/Net. */
  const ORDER_AGG_SELECT = `
    ${RATES_CTE}
    SELECT
      COUNT(*)::int                                              AS total,
      COUNT(*) FILTER (WHERE o.status_class = 'delivered')::int  AS delivered,
      COUNT(*) FILTER (WHERE o.status_class = 'confirmed')::int  AS confirmed_only,
      COUNT(*) FILTER (WHERE o.status_class = 'returned')::int   AS returned,
      COUNT(*) FILTER (WHERE o.status_class = 'pending')::int    AS pending,
      COUNT(*) FILTER (WHERE LOWER(o.status) = 'holding')::int   AS on_hold,
      COALESCE(SUM(${EFF}), 0)                                                            AS revenue_all,
      COALESCE(SUM(${EFF}) FILTER (WHERE o.status_class IN ('confirmed','delivered')), 0) AS revenue_confirmed,
      COALESCE(SUM(${EFF}) FILTER (WHERE o.status_class = 'delivered'), 0)                AS revenue_delivered
    FROM external_affiliate_orders o
    CROSS JOIN _global _g
    LEFT JOIN _rates _r ON _r.canon = ${cleanName('o.product_name')}
    WHERE o.business_id = $1 AND o.network = 'safqa' AND ${SAFQA_BACKED}`;

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
         ${prodPred(4)}
         ${campPred(5)}
         ${refPred(6)}`,
      [businessId, startDate, endDate, product, campaign, referralCodes]
    );
  } catch (err) {
    console.error(
      `[aggregateSafqaFromDb] ❌ date-filtered order query FAILED for business ${businessId} ` +
      `(range ${startDate || '—'}..${endDate || '—'}). This is the swallowed error that ` +
      `zeroes the grid. Most likely the created_at column is missing — restart the backend ` +
      `to run the boot migration. Falling back to an UNFILTERED read so data still renders.\n`,
      err
    );
    /* Fallback: drop the date bounds but KEEP product ($2) + campaign ($3) + referral ($4). */
    aggRes = await pool.query(
      `${ORDER_AGG_SELECT}${prodPred(2)}${campPred(3)}${refPred(4)}`,
      [businessId, product, campaign, referralCodes]
    );
  }

  /* ADS — STRICTLY ISOLATED Safqa ad spend. Sum ONLY expenses whose campaign name
     contains a KNOWN Safqa SKU (from external_affiliate_orders network='safqa') —
     the SAME "campaign_name CONTAINS sku" rule the Detailed Products Table uses.
     This excludes the tenant's standard e-commerce campaigns (e.g. MASSAG) so the
     affiliate ADS / CPP / NET PROFIT are not polluted by non-Safqa spend. When a
     product is selected, the EXISTS further narrows to that product's SKU.
     Non-fatal: degrade ADS to 0 on any error, but LOG it. */
  const adsRes = await pool.query(
    `SELECT COALESCE(SUM(e.amount), 0) AS ad_spend
       FROM expenses e
      WHERE e.business_id = $1::integer AND e.meta_sync = TRUE
        AND ($2::date IS NULL OR e.expense_date >= $2::date)
        AND ($3::date IS NULL OR e.expense_date <= $3::date)
        /* Campaign filter ($5): when a campaign is selected, ADS narrows to EXACTLY
           that campaign's spend. The EXISTS below still guarantees it is a Safqa
           campaign, so affiliate ADS stays isolated from e-commerce spend. */
        AND ($5::text IS NULL OR UPPER(e.campaign_name) = UPPER($5))
        /* AGENCY scope: restrict spend to the buyer's Meta ad accounts. */
        AND ($6::int[] IS NULL OR e.meta_account_id = ANY($6::int[]))
        AND EXISTS (
              SELECT 1
                FROM external_affiliate_orders o
               WHERE o.business_id = $1::integer AND o.network = 'safqa'
                 AND COALESCE(TRIM(o.sku), '') <> ''
                 AND UPPER(e.campaign_name) LIKE '%' || UPPER(TRIM(o.sku)) || '%'
                 AND ($4::text IS NULL OR o.product_name = $4
                      OR ${cleanName('o.product_name')} = $4
                      OR ${baseSku('o.sku')} = UPPER(TRIM($4)))
            )`,
    [businessId, startDate, endDate, product, campaign, adAccountIds]
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
  /* CONFIRMED = every order that passed CALL-CENTER confirmation: the in-pipeline
     confirmed orders, the delivered ones, AND the returned ones (a return was
     confirmed first, then failed at shipping/delivery). Returns are added to
     confirmed ONLY — they stay in `returned`/NDR and are NOT in `delivered`.
     Excluding them would artificially deflate CR%. */
  const confirmed     = delivered + confirmedOnly + returned;

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
  /* NDR = "Net Delivery Rate" = delivered ÷ TOTAL orders (unified with the
     Detailed Products Table, which uses delivered/total). 0-safe on orders=0. */
  const ndr = orders   > 0 ? r2((delivered / orders) * 100)  : 0;        // NDR (net delivery rate)
  const dr  = resolved > 0 ? r2((delivered / resolved) * 100) : 0;        // DR = delivered ÷ resolved

  /* ── Derived money metrics (global DR; Safqa has no product-level data) ── */
  const futureBalance = r0(profitInProgress * (dr / 100));               // F.B (IN PROGRESS)
  const avgProfit     = delivered > 0 ? r2(profitDelivered / delivered) : 0; // AVG PROFIT
  /* MAX CPP = expected revenue per RAW lead = avgCommission × CR × DR. A raw
     Meta lead must survive BOTH the call center (CR) AND the courier (DR) to
     earn its commission. cr/dr are percentages here → divide each by 100.
     0-safe: avgProfit=0 when delivered=0, cr=0 when orders=0, dr=0 when
     resolved=0, so the product is 0 in any degenerate case. */
  const maxCpp        = r2(avgProfit * (cr / 100) * (dr / 100));         // MAX CPP
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
  /* Campaign filter — same naming-convention rule as aggregateSafqaFromDb so the
     Detailed Table stays UNIFIED with the Top Cards: an order belongs to the
     campaign when the campaign name CONTAINS its SKU. NULL = all campaigns. */
  const campaign  = (opts.campaign && opts.campaign !== 'كل الحملات') ? String(opts.campaign).trim() : null;
  /* AGENCY scope (Media-Buyer isolation) — UNIFIED with aggregateSafqaFromDb so
     the Detailed Table matches the Top Cards. referralCodes → marketer filter;
     adAccountIds → ADS scope. null = admin (all); [] = scoped-empty (0 rows). */
  const referralCodes = Array.isArray(opts.referralCodes) ? opts.referralCodes : null;
  const adAccountIds  = Array.isArray(opts.adAccountIds)  ? opts.adAccountIds  : null;

  /* $1 tenant · $2 start · $3 end · $4 product · $5 campaign · $6 referralCodes (marketer).
     created_at is the order-placement date (back-dated from the CSV / set by the webhook). */
  const params = [businessId, startDate, endDate, product, campaign, referralCodes];
  /* Aggressive canonical base name (see aggregateSafqaFromDb): strip the leading
     "(N) قطعة" tag AND every " - " descriptor/suffix so EasyOrder-slug vs Safqa-code
     variants of one physical product collapse to a single label/row. */
  const cleanName = (col) => `TRIM(regexp_replace(regexp_replace(${col}, '^\\s*(\\(\\s*\\d+\\s*\\)\\s*)?(قطعة\\s+)?', ''), '\\s+[-–—].*$', ''))`;
  const baseSku   = (col) => `UPPER(TRIM(split_part(${col}, ',', 1)))`;
  const where = `
    FROM external_affiliate_orders
    WHERE network = 'safqa' AND business_id = $1
      /* GHOST EXCLUSION (see aggregateSafqaFromDb): Safqa-backed rows only — a serial
         or a realized commission. Un-synced EasyOrder ghosts (UUID + total=0) are
         excluded from products / governorates / daily / rejections alike. */
      AND (external_id LIKE 'sk-%' OR COALESCE(total, 0) > 0)
      AND ($2::date IS NULL OR COALESCE(created_at, updated_at)::date >= $2::date)
      AND ($3::date IS NULL OR COALESCE(created_at, updated_at)::date <= $3::date)
      AND ($4::text IS NULL OR product_name = $4
           OR ${cleanName('product_name')} = $4
           OR ${baseSku('sku')} = UPPER(TRIM($4))
           OR ${baseSku('sku')} IN (
                SELECT ${baseSku('s2.sku')} FROM external_affiliate_orders s2
                 WHERE s2.business_id = $1 AND s2.network = 'safqa'
                   AND COALESCE(TRIM(s2.sku),'') <> '' AND ${cleanName('s2.product_name')} = $4))
      AND ($5::text IS NULL OR (COALESCE(TRIM(sku),'') <> '' AND UPPER($5::text) LIKE '%' || UPPER(TRIM(sku)) || '%'))
      AND ($6::text[] IS NULL OR marketer = ANY($6::text[]))`;

  /* CONFIRMED includes returns: a returned order passed call-center confirmation
     first (then failed at shipping/delivery). Returns are counted in CONFIRMED
     and RETURNED/NDR, but NOT in DELIVERED. */
  const CONF = `status_class IN ('confirmed','delivered','returned')`;
  const DELV = `status_class = 'delivered'`;
  const RET  = `status_class = 'returned'`;
  const REV  = `COALESCE(SUM(total) FILTER (WHERE ${DELV}), 0)`;

  try {
    const [dailyR, govR, rejR, prodR, grR, adR] = await Promise.all([
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
      /* Rejection-reasons distribution. Safqa does NOT send a granular per-order
         reason (no cancel_reason/rejection_reason column, none in raw), and the
         `note` column holds CUSTOMER DELIVERY notes ("مستعجل", "عايز يستلم الخميس"),
         not failure causes. The authoritative failure reason we DO have is the
         Safqa status itself.
         SCOPE (per business decision): ONLY pre-shipping call-center cancellations
         (status_class='cancelled' → ملغي). Post-shipping returns (مرتجع / جار
         الاسترجاع) are courier/shipping issues and are deliberately EXCLUDED so this
         chart isolates lead-quality / call-center cancellation performance. */
      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(status_ar), ''), 'غير محدد')   AS reason,
               COUNT(*)::int                              AS count
        ${where} AND status_class = 'cancelled'
        GROUP BY 1 ORDER BY count DESC`, params),
      /* Detailed Product Performance — ONE row per physical product. Group by the
         AGGRESSIVE canonical NAME (not SKU) so the same product merges even when it
         carries different codes (EasyOrder slug e.g. 'hzm-ltdfy' vs Safqa code
         'OAOPRJR') or wording variants ("(1) قطعة …", "… - مستورد"). The display
         name IS that canonical name; the representative SKU is the group's most
         common code (used only for ad-spend attribution by campaign-name match). */
      pool.query(`
        SELECT COALESCE(NULLIF(${cleanName('product_name')}, ''), 'غير محدد')      AS group_key,
               COALESCE(mode() WITHIN GROUP (ORDER BY NULLIF(${baseSku('sku')}, '')), '') AS sku,
               MAX(COALESCE(NULLIF(${cleanName('product_name')}, ''), 'غير محدد'))   AS product_name,
               COUNT(*)::int                              AS total_orders,
               COUNT(*) FILTER (WHERE ${CONF})::int       AS confirmed,
               COUNT(*) FILTER (WHERE ${DELV})::int       AS delivered,
               COUNT(*) FILTER (WHERE ${RET})::int        AS returned,
               ${REV}                                     AS delivered_revenue,
               /* Confirmed-bucket commission (in-pipeline + delivered, EXCLUDES
                  returns — mirrors the top grid's revenue_confirmed). Used to derive
                  the per-product Profit-In-Progress / Future-Balance / Forecasted-Net. */
               COALESCE(SUM(total) FILTER (WHERE status_class IN ('confirmed','delivered')), 0) AS confirmed_revenue,
               /* EXPECTED-COMMISSION inputs (see aggregateSafqaFromDb): this product's
                  median realised commission per unit, plus the unit count of orders
                  still missing their commission (total=0) in each money bucket — so JS
                  can value them at expected = rate × units (Safqa's wallet logic). */
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total / GREATEST(COALESCE(quantity,1),1))
                 FILTER (WHERE total > 0)                                              AS unit_rate,
               COALESCE(SUM(GREATEST(COALESCE(quantity,1),1))
                 FILTER (WHERE ${DELV} AND COALESCE(total,0) = 0), 0)::int             AS zero_delivered_units,
               COALESCE(SUM(GREATEST(COALESCE(quantity,1),1))
                 FILTER (WHERE status_class IN ('confirmed','delivered') AND COALESCE(total,0) = 0), 0)::int AS zero_pipe_units
        ${where}
        GROUP BY group_key ORDER BY delivered_revenue DESC`, params),
      /* Tenant-wide global median commission/unit — fallback rate for products that
         have no funded orders of their own yet. */
      pool.query(`
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total / GREATEST(COALESCE(quantity,1),1)) AS unit_rate
          FROM external_affiliate_orders WHERE business_id = $1 AND network = 'safqa' AND total > 0`,
        [businessId]),
      /* Meta campaign-level spend for THIS tenant (the affiliate's own ad spend),
         date-filtered on expense_date. Attributed per product in JS by the
         naming convention: campaign name CONTAINS the product SKU. Strictly
         business-scoped + meta_sync — no overlap with any other tenant/system. */
      pool.query(`
        SELECT UPPER(campaign_name) AS campaign, COALESCE(SUM(amount), 0) AS spend
          FROM expenses
         WHERE business_id = $1::integer AND meta_sync = TRUE
           AND ($2::date IS NULL OR expense_date >= $2::date)
           AND ($3::date IS NULL OR expense_date <= $3::date)
           AND ($4::int[] IS NULL OR meta_account_id = ANY($4::int[]))
         GROUP BY UPPER(campaign_name)`, [businessId, startDate, endDate, adAccountIds]),
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

    /* Naming-convention ad-spend attribution: a Meta campaign's spend links to a
       product when the campaign NAME contains that product's SKU (uppercased). */
    /* When a campaign is selected, the per-product ad-spend must reflect ONLY that
       campaign (so the Detailed Table's CPP/Net stays consistent with the campaign-
       scoped Top-Card ADS). adR.campaign is already UPPER(campaign_name). */
    const selCampU = campaign ? campaign.toUpperCase() : null;
    const campaigns = (adR.rows || [])
      .map((c) => ({ name: String(c.campaign || ''), spend: num(c.spend) }))
      .filter((c) => c.spend > 0)
      .filter((c) => !selCampU || c.name === selCampU);
    const r2 = (x) => Math.round(num(x) * 100) / 100;
    /* Tenant-wide fallback commission/unit for products without funded orders. */
    const globalRate = num(grR.rows[0] && grR.rows[0].unit_rate);

    const products = prodR.rows.map((r) => {
      const delivered   = num(r.delivered);
      const returned    = num(r.returned);
      const confirmed   = num(r.confirmed);
      const totalOrders = num(r.total_orders);
      const resolved    = delivered + returned;
      const sku         = (r.sku || '').trim();

      /* EXPECTED-COMMISSION valuation (same root-cause fix as the top grid): orders
         still awaiting their commission (total=0) are valued at this product's
         median realised commission/unit × their units, so PROFIT (DELIVERED / IN
         PROGRESS) doesn't undercount live orders before a CSV reconciliation. */
      const unitRate = num(r.unit_rate) || globalRate;
      const revenue  = Math.round(num(r.delivered_revenue) + unitRate * num(r.zero_delivered_units));

      /* Product Ad Spend = Σ spend of campaigns whose name contains this SKU. */
      let adSpend = 0;
      if (sku) {
        const skuU = sku.toUpperCase();
        for (const c of campaigns) if (c.name.includes(skuU)) adSpend += c.spend;
      }
      adSpend = r2(adSpend);

      /* Actual CPP = ad spend ÷ total orders (0 when no orders). */
      const actualCpp = totalOrders > 0 ? r2(adSpend / totalOrders) : 0;

      /* MAX CPP = avg commission × CR × DR (as decimals) — the break-even cost we
         can pay to acquire one order. avg commission = realised commission per
         delivered order; CR = confirmed/total; DR = delivered/resolved (the same
         rates the table displays). */
      const avgCommission = delivered    > 0 ? revenue / delivered    : 0;
      const crDec         = totalOrders  > 0 ? confirmed / totalOrders : 0;
      const drDec         = resolved     > 0 ? delivered / resolved    : 0;
      const maxCpp        = r2(avgCommission * crDec * drDec);

      /* ── In-progress money metrics (mirror the top 20-grid, per product) ──────
         profitInProgress = Σ commission of CONFIRMED-not-delivered orders
                          = confirmed-bucket revenue − delivered revenue.
         futureBalance    = profitInProgress × DR  (expected to still convert).
         netProfit        = delivered revenue − attributed ad spend  (realised).
         forecastedNet    = netProfit + futureBalance  (realised + expected). */
      const confirmedRevenue = Math.round(num(r.confirmed_revenue) + unitRate * num(r.zero_pipe_units));
      const profitInProgress = Math.max(0, confirmedRevenue - revenue);
      const futureBalance    = Math.round(profitInProgress * drDec);
      const netProfit        = Math.round(revenue - adSpend);
      const forecastedNet    = Math.round(netProfit + futureBalance);

      return {
        product_id:          r.sku || r.product_name,
        product_name:        r.product_name,
        sku,
        cost_price:          0,
        units_delivered:     delivered,
        units_shipped:       resolved,                                   // DR denominator (resolved shipments)
        delivery_rate:       resolved > 0 ? Math.round((delivered / resolved) * 1000) / 10 : 0,
        total_orders:        totalOrders,
        confirmed_orders:    confirmed,
        erp_orders:          confirmed,
        delivered_revenue:   revenue,
        attributed_ad_spend: adSpend,            // SKU-in-campaign-name attribution
        cogs:                0,                  // affiliate holds no stock
        shipping_cost:       0,
        opex_allocated:      0,
        net_profit:          netProfit,          // realised commission − attributed ad spend
        profit_in_progress:  profitInProgress,   // Σ commission of confirmed-not-delivered
        future_balance:      futureBalance,      // profitInProgress × DR
        forecasted_net:      forecastedNet,      // net_profit + future_balance
        actual_cpp:          actualCpp,
        max_cpp:             maxCpp,
        cpa:                 actualCpp > 0 ? actualCpp : null,
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
  updateSafqaStatusByPhone,
  purgeGhostOrders,
  commissionFor,
  COMMISSION_RATES,
  normalizePhone,
  aggregateSafqaFromDb,
  aggregateSafqaBreakdowns,
  classifySafqaStatus,
  primarySku,
  primaryProductName,
  // Legacy (Safqa has no GET API — kept only for reference, no longer called):
  fetchSafqaStats,
  withSafqaPublicBase,
};
