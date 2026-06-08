'use strict';

const express = require('express');
const pool    = require('../config/db');
const { captureActualShippingFee } = require('../services/bostaShippingFee');

const router = express.Router();

/* ─────────────────────────────────────────────────────────────────────────
   Bosta Inbound Webhook  —  POST /api/webhooks/bosta
   ─────────────────────────────────────────────────────────────────────────

   EVENT HANDLING TABLE:
   ┌──────────────────────────────┬──────────────────────────────────────────┐
   │ Bosta status                 │ Actions taken                            │
   ├──────────────────────────────┼──────────────────────────────────────────┤
   │ delivered                    │ Order status + COD → treasury_transactions│
   │ returned /                   │ Order status + stock +1 + product_returns │
   │   delivered_to_merchant      │                                          │
   │ out_for_delivery             │ Order status only                        │
   │ returning_to_merchant        │ Order status only — parcel still in transit│
   │ cancelled / canceled /       │ → 'جاري الإعادة' (RTO): leaves in-transit, │
   │   terminated                 │   restock deferred to physical 'returned' │
   │ (any unmapped status)        │ Log only — order row untouched           │
   └──────────────────────────────┴──────────────────────────────────────────┘

   Stock matching strategy (mirrors orders.js):
   ┌─────────────────────────────────────────────────────────────────────┐
   │ order.sku is set   →  UPDATE products WHERE sku = $1  (exact)      │
   │ order.sku is NULL  →  UPDATE products WHERE TRIM(name) = TRIM($1)  │
   │                       (legacy fallback for pre-SKU orders)         │
   └─────────────────────────────────────────────────────────────────────┘

   Idempotency (webhook retry safety):
   ┌─────────────────────────────────────────────────────────────────────┐
   │ delivered  → partial unique index on treasury_transactions(order_id)│
   │              WHERE source = 'bosta_cod' prevents duplicate revenue  │
   │ returned   → pre-flight SELECT on product_returns(order_id) prevents│
   │              double stock increment; partial unique index is the DB │
   │              backstop for simultaneous retries                      │
   └─────────────────────────────────────────────────────────────────────┘
   ───────────────────────────────────────────────────────────────────────── */

/**
 * The ONLY statuses that confirm the item is physically back at the warehouse.
 * 'returning_to_merchant' is intentionally absent — the parcel is still in transit.
 */
const FINAL_RETURN_STATUSES = new Set(['returned', 'delivered_to_merchant']);

/**
 * Bosta canonical status → Arabic order status label.
 * Statuses absent from this map are logged but leave the order row unchanged.
 */
const BOSTA_TO_ORDER_STATUS = {
  'out_for_delivery':      'تم الشحن',
  'delivered':             'تم التوصيل',
  // Bosta only emits webhooks for parcels already in its system (i.e. dispatched),
  // so a 'cancelled'/'canceled'/'terminated' event is a SHIPPED parcel being killed
  // → it is return-bound (RTO), NOT a pre-ship rejection. Map it to the in-transit
  // return leg so it (a) leaves "قيد التوصيل"/in-transit immediately and counts
  // toward returns/NDR, and (b) restocks ONLY once it is physically received
  // (code 46 / 'returned'), never prematurely. Was 'تم الرفض', which stranded the
  // parcel outside the return pipeline and never restored its deducted stock.
  'cancelled':             'جاري الإعادة',   // RTO in transit back — NO stock change yet
  'returning_to_merchant': 'جاري الإعادة',   // in transit back — NO stock change
  'returned':              'تم الإرجاع',     // physically received → triggers stock+N
  'delivered_to_merchant': 'تم الإرجاع',     // alternate Bosta field for same event
};

/**
 * Bosta sends statuses in many shapes across versions/locales:
 *   snake_case ("out_for_delivery"), Title Case ("Out for Delivery"),
 *   or descriptive returns ("Returned to business", "Returned to Merchant").
 * This collapses any incoming string to one of our canonical keys above.
 *
 * Returns a canonical key string, or the underscored form if unrecognised.
 */
