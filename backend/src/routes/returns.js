'use strict';

const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

/* ── Idempotent migrations for the reconciliation feature ────────────────────
   note          — free-text audit tag (e.g. "Reconciliation Auto-Fix").
   reconciled_at — set when an order-linked return's missing units have been
                   topped-up, so the reconciliation report excludes it and the
                   same discrepancy can never be auto-corrected twice.          */
pool.query(`ALTER TABLE product_returns ADD COLUMN IF NOT EXISTS note TEXT`)
  .then(() => pool.query(`ALTER TABLE product_returns ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ`))
  /* ── One-time backfill of the ground-truth restock marker ──────────────────
     Order-linked returns logged BEFORE the reconciled_at marker existed have it
     NULL even though applyPhysicalReturn DID restock them (alias-aware). The
     Error Check modal therefore re-flagged already-restocked items (the log
     shows them green) and "تصحيح الكمية" would DOUBLE-restock them. Mark every
     such row whose product still resolves by sku / name / alias (the SAME match
     applyPhysicalReturn uses to restock) as reconciled. Self-limiting (only
     touches reconciled_at IS NULL); genuinely-unresolvable returns (no product
     match → never restocked) keep reconciled_at NULL and stay flagged. */
  .then(() => pool.query(`
    UPDATE product_returns r
       SET reconciled_at = NOW()
     WHERE r.order_id IS NOT NULL
       AND r.reconciled_at IS NULL
       AND EXISTS (
         SELECT 1 FROM products p
          WHERE p.business_id = r.business_id
            AND (
                  LOWER(TRIM(p.sku))  = LOWER(NULLIF(TRIM(r.sku), ''))
               OR LOWER(TRIM(p.name)) = LOWER(NULLIF(TRIM(r.product_name), ''))
               OR EXISTS (
                    SELECT 1 FROM unnest(COALESCE(p.aliases, '{}'::text[])) AS a
                     WHERE LOWER(TRIM(a)) = LOWER(NULLIF(TRIM(r.sku), ''))
                        OR LOWER(TRIM(a)) = LOWER(NULLIF(TRIM(r.product_name), ''))
                  )
            )
       )
  `))
  .then((res) => console.log(`✅  product_returns: note + reconciled_at ready; back-filled ${res.rowCount ?? 0} already-restocked return(s)`))
  .catch((err) => console.warn('⚠️   product_returns reconciliation columns:', err.message));

/* ── Shared product-matching helpers (used by reconciliation report + fix) ────
   normRec       — trim + lowercase for case-insensitive comparison.
   wasOldMatched — replays the OLD restock logic (sku-first EXACT, no fallback;
                   else EXACT name) → was stock incremented at the time?
   resolveNew    — alias-aware resolution (sku/name vs product sku/name/aliases)
                   → the real product, mirroring resolveProductForOrder.        */
const normRec = (s) => String(s ?? '').trim().toLowerCase();
function wasOldMatched(products, sku, name) {
  const s = String(sku ?? '').trim();
  if (s) return products.some((p) => p.sku === s);
  return products.some((p) => String(p.name).trim() === String(name ?? '').trim());
}
function resolveNew(products, sku, name) {
  const skuKey = normRec(sku), nameKey = normRec(name);
  let best = null, bestRank = 99;
  for (const p of products) {
    let rank = 99;
    if (skuKey && normRec(p.sku) === skuKey) rank = 1;
    else if (nameKey && normRec(p.name) === nameKey) rank = 2;
    else if ((p.aliases || []).some((a) => { const k = normRec(a); return (skuKey && k === skuKey) || (nameKey && k === nameKey); })) rank = 3;
    if (rank < bestRank) { bestRank = rank; best = p; }
  }
  return best;
}

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
         r.return_date,
         r.note
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

/* ── GET /api/returns/reconciliation ─────────────────────────────────────────
   Admin-only. Surfaces returns that were LOGGED (product_returns, order-linked)
   but whose units were never added back to stock because of the old SKU-first
   restock matching bug (a sku that was actually a campaign alias, or a name with
   case/spacing drift, matched 0 product rows → logged but not restocked).

   For each order-linked return we compare:
     • OLD logic (what actually ran): sku-first EXACT (no fallback); if no sku,
       EXACT name. This decides whether stock was incremented at the time.
     • NEW logic (alias-aware): match sku OR name against product sku/name/aliases
       (case-insensitive, trimmed). This tells us the real product to top up.
   A discrepancy = NEW resolves a product but OLD did not → those units are
   missing from that product's stock. Rows that resolve to no product at all are
   reported separately as "unresolved" so the admin can investigate.

   Optional query: ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD (defaults: all time).
   Response: { totalMissingQty, affectedProducts, rows: [ { product_name, sku,
              missing_qty, return_date, resolved } ] }                          */
