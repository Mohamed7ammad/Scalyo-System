'use strict';

const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

/* ── GET /api/returns/daily ──────────────────────────────────────────────────
   Query param:  ?date=YYYY-MM-DD   (defaults to today when omitted)
   Returns:      Array of { product_name, sku, quantity } for that date,
                 joined to the products table to pull the SKU.             */
router.get('/daily', authenticate, async (req, res) => {
  // Default to today in YYYY-MM-DD if no date is supplied
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  // Basic format validation — prevents SQL injection via the date string
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'صيغة التاريخ غير صحيحة. استخدم YYYY-MM-DD' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
         r.product_name,
         COALESCE(p.sku, '—')       AS sku,
         r.quantity,
         r.return_date
       FROM   product_returns r
       LEFT   JOIN products p
              ON TRIM(p.name) = TRIM(r.product_name)
             AND p.business_id = r.business_id
       WHERE  r.return_date = $1
         AND  r.business_id = $2
       ORDER  BY r.product_name ASC`,
      [date, req.user.business_id]
    );

    res.json(rows);
  } catch (err) {
    console.error('[Returns] /daily error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/returns/manual ────────────────────────────────────────────────
   Admin-only.  Logs a physical return that arrived outside the Bosta webhook
   (backfill, manual receipt, etc.).

   Body:  { productId: string (UUID), quantity: number, returnDate: YYYY-MM-DD }

   Transaction steps:
     1. Resolve product name from productId
     2. Upsert product_returns — increment daily aggregate for that date
     3. Increment products.stock_quantity by the submitted quantity
   All three steps are wrapped in BEGIN / COMMIT; any failure rolls back.      */
router.post('/manual', authenticate, requireAdmin, async (req, res) => {
  const { productId, quantity, returnDate } = req.body;

  /* ── Input validation ─────────────────────────────────────────────────── */
  if (!productId || !quantity || !returnDate) {
    return res.status(400).json({ error: 'productId و quantity و returnDate مطلوبة' });
  }

  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1) {
    return res.status(400).json({ error: 'الكمية يجب أن تكون رقماً صحيحاً موجباً' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) {
    return res.status(400).json({ error: 'صيغة التاريخ غير صحيحة. استخدم YYYY-MM-DD' });
  }

  const businessId = req.user.business_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* Step 1 — resolve product name (tenant-scoped) ─────────────────────── */
    const { rows: productRows } = await client.query(
      'SELECT name, stock_quantity FROM products WHERE id = $1 AND business_id = $2',
      [productId, businessId]
    );
    if (!productRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'المنتج غير موجود' });
    }
    const productName = productRows[0].name.trim();

    /* Step 2 — upsert daily returns aggregate (tenant-scoped) ───────────── */
    await client.query(
      `INSERT INTO product_returns (product_name, return_date, quantity, business_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_name, return_date, business_id) WHERE order_id IS NULL
       DO UPDATE SET quantity = product_returns.quantity + $3`,
      [productName, returnDate, qty, businessId]
    );

    /* Step 3 — increment live stock (tenant-scoped) ─────────────────────── */
    const { rows: updatedRows } = await client.query(
      `UPDATE products
       SET    stock_quantity = stock_quantity + $1
       WHERE  id             = $2 AND business_id = $3
       RETURNING name, stock_quantity`,
      [qty, productId, businessId]
    );

    await client.query('COMMIT');

    console.log(
      `[Returns/Manual] +${qty} → "${updatedRows[0].name}"` +
      ` | stock now ${updatedRows[0].stock_quantity} | date=${returnDate}`
    );

    res.json({
      message:  `تم تسجيل ${qty} وحدة مرتجعة بنجاح`,
      product:  updatedRows[0].name,
      newStock: updatedRows[0].stock_quantity,
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Returns] /manual error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

module.exports = router;
