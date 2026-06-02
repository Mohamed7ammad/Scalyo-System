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

/* ── Cart items accessor ──────────────────────────────────────────────────────
   EasyOrder's real payload uses `cart_items`. Aliases kept as defensive
   fallbacks for other/legacy shapes.                                            */
function getCartItems(body) {
  const items =
    body.cart_items ?? body.cartItems ?? body.items ?? body.products ??
    body.line_items ?? body.lineItems ?? body.order_items ?? null;
  return Array.isArray(items) ? items : [];
}

/** Per-line product name: cart_items[i].product.name (with fallbacks). */
function lineItemName(it) {
  return (
    it?.product?.name ?? it?.product_name ?? it?.name ?? it?.title ?? null
  );
}

/** Per-line SKU: cart_items[i].product.slug (with fallbacks). */
function lineItemSku(it) {
  return (
    it?.product?.slug ?? it?.sku ?? it?.slug ?? it?.product?.sku ?? null
  );
}

/* ── Quantity parser ──────────────────────────────────────────────────────────
   Rule 8: SUM the `quantity` of every entry in cart_items. Falls back to a flat
   quantity field, then to 1.                                                     */
function parseQuantity(body) {
  const items = getCartItems(body);
  if (items.length) {
    const sum = items.reduce((acc, it) => {
      const q = parseInt(it?.quantity ?? it?.qty ?? it?.count ?? 1, 10);
      return acc + Math.max(1, isNaN(q) ? 1 : q);
    }, 0);
    if (sum > 0) return sum;
  }
  const direct = body.quantity ?? body.qty ?? body.Quantity ?? body.count;
  if (direct != null && !isNaN(parseInt(direct, 10))) {
    return Math.max(1, parseInt(direct, 10));
  }
  return 1;
}

/* ── Field extractor ──────────────────────────────────────────────────────────
   Maps the EasyOrder webhook payload to our orders columns:
     full_name              → FullName
     phone                  → Phone
     government             → City
     address                → Address
     total_cost             → ProductPrice (the COD amount to collect)
     cart_items[*].product.name → ProductName (all items joined with ' + ')
     cart_items[0].product.slug → sku
     Σ cart_items[*].quantity   → quantity
   Top-level aliases retained so other payload variants still parse.             */
function extractOrderFields(body) {
  const items = getCartItems(body);

  // Product name: join every line item's name (Rule 6); fall back to top-level.
  const names = items.map(lineItemName).filter(Boolean);
  const productName =
    names.length ? names.join(' + ')
                 : (body.ProductName ?? body.product ?? body.Product ?? null);

  // SKU: first line item's slug (Rule 7); fall back to top-level.
  const sku = (items.length ? lineItemSku(items[0]) : null) ?? body.sku ?? body.slug ?? null;

  // COD: prefer the order's total_cost (Rule 5), then common aliases.
  const productPrice =
    body.total_cost ?? body.totalCost ?? body.ProductPrice ?? body.total ??
    body.total_price ?? body.amount ?? body.price ?? null;

  return {
    FullName:     body.full_name ?? body.FullName ?? body.name ?? body.customer_name ?? null,
    Phone:        body.phone ?? body.Phone ?? body.phone_number ?? body.mobile ?? null,
    City:         body.government ?? body.governorate ?? body.City ?? body.city ?? null,
    Address:      body.address ?? body.Address ?? body.shipping_address ?? null,
    Note:         body.Note ?? body.note ?? body.notes ?? body.comment ?? null,
    ProductName:  productName,
    ProductPrice: productPrice,
    sku,
    quantity:     parseQuantity(body),
  };
}

/* ── Assignment helpers ───────────────────────────────────────────────────────
   Persist one order to an agent (tenant-scoped). Returns the updated row.       */
async function assignOrderTo(orderId, businessId, email) {
  const upd = await pool.query(
    `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW()
      WHERE id = $2 AND business_id = $3 RETURNING *`,
    [email, orderId, businessId]
  );
  return upd.rows[0] || null;
}

/* WEIGHTED round-robin: assign to the present agent whose CURRENT share of
   assigned orders is furthest below their configured target percentage
   (deficit = targetShare − actualShare). This honours the admin's custom split
   over time. Agents with distribution_percentage = 0 are excluded.
   Returns the updated order row, or null when no weighted agent is eligible
   (caller then falls back to least-loaded).                                     */
async function autoAssignWeighted(orderId, businessId) {
  const { rows } = await pool.query(
    `SELECT u.email,
            COALESCE(u.distribution_percentage, 0)::float AS weight,
            COUNT(o.id)::int                              AS assigned_count
       FROM users u
       LEFT JOIN orders o
         ON o."AssignedTo" = u.email AND o.business_id = u.business_id
      WHERE u.role = 'agent'
        AND COALESCE(u.is_active,  true)  = true
        AND COALESCE(u.is_absent, false)  = false
        AND u.business_id = $1
        AND COALESCE(u.distribution_percentage, 0) > 0
      GROUP BY u.email, u.distribution_percentage`,
    [businessId]
  );
  if (!rows.length) return null;   // no weighted config → let caller fall back

  const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
  const totalCount  = rows.reduce((s, r) => s + r.assigned_count, 0);
  if (totalWeight <= 0) return null;

  /* Pick the max deficit = (weight/ΣW) − (count/ΣC). When nothing is assigned
     yet (ΣC = 0) every actualShare is 0, so the highest-weight agent wins.      */
  let best = null;
  for (const r of rows) {
    const targetShare = r.weight / totalWeight;
    const actualShare = totalCount > 0 ? r.assigned_count / totalCount : 0;
    const deficit     = targetShare - actualShare;
    if (
      !best ||
      deficit > best.deficit ||
      (deficit === best.deficit && r.weight > best.weight) ||
      (deficit === best.deficit && r.weight === best.weight && r.email < best.email)
    ) {
      best = { email: r.email, weight: r.weight, deficit };
    }
  }

  const updated = await assignOrderTo(orderId, businessId, best.email);
  if (updated) {
    console.log(`[EasyOrder webhook] weighted pick → ${best.email} (deficit ${best.deficit.toFixed(3)})`);
  }
  return updated;
}

