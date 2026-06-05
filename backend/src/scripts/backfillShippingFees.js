/* ─────────────────────────────────────────────────────────────────────────
   Backfill orders.actual_shipping_fee from Bosta (Phase B1).

   For every DELIVERED order that has a Bosta tracking code but no captured
   shipping fee yet, fetch the exact per-AWB priceAfterVat from Bosta's
   integrations API and store it. Idempotent + re-runnable: only touches rows
   where actual_shipping_fee IS NULL, so re-runs fill only newly-delivered
   orders and never overwrite existing values.

   Runs across ALL tenants (each order_id belongs to exactly one business);
   the Bosta api_key is read per-tenant from shipping_settings.

   Usage (from the backend/ directory):
       node src/scripts/backfillShippingFees.js
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('../config/db');
const { fetchActualShippingFee } = require('../services/bostaShippingFee');

/* Bounded-concurrency map so we stay gentle on Bosta's API. */
async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

async function main() {
  console.log('🚚 [backfillShippingFees] Starting (idempotent — fills NULLs only)…\n');

  /* Ensure the column exists so the script is self-sufficient on any DB
     (it is normally created by routes/bosta.js on server boot). */
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS actual_shipping_fee NUMERIC(10,2)`);

  const { rows: targets } = await pool.query(`
    SELECT id, "BostaTrackingCode" AS tn, business_id
    FROM   orders
    WHERE  "Status" = 'تم التوصيل'
      AND  actual_shipping_fee IS NULL
      AND  COALESCE(TRIM("BostaTrackingCode"), '') <> ''
  `);

  if (targets.length === 0) {
    console.log('✅ Nothing to backfill — every delivered order already has a fee.');
    await pool.end();
    process.exit(0);
  }
  console.log(`Found ${targets.length} delivered order(s) needing a shipping fee.\n`);

  /* api_key per tenant (one DB read each, cached). */
  const apiKeyByBiz = new Map();
  async function apiKeyFor(bizId) {
    if (apiKeyByBiz.has(bizId)) return apiKeyByBiz.get(bizId);
    const { rows } = await pool.query(
      `SELECT api_key FROM shipping_settings
       WHERE provider_name='bosta' AND is_active=true AND business_id=$1`, [bizId]);
    const key = (rows[0] && rows[0].api_key) || process.env.BOSTA_API_KEY || null;
    apiKeyByBiz.set(bizId, key);
    return key;
  }

  let ok = 0, miss = 0;
  await mapLimit(targets, 5, async (o) => {
    const apiKey = await apiKeyFor(o.business_id);
    const fee = await fetchActualShippingFee(String(o.tn).trim(), apiKey);
    if (fee == null) { miss++; return; }
    await pool.query(
      `UPDATE orders SET actual_shipping_fee = $1
       WHERE id = $2 AND business_id = $3 AND actual_shipping_fee IS NULL`,
      [fee, o.id, o.business_id]
    );
    ok++;
  });

  console.log(`\n✅ [backfillShippingFees] Done. Captured ${ok} fee(s), ${miss} unavailable/failed.`);

  /* Per-product summary of what is now stored. */
  const { rows: summary } = await pool.query(`
    SELECT COALESCE(p.name, '؟ غير محدد') AS product,
           COUNT(*) FILTER (WHERE o.actual_shipping_fee IS NOT NULL) AS n,
           COALESCE(SUM(o.actual_shipping_fee), 0)                   AS total,
           ROUND(AVG(o.actual_shipping_fee), 2)                      AS avg
    FROM   orders o
    LEFT   JOIN products p ON p.business_id = o.business_id AND (
      (COALESCE(o.sku,'')<>'' AND UPPER(o.sku)=UPPER(p.sku))
      OR (UPPER(TRIM(COALESCE(o."ProductName",'')))=UPPER(TRIM(p.name))
          AND NOT EXISTS (SELECT 1 FROM products px WHERE px.business_id=o.business_id AND COALESCE(o.sku,'')<>'' AND UPPER(px.sku)=UPPER(o.sku))))
    WHERE  o."Status" = 'تم التوصيل' AND o.actual_shipping_fee IS NOT NULL
    GROUP  BY p.name ORDER BY total DESC
  `);
  console.log('\nStored per-product shipping (actual_shipping_fee):');
  summary.forEach(r => console.log(`  ${String(r.product).slice(0,30).padEnd(32)} n=${r.n}  Σ=${Number(r.total).toFixed(2)}  avg=${r.avg}`));

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [backfillShippingFees] Failed:', err.message);
  process.exit(1);
});