router.get('/reconciliation', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const { startDate, endDate } = req.query;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (startDate && !dateRe.test(startDate)) return res.status(400).json({ error: 'صيغة startDate غير صحيحة' });
  if (endDate   && !dateRe.test(endDate))   return res.status(400).json({ error: 'صيغة endDate غير صحيحة' });

  try {
    // 1. Catalog for this tenant.
    const { rows: products } = await pool.query(
      'SELECT id, name, sku, COALESCE(aliases, \'{}\'::text[]) AS aliases FROM products WHERE business_id = $1',
      [businessId]
    );

    // 2. Order-linked, NOT-yet-reconciled returns (manual returns have order_id
    //    IS NULL and were restocked atomically by id; already-fixed rows carry
    //    reconciled_at, so both are excluded).
    const params = [businessId];
    let where = 'business_id = $1 AND order_id IS NOT NULL AND reconciled_at IS NULL';
    if (startDate) { params.push(startDate); where += ` AND return_date >= $${params.length}`; }
    if (endDate)   { params.push(endDate);   where += ` AND return_date <= $${params.length}`; }
    const { rows: returns } = await pool.query(
      `SELECT product_name, sku, quantity, return_date FROM product_returns WHERE ${where}`,
      params
    );

    // 3. Find discrepancies, aggregate by (product, date).
    const agg = new Map();   // key → { product_id, product_name, sku, return_date, missing_qty, resolved }
    for (const r of returns) {
      const sku = r.sku ? String(r.sku).trim() : '';
      const name = r.product_name || '';
      if (wasOldMatched(products, sku, name)) continue;   // stock was correctly incremented at the time

      const prod = resolveNew(products, sku, name);
      const dateStr = r.return_date instanceof Date ? r.return_date.toISOString().slice(0, 10) : String(r.return_date);
      const displayName = prod ? prod.name : (name || '—');
      const displaySku  = prod ? (prod.sku || '') : sku;
      const key = `${prod ? prod.id : 'unresolved:' + normRec(name)}|${dateStr}`;
      const hit = agg.get(key);
      if (hit) hit.missing_qty += r.quantity;
      else agg.set(key, {
        product_id:   prod ? prod.id : null,
        product_name: displayName,
        sku:          displaySku,
        return_date:  dateStr,
        missing_qty:  r.quantity,
        resolved:     Boolean(prod),
      });
    }

    const rows = Array.from(agg.values())
      .sort((a, b) => (a.return_date < b.return_date ? 1 : a.return_date > b.return_date ? -1 : b.missing_qty - a.missing_qty));
    const totalMissingQty  = rows.reduce((s, r) => s + r.missing_qty, 0);
    const affectedProducts = new Set(rows.map((r) => r.product_name)).size;

    res.json({ totalMissingQty, affectedProducts, rows });
  } catch (err) {
    console.error('[Returns] /reconciliation error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/returns/reconcile-fix ─────────────────────────────────────────
   Admin-only. Auto-corrects ONE reconciliation row: tops up the product's stock
   by the units that were logged-but-never-restocked for that product on that
   date, and marks those return rows reconciled so the fix is idempotent.

   Body: { productId: UUID, returnDate?: YYYY-MM-DD }
   The missing quantity is recomputed SERVER-SIDE (the client value is never
   trusted) inside a transaction with FOR UPDATE row locks, so concurrent /
   repeated clicks can never double-add. An audit row is also logged as a manual
   return tagged "Reconciliation Auto-Fix".                                     */
router.post('/reconcile-fix', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const { productId, returnDate } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId مطلوب' });
  if (returnDate && !/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) {
    return res.status(400).json({ error: 'صيغة returnDate غير صحيحة' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Target product (tenant-scoped).
    const { rows: prodRows } = await client.query(
      'SELECT id, name, sku, stock_quantity FROM products WHERE id = $1 AND business_id = $2',
      [productId, businessId]
    );
    if (!prodRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'المنتج غير موجود' }); }
    const product = prodRows[0];

    // Full catalog for matching.
    const { rows: products } = await client.query(
      'SELECT id, name, sku, COALESCE(aliases, \'{}\'::text[]) AS aliases FROM products WHERE business_id = $1',
      [businessId]
    );

    // Lock the candidate return rows (order-linked, not yet reconciled).
    const params = [businessId];
    let where = 'business_id = $1 AND order_id IS NOT NULL AND reconciled_at IS NULL';
    if (returnDate) { params.push(returnDate); where += ` AND return_date = $${params.length}`; }
    const { rows: returns } = await client.query(
      `SELECT id, product_name, sku, quantity FROM product_returns WHERE ${where} FOR UPDATE`,
      params
    );

    // Recompute the units missing for THIS product (old-unmatched + new-resolves-here).
    const ids = [];
    let missing = 0;
    for (const r of returns) {
      const sku = r.sku ? String(r.sku).trim() : '';
      if (wasOldMatched(products, sku, r.product_name)) continue;
      const resolved = resolveNew(products, sku, r.product_name);
      if (resolved && resolved.id === product.id) { ids.push(r.id); missing += r.quantity; }
    }

    if (missing === 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, corrected: 0, newStock: product.stock_quantity, product: product.name,
        message: 'لا توجد كمية تحتاج تصحيح (ربما صُحّحت مسبقاً)' });
    }

    // Atomic top-up.
    const upd = await client.query(
      'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2 AND business_id = $3 RETURNING stock_quantity',
      [missing, product.id, businessId]
    );

    // Mark the contributing returns reconciled (idempotency guard).
    await client.query(
      'UPDATE product_returns SET reconciled_at = NOW() WHERE id = ANY($1::int[])',
      [ids]
    );

    // Audit row — logged as a manual return with a note (order_id IS NULL).
    await client.query(
      `INSERT INTO product_returns (product_name, sku, return_date, quantity, business_id, note, reconciled_at)
       VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, NOW())
       ON CONFLICT (product_name, return_date, business_id) WHERE order_id IS NULL
       DO UPDATE SET quantity = product_returns.quantity + EXCLUDED.quantity,
                     note     = COALESCE(product_returns.note, EXCLUDED.note)`,
      [product.name, product.sku, missing, businessId, 'Reconciliation Auto-Fix']
    );

    await client.query('COMMIT');
    console.log(`[Returns/ReconcileFix] +${missing} → "${product.name}" | stock now ${upd.rows[0].stock_quantity} | ${ids.length} return row(s) reconciled`);

    res.json({ ok: true, corrected: missing, newStock: upd.rows[0].stock_quantity, product: product.name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Returns] /reconcile-fix error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

module.exports = router;
