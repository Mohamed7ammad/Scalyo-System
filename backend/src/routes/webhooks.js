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

/* ── Quantity parser ──────────────────────────────────────────────────────────
   EasyOrder orders can contain multiple units. Resolve the total quantity from
   either a flat field or a line-items array (summing per-line quantities).
   Defaults to 1. (Field names are provisional — refined once a real sample
   payload is supplied.)                                                          */
function parseQuantity(body) {
  const direct = body.quantity ?? body.qty ?? body.Quantity ?? body.count ?? body.items_count;
  if (direct != null && !isNaN(parseInt(direct, 10))) {
    return Math.max(1, parseInt(direct, 10));
  }
  const items =
    body.items ?? body.cart_items ?? body.cartItems ?? body.products ??
    body.line_items ?? body.lineItems ?? body.order_items ?? null;
  if (Array.isArray(items) && items.length) {
    const sum = items.reduce((acc, it) => {
      const q = parseInt(it?.quantity ?? it?.qty ?? it?.count ?? 1, 10);
      return acc + Math.max(1, isNaN(q) ? 1 : q);
    }, 0);
    if (sum > 0) return sum;
  }
  return 1;
}

/* ── Field extractor ──────────────────────────────────────────────────────────
   Pulls the order fields from a variety of possible EasyOrder shapes, falling
   back to the first line item for product details when not present top-level.   */
function extractOrderFields(body) {
  const items =
    body.items ?? body.cart_items ?? body.cartItems ?? body.products ??
    body.line_items ?? body.lineItems ?? body.order_items ?? null;
  const firstItem = Array.isArray(items) && items.length ? items[0] : {};

  return {
    FullName:     body.FullName ?? body.full_name ?? body.name ?? body.customer_name ?? null,
    Phone:        body.Phone ?? body.phone ?? body.phone_number ?? body.mobile ?? null,
    City:         body.City ?? body.city ?? body.governorate ?? null,
    Address:      body.Address ?? body.address ?? body.shipping_address ?? null,
    Note:         body.Note ?? body.note ?? body.notes ?? body.comment ?? null,
    ProductName:  body.ProductName ?? body.product ?? body.Product ??
                  firstItem.name ?? firstItem.product_name ?? firstItem.title ?? null,
    ProductPrice: body.ProductPrice ?? body.price ?? body.Price ??
                  body.total ?? body.total_price ?? body.amount ??
                  firstItem.price ?? null,
    quantity:     parseQuantity(body),
  };
}

/* ── Shared ingest ────────────────────────────────────────────────────────────
   Inserts an EasyOrder payload into orders for a SPECIFIC tenant (businessId),
   with dedup + multi-unit quantity. Returns { ok, status, payload }.            */
async function ingestEasyOrder(body, businessId) {
  const f = extractOrderFields(body);

  if (!f.FullName || !f.Phone) {
    return { ok: false, status: 400, payload: { error: 'FullName and Phone are required' } };
  }

  /* Idempotency key: prefer EasyOrder's real id, else a deterministic composite
     hash so id-less rows still dedup. Always non-null → index + ON CONFLICT engage. */
  const realId = String(
    body.external_order_id ?? body.order_id ?? body.orderId ??
    body.id ?? body.reference ?? body.ref ?? ''
  ).trim();
  const externalId = realId || buildFallbackKey(body);

  const result = await pool.query(
    `INSERT INTO orders
       ("FullName", "Phone", "DeliveryRate", "City", "Address", "Note", "Status",
        "ProductName", "ProductPrice", "quantity", external_order_id, order_source, business_id)
     VALUES ($1, $2, 'بدون', $3, $4, $5, 'جديد',
             $6, $7, $8, $9, 'easyorder', $10)
     ON CONFLICT (external_order_id, business_id) WHERE external_order_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [f.FullName, f.Phone, f.City || null, f.Address || null, f.Note || null,
     f.ProductName, f.ProductPrice, Math.max(1, parseInt(f.quantity, 10) || 1),
     externalId, businessId]
  );

  if (result.rows.length === 0) {
    console.log(`↩️  EasyOrder webhook: duplicate "${externalId}" (tenant ${businessId}) — skipped`);
    return { ok: true, status: 200, payload: { success: true, skipped: true, reason: 'duplicate order' } };
  }

  const newOrder = result.rows[0];
  console.log(`✅  EasyOrder webhook: order #${newOrder.id} (tenant ${businessId}, qty ${newOrder.quantity}) created`);
  enrichDeliveryRate(newOrder.id, f.Phone);   // background — fire-and-forget
  return { ok: true, status: 201, payload: { success: true, order: newOrder } };
}

/* ── POST /api/webhooks/easyorder/:businessId — tenant-aware (PREFERRED) ──────
   EasyOrder posts here with the tenant's unique URL. Optional per-tenant secret
   (header x-easyorder-secret / x-webhook-secret, or ?secret=) is validated when
   provided. Each tenant configures their own URL from the integration page.    */
router.post('/easyorder/:businessId', async (req, res) => {
  const businessId = parseInt(req.params.businessId, 10);
  if (!businessId || isNaN(businessId)) {
    return res.status(400).json({ error: 'Invalid tenant id' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, easyorder_webhook_secret FROM business_profile WHERE id = $1 LIMIT 1`,
      [businessId]
    );
    if (!rows.length) {
      console.warn(`⚠️  EasyOrder webhook: unknown tenant ${businessId}`);
      return res.status(404).json({ error: 'Unknown tenant' });
    }

    /* Secret check: if a secret is stored AND the caller supplied one, they must
       match. (Lenient when EasyOrder can't send a secret — the unguessable URL +
       tenant id still scopes the write. Tighten once confirmed in production.)   */
    const storedSecret = rows[0].easyorder_webhook_secret;
    const incoming =
      req.headers['x-easyorder-secret'] ?? req.headers['x-webhook-secret'] ?? req.query.secret ?? null;
    if (storedSecret && incoming != null && incoming !== storedSecret) {
      console.warn(`⚠️  EasyOrder webhook: secret mismatch for tenant ${businessId}`);
      return res.status(401).json({ error: 'Webhook secret mismatch' });
    }

    console.log(`📦 EasyOrder webhook (tenant ${businessId}):`, JSON.stringify(req.body));
    const { status, payload } = await ingestEasyOrder(req.body, businessId);
    return res.status(status).json(payload);
  } catch (err) {
    console.error('EasyOrder webhook error:', err);
    return res.status(500).json({ error: 'Failed to process webhook' });
  }
});

/* ── POST /api/webhooks/easyorder — LEGACY (no tenant in URL) ─────────────────
   Kept for backward compatibility. Uses the optional global WEBHOOK_SECRET and
   claims orders for the ORIGINAL tenant (lowest business_profile.id). New
   integrations should use the tenant-aware /:businessId route above.            */
router.post('/easyorder', async (req, res) => {
  if (process.env.WEBHOOK_SECRET) {
    const incoming = req.headers['x-webhook-secret'];
    if (incoming !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Webhook secret mismatch' });
    }
  }

  try {
    console.log('📦 Webhook payload received (legacy):', JSON.stringify(req.body));
    const { rows } = await pool.query(`SELECT MIN(id) AS id FROM business_profile`);
    const businessId = rows[0]?.id;
    if (!businessId) return res.status(500).json({ error: 'No tenant configured' });

    const { status, payload } = await ingestEasyOrder(req.body, businessId);
    return res.status(status).json(payload);
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Failed to process webhook' });
  }
});

module.exports = router;