const STATUS_ALIASES = {
  'delivered':                    'delivered',
  'out for delivery':             'out_for_delivery',
  'out_for_delivery':             'out_for_delivery',
  'cancelled':                    'cancelled',
  'canceled':                     'cancelled',
  'terminated':                   'cancelled',
  // ── In-transit back to merchant (NO stock change) ──
  'returning to business':        'returning_to_merchant',
  'returning to merchant':        'returning_to_merchant',
  'returning_to_merchant':        'returning_to_merchant',
  'in return':                    'returning_to_merchant',
  // ── Physically returned / received by merchant (TRIGGERS restock) ──
  'returned':                     'returned',
  'returned to business':         'returned',
  'returned to merchant':         'returned',
  'return to merchant':           'returned',
  'returned to the merchant':     'returned',
  'delivered to merchant':        'delivered_to_merchant',
  'delivered to business':        'delivered_to_merchant',
  'package received at warehouse':'returned',
  'returned to origin':           'returned',
  'returned to sender':           'returned',
  // ── Arabic state names (Bosta nameAr) — used by the backfill sync ──
  'تم الاسترجاع':                 'returned',   // ← Bosta "Unsuccessful → Returned"
  'تم الإرجاع':                   'returned',
  'تم الارجاع':                   'returned',
  'مرتجع':                        'returned',
  'مرتجع للتاجر':                 'returned',
  'تم الاسترداد':                 'returned',
};

function canonicalizeStatus(statusStr) {
  if (!statusStr) return null;
  const key = String(statusStr).toLowerCase().replace(/\s+/g, ' ').trim();
  if (STATUS_ALIASES[key]) return STATUS_ALIASES[key];
  // Fall back to the underscored form so snake_case inputs still pass through.
  return key.replace(/ /g, '_');
}

/**
 * Parse the Bosta webhook body and extract the fields we need.
 * Bosta's envelope varies across API versions; we handle both known shapes.
 *
 * Returns: { trackingNumber, statusStr, webhookCod, isReturn }
 *   webhookCod — the COD amount Bosta reports in the payload (may be null)
 *   isReturn   — Bosta's structural return flag (a return parcel can report a
 *                "Delivered" state that actually means "delivered BACK to us")
 */
function parseBostaPayload(body) {
  const root = body?.data ?? body;

  const trackingNumber =
    root?.trackingNumber  ??
    root?.tracking_number ??
    root?.TrackingNumber  ??
    null;

  // Status can arrive as a flat string OR a nested { value, code } object
  const rawStatus =
    root?.state?.value ??
    root?.status       ??
    root?.state        ??
    null;

  const statusStr = typeof rawStatus === 'string'
    ? rawStatus.toLowerCase().trim()
    : null;

  // Numeric Bosta state code (e.g. 45/46 = returned to business). Far more
  // reliable than the localised string when present.
  const rawCode =
    root?.state?.code ??
    root?.state?.stateCode ??
    root?.stateCode ??
    (typeof root?.state === 'number' ? root.state : null);
  const stateCode = rawCode != null && !isNaN(Number(rawCode)) ? Number(rawCode) : null;

  // Structural return flag — far more reliable than parsing the state string.
  const isReturn =
    root?.isReturn === true ||
    root?.is_return === true ||
    root?.type === 30 ||
    body?.isReturn === true;

  // COD amount — try multiple fields across Bosta payload versions
  const rawCod =
    root?.specs?.cod             ??   // most common V2 field
    root?.cod                    ??   // top-level fallback
    root?.deliverySpecs?.cod     ??   // V1 shape
    null;
  const webhookCod = rawCod !== null && rawCod !== undefined && !isNaN(Number(rawCod))
    ? Math.max(0, parseFloat(rawCod))
    : null;

  /* Actual delivery timestamp Bosta reports (ISO). Used to stamp delivered_at
     so analytics can date deliveries precisely. Null when not present. */
  const rawDeliveryTime =
    root?.state?.deliveryTime ??
    root?.deliveryTime        ??
    root?.deliveredAt         ??
    root?.state?.delivering?.time ??
    null;
  const deliveredAt = rawDeliveryTime && !isNaN(new Date(rawDeliveryTime).getTime())
    ? new Date(rawDeliveryTime).toISOString()
    : null;

  return { trackingNumber, statusStr, stateCode, webhookCod, isReturn, deliveredAt };
}

/**
 * Bosta numeric state code for a SUCCESSFUL delivery to the consignee.
 * Code 45 = "Delivered" — a terminal SUCCESS state, NOT a return. Used as a
 * locale-independent positive signal so a delivery is recognised even when the
 * status string is missing or localised in Arabic.
 */
