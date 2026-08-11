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

/* ── GET /api/inventory/in-transit — stock currently WITH the courier ─────────
   "بضاعة لدى شركة الشحن" — REAL-TIME from Bosta, so it mirrors the Bosta dashboard
   1:1 (not our local 'تم الشحن' snapshot, which can drift). Flow:
     1. Fetch every LIVE "قيد التنفيذ" parcel from Bosta (paginated) → tracking #s.
        `total_orders` is Bosta's authoritative count (e.g. 298).
     2. Cross-reference those tracking numbers against the local orders table
        (BostaTrackingCode) to resolve ProductName + quantity.
     3. Group + sum quantities per product; Bosta parcels with no local match are
        surfaced as a single "غير معروف" row so the breakdown reconciles to total.
   Admin-only, tenant-scoped. Registered BEFORE any '/:param' route.              */
router.get('/in-transit', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;

  /* Serve the cached payload if fresh (unless ?fresh=1 forces a live re-fetch). */
  const force  = String(req.query.fresh || '') === '1';
  const cached = IN_TRANSIT_CACHE.get(businessId);
  if (!force && cached && Date.now() - cached.at < IN_TRANSIT_TTL_MS) {
    return res.json({ ...cached.payload, cached: true });
  }

  try {
    // 1. Live Bosta fetch → unique tracking numbers (Bosta's reality).
    const parcels   = await fetchInTransitParcels(businessId);
    const trackings = [...new Set(parcels.map((p) => p.trackingNumber).filter(Boolean))];
    const total_orders = trackings.length;

    if (total_orders === 0) {
      const empty = { status: 'قيد التنفيذ', source: 'bosta', total_orders: 0, total_units: 0, breakdown: [] };
      IN_TRANSIT_CACHE.set(businessId, { at: Date.now(), payload: empty });
      return res.json(empty);
    }

    // 2. Cross-reference ONLY these tracking numbers against local orders.
    //    orders = distinct parcels of that product; count = units (Σ quantity).
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM("ProductName"), ''), 'غير محدد')     AS product,
              COUNT(DISTINCT "BostaTrackingCode")::int                  AS orders,
              COALESCE(SUM(COALESCE("quantity", 1)), 0)::int            AS count
         FROM orders
        WHERE business_id = $1
          AND "BostaTrackingCode" = ANY($2::text[])
        GROUP BY 1
        ORDER BY count DESC, orders DESC`,
      [businessId, trackings]
    );

    const breakdown  = rows.map((r) => ({ product: r.product, count: r.count, orders: r.orders }));
    let   total_units = rows.reduce((s, r) => s + r.count, 0);

    // 3. Bosta parcels not present locally (untracked / imported elsewhere) → one
    //    honest bucket so the breakdown always reconciles to Bosta's total.
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

    const payload = { status: 'قيد التنفيذ', source: 'bosta', total_orders, total_units, breakdown };
    IN_TRANSIT_CACHE.set(businessId, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    if (err.code === 'BOSTA_NOT_CONFIGURED') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[inventory/in-transit]', err.message);
    res.status(502).json({ error: 'تعذّر جلب البضاعة قيد التنفيذ من Bosta. تحقّق من صلاحية التوكن في إعدادات الشحن.' });
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
