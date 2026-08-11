const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

const getShortName = (name) => { return name ? name.trim().split(/\s+/).slice(0, 3).join(' ') : ''; };

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
   "بضاعة لدى شركة الشحن" — every order dispatched to Bosta and not yet delivered
   or returned sits at Status = 'تم الشحن' (Bosta's forward/قيد التنفيذ leg). We
   group those by product name and sum the quantities so the admin can see exactly
   how many units of each product are floating in transit right now.
   Admin-only, tenant-scoped, live imports only (excludes the isolated lost-order
   queue). Registered BEFORE any '/:param' route so the literal path wins.        */
router.get('/in-transit', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM("ProductName"), ''), 'غير محدد') AS product,
              COUNT(*)::int                              AS orders,
              COALESCE(SUM(COALESCE("quantity", 1)), 0)::int AS count
         FROM orders
        WHERE business_id = $1
          AND "Status" = 'تم الشحن'
          AND COALESCE(is_lost_order, FALSE) = FALSE
        GROUP BY 1
        ORDER BY count DESC, orders DESC`,
      [req.user.business_id]
    );

    const total_orders = rows.reduce((s, r) => s + r.orders, 0);
    const total_units  = rows.reduce((s, r) => s + r.count,  0);

    res.json({
      status:       'تم الشحن',
      total_orders,                                    // e.g. 298 floating orders
      total_units,                                     // total units across products
      breakdown: rows.map((r) => ({ product: r.product, count: r.count, orders: r.orders })),
    });
  } catch (err) {
    console.error('[inventory/in-transit]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم أثناء حساب البضاعة قيد الشحن' });
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
