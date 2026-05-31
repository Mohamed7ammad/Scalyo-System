const express = require('express');
const crypto  = require('crypto');
const pool    = require('../config/db');
const { enrichDeliveryRate } = require('../services/bostaEnrich');

const router = express.Router();

/* ── Fallback dedup key ───────────────────────────────────────────────────────
   EasyOrder's Excel rows have NO order id, so we synthesise a DETERMINISTIC
   external_order_id from the row's own content. Same row → same key → the
   existing (external_order_id, business_id) unique index + ON CONFLICT catch it.

   Composite = Phone + FullName + ProductName (+ Date when the sheet provides one).
   • Re-importing the same file → identical key → skipped (no duplicate).
   • A genuine re-order of a DIFFERENT product → different key → inserted.
   • If a row carries a Date, the same product on a different day is allowed.
   Phone is reduced to digits and text is normalised so trivial formatting
   differences ("0100 123" vs "+20100123") don't slip a duplicate through.     */
function normPhone(v) { return String(v ?? '').replace(/\D/g, ''); }
function normText(v)  { return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }

function buildFallbackKey(body) {
  const phone   = normPhone(body.Phone);
  const name    = normText(body.FullName);
  const product = normText(body.ProductName ?? body.product ?? body.Product);
  const date    = String(
    body.Date ?? body.date ?? body.order_date ?? body.orderDate ?? body.OrderDate ?? ''
  ).trim().slice(0, 10);                 // YYYY-MM-DD portion only, if present
  const basis = [phone, name, product, date].join('|');
  const hash  = crypto.createHash('sha1').update(basis).digest('hex').slice(0, 24);
  return `eo-auto:${hash}`;             // prefixed → never collides with a real id
}

/* ── Idempotent: external-order dedup support ────────────────────────────────
   Guarantees an EasyOrder import can NEVER create a duplicate row for the same
   external order within a tenant. Runs sequentially on boot (IF NOT EXISTS), so
   the column + partial unique index always exist before any webhook fires.
   Index name/shape match services/taagerSync (one shared index, not two).    */
(async () => {
  try {
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_order_id VARCHAR(120)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_source      VARCHAR(50)`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS orders_external_tenant_uidx
        ON orders (external_order_id, business_id)
        WHERE external_order_id IS NOT NULL
    `);
    console.log('✅  webhooks: external_order_id dedup index ready');
  } catch (err) {
    console.warn('⚠️  webhooks dedup migration skipped:', err.message);
  }
})();

/* ── POST /api/webhooks/easyorder ────────────────────────────────── */
router.post('/easyorder', async (req, res) => {
  // Validate shared secret if configured
  if (process.env.WEBHOOK_SECRET) {
    const incoming = req.headers['x-webhook-secret'];
    if (incoming !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Webhook secret mismatch' });
    }
  }

  try {
    console.log('📦 Webhook payload received:', JSON.stringify(req.body, null, 2));

    const { FullName, Phone, City, Address, Note } = req.body;
    const ProductName  = req.body.ProductName  ?? req.body.product ?? req.body.Product ?? null;
    const ProductPrice = req.body.ProductPrice ?? req.body.price   ?? req.body.Price   ?? null;

    if (!FullName || !Phone) {
      console.warn('⚠️  Webhook rejected: missing FullName or Phone');
      return res.status(400).json({ error: 'FullName and Phone are required' });
    }

    /* Idempotency key:
         1. Prefer EasyOrder's REAL order id when present (any common field name).
         2. Otherwise FALL BACK to a deterministic composite hash so id-less Excel
            rows still dedup. Either way external_order_id is NON-NULL, so the
            partial unique index + ON CONFLICT always engage. */
    const realId = String(
      req.body.external_order_id ?? req.body.order_id ?? req.body.orderId ??
      req.body.id ?? req.body.reference ?? req.body.ref ?? ''
    ).trim();
    const externalId = realId || buildFallbackKey(req.body);

    // Always insert as 'بدون' — the background enrichment below will overwrite
    // it with the real Bosta rating within seconds.
    // TENANT: this public webhook has no tenant context, so new orders are
    // claimed by the ORIGINAL tenant (lowest business_profile.id). When the
    // webhook is upgraded to carry a tenant key, swap the subquery for it.
    //
    // DEDUP: ON CONFLICT on the (external_order_id, business_id) partial unique
    // index → a re-imported order is skipped silently (0 rows returned) instead
    // of creating a duplicate.
    const result = await pool.query(
      `INSERT INTO orders
         ("FullName", "Phone", "DeliveryRate", "City", "Address", "Note", "Status",
          "ProductName", "ProductPrice", external_order_id, order_source, business_id)
       VALUES ($1, $2, 'بدون', $3, $4, $5, 'جديد',
               $6, $7, $8, 'easyorder', (SELECT MIN(id) FROM business_profile))
       ON CONFLICT (external_order_id, business_id) WHERE external_order_id IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [FullName, Phone, City || null, Address || null, Note || null,
       ProductName, ProductPrice, externalId]
    );

    /* Conflict → the order already exists for this tenant. Skip silently. */
    if (result.rows.length === 0) {
      console.log(`↩️  EasyOrder webhook: duplicate "${externalId}" (${realId ? 'order id' : 'composite key'}) — skipped`);
      return res.status(200).json({ success: true, skipped: true, reason: 'duplicate order' });
    }

    const newOrder = result.rows[0];

    // Respond immediately — don't make EasyOrders wait for Bosta.
    res.status(201).json({ success: true, order: newOrder });

    // Fire background enrichment after the response is sent.
    enrichDeliveryRate(newOrder.id, Phone);

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

module.exports = router;