const DELIVERED_STATE_CODES = new Set([45]);

/**
 * Bosta numeric state codes that mean the parcel was PHYSICALLY returned to the
 * merchant/origin (RTO complete → triggers restock). Code 46 = "Returned to
 * business".
 *
 * IMPORTANT — codes deliberately EXCLUDED:
 *   • 45  → "Delivered" (success). It was previously (incorrectly) listed here,
 *           which force-reclassified every delivered parcel as a return — the
 *           order never reached 'تم التوصيل', so revenue and the delivered count
 *           read 0 on the dashboard. THIS was the analytics-breaking bug.
 *   • 47  → "Returning to merchant" but still IN TRANSIT (the dashboard exposes
 *           it as the in-flight '47:R' returning leg, never in the received-back
 *           tab). Forcing 'returned' here would restock + finalise a parcel that
 *           has not physically arrived. The status string maps it correctly to
 *           'returning_to_merchant' (جاري الإعادة, no stock change).
 */
const RETURN_STATE_CODES = new Set([46]);

/**
 * Calculate the net COD amount from the order's own DB fields.
 * Used as a fallback when the Bosta webhook payload doesn't include a COD value.
 *
 * Mirrors the calcCod() logic in shipping.js:
 *   net = max(0, productPrice − depositAmount)
 */
function calcOrderCod(order) {
  const price   = parseFloat(String(order.ProductPrice || '0').replace(/[^\d.]/g, '')) || 0;
  const deposit = Math.max(0, parseFloat(order.depositAmount) || 0);
  return parseFloat(Math.max(0, price - deposit).toFixed(2));
}

/* ── Shared physical-return processor ─────────────────────────────────────────
   The SINGLE source of truth for applying a PHYSICAL return — used by BOTH the
   live Bosta webhook and the backfill sync (routes/bosta.js). Idempotent:
     1. Status → 'تم الإرجاع'  (idempotent UPDATE)
     2. Stock replenished by `quantity` — SKU-first, name fallback
     3. Logged ONCE in product_returns (order_id partial-unique → no double-count)

   `order` must carry: id, ProductName, sku, quantity, business_id.
   Returns { statusUpdated, alreadyLogged, restocked, qty }. Throws only on a
   genuine DB error (caller decides how to surface it).                        */
