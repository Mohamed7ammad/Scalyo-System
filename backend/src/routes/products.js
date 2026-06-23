const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

/* ── Idempotent startup: ensure purchase_orders table exists ────────────────
   Same pattern used by shipping.js / orders.js for column guards.           */
pool.query(`
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id            SERIAL        PRIMARY KEY,
    product_id    UUID          REFERENCES products(id) ON DELETE CASCADE,
    quantity      INTEGER       NOT NULL CHECK (quantity > 0),
    cost_price    NUMERIC(10,2) NOT NULL,
    purchase_date DATE          DEFAULT CURRENT_DATE,
    created_at    TIMESTAMPTZ   DEFAULT NOW()
  )
`)
  .then(() => console.log('✅  purchase_orders table ready'))
  .catch((err) => console.warn('⚠️   purchase_orders table check:', err.message));

/* Idempotent migration for older installations that have purchase_orders
   without the purchase_date column.                                          */
pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS purchase_date DATE DEFAULT CURRENT_DATE`)
  .then(() => console.log('✅  purchase_orders: "purchase_date" column ready'))
  .catch((err) => console.warn('⚠️   purchase_orders purchase_date check:', err.message));

/* ── Product aliases (SKU mapping) ──────────────────────────────────────────
   External campaign codes that map onto this product. Media buyers can put any
   of these in a Meta ad / EasyOrder form; the inventory hook matches the order's
   sku OR product name against the product's main sku OR any alias.            */
pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}'`)
  .then(() => console.log('✅  products: "aliases" column ready'))
  .catch((err) => console.warn('⚠️   products aliases column check:', err.message));

// ── Allowed fields for PATCH (explicit allowlist — never dynamic) ──────────
const MUTABLE_FIELDS = new Set([
  'name', 'sku', 'cost_price', 'selling_price', 'stock_quantity', 'image_url', 'aliases',
]);

/* Normalise an aliases payload (array OR comma-separated string) → trimmed,
   de-duplicated, non-empty string array. */
function normalizeAliases(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') arr = raw.split(',');
  return [...new Set(
    arr.map((a) => String(a).trim()).filter(Boolean)
  )];
}

