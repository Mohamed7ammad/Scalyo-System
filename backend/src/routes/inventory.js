const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const { fetchInTransitParcels } = require('./bosta');   // live "قيد التنفيذ" fetch

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