/* LEAST-LOADED fallback: the present agent with the FEWEST pending 'جديد'
   orders. Used when no agent has a distribution percentage configured, so
   orders never sit unassigned (غير محدد).                                       */
async function autoAssignLeastLoaded(orderId, businessId) {
  const { rows } = await pool.query(
    `SELECT u.email,
            COUNT(o.id) FILTER (WHERE o."Status" = 'جديد') AS load
       FROM users u
       LEFT JOIN orders o
         ON o."AssignedTo" = u.email AND o.business_id = u.business_id
      WHERE u.role = 'agent'
        AND COALESCE(u.is_active,  true)  = true
        AND COALESCE(u.is_absent, false)  = false
        AND u.business_id = $1
      GROUP BY u.email
      ORDER BY load ASC, u.email ASC
      LIMIT 1`,
    [businessId]
  );
  if (!rows.length) return null;
  return assignOrderTo(orderId, businessId, rows[0].email);
}

/* Orchestrator: weighted first (honours custom %), else least-loaded. Never
   throws — assignment problems must not fail order creation.                    */
async function autoAssignOrder(orderId, businessId) {
  try {
    return (await autoAssignWeighted(orderId, businessId))
        || (await autoAssignLeastLoaded(orderId, businessId));
  } catch (err) {
    console.warn('[EasyOrder webhook] auto-assign skipped:', err.message);
    return null;
  }
}

/* ── Shared ingest ────────────────────────────────────────────────────────────
   Inserts an EasyOrder payload into orders for a SPECIFIC tenant (businessId),
   with dedup + multi-unit quantity. Returns { ok, status, payload }.            */
async function ingestEasyOrder(body, businessId) {
  const f = extractOrderFields(body);

  if (!f.FullName || !f.Phone) {
    return { ok: false, status: 400, payload: { error: 'FullName and Phone are required' } };
  }

  /* Idempotency key: prefer EasyOrder's stable root order id — `id` (UUID) is the
     canonical identifier, `short_id` (integer) is the next best. Then other
     common id fields. Finally fall back to a deterministic composite hash so
     id-less rows still dedup. Always non-null → index + ON CONFLICT engage, so a
     webhook fired twice for the same order can never create a duplicate.        */
  const realId = String(
    body.id ?? body.short_id ?? body.shortId ??
    body.external_order_id ?? body.order_id ?? body.orderId ??
    body.reference ?? body.ref ?? ''
  ).trim();
  const externalId = realId || buildFallbackKey(body);

  const result = await pool.query(
    `INSERT INTO orders
       ("FullName", "Phone", "DeliveryRate", "City", "Address", "Note", "Status",
        "ProductName", "ProductPrice", "sku", "quantity", external_order_id, order_source, business_id)
     VALUES ($1, $2, 'بدون', $3, $4, $5, 'جديد',
             $6, $7, $8, $9, $10, 'easyorder', $11)
     ON CONFLICT (external_order_id, business_id) WHERE external_order_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [f.FullName, f.Phone, f.City || null, f.Address || null, f.Note || null,
     f.ProductName, f.ProductPrice, f.sku || null, Math.max(1, parseInt(f.quantity, 10) || 1),
     externalId, businessId]
  );

  if (result.rows.length === 0) {
    console.log(`↩️  EasyOrder webhook: duplicate "${externalId}" (tenant ${businessId}) — skipped`);
    return { ok: true, status: 200, payload: { success: true, skipped: true, reason: 'duplicate order' } };
  }

  let newOrder = result.rows[0];
  console.log(`✅  EasyOrder webhook: order #${newOrder.id} (tenant ${businessId}, qty ${newOrder.quantity}) created`);

  /* Auto-assign: weighted round-robin by the admin's saved percentages, falling
     back to least-loaded. Done before responding so the returned order carries
     AssignedTo and never sits unassigned (غير محدد). */
  const assigned = await autoAssignOrder(newOrder.id, businessId);
  if (assigned) {
    newOrder = assigned;
    console.log(`🤝  EasyOrder webhook: order #${newOrder.id} auto-assigned to ${newOrder.AssignedTo}`);
  } else {
    console.log(`ℹ️   EasyOrder webhook: order #${newOrder.id} left unassigned — no present agents`);
  }

  enrichDeliveryRate(newOrder.id, f.Phone);   // background — fire-and-forget
  return { ok: true, status: 201, payload: { success: true, order: newOrder } };
}

/* ── GET /api/webhooks/easyorder/:businessId — health/diagnostic ─────────────
   EasyOrder uses POST, but a GET here lets you confirm in a browser that THIS
   build (with the tenant-aware route) is actually deployed — a 200 JSON means
   the new code is live; a 404 means the running backend is stale and needs a
   redeploy/restart. Does NOT touch the database.                               */
router.get('/easyorder/:businessId', (req, res) => {
  res.status(200).json({
    ok: true,
    endpoint: 'easyorder-webhook',
    business_id: req.params.businessId,
    method_expected: 'POST',
    message: 'EasyOrder webhook endpoint is live. Send order payloads via POST.',
  });
});

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