// GET /api/products — all authenticated roles (agents need it for the manual
// order modal). SECURITY: non-admins never receive cost_price (COGS); they get
// only the safe fields needed to pick a product and show stock badges.
router.get('/', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const cols = isAdmin
      ? '*'
      : 'id, name, sku, aliases, selling_price, stock_quantity, image_url, created_at, business_id';
    const result = await pool.query(
      `SELECT ${cols} FROM products WHERE business_id = $1 ORDER BY name ASC`,
      [req.user.business_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/products — admin only, create a new product
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const {
    name, sku,
    cost_price    = 0,
    selling_price = 0,
    stock_quantity = 0,
    image_url     = null,
    aliases       = [],
  } = req.body;

  if (!name || !sku) {
    return res.status(400).json({ error: 'name و sku مطلوبان' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (name, sku, cost_price, selling_price, stock_quantity, image_url, aliases, business_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name.trim(),
        sku.trim().toUpperCase(),
        Number(cost_price)     || 0,
        Number(selling_price)  || 0,
        Number(stock_quantity) || 0,
        image_url || null,
        normalizeAliases(aliases),
        req.user.business_id,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'SKU مستخدم بالفعل — اختر SKU مختلف' });
    }
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PATCH /api/products/:id — admin only, partial update
router.patch('/:id', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;

  // Build update payload from the explicit allowlist only
  const updates = {};
  for (const [key, val] of Object.entries(req.body)) {
    if (MUTABLE_FIELDS.has(key)) updates[key] = val;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'لا توجد حقول صالحة للتحديث' });
  }

  // Normalise string fields
  if (updates.name) updates.name = String(updates.name).trim();
  if (updates.sku)  updates.sku  = String(updates.sku).trim().toUpperCase();
  if (updates.aliases !== undefined) updates.aliases = normalizeAliases(updates.aliases);

  // Coerce numeric fields so accidental string values don't slip through
  for (const numField of ['cost_price', 'selling_price', 'stock_quantity']) {
    if (updates[numField] !== undefined) {
      updates[numField] = Number(updates[numField]) || 0;
    }
  }

  const fields     = Object.keys(updates);
  const values     = Object.values(updates);
  const setClauses = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ');

  try {
    const result = await pool.query(
      `UPDATE products SET ${setClauses}
       WHERE id = $${fields.length + 1} AND business_id = $${fields.length + 2}
       RETURNING *`,
      [...values, id, req.user.business_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'المنتج غير موجود' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'SKU مستخدم بالفعل — اختر SKU مختلف' });
    }
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/products/purchases — admin only ────────────────────────────
   Records an incoming supply batch and recalculates the product's cost_price
   using the Weighted Average Cost (WAC) formula:

     New_WAC = (current_stock × current_cost + incoming_qty × incoming_cost)
               ÷ (current_stock + incoming_qty)

   Both the product table (stock_quantity, cost_price) and the purchase_orders
   audit log are updated atomically inside a single transaction.
   ────────────────────────────────────────────────────────────────────────── */
/* ── GET /api/products/purchases — admin only ─────────────────────────────
   Returns full purchase history joined with product name + SKU, ordered by
   purchase_date DESC so the most recent batches appear first.
   Falls back to created_at::date when purchase_date is NULL (legacy rows).  */
router.get('/purchases', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        po.id,
        p.name                                              AS product_name,
        p.sku,
        po.quantity,
        po.cost_price,
        COALESCE(po.purchase_date, po.created_at::date)    AS purchase_date,
        po.created_at
      FROM   purchase_orders po
      JOIN   products        p  ON po.product_id = p.id
      WHERE  po.business_id = $1
      ORDER  BY COALESCE(po.purchase_date, po.created_at::date) DESC,
                po.created_at DESC
    `, [req.user.business_id]);
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /purchases]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/purchases', authenticate, requireAdmin, async (req, res) => {
  const { productId, quantity, unitCost, purchaseDate } = req.body;

  if (!productId || quantity === undefined || unitCost === undefined) {
    return res.status(400).json({ error: 'productId, quantity, unitCost مطلوبان' });
  }

  const qty  = Number(quantity);
  const cost = Number(unitCost);

  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'الكمية يجب أن تكون عدد صحيح أكبر من صفر' });
  }
  if (isNaN(cost) || cost < 0) {
    return res.status(400).json({ error: 'سعر تكلفة الوحدة غير صالح' });
  }

  const businessId = req.user.business_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* Step A: lock the product row for the duration of this transaction so
       concurrent batches don't produce a race-condition on WAC. */
    const productResult = await client.query(
      `SELECT id, name, sku, cost_price, stock_quantity
       FROM products WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [productId, businessId]
    );
    if (!productResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'المنتج غير موجود' });
    }

    const product      = productResult.rows[0];
    const currentStock = product.stock_quantity;
    const currentCost  = parseFloat(product.cost_price) || 0;

    /* Step B: WAC formula ─────────────────────────────────────────────
       Edge case: if current stock is 0 (first batch or after full depletion)
       the formula collapses to the incoming unit cost.                  */
    const newStock = currentStock + qty;
    const rawWAC   = newStock > 0
      ? ((currentStock * currentCost) + (qty * cost)) / newStock
      : cost;
    const newWAC   = parseFloat(rawWAC.toFixed(2));

    /* Step C: update product — increment stock + overwrite cost_price with WAC */
    const updatedResult = await client.query(
      `UPDATE products
       SET stock_quantity = $1,
           cost_price     = $2
       WHERE id = $3 AND business_id = $4
       RETURNING *`,
      [newStock, newWAC, productId, businessId]
    );

    /* Step D: audit log — purchase_date defaults to CURRENT_DATE when not provided */
    const insertDate = purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)
      ? purchaseDate
      : null;   // DB default (CURRENT_DATE) takes over when null

    const poResult = await client.query(
      `INSERT INTO purchase_orders (product_id, quantity, cost_price, purchase_date, business_id)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5)
       RETURNING id`,
      [productId, qty, cost, insertDate, businessId]
    );
    const purchaseOrderId = poResult.rows[0].id;

    /* Step E: financial link — post the cash-out to the treasury so the drawer
       balance reflects the stock purchase automatically (modules were previously
       disconnected). source='INVENTORY_PURCHASE' is EXCLUDED from the dashboard
       P&L OPEX (it becomes COGS on delivery) but still counts in the cash balance.
       purchase_order_id ties it to this batch → the row is LOCKED in the UI/API
       (no manual edit/delete). ON CONFLICT keeps the whole thing idempotent if the
       request is retried. */
    const totalCost = parseFloat((qty * cost).toFixed(2));
    await client.query(
      `INSERT INTO treasury_transactions
         (order_id, amount, type, source, description, transaction_date, business_id, purchase_order_id)
       VALUES (NULL, $1, 'expense', 'INVENTORY_PURCHASE', $2, COALESCE($3::date, CURRENT_DATE), $4, $5)
       ON CONFLICT (purchase_order_id) WHERE purchase_order_id IS NOT NULL DO NOTHING`,
      [
        totalCost,
        `فاتورة مشتريات مخزون - ${product.sku} (${qty} وحدة × ${cost} ج)`,
        insertDate, businessId, purchaseOrderId,
      ]
    );

    await client.query('COMMIT');

    console.log(
      `[Purchase] ✅ "${product.name}" | +${qty} units | ` +
      `WAC: ${currentCost} → ${newWAC} EGP | stock: ${currentStock} → ${newStock}`
    );

    res.status(201).json({
      message:       `تم تسجيل الشحنة — تكلفة WAC الجديدة: ${newWAC} ج.م`,
      product:       updatedResult.rows[0],
      previousCost:  currentCost,
      newCost:       newWAC,
      addedQuantity: qty,
      newStock,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Purchase] Transaction error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

// DELETE /api/products/:id — admin only
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 AND business_id = $2 RETURNING id',
      [req.params.id, req.user.business_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'المنتج غير موجود' });
    }
    res.json({ message: 'تم حذف المنتج بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
