const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const { fetchInTransitParcels, fetchReturningParcels } = require('./bosta');   // live Bosta buckets

const router = express.Router();

const getShortName = (name) => { return name ? name.trim().split(/\s+/).slice(0, 3).join(' ') : ''; };

/* Per-tenant cache for the in-transit summary. The endpoint hits Bosta's live API
   (paginated, rate-limited), but the banner polls every ~30s — so we serve a
   cached payload for a few minutes to collapse those polls into ONE Bosta fetch
   and never trip a 429. In-transit counts change slowly, so a short TTL keeps it
   effectively real-time. Tunable via IN_TRANSIT_CACHE_TTL_MS.                    */
const IN_TRANSIT_CACHE    = new Map();   // businessId → { at: epochMs, payload }
const IN_TRANSIT_TTL_MS   = Number(process.env.IN_TRANSIT_CACHE_TTL_MS) || 3 * 60 * 1000;

// GET /api/inventory — admin only
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM inventory WHERE business_id = $1 ORDER BY "ProductName" ASC',
      [req.user.business_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── Shared in-transit resolver (Bosta fetch + summary, cached) ───────────────
   Fetches the LIVE "قيد التنفيذ" parcels from Bosta (paginated), cross-references
   the local orders table, and builds the per-product summary. The Bosta tracking
   numbers AND the summary are cached together per tenant, so the summary banner
   AND the details page share ONE Bosta fetch (never re-hitting the rate-limited
   API within the TTL). Returns { at, trackings, payload, fromCache }.
   Throws err.code='BOSTA_NOT_CONFIGURED' when Bosta creds are missing.           */
async function ensureInTransit(businessId, force = false) {
  const cached = IN_TRANSIT_CACHE.get(businessId);
  if (!force && cached && Date.now() - cached.at < IN_TRANSIT_TTL_MS) {
    return { ...cached, fromCache: true };
  }

  // 1. Live Bosta fetch → unique tracking numbers (Bosta's reality).
  const parcels   = await fetchInTransitParcels(businessId);
  const trackings = [...new Set(parcels.map((p) => p.trackingNumber).filter(Boolean))];
  const total_orders = trackings.length;

  let payload;
  if (total_orders === 0) {
    payload = { status: 'قيد التنفيذ', source: 'bosta', total_orders: 0, total_units: 0, breakdown: [] };
  } else {
    // 2. Cross-reference ONLY these tracking numbers against local orders.
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM("ProductName"), ''), 'غير محدد')     AS product,
              COUNT(DISTINCT "BostaTrackingCode")::int                  AS orders,
              COALESCE(SUM(COALESCE("quantity", 1)), 0)::int            AS count
         FROM orders
        WHERE business_id = $1 AND "BostaTrackingCode" = ANY($2::text[])
        GROUP BY 1
        ORDER BY count DESC, orders DESC`,
      [businessId, trackings]
    );
    const breakdown  = rows.map((r) => ({ product: r.product, count: r.count, orders: r.orders }));
    let   total_units = rows.reduce((s, r) => s + r.count, 0);

    // 3. Bosta parcels not present locally → one honest bucket so the breakdown
    //    always reconciles to Bosta's total.
    const { rows: m } = await pool.query(
      `SELECT COUNT(DISTINCT "BostaTrackingCode")::int AS n
         FROM orders WHERE business_id = $1 AND "BostaTrackingCode" = ANY($2::text[])`,
      [businessId, trackings]
    );
    const unmatched = Math.max(0, total_orders - (m[0]?.n || 0));
    if (unmatched > 0) {
      breakdown.push({ product: 'غير معروف (خارج النظام)', count: unmatched, orders: unmatched });
      total_units += unmatched;
    }
    payload = { status: 'قيد التنفيذ', source: 'bosta', total_orders, total_units, breakdown };
  }

  const entry = { at: Date.now(), trackings, payload };
  IN_TRANSIT_CACHE.set(businessId, entry);
  return { ...entry, fromCache: false };
}

/* ── GET /api/inventory/in-transit — per-product summary (banner) ─────────────
   Admin-only, tenant-scoped, cached. Mirrors the Bosta dashboard 1:1.           */
router.get('/in-transit', authenticate, requireAdmin, async (req, res) => {
  try {
    const { payload, fromCache } = await ensureInTransit(req.user.business_id, String(req.query.fresh || '') === '1');
    res.json({ ...payload, cached: fromCache });
  } catch (err) {
    if (err.code === 'BOSTA_NOT_CONFIGURED') return res.status(400).json({ error: err.message });
    console.error('[inventory/in-transit]', err.message);
    res.status(502).json({ error: 'تعذّر جلب البضاعة قيد التنفيذ من Bosta. تحقّق من صلاحية التوكن في إعدادات الشحن.' });
  }
});

/* ── GET /api/inventory/in-transit/details — full order rows for the page ─────
   Reuses the SAME cached Bosta tracking numbers as the summary (no extra Bosta
   call within the TTL), then returns the matching local order rows: id, customer
   name + phone, product, quantity, tracking code, status, date. No financials.  */
router.get('/in-transit/details', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  try {
    const { trackings, fromCache } = await ensureInTransit(businessId, String(req.query.fresh || '') === '1');
    if (!trackings.length) {
      return res.json({ total_orders: 0, matched: 0, orders: [], cached: fromCache });
    }
    const { rows } = await pool.query(
      `SELECT id,
              "FullName"          AS customer_name,
              "Phone"             AS phone,
              "ProductName"       AS product_name,
              COALESCE("quantity", 1)::int AS quantity,
              "BostaTrackingCode" AS tracking_number,
              "Status"            AS status,
              "createdAt"         AS created_at
         FROM orders
        WHERE business_id = $1 AND "BostaTrackingCode" = ANY($2::text[])
        ORDER BY "createdAt" DESC`,
      [businessId, trackings]
    );
    res.json({ total_orders: trackings.length, matched: rows.length, orders: rows, cached: fromCache });
  } catch (err) {
    if (err.code === 'BOSTA_NOT_CONFIGURED') return res.status(400).json({ error: err.message });
    console.error('[inventory/in-transit/details]', err.message);
    res.status(502).json({ error: 'تعذّر جلب تفاصيل الطلبات قيد التنفيذ من Bosta.' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   Incoming Returns Forecast — المرتجعات القادمة
   ════════════════════════════════════════════════════════════════════════════
   Stock that is physically on its way BACK to us: Bosta's "مرتجعاتك العائدة"
   bucket (RETURNING_STATE_CODES — return-leg parcels, not yet handed back), each
   with Bosta's expected arrival date (`scheduledAt`, the "وقت التوصيل المتوقع").
   Lets the owner scale ads on products that are out of stock but have units
   coming back.

   Pipeline (one Bosta fetch, cached per tenant like the in-transit summary):
     1. Bosta returning parcels → tracking + expected Cairo date + package info.
     2. Local order LINES for those trackings (one parcel can hold several lines),
        skipping lines ALREADY physically received (a product_returns row exists
        for the order — Bosta can lag behind the warehouse log).
     3. Resolve each line to a catalogue product: SKU → name → alias.
     4. Aggregate per product: total incoming units, parcels, arrivals by date,
        and current stock_quantity (can be negative = oversold).
     5. Parcels not in the local orders table are still counted, labelled with
        Bosta's own package description / item count (source: 'bosta').
   ════════════════════════════════════════════════════════════════════════════ */
const INCOMING_CACHE = new Map();   // businessId → { at, payload }

/* ISO timestamp → 'YYYY-MM-DD' in Cairo time (Bosta's 20:59:59Z = 23:59 local). */
const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
const cairoDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : CAIRO_DAY.format(d);
};
const norm = (s) => String(s ?? '').trim().toLowerCase();

async function ensureIncomingReturns(businessId, force = false) {
  const cached = INCOMING_CACHE.get(businessId);
  if (!force && cached && Date.now() - cached.at < IN_TRANSIT_TTL_MS) {
    return { ...cached, fromCache: true };
  }

  // 1. Live Bosta returning bucket (paginated + deduped inside fetchFollowupBucket).
  const parcels = await fetchReturningParcels(businessId);
  const byTracking = new Map();   // tracking → { date, itemsCount, description }
  for (const p of parcels) {
    const t = String(p.trackingNumber || '').trim();
    if (!t) continue;
    byTracking.set(t, { date: cairoDate(p.expectedAt), itemsCount: p.itemsCount, description: (p.description || '').trim() });
  }
  const trackings = [...byTracking.keys()];

  // 2. Catalogue lookup maps (small table — resolve in JS: SKU → name → alias).
  const { rows: products } = await pool.query(
    `SELECT id, name, sku, stock_quantity, aliases FROM products WHERE business_id = $1`, [businessId]);
  const bySku = new Map(), byName = new Map();
  for (const p of products) {
    if (p.sku) bySku.set(String(p.sku).trim().toUpperCase(), p);
    byName.set(norm(p.name), p);
    for (const a of (Array.isArray(p.aliases) ? p.aliases : [])) if (a && !byName.has(norm(a))) byName.set(norm(a), p);
  }
  const resolve = (sku, name) =>
    (sku && bySku.get(String(sku).trim().toUpperCase())) || byName.get(norm(name)) || null;

  // 3. Local order lines for those trackings + "already received" marker.
  const { rows: lines } = trackings.length ? await pool.query(
    `SELECT o.id, o."BostaTrackingCode" AS tracking, o."ProductName" AS product_name, o.sku,
            COALESCE(o."quantity", 1)::int AS qty,
            EXISTS (SELECT 1 FROM product_returns pr WHERE pr.order_id = o.id) AS received
       FROM orders o
      WHERE o.business_id = $1 AND o."BostaTrackingCode" = ANY($2::text[])`,
    [businessId, trackings]) : { rows: [] };

  const matched = new Set(lines.map((l) => String(l.tracking)));
  const pending = new Set();                 // trackings with ≥1 not-yet-received line
  const agg = new Map();                     // key → product bucket
  const bucket = (key, init) => { if (!agg.has(key)) agg.set(key, { ...init, total_units: 0, parcelSet: new Set(), arrivals: new Map() }); return agg.get(key); };
  const add = (b, tracking, date, units) => {
    b.total_units += units;
    b.parcelSet.add(tracking);
    const k = date || 'unknown';
    b.arrivals.set(k, (b.arrivals.get(k) || 0) + units);
  };

  for (const l of lines) {
    if (l.received) continue;                // physically back already — not "incoming"
    const tracking = String(l.tracking);
    pending.add(tracking);
    const p   = resolve(l.sku, l.product_name);
    const key = p ? `p:${p.id}` : `n:${norm(l.product_name) || 'unknown'}`;
    const b   = bucket(key, p
      ? { key, name: p.name, sku: p.sku || null, current_stock: Number(p.stock_quantity), source: 'orders' }
      : { key, name: (l.product_name || '').trim() || 'غير محدد', sku: l.sku || null, current_stock: null, source: 'orders' });
    add(b, tracking, byTracking.get(tracking)?.date, Math.max(1, l.qty));
  }

  // 4. Bosta parcels with NO local order → still stock coming back; label from Bosta.
  let unmatchedParcels = 0;
  for (const [tracking, info] of byTracking) {
    if (matched.has(tracking)) continue;
    unmatchedParcels += 1;
    const p   = info.description ? resolve(null, info.description) : null;
    const key = p ? `p:${p.id}` : `b:${norm(info.description) || 'unknown'}`;
    const b   = bucket(key, p
      ? { key, name: p.name, sku: p.sku || null, current_stock: Number(p.stock_quantity), source: 'orders' }
      : { key, name: info.description || 'غير معروف (خارج النظام)', sku: null, current_stock: null, source: 'bosta' });
    add(b, tracking, info.date, Math.max(1, info.itemsCount || 1));
  }

  const productsOut = [...agg.values()].map((b) => ({
    key: b.key, name: b.name, sku: b.sku, source: b.source,
    current_stock: b.current_stock,
    total_units:   b.total_units,
    parcels:       b.parcelSet.size,
    /* Ascending by date; 'unknown' (no Bosta date) last. */
    arrivals: [...b.arrivals.entries()]
      .map(([date, units]) => ({ date: date === 'unknown' ? null : date, units }))
      .sort((a, c) => (a.date === null) - (c.date === null) || String(a.date).localeCompare(String(c.date))),
  })).sort((a, c) => c.total_units - a.total_units);

  const received_excluded = [...matched].filter((t) => !pending.has(t)).length;
  const payload = {
    source: 'bosta',
    today:  cairoDate(new Date().toISOString()),
    totals: {
      parcels:           pending.size + unmatchedParcels,
      units:             productsOut.reduce((s, p) => s + p.total_units, 0),
      products:          productsOut.length,
      bosta_parcels:     trackings.length,
      received_excluded, // parcels Bosta still lists but the warehouse already logged
      unmatched_parcels: unmatchedParcels,
    },
    products: productsOut,
  };
  const entry = { at: Date.now(), payload };
  INCOMING_CACHE.set(businessId, entry);
  return { ...entry, fromCache: false };
}

/* ── GET /api/inventory/incoming-returns — per-product incoming forecast ──────
   Admin-only, tenant-scoped, cached (?fresh=1 forces a live Bosta pull —
   the page's «تحديث من بوسطة» button). */
router.get('/incoming-returns', authenticate, requireAdmin, async (req, res) => {
  try {
    const { at, payload, fromCache } = await ensureIncomingReturns(req.user.business_id, String(req.query.fresh || '') === '1');
    res.json({ ...payload, fetched_at: new Date(at).toISOString(), cached: fromCache });
  } catch (err) {
    if (err.code === 'BOSTA_NOT_CONFIGURED') return res.status(400).json({ error: err.message });
    console.error('[inventory/incoming-returns]', err.message);
    res.status(502).json({ error: 'تعذّر جلب المرتجعات القادمة من Bosta. تحقّق من صلاحية التوكن في إعدادات الشحن.' });
  }
});

// POST /api/inventory — admin only, upsert stock for a product
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { ProductName, StockQuantity } = req.body;

  if (!ProductName || StockQuantity === undefined || StockQuantity === null) {
    return res.status(400).json({ error: 'ProductName و StockQuantity مطلوبان' });
  }

  const qty       = parseInt(StockQuantity, 10);
  const shortName = getShortName(ProductName);

  if (isNaN(qty) || qty < 0) {
    return res.status(400).json({ error: 'StockQuantity يجب أن يكون رقماً موجباً' });
  }
  if (!shortName) {
    return res.status(400).json({ error: 'ProductName غير صالح' });
  }

  console.log(`Inventory upsert: "${shortName}" → ${qty}`);

  try {
    const result = await pool.query(
      `INSERT INTO inventory ("ProductName", "StockQuantity", "updatedAt", business_id)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT ("ProductName", business_id)
       DO UPDATE SET "StockQuantity" = $2, "updatedAt" = NOW()
       RETURNING *`,
      [shortName, qty, req.user.business_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;

module.exports.ensureIncomingReturns = ensureIncomingReturns;   // used by tests / scripts
