'use strict';

const express = require('express');
const pool    = require('../config/db');

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
   │ cancelled                    │ Order status only                        │
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
  'cancelled':             'تم الرفض',
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

  return { trackingNumber, statusStr, stateCode, webhookCod, isReturn };
}

/**
 * Bosta numeric delivery-state codes that mean the parcel has been returned to
 * the merchant/origin (physical return → triggers restock). 45 & 46 are the
 * canonical "Returned to business" / "Delivered to sender" codes.
 */
const RETURN_STATE_CODES = new Set([45, 46, 47]);

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

/* ── Idempotent schema migrations ─────────────────────────────────────────
   All run at startup; safe to repeat on every deploy.                      */

/* ── product_returns table ─────────────────────────────────────────────── */
pool.query(`
  CREATE TABLE IF NOT EXISTS product_returns (
    id            SERIAL        PRIMARY KEY,
    product_name  VARCHAR(255)  NOT NULL,
    return_date   DATE          NOT NULL DEFAULT CURRENT_DATE,
    quantity      INTEGER       NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ   DEFAULT NOW(),
    UNIQUE (product_name, return_date)
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

    const { trackingNumber, statusStr, stateCode, webhookCod, isReturn } = parseBostaPayload(req.body);

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

    /* Numeric state code takes precedence for returns: codes 45/46 ("Returned
       to business" / "Delivered to sender") are unambiguous even when the
       localised string is missing or worded differently. */
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
       calculation and sku for the SKU-first inventory logic.
       NOTE: the orders table has NO "Quantity" column — each order is a single
       unit, so a physical return restocks exactly 1.                         */
    const { rows } = await pool.query(
      `SELECT id, "ProductName", "Status", "sku", "ProductPrice", "depositAmount", business_id
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
    const orderQty    = 1;   // orders table has no Quantity column → 1 unit per order
    /* TENANT: every downstream write is scoped to the matched order's owner,
       so a Bosta event can never mutate another tenant's stock/treasury.   */
    const businessId  = order.business_id ?? null;

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

    /* ── Step 3: Treasury — record COD on successful delivery ─────────────
       Fires only for 'delivered'.  The partial unique index on
       treasury_transactions (order_id) WHERE source = 'bosta_cod' is the
       idempotency backstop: if the same event arrives twice the second
       INSERT hits ON CONFLICT DO NOTHING and produces no side-effects.

       COD priority:
         1. specs.cod from the Bosta webhook payload  (actual collected)
         2. Calculated from order: ProductPrice − depositAmount  (fallback)  */
    if (canonical === 'delivered') {
      const codAmount = webhookCod !== null
        ? webhookCod
        : calcOrderCod(order);

      const description =
        `COD وصل من Bosta — طلب #${order.id}` +
        (productName ? ` | ${productName}` : '') +
        (webhookCod !== null ? ' | المبلغ من الـ Webhook' : ' | المبلغ محسوب من الطلب');

      const { rowCount: inserted } = await pool.query(
        `INSERT INTO treasury_transactions
           (order_id, amount, type, source, description, transaction_date, business_id)
         VALUES ($1, $2, 'revenue', 'bosta_cod', $3, CURRENT_DATE, $4)
         ON CONFLICT (order_id) WHERE source = 'bosta_cod'
         DO NOTHING`,
        [order.id, codAmount.toFixed(2), description, businessId]
      );

      if (inserted > 0) {
        console.log(
          `✅  Treasury: +${codAmount.toFixed(2)} EGP recorded` +
          ` for order #${order.id} (source: bosta_cod)`
        );
      } else {
        console.warn(
          `[Bosta Webhook] ⚠️  Treasury: bosta_cod entry for order #${order.id}` +
          ` already exists — skipped (idempotent).`
        );
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

    if (!productName) {
      console.warn(
        `[Bosta Webhook] ⚠️  Order #${order.id} has no ProductName` +
        ` — cannot identify product for stock replenishment. Return skipped.`
      );
      return;
    }

    /* ── Step 4a: Idempotency gate ────────────────────────────────────────
       Has this exact order already been logged as a physical return?
       Handles Bosta webhook retries: the 200 is already sent, but this
       guard prevents a double stock increment on any re-delivery.         */
    const dupCheck = await pool.query(
      'SELECT 1 FROM product_returns WHERE order_id = $1 AND business_id = $2 LIMIT 1',
      [order.id, businessId]
    );
    if (dupCheck.rowCount > 0) {
      console.warn(
        `[Bosta Webhook] ⚠️  Duplicate event: return for order #${order.id}` +
        ` already logged — skipping stock update and returns log.`
      );
      return;
    }

    console.log(
      `[Bosta Webhook] ✅ Physical return confirmed for order #${order.id}.` +
      ` Processing stock replenishment...`
    );

    /* ── Step 4b: SKU-first stock replenishment ────────────────────────────
       If the order carries a SKU we match exactly on products.sku.
       For legacy orders with no SKU we fall back to a trimmed name match —
       same dual-dispatch pattern used by orders.js.                        */
    const hasSku    = Boolean(orderSku);
    const stockSql  = hasSku
      ? `UPDATE products
         SET    stock_quantity = stock_quantity + $2
         WHERE  sku = $1 AND business_id = $3
         RETURNING name, sku, stock_quantity`
      : `UPDATE products
         SET    stock_quantity = stock_quantity + $2
         WHERE  TRIM(name) = TRIM($1) AND business_id = $3
         RETURNING name, sku, stock_quantity`;
    const stockParam = hasSku ? orderSku : productName;

    console.log(
      `[Bosta Webhook] Replenishing stock +${orderQty}` +
      ` (match by ${hasSku ? `SKU "${orderSku}"` : `name "${productName}"`})`
    );

    const stockResult = await pool.query(stockSql, [stockParam, orderQty, businessId]);

    if (stockResult.rowCount === 0) {
      console.warn(
        `⚠️  Inventory Update Failed: no product matched` +
        ` (${hasSku ? `SKU: "${orderSku}"` : `name: "${productName}"`}).` +
        ` Return will still be logged.`
      );
    } else {
      const p = stockResult.rows[0];
      console.log(
        `✅  Stock replenished: "${p.name}" +${orderQty}` +
        ` (SKU: ${p.sku ?? 'none'}) → stock now ${p.stock_quantity}`
      );
    }

    /* ── Step 4c: Log the return in product_returns ───────────────────────
       The (product_name, return_date) unique constraint is kept for backward
       compatibility with the manual returns route (returns.js).
       Two returns of the same product on the same day correctly aggregate.

       sku      — pulled directly from the order, no JOIN required
       order_id — used by the idempotency check (Step 4a) and the partial
                  unique index that prevents exact duplicate rows           */
    const today = new Date().toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO product_returns (product_name, sku, order_id, return_date, quantity, business_id)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, $5)
       ON CONFLICT (product_name, return_date, business_id) DO UPDATE SET
         quantity = product_returns.quantity + $4,
         sku      = COALESCE(EXCLUDED.sku, product_returns.sku)`,
      [productName, orderSku, order.id, orderQty, businessId]
    );

    console.log(
      `✅  product_returns logged: "${productName}" x${orderQty}` +
      ` (SKU: ${orderSku ?? 'none'}, order #${order.id}) on ${today}`
    );

  } catch (err) {
    /* Post-response catch — never calls res.status() again.
       Constraint violations on the partial unique indexes surface here
       and are logged rather than silently swallowed.                     */
    console.error('[Bosta Webhook] Unhandled error:', err.message, err.stack);
  }
});

module.exports = router;