async function applyPhysicalReturn(order) {
  const businessId  = order.business_id ?? null;
  const productName = (order.ProductName || '').trim();
  const orderSku    = order.sku ? String(order.sku).trim() : null;
  const orderQty    = Math.max(1, parseInt(order.quantity, 10) || 1);

  // 1. Status → returned (idempotent). Also clear stock_deducted: the physical
  //    restock below returns this order's units, so it no longer holds committed
  //    stock — this keeps the orders.js PATCH inventory hook from restocking it
  //    a second time on any later manual status change.
  await pool.query(
    `UPDATE orders SET "Status" = 'تم الإرجاع', "stock_deducted" = false, "updatedAt" = NOW()
      WHERE id = $1 AND business_id = $2`,
    [order.id, businessId]
  );

  // 2. Idempotency CLAIM — insert the return row first and let the partial unique
  //    index decide. If the order was already logged, ON CONFLICT inserts nothing
  //    and we skip the restock entirely → a return can NEVER be double-counted,
  //    even under concurrent webhook + sync delivery. Tying the restock to winning
  //    this insert is safer than a separate SELECT gate (no check-then-act window).
  const claim = await pool.query(
    `INSERT INTO product_returns (product_name, sku, order_id, return_date, quantity, business_id)
     VALUES ($1, $2, $3, CURRENT_DATE, $4, $5)
     ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [productName, orderSku, order.id, orderQty, businessId]
  );
  if (claim.rowCount === 0) {
    return { statusUpdated: true, alreadyLogged: true, restocked: false, qty: orderQty };
  }

  // 3. Stock replenishment — ATOMIC + alias-aware. Matches the order's sku OR name
  //    against a product's sku, name, OR any aliases[] entry (case-insensitive,
  //    trimmed; exact SKU preferred) — the SAME resolution as resolveProductForOrder
  //    used at order time, so a return whose sku is a campaign alias (or whose name
  //    drifted in case/spacing) still restocks the right product instead of being
  //    silently skipped. Done as ONE statement so the increment stays atomic and
  //    concurrent restocks can never overwrite each other.
  let restocked = false;
  if (productName || orderSku) {
    const r = await pool.query(
      `UPDATE products
          SET stock_quantity = stock_quantity + $3
        WHERE business_id = $4
          AND id = (
            SELECT id FROM products
             WHERE business_id = $4
               AND (
                     LOWER(TRIM(sku))  = LOWER(NULLIF($1, ''))
                  OR LOWER(TRIM(name)) = LOWER(NULLIF($2, ''))
                  OR EXISTS (
                       SELECT 1 FROM unnest(COALESCE(aliases, '{}'::text[])) AS a
                        WHERE LOWER(TRIM(a)) = LOWER(NULLIF($1, ''))
                           OR LOWER(TRIM(a)) = LOWER(NULLIF($2, ''))
                     )
                   )
             ORDER BY CASE
                        WHEN LOWER(TRIM(sku))  = LOWER(NULLIF($1, '')) THEN 1
                        WHEN LOWER(TRIM(name)) = LOWER(NULLIF($2, '')) THEN 2
                        ELSE 3
                      END
             LIMIT 1
          )
        RETURNING name, stock_quantity`,
      [orderSku, productName, orderQty, businessId]
    );
    restocked = r.rowCount > 0;
  }

  return { statusUpdated: true, alreadyLogged: false, restocked, qty: orderQty };
}

/* ── Idempotent schema migrations ─────────────────────────────────────────
   All run at startup; safe to repeat on every deploy.                      */

/* ── delivered_at — the TRUE delivery timestamp (from Bosta state.deliveryTime,
   fallback NOW() at the moment the delivered event is processed). Lets analytics
   filter delivered orders by WHEN they were delivered, not when the order was
   placed ("createdAt"). Nullable; set only on the delivered transition.      */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`)
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS orders_delivered_at_idx ON orders (delivered_at)`))
  .then(() => console.log('✅  Orders: delivered_at column + index ready'))
  .catch((err) => console.warn('⚠️   delivered_at migration skipped:', err.message));

/* ── expected_cod — Bosta's LIVE collectable COD per order ────────────────────
   The amount Bosta currently expects to COLLECT for this parcel. Bosta zeroes it
   ("بدون تحصيل") the instant a parcel becomes return-bound, so it's the reliable
   signal that separates real forward cash from return-leg ghost money in the
   forecasting pipeline. NULL = not yet reported by Bosta → analytics falls back to
   (ProductPrice − depositAmount) for genuinely-forward, not-yet-synced orders. */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS expected_cod NUMERIC(12,2)`)
  .then(() => console.log('✅  Orders: expected_cod column ready'))
  .catch((err) => console.warn('⚠️   expected_cod migration skipped:', err.message));

/* ── bosta_action_required — parcel is in Bosta's "في انتظار متابعتك" bucket ───
   A delivery exception the merchant must act on (failed attempts, address issue…).
   It is NOT actively moving toward the customer, so it is EXCLUDED from the
   forecasting pipeline (in-transit count + outstanding cash). Maintained as a live
   mirror by the hourly Bosta reconciliation; cleared automatically when the parcel
   recovers (back to a forward state) or leaves 'تم الشحن'. */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bosta_action_required BOOLEAN NOT NULL DEFAULT FALSE`)
  .then(() => console.log('✅  Orders: bosta_action_required column ready'))
  .catch((err) => console.warn('⚠️   bosta_action_required migration skipped:', err.message));

/* ── product_returns table ─────────────────────────────────────────────── */
pool.query(`
  CREATE TABLE IF NOT EXISTS product_returns (
    id            SERIAL        PRIMARY KEY,
    product_name  VARCHAR(255)  NOT NULL,
    return_date   DATE          NOT NULL DEFAULT CURRENT_DATE,
    quantity      INTEGER       NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ   DEFAULT NOW()
    /* No (product_name, return_date) UNIQUE here: manual returns are kept unique
       per day via the PARTIAL index product_returns_manual_name_date_uidx
       (WHERE order_id IS NULL); webhook per-order rows use the order_id index. */
  )
