const express = require('express');
const crypto  = require('crypto');
const pool    = require('../config/db');
const { enrichDeliveryRate } = require('../services/bostaEnrich');
const { recordSafqaOrder, updateSafqaStatusByPhone } = require('../services/externalAffiliate');
const { extractReferralCode, resolveMarketerCode } = require('../utils/referral');

/* Tenant's known media-buyer referral codes (users.referral_code). Used to
   resolve an EasyOrder utm_campaign → a canonical marketer at ingest. Returns
   [] on any error so attribution degrades to organic rather than failing. */
async function loadMarketerCodes(businessId) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT referral_code FROM users
        WHERE business_id = $1 AND referral_code IS NOT NULL AND TRIM(referral_code) <> ''`,
      [businessId]
    );
    return rows.map((r) => String(r.referral_code).trim());
  } catch (err) {
    console.warn('[EasyOrder webhook] loadMarketerCodes failed:', err.message);
    return [];
  }
}

/* Resolve a webhook URL identifier — either the numeric business id (legacy) OR a
   readable business-name slug (e.g. /easyorder/slaaa) — to the tenant row. */
async function resolveTenantByIdent(ident) {
  const s = String(ident ?? '').trim();
  if (!s) return null;
  const sql = `SELECT id, plan_type, easyorder_webhook_secret FROM business_profile`;
  const { rows } = /^\d+$/.test(s)
    ? await pool.query(`${sql} WHERE id = $1 LIMIT 1`, [parseInt(s, 10)])
    : await pool.query(`${sql} WHERE LOWER(slug) = LOWER($1) LIMIT 1`, [s]);
  return rows[0] || null;
}

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
    /* Media-Buyer attribution: the UTM/Sub-ID appended to the buyer's ad link. */
    referral_code: extractReferralCode(body),
  };
}

/* ── EXACT auto-commission — EasyOrder cost extraction ────────────────────────
   Commission = selling price − base cost. EasyOrder exposes the base cost under the
   key `expense` (confirmed from a live payload):
     • TOP-LEVEL `expense` = base cost + shipping, ALREADY aggregated over every item
       and quantity. So commission = total_cost − expense — shipping cancels and it
       is quantity-safe by construction. This is the PRIMARY path.
         e.g. total_cost 664 − expense 364 = 300  ( = selling 579 − base 279 ).
     • PER-ITEM `cart_items[].product.expense` = per-unit base cost (NO shipping):
       base = Σ(expense × qty); commission = (total_cost − shipping) − base. FALLBACK.
   ⚠️ CRITICAL: the SELLING price lives in `cost` / `price` / `sale_price` /
   `cart_items[].price` (all 579 here) — those are NEVER the base cost. */
function money(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
/* Per-item base cost (Σ over cart items × qty) from EasyOrder's per-item `expense`
   (with a few defensive aliases), or null when none is present. */
function extractItemBaseCost(body) {
  const items = Array.isArray(body?.cart_items) ? body.cart_items : [];
  let sum = 0, found = false;
  for (const it of items) {
    const qty = Math.max(1, parseInt(it?.quantity ?? it?.qty ?? 1, 10) || 1);
    let unit = null;
    for (const k of ['expense', 'buying_price', 'cost_price', 'base_cost', 'purchase_price', 'product_cost']) {
      unit = money(it?.product?.[k]) ?? money(it?.[k]);
      if (unit != null) break;
    }
    if (unit != null) { sum += unit * qty; found = true; }
  }
  return found ? sum : null;
}
/* EXACT net commission from the order's real EasyOrder costs. Returns 0 when no base
   cost is present (→ the Safqa webhook falls back to the fixed COMMISSION_RATES). */
function calcExactCommission(body) {
  const grossCod = money(body?.total_cost ?? body?.totalCost ?? body?.total) ?? 0;
  if (grossCod <= 0) return 0;
  const shipping = money(body?.shipping_cost ?? body?.shippingCost) ?? 0;
  /* PRIMARY: top-level `expense` = base + shipping → commission = total_cost − expense
     (quantity-safe). ⚠️ CRITICAL GUARD: a real base cost exists ONLY when
     expense > shipping. If expense == shipping the merchant set NO base cost (EO
     returns shipping alone), so total_cost − expense would be the WHOLE selling price
     — we must NOT treat that as commission. Fall through to per-item, then fixed-rate. */
  const topExpense = money(body?.expense);
  if (topExpense != null && topExpense > shipping && topExpense < grossCod) {
    return Math.round(grossCod - topExpense);
  }
  /* FALLBACK: per-item product.expense (pure base, no shipping) → subtract shipping. */
  const base = extractItemBaseCost(body);
  if (base != null && base > 0) { const c = (grossCod - shipping) - base; return c > 0 ? Math.round(c) : 0; }
  return 0;
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
/* ── Affiliate ingest (double-webhook strategy) ───────────────────────────────
   For AFFILIATE tenants the EasyOrder webhook is the CREATION + ATTRIBUTION source
   (Safqa's own webhook only does status updates and strips marketer/sku). We write
   a rich row into external_affiliate_orders with the marketer captured from the
   UTM/referral, full product/geo/qty details, and the customer phone (the key the
   Safqa status webhook later matches on). `total` is set to 0 — the marketer
   COMMISSION is unknown here and is filled in by the Safqa status push. */
async function ingestEasyOrderAffiliate(body, businessId) {
  const f = extractOrderFields(body);
  if (!f.FullName || !f.Phone) {
    return { ok: false, status: 400, payload: { error: 'FullName and Phone are required' } };
  }

  const externalId = String(
    body.id ?? body.short_id ?? body.shortId ??
    body.external_order_id ?? body.order_id ?? body.orderId ??
    body.reference ?? body.ref ?? ''
  ).trim() || buildFallbackKey(body);

  /* Marketer attribution: resolve the buyer from the payload against the tenant's
     known referral codes. This maps a utm_campaign that CONTAINS a buyer's name
     (e.g. "adham", "adham_botagaz") → the canonical code 'adham', and drops bare
     Facebook campaign ids → organic. Falls back to main_account when nothing
     attributable is present. (f.referral_code is the raw extract; this canonicalises.) */
  const knownCodes = await loadMarketerCodes(businessId);
  const marketer = resolveMarketerCode(body, knownCodes) || 'main_account';

  /* EXACT commission from EasyOrder's real costs (selling − base). HELD in
     calc_commission (NOT total) so this order can't enter the financials until
     Safqa accepts it; the Safqa-touch paths then promote it. 0 when no base cost
     was entered → the Safqa webhook falls back to the fixed COMMISSION_RATES. */
  const calcCommission = calcExactCommission(body);

  /* Build a Safqa-shaped order object so recordSafqaOrder handles the upsert,
     status classification, phone normalisation and full-envelope raw capture. */
  const syntheticOrder = {
    _id:           externalId,
    serial_number: externalId,
    status:        'pending',          // created — call-center confirmation not done yet
    status_ar:     'قيد المعالجة',
    total:         0,                  // stays 0 — commission is held in calc_commission
    calc_commission: calcCommission,   // exact (selling − base); promoted on Safqa touch
    /* Attribution: the canonical media-buyer resolved from utm_campaign / referral
       (see resolveMarketerCode above). Orders with no attributable buyer are
       ORGANIC → 'main_account' (not null/'-') so the dashboard can isolate them via
       the "الحساب الأساسي" filter instead of blending into the "all buyers" view. */
    marketer,
    product_name:  f.ProductName || null,
    sku:           f.sku || null,
    governorate:   f.City || null,
    note:          f.Note || null,
    quantity:      Math.max(1, parseInt(f.quantity, 10) || 1),
    client_phone1: f.Phone,
  };

  /* primaryCreate: this IS the order's creation event, so recordSafqaOrder must
     NOT phone-merge it into a prior open order (a repeat customer's earlier order
     is a DIFFERENT order, not a cross-channel duplicate). Idempotency for a
     double-fired webhook is still guaranteed by the external_id ON CONFLICT. */
  const r = await recordSafqaOrder(syntheticOrder, businessId, { fullBody: body, primaryCreate: true });
  if (!r.ok) return { ok: false, status: 400, payload: { error: r.reason || 'ingest failed' } };
  console.log(`✅  EasyOrder→affiliate: ${r.inserted ? 'created' : 'updated'} order "${externalId}" ` +
              `(tenant ${businessId}, marketer="${syntheticOrder.marketer ?? '∅'}", sku="${syntheticOrder.sku ?? '∅'}")`);
  return { ok: true, status: r.inserted ? 201 : 200, payload: { success: true, external_id: externalId, marketer: syntheticOrder.marketer } };
}

async function ingestEasyOrder(body, businessId, planType = 'ecommerce') {
  /* Affiliate tenants route to external_affiliate_orders (creation + attribution). */
  if (planType === 'affiliate') {
    return ingestEasyOrderAffiliate(body, businessId);
  }

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
        "ProductName", "ProductPrice", "sku", "quantity", external_order_id,
        referral_code, order_source, business_id)
     VALUES ($1, $2, 'بدون', $3, $4, $5, 'جديد',
             $6, $7, $8, $9, $10, $11, 'easyorder', $12)
     ON CONFLICT (external_order_id, business_id) WHERE external_order_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [f.FullName, f.Phone, f.City || null, f.Address || null, f.Note || null,
     f.ProductName, f.ProductPrice, f.sku || null, Math.max(1, parseInt(f.quantity, 10) || 1),
     externalId, f.referral_code || null, businessId]
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
router.get('/easyorder/:ident', (req, res) => {
  res.status(200).json({
    ok: true,
    endpoint: 'easyorder-webhook',
    tenant_ident: req.params.ident,
    method_expected: 'POST',
    message: 'EasyOrder webhook endpoint is live. Send order payloads via POST.',
  });
});

/* ── POST /api/webhooks/easyorder/:businessId — tenant-aware (PREFERRED) ──────
   EasyOrder posts here with the tenant's unique URL. Optional per-tenant secret
   (header x-easyorder-secret / x-webhook-secret, or ?secret=) is validated when
   provided. Each tenant configures their own URL from the integration page.    */
router.post('/easyorder/:ident', async (req, res) => {
  try {
    /* :ident is either the readable business slug (preferred — e.g. /easyorder/slaaa)
       or the numeric business id (legacy). Both resolve to the same tenant. */
    const tenant = await resolveTenantByIdent(req.params.ident);
    if (!tenant) {
      console.warn(`⚠️  EasyOrder webhook: unknown tenant "${req.params.ident}"`);
      return res.status(404).json({ error: 'Unknown tenant' });
    }

    /* Secret check: if a secret is stored AND the caller supplied one, they must
       match. (Lenient when EasyOrder can't send a secret — the unguessable slug
       still scopes the write. Tighten once confirmed in production.)             */
    const storedSecret = tenant.easyorder_webhook_secret;
    const incoming =
      req.headers['x-easyorder-secret'] ?? req.headers['x-webhook-secret'] ?? req.query.secret ?? null;
    if (storedSecret && incoming != null && incoming !== storedSecret) {
      console.warn(`⚠️  EasyOrder webhook: secret mismatch for tenant ${tenant.id}`);
      return res.status(401).json({ error: 'Webhook secret mismatch' });
    }

    console.log(`📦 EasyOrder webhook (tenant ${tenant.id}, plan ${tenant.plan_type}):`, JSON.stringify(req.body));
    const { status, payload } = await ingestEasyOrder(req.body, tenant.id, tenant.plan_type);
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
    const { rows } = await pool.query(
      `SELECT id, plan_type FROM business_profile ORDER BY id ASC LIMIT 1`);
    const tenant = rows[0];
    if (!tenant?.id) return res.status(500).json({ error: 'No tenant configured' });

    const { status, payload } = await ingestEasyOrder(req.body, tenant.id, tenant.plan_type);
    return res.status(status).json(payload);
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Failed to process webhook' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   SAFQA  —  orderHook (PUSH) receiver
   ────────────────────────────────────────────────────────────────────────────
   Safqa has no GET API; it PUSHES real-time order updates to the per-tenant URL
   the merchant registers as their `orderHook`. We validate the tenant, then upsert
   each pushed order into external_affiliate_orders (recordSafqaOrder), which the
   dashboard aggregates from. Always 200 on a well-formed event so Safqa doesn't
   retry-storm; malformed bodies get a 400.
   ════════════════════════════════════════════════════════════════════════════ */

/* GET — browser health check (confirms THIS build is deployed; no DB writes). */
router.get('/safqa/:businessId', (req, res) => {
  res.status(200).json({
    ok: true,
    endpoint: 'safqa-webhook',
    business_id: req.params.businessId,
    method_expected: 'POST',
    message: 'Safqa orderHook endpoint is live. Register this URL as your orderHook; any pushed order (created or status-updated) is ingested.',
  });
});

/* POST — Safqa orderHook. Body: { event, order: { _id, status, status_ar, total, marketer } } */
router.post('/safqa/:businessId', async (req, res) => {
  const businessId = parseInt(req.params.businessId, 10);
  if (!businessId || isNaN(businessId)) {
    return res.status(400).json({ error: 'Invalid tenant id' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id FROM business_profile WHERE id = $1 LIMIT 1`,
      [businessId]
    );
    if (!rows.length) {
      console.warn(`⚠️  Safqa webhook: unknown tenant ${businessId}`);
      return res.status(404).json({ error: 'Unknown tenant' });
    }

    const body  = req.body || {};
    const event = String(body.event ?? '').trim();

    /* Locate the order object anywhere Safqa might put it. We INGEST ANY payload
       that carries a valid order — regardless of the `event` string (created /
       updated / status.updated / anything) — so the very first push (order
       creation) is never dropped. */
    const order =
      (body.order && typeof body.order === 'object')                                   ? body.order
      : (body.data?.order && typeof body.data.order === 'object')                      ? body.data.order
      : (body.data && typeof body.data === 'object' && (body.data._id || body.data.id)) ? body.data
      : (body._id || body.id)                                                          ? body
      : null;

    /* FULL envelope logged (NOT truncated) so any envelope-level tracking Safqa
       sends (sub-id / UTM / query params / metadata) is visible in the PM2 logs.
       Grep with: pm2 logs scalyo-backend | grep "Safqa webhook FULL". */
    console.log(`📦 Safqa webhook FULL (tenant ${businessId}) event="${event || '(none)'}":`, JSON.stringify(body));

    if (!order || typeof order !== 'object' || !(order._id || order.id)) {
      return res.status(400).json({ error: 'Missing or invalid order object' });
    }

    /* DOUBLE-WEBHOOK STRATEGY: Safqa now does STATUS UPDATES ONLY. EasyOrder
       created the rich row (marketer/sku/geo/phone); the Safqa push carries only
       status + client_phone1 (+commission `total`). Match the existing row by
       phone and update its status/commission — do NOT create a new marketer-less,
       sku-less row. */
    /* ── SAFQA = SUPPLEMENT ONLY ─────────────────────────────────────────────────
       EasyOrder is the PRIMARY source (it owns marketer + commission). The Safqa
       webhook must only MATCH the existing EasyOrder row (by phone) and inject the
       serial + confirm status — it must NEVER spawn a standalone sk- row, which was
       the "duplicate factory" behind the dual-webhook clash. */
    const matchRes = await updateSafqaStatusByPhone(order, businessId);
    if (matchRes.matched) {
      return res.status(200).json({
        ok: true, action: 'supplemented', external_id: matchRes.externalId,
        safqa_serial: matchRes.safqaSerial, status_class: matchRes.statusClass,
      });
    }

    /* No EasyOrder row for this phone yet (e.g. Safqa push arrived before EasyOrder's,
       or a Safqa-only order). DEFAULT: SKIP — do NOT create an sk- row (that's what
       produced the duplicates). The order is ingested when its EasyOrder webhook
       arrives, and the next Safqa push then supplements its serial. Opt back into the
       legacy create ONLY with SAFQA_CREATE_ON_NO_MATCH=true. Always 200 (no retry-storm). */
    const allowCreate = String(process.env.SAFQA_CREATE_ON_NO_MATCH).toLowerCase() === 'true';
    if (allowCreate) {
      const created = await recordSafqaOrder(order, businessId, { fullBody: body, totalIsGross: true });
      console.log(`ℹ️  Safqa webhook: no phone match → legacy create (opt-in) external_id=${created.externalId}, tenant ${businessId}`);
      return res.status(200).json({ ok: true, action: created.inserted ? 'created' : 'updated', external_id: created.externalId, status_class: created.statusClass });
    }
    console.log(
      `ℹ️  Safqa webhook: no EasyOrder row for phone (${matchRes.reason}) — supplement SKIPPED (no sk- row created). ` +
      `serial=${order.serial_number ?? order._id}, tenant ${businessId}. Will supplement once EasyOrder ingests it.`
    );
    return res.status(200).json({ ok: true, action: 'skipped_no_match', reason: matchRes.reason });
  } catch (err) {
    console.error('Safqa webhook error:', err);
    return res.status(500).json({ error: 'Failed to process webhook' });
  }
});

module.exports = router;
/* Exposed for unit tests / reuse (does not affect the router mount). */
module.exports.calcExactCommission = calcExactCommission;