`)
  .then(() =>
    /* sku — direct link to product catalogue; no JOIN needed on reads */
    pool.query(`ALTER TABLE product_returns ADD COLUMN IF NOT EXISTS sku VARCHAR(100)`)
  )
  .then(() =>
    /* order_id — ties each webhook return to its exact source order */
    pool.query(`ALTER TABLE product_returns ADD COLUMN IF NOT EXISTS order_id INTEGER`)
  )
  .then(() =>
    /* Partial unique index: prevents the same order from creating two
       return rows (idempotent against Bosta webhook retries).
       Manual returns from returns.js have order_id = NULL and are excluded. */
    pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS product_returns_order_id_uidx
        ON product_returns (order_id)
        WHERE order_id IS NOT NULL
    `)
  )

  /* ── treasury_transactions table ─────────────────────────────────────── */
  .then(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS treasury_transactions (
        id               SERIAL        PRIMARY KEY,
        order_id         INTEGER,
        amount           NUMERIC(12,2) NOT NULL,
        type             VARCHAR(50)   NOT NULL,
        source           VARCHAR(50)   NOT NULL,
        description      TEXT,
        transaction_date DATE          NOT NULL DEFAULT CURRENT_DATE,
        created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `)
  )
  .then(() =>
    /* Partial unique index: one 'bosta_cod' revenue entry per order.
       Ensures a duplicate 'delivered' webhook never double-counts cash.    */
    pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS treasury_bosta_cod_order_uidx
        ON treasury_transactions (order_id)
        WHERE source = 'bosta_cod'
    `)
  )
  /* ── Orphan cleanup (must precede the FK — orphans would violate it) ──────
     Removes financial rows whose order was already deleted. Manual entries
     (order_id IS NULL) are preserved.                                        */
  .then(() =>
    pool.query(`
      DELETE FROM treasury_transactions t
       WHERE t.order_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = t.order_id)
    `)
  )
  /* ── Permanent fix: FK with ON DELETE CASCADE ────────────────────────────
     Deleting an order now automatically wipes its commissions/revenue.
     Idempotent — only added if the constraint doesn't already exist.         */
  .then(() =>
    pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'treasury_transactions_order_id_fkey'
        ) THEN
          ALTER TABLE treasury_transactions
            ADD CONSTRAINT treasury_transactions_order_id_fkey
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `)
  )
  .then(() => console.log('✅  Webhook: product_returns + treasury_transactions tables ready (FK ON DELETE CASCADE)'))
  .catch((err) => console.warn('⚠️   Webhook schema migration error:', err.message));

/* ── POST /api/webhooks/bosta ──────────────────────────────────────────── */
router.post('/bosta', async (req, res) => {

  /* ── Inbound diagnostics — log EVERY hit BEFORE the secret guard ─────────
     So prod logs unambiguously show whether Bosta is reaching us at all (and
     whether it sent a signature header) even when a request is later rejected.
     We log header PRESENCE only — never the secret value itself.            */
  console.log(
    '📥 [Bosta Webhook] INBOUND hit — sigHeaderPresent=' +
    `${!!(req.headers['x-bosta-signature'] || req.headers['x-webhook-secret'])}`
  );
  console.log('📥 [Bosta Webhook] INBOUND payload:', JSON.stringify(req.body));

  /* ── Security: shared-secret guard ──────────────────────────────────────
     Reads webhook_secret from shipping_settings DB first (Phase 1 SaaS store),
     then falls back to BOSTA_WEBHOOK_SECRET env var.
     If neither is configured the endpoint is open (acceptable in development). */
  let webhookSecret = null;
  try {
    const { rows: credRows } = await pool.query(
      `SELECT webhook_secret
       FROM   shipping_settings
       WHERE  provider_name = 'bosta' AND is_active = true`
    );
    webhookSecret = credRows[0]?.webhook_secret || process.env.BOSTA_WEBHOOK_SECRET || null;
  } catch (credErr) {
    console.warn('[Bosta Webhook] Could not read shipping_settings, falling back to .env:', credErr.message);
    webhookSecret = process.env.BOSTA_WEBHOOK_SECRET || null;
  }

  if (webhookSecret) {
    const incoming =
      req.headers['x-bosta-signature'] ??
      req.headers['x-webhook-secret']  ??
      '';
    if (incoming !== webhookSecret) {
      console.warn('[Bosta Webhook] ⚠️  Secret mismatch — request rejected');
      return res.status(401).json({ error: 'Webhook secret mismatch' });
    }
  }

  /* Acknowledge immediately — Bosta expects 2xx within a few seconds.
     All DB work happens after the response is flushed.                   */
  res.status(200).json({ received: true });

  try {
    console.log('[Bosta Webhook] Raw payload:', JSON.stringify(req.body, null, 2));

    const { trackingNumber, statusStr, stateCode, webhookCod, isReturn, deliveredAt } = parseBostaPayload(req.body);

    if (!trackingNumber) {
      console.warn('[Bosta Webhook] Missing trackingNumber — skipping');
      return;
    }
    if (!statusStr && stateCode == null) {
      console.warn(`[Bosta Webhook] Missing status & state code for tracking "${trackingNumber}" — skipping`);
      return;
    }

    /* Normalise the raw Bosta string to a canonical key. */
    let canonical = canonicalizeStatus(statusStr);

    /* Positive delivery signal: Bosta code 45 = "Delivered". Numeric codes are
       locale-independent, so this rescues deliveries whose status string is
       missing or arrives in Arabic. Applied ONLY when the string hasn't already
       resolved to a return state, so a genuine RTO parcel is never mislabelled
       as delivered (the isReturn guard below is the final backstop). */
    if (
      DELIVERED_STATE_CODES.has(stateCode) &&
      canonical !== 'returned' &&
      canonical !== 'returning_to_merchant' &&
      canonical !== 'delivered_to_merchant'
    ) {
      if (canonical !== 'delivered') {
        console.log(`[Bosta Webhook] state code ${stateCode} → forcing canonical "delivered"`);
      }
      canonical = 'delivered';
    }

    /* Numeric state code takes precedence for PHYSICAL returns: code 46
       ("Returned to business") is unambiguous even when the localised string is
       missing or worded differently. 45 (Delivered) and 47 (returning, still in
       transit) are intentionally NOT in this set — see RETURN_STATE_CODES. */
    if (RETURN_STATE_CODES.has(stateCode)) {
      if (canonical !== 'returned') {
        console.log(`[Bosta Webhook] state code ${stateCode} → forcing canonical "returned"`);
      }
      canonical = 'returned';
    }

    /* A return parcel that reports "delivered" actually means it was delivered
       BACK to the merchant → treat it as a physical return so stock is restored. */
    if (isReturn && (canonical === 'delivered' || canonical === 'delivered_to_merchant')) {
      console.log(`[Bosta Webhook] isReturn=true + "${statusStr}" → reclassifying as physical return`);
      canonical = 'returned';
    }

    /* Return-LEG detector — the ghost-order fix. The structural isReturn flag means
       the parcel is heading BACK to us. If it hasn't already resolved to a
       physically-received return above, classify it as IN-TRANSIT return
       ('returning_to_merchant' → 'جاري الإعادة') so it leaves the forward pipeline
       IMMEDIATELY. This catches Bosta's ambiguous intermediate "Processing"/"In
       Transit" states on the return leg (the :R state codes) that carry no
       recognizable status string and previously left the order stuck at
       'تم الشحن' — silently inflating the in-transit count and outstanding cash. */
    if (isReturn && canonical !== 'returned' && canonical !== 'delivered_to_merchant') {
      if (canonical !== 'returning_to_merchant') {
        console.log(`[Bosta Webhook] isReturn=true + "${statusStr}" (state ${stateCode ?? '?'}) → forcing canonical "returning_to_merchant"`);
      }
      canonical = 'returning_to_merchant';
    }

    console.log(
      `[Bosta Webhook] tracking="${trackingNumber}"  rawStatus="${statusStr}"  ` +
      `stateCode=${stateCode ?? '(none)'}  canonical="${canonical}"  isReturn=${isReturn}  ` +
      `webhookCod=${webhookCod ?? '(not in payload)'}`
    );

    /* ── Return-state detector (explicit monitoring hook) ────────────────────
       Loud, unambiguous logging the moment ANY return-related state arrives —
       whether in-transit ('returning_to_merchant') or physically received
       ('returned' / 'delivered_to_merchant'). Lets us watch Bosta return
       payloads live in pm2 logs without grepping the whole flow.            */
    const RETURN_STATES = new Set([
      'returning_to_merchant', 'returned', 'delivered_to_merchant',
    ]);
    if (isReturn || RETURN_STATES.has(canonical)) {
      console.log(
        `🔁 [Bosta Webhook] RETURN STATE DETECTED → tracking="${trackingNumber}" ` +
        `canonical="${canonical}" isReturn=${isReturn} ` +
        `willRestock=${FINAL_RETURN_STATUSES.has(canonical)}`
      );
      console.log('🔁 [Bosta Webhook] Return payload:', JSON.stringify(req.body));
    }

    /* ── Step 1: Resolve the order by BostaTrackingCode ──────────────────
       SELECT includes ProductPrice + depositAmount for the treasury COD
       calculation, sku for the SKU-first inventory logic, and quantity so a
       physical return restocks the EXACT number of units that were shipped.  */
    const { rows } = await pool.query(
      `SELECT id, "ProductName", "Status", "sku", "ProductPrice", "depositAmount",
              COALESCE("quantity", 1) AS quantity, business_id
       FROM   orders
       WHERE  "BostaTrackingCode" = $1`,
      [trackingNumber]
    );

    if (!rows.length) {
      /* Bosta already received 200 — just log and exit cleanly.           */
      console.warn(
        `[Bosta Webhook] ⚠️  No order found for tracking code "${trackingNumber}" — ` +
        `event acknowledged (200) but no DB action taken.`
      );
      return;
    }

    const order       = rows[0];
    const productName = (order.ProductName || '').trim();
    const orderSku    = order.sku?.trim() || null;
    const orderQty    = Math.max(1, parseInt(order.quantity, 10) || 1);   // restock exact units shipped
    /* TENANT: every downstream write is scoped to the matched order's owner,
       so a Bosta event can never mutate another tenant's stock/treasury.   */
    const businessId  = order.business_id ?? null;

    /* ── "بدون تحصيل" (COD zeroed) → return-bound ────────────────────────────
       Bosta zeroes the collectable COD the instant a parcel is refused / cancelled
       / RTO. If THIS event reports COD = 0 for an order that ACTUALLY had a COD to
       collect (net forward COD = ProductPrice − deposit > 0) and the parcel is still
       in a FORWARD state (maps to 'تم الشحن', or is an unmapped intermediate), it is
       return-bound → force the in-transit return leg so it leaves "قيد التوصيل"
       immediately and counts toward returns/NDR. The net-COD guard means genuinely
       prepaid orders (COD 0 from the start) are never misread. No restock here — the
       physical 'تم الإرجاع' event (code 46) restocks once the parcel arrives. */
    const netForwardCod =
      (parseFloat(String(order.ProductPrice ?? '').replace(/[^0-9.]/g, '')) || 0)
      - (parseFloat(order.depositAmount) || 0);
    const codZeroed = webhookCod !== null && webhookCod !== undefined && Number(webhookCod) === 0;
    const mappedNow = BOSTA_TO_ORDER_STATUS[canonical];
    const isForwardMapped = mappedNow === undefined || mappedNow === 'تم الشحن';
    if (codZeroed && netForwardCod > 0 && isForwardMapped) {
      console.log(`[Bosta Webhook] Order #${order.id} COD=0 (بدون تحصيل) on a COD order in forward state → forcing "returning_to_merchant"`);
      canonical = 'returning_to_merchant';
    }

    const newOrderStatus = BOSTA_TO_ORDER_STATUS[canonical];

    console.log(
      `[Bosta Webhook] Order #${order.id}` +
      ` | product="${productName}"` +
      ` | SKU=${orderSku ? `"${orderSku}"` : 'null (name fallback)'}` +
      ` | qty=${orderQty}` +
      ` | ${order.Status} → canonical="${canonical}" → mapped="${newOrderStatus ?? '(unmapped)'}"`
    );

    /* ── Step 2: Update the order's Status ───────────────────────────────
       Only fires when the Bosta status maps to an Arabic label.           */
    if (newOrderStatus) {
      await pool.query(
        `UPDATE orders SET "Status" = $1, "updatedAt" = NOW() WHERE id = $2 AND business_id = $3`,
        [newOrderStatus, order.id, businessId]
      );
      console.log(`✅  Order #${order.id} status → "${newOrderStatus}"`);
    } else {
      console.log(`[Bosta Webhook] Status "${statusStr}" is unmapped — order row left unchanged`);
    }

    /* ── Step 2b: Persist Bosta's LIVE expected COD ──────────────────────────
       Runs on EVERY event (even unmapped intermediate states) so the forecasting
       pipeline values each shipment by what Bosta will ACTUALLY collect, not the
       original order price. Bosta zeroes COD ("بدون تحصيل") on return-bound parcels,
       so this is what stops them inflating Outstanding Cash. Any return canonical
       forces 0 (nothing left to collect). */
    const isReturnCanonical =
      canonical === 'returning_to_merchant' ||
      canonical === 'returned' ||
      canonical === 'delivered_to_merchant';
    const codToStore = isReturnCanonical ? 0 : webhookCod;
    if (codToStore !== null && codToStore !== undefined) {
      await pool.query(
        `UPDATE orders SET expected_cod = $1 WHERE id = $2 AND business_id = $3`,
        [codToStore, order.id, businessId]
      );
      console.log(`[Bosta Webhook] Order #${order.id} expected_cod → ${codToStore}`);
    }

    /* ── Step 3: Stamp delivered_at on a successful delivery ──────────────
       We DELIBERATELY do NOT record COD as treasury revenue here. Delivery is
       NOT cash-in-hand: revenue is recognised MANUALLY only when the courier
       actually wires the collected money to the bank. We just record WHEN the
       order was delivered so analytics can date it accurately. Idempotent —
       delivered_at is set only once (the first delivered event wins).         */
    if (canonical === 'delivered') {
      await pool.query(
        `UPDATE orders SET delivered_at = COALESCE($1::timestamptz, NOW())
         WHERE id = $2 AND business_id = $3 AND delivered_at IS NULL`,
        [deliveredAt, order.id, businessId]
      );
      console.log(`✅  Order #${order.id} delivered_at stamped (no auto-revenue — recorded manually on bank settlement).`);

      /* ── Phase B1: capture the EXACT per-AWB shipping fee ─────────────────
         Pull priceAfterVat from Bosta's integrations API and store it on the
         order (idempotent — only when not already set). Fully isolated in its
         own try/catch + runs AFTER the 200 ack, so a Bosta API hiccup can never
         affect the delivery status write or the webhook response. Any miss is
         backfilled later by src/scripts/backfillShippingFees.js.            */
      try {
        const fee = await captureActualShippingFee(trackingNumber, businessId);
        if (fee != null) {
          console.log(`✅  Order #${order.id} actual_shipping_fee = ${fee} EGP (Bosta priceAfterVat).`);
        } else {
          console.log(`[Bosta Webhook] actual_shipping_fee not captured for #${order.id} (already set or fee unavailable) — backfill will retry.`);
        }
      } catch (feeErr) {
        console.warn(`[Bosta Webhook] actual_shipping_fee capture error for #${order.id}:`, feeErr.message);
      }
    }

    /* ── Step 4: Physical-return gate ────────────────────────────────────
       Only 'returned' and 'delivered_to_merchant' confirm the item is back
       in the merchant's hands. All other statuses stop here.              */
    if (!FINAL_RETURN_STATUSES.has(canonical)) {
      console.log(
        `[Bosta Webhook] Status "${canonical}" requires no inventory action — done.`
      );
      return;
    }

    /* ── Step 4: process the physical return through the SHARED, idempotent
       processor — the EXACT same path the backfill sync uses (status →
       تم الإرجاع, stock +qty, log once). */
    const result = await applyPhysicalReturn(order);
    if (result.alreadyLogged) {
      console.warn(`[Bosta Webhook] ⚠️  Return for order #${order.id} already logged — skipped (idempotent).`);
    } else {
      console.log(
        `✅  [Bosta Webhook] Physical return processed for order #${order.id}: ` +
        `status→تم الإرجاع | ${result.restocked ? `stock +${result.qty}` : 'no product matched (logged anyway)'} | logged.`
      );
    }

  } catch (err) {
    /* Post-response catch — never calls res.status() again.
       Constraint violations on the partial unique indexes surface here
       and are logged rather than silently swallowed.                     */
    console.error('[Bosta Webhook] Unhandled error:', err.message, err.stack);
  }
});

/* Shared exports for the backfill sync (routes/bosta.js) — so missed returns
   are processed through the EXACT same logic as the live webhook. */
router.applyPhysicalReturn   = applyPhysicalReturn;
router.canonicalizeStatus    = canonicalizeStatus;
router.FINAL_RETURN_STATUSES = FINAL_RETURN_STATUSES;

module.exports = router;
