'use strict';

/**
 * taagerSync.js — Deep Taager → internal DB synchroniser.
 * ─────────────────────────────────────────────────────────────────────────────
 * Upgrades the Taager integration from a surface-level stats aggregator into a
 * FULL ORDER SYNC: it pulls the merchant's real Taager orders and UPSERTs them
 * into our own `orders` table (and creates lightweight product stubs), so the
 * rest of the platform — Products Profitability, the unified dashboard, Meta-Ads
 * SKU mapping — all light up from native DB data with 100% accurate definitions.
 *
 * Why DB-native instead of in-memory aggregation?
 *   • One source of truth: every widget uses the same SQL, same status rules.
 *   • SKU-level joins (orders ↔ products) become possible → profitability table.
 *   • Status semantics match the platform exactly (e.g. 'created' = new/pending,
 *     NOT confirmed — fixing the slight mismatch vs Taager's own CSV export).
 *
 * MULTI-TENANT: every write is stamped + scoped by business_id. A Taager order
 * is keyed by (external_order_id, business_id) so re-runs UPSERT, never duplicate.
 */

const pool = require('../config/db');
const { loadAffiliateCreds, fetchTaagerOrders, fetchTaagerProducts } = require('./externalAffiliate');

/* ── Taager product-catalog field candidates ─────────────────────────────────
   Best-effort key names for the products endpoint. Trim to the exact keys once
   the one-shot debug log (TAAGER_DEBUG) reveals a real product object.         */
const PRODUCT_SKU_KEYS     = ['productId', 'id', 'sku', 'prodId'];
const PRODUCT_NAME_KEYS    = ['productName', 'name', 'title', 'nameAr', 'productNameAr'];
/* Merchant cost / wholesale price → our cost_price (COGS basis). */
const PRODUCT_COST_KEYS    = ['productPrice', 'price', 'cost', 'costPrice', 'wholesalePrice', 'buyingPrice', 'productCost'];
/* Recommended/customer sale price → our selling_price default. */
const PRODUCT_SELL_KEYS    = ['salePrice', 'sellingPrice', 'customerPrice', 'recommendedPrice', 'price', 'productPrice'];
/* Image URL → our image_url. */
const PRODUCT_IMAGE_KEYS   = ['picture', 'image', 'imageUrl', 'image_url', 'productPicture', 'thumbnail', 'mainImage'];

/* ── Taager status → internal (Arabic) status ────────────────────────────────
   Our `orders."Status"` column and ALL analytics SQL speak Arabic, so we map
   Taager's English states onto that exact vocabulary. Anything not explicitly
   rejected/cancelled/returned/new falls through to "confirmed".               */
const TAAGER_STATUS_MAP = {
  created:           'جديد',          // new / pending — NOT counted as confirmed
  pending:           'جديد',
  confirmed:         'تم التأكيد',     // confirmed
  processing:        'تم التأكيد',
  in_progress:       'تم الشحن',       // shipped
  shipped:           'تم الشحن',
  out_for_delivery:  'تم الشحن',
  delivered:         'تم التوصيل',     // delivered
  cancelled:         'تم الرفض',       // cancelled → rejected bucket
  canceled:          'تم الرفض',
  customer_rejected: 'تم الرفض',       // rejected
  rejected:          'تم الرفض',
  return_verified:   'تم الإرجاع',     // returned
  returned:          'تم الإرجاع',
};
const DEFAULT_STATUS = 'تم التأكيد';   // unknown, non-bad → confirmed (per business rule)

/** Coerce any value to a finite number (else 0). */
function num(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Map one Taager status string to our internal Arabic status. */
function mapTaagerStatus(status) {
  const key = String(status ?? '').trim().toLowerCase();
  return TAAGER_STATUS_MAP[key] || DEFAULT_STATUS;
}

/* ── One-time idempotent schema guard ────────────────────────────────────────
   Adds the integration columns + the dedupe index. Runs once per process.     */
let _schemaReady = null;
function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_order_id VARCHAR(120)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_source      VARCHAR(50)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission        NUMERIC(12,2)`);
    /* Dedupe key for external orders — partial so it never clashes with the many
       NULL external_order_id rows coming from the ERP / Google-Sheet sync. */
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS orders_external_tenant_uidx
        ON orders (external_order_id, business_id)
        WHERE external_order_id IS NOT NULL
    `);
    console.log('✅  taagerSync: orders integration columns + dedupe index ready');
  })().catch((err) => {
    _schemaReady = null; // allow a later retry if it failed
    console.error('[taagerSync] ensureSchema failed:', err.message);
    throw err;
  });
  return _schemaReady;
}

/** Pull the first order line (where SKU / product name live). */
function firstLine(order) {
  const lines = Array.isArray(order.orderLines) ? order.orderLines : [];
  return lines[0] || {};
}

/**
 * Normalise one raw Taager order into the column values we store.
 * Returns null when the order has no usable id (can't dedupe → skip).
 */
function mapTaagerOrder(order) {
  const externalId = String(order.orderId ?? order.id ?? '').trim();
  if (!externalId) return null;

  const line = firstLine(order);
  return {
    externalId,
    status:      mapTaagerStatus(order.status),
    productName: line.productName ?? line.name ?? null,
    sku:         line.productId != null ? String(line.productId) : (line.sku ?? null),
    quantity:    Math.max(1, num(line.quantity) || 1),
    price:       num(order.cashOnDelivery),   // total_price ← cashOnDelivery
    commission:  num(order.orderProfit),      // commission  ← orderProfit
    /* Best-effort customer fields (defensive — Taager payload may omit them). */
    fullName:    order.receiverName ?? order.customerName ?? order.clientName ?? null,
    phone:       order.receiverPhone ?? order.customerPhone ?? order.phone ?? null,
    city:        order.governorate ?? order.province ?? order.city ?? null,
    address:     order.address ?? order.shippingAddress ?? null,
    createdAt:   order.createdAt ?? order.orderDate ?? order.created_at ?? null,
  };
}

/**
 * Synchronise a batch of raw Taager orders into the internal DB for one tenant.
 * UPSERTs each order (keyed by external_order_id + business_id) and ensures a
 * matching product stub exists per SKU so the profitability table can join.
 *
 * Returns { upserted, productsCreated, skipped }.
 */
async function syncTaagerOrdersToDB(businessId, taagerOrders) {
  if (businessId == null) throw new Error('syncTaagerOrdersToDB: businessId is required');
  await ensureSchema();

  const rows = (taagerOrders || []).map(mapTaagerOrder).filter(Boolean);
  const skipped = (taagerOrders || []).length - rows.length;

  let upserted = 0;
  let productsCreated = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const r of rows) {
      /* 1. Product stub so orders↔products SKU joins (profitability) resolve.
            cost/selling/stock default to 0; the merchant can enrich later. */
      if (r.sku) {
        const prod = await client.query(
          `INSERT INTO products (name, sku, cost_price, selling_price, stock_quantity, business_id)
                VALUES ($1, $2, 0, 0, 0, $3::integer)
           ON CONFLICT (sku, business_id) DO NOTHING`,
          [r.productName || r.sku, r.sku, businessId]
        );
        if (prod.rowCount > 0) productsCreated += 1;
      }

      /* 2. UPSERT the order. createdAt is set only on first insert (preserved on
            update); the updatedAt trigger stamps the row automatically. */
      await client.query(
        `INSERT INTO orders
           ("FullName", "Phone", "DeliveryRate", "City", "Address",
            "Status", "Note", "ProductName", "ProductPrice", sku,
            commission, external_order_id, order_source, business_id, "createdAt")
         VALUES
           ($1, $2, 'بدون', $3, $4,
            $5, NULL, $6, $7, $8,
            $9, $10, 'taager', $11::integer, COALESCE($12::timestamptz, NOW()))
         ON CONFLICT (external_order_id, business_id) WHERE external_order_id IS NOT NULL
         DO UPDATE SET
           "Status"       = EXCLUDED."Status",
           "ProductName"  = EXCLUDED."ProductName",
           "ProductPrice" = EXCLUDED."ProductPrice",
           sku            = EXCLUDED.sku,
           "City"         = COALESCE(EXCLUDED."City", orders."City"),
           commission     = EXCLUDED.commission,
           order_source   = 'taager'`,
        [
          r.fullName,                 // $1
          r.phone,                    // $2
          r.city,                     // $3
          r.address,                  // $4
          r.status,                   // $5
          r.productName,              // $6
          String(r.price),            // $7  ProductPrice stored as text (matches ERP)
          r.sku,                      // $8
          r.commission,               // $9
          r.externalId,               // $10
          businessId,                 // $11
          r.createdAt,                // $12
        ]
      );
      upserted += 1;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[taagerSync] sync transaction rolled back:', err.message);
    throw err;
  } finally {
    client.release();
  }

  return { upserted, productsCreated, skipped };
}

/* ── Product-catalog field pickers ───────────────────────────────────────── */
function firstVal(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}
function firstNum(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') {
      const n = num(obj[k]);
      if (n > 0) return n;
    }
  }
  return 0;
}
function firstImage(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v) && v.length) {
      const f = v[0];
      if (typeof f === 'string' && f) return f;
      if (f && typeof f === 'object') return f.url || f.src || f.image || null;
    }
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** Normalise one raw Taager product → the columns we enrich. null when no SKU. */
function mapTaagerProduct(product) {
  const sku = firstVal(product, PRODUCT_SKU_KEYS);
  if (sku == null || String(sku).trim() === '') return null;
  return {
    sku:   String(sku),
    name:  firstVal(product, PRODUCT_NAME_KEYS) ?? String(sku),
    cost:  firstNum(product, PRODUCT_COST_KEYS),
    sell:  firstNum(product, PRODUCT_SELL_KEYS),
    image: firstImage(product, PRODUCT_IMAGE_KEYS),
  };
}

/**
 * Backfill the Taager product catalog into our `products` table for one tenant.
 * UPSERTs by (sku, business_id). Enrichment is NON-DESTRUCTIVE:
 *   • cost_price / selling_price are filled ONLY while ours is still 0 (a stub) —
 *     a merchant's manually-entered cost is never overwritten.
 *   • image_url / name fill only when ours is empty.
 * Returns { productsFetched, productsUpserted, productsSkipped }.
 */
async function syncTaagerProductsToDB(businessId, products) {
  if (businessId == null) throw new Error('syncTaagerProductsToDB: businessId is required');

  const rows = (products || []).map(mapTaagerProduct).filter(Boolean);
  const productsSkipped = (products || []).length - rows.length;
  let productsUpserted = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO products (name, sku, cost_price, selling_price, stock_quantity, image_url, business_id)
              VALUES ($1, $2, $3, $4, 0, $5, $6::integer)
         ON CONFLICT (sku, business_id) DO UPDATE SET
           name          = COALESCE(NULLIF(products.name, ''), NULLIF(EXCLUDED.name, ''), products.name),
           cost_price    = CASE WHEN COALESCE(products.cost_price,    0) = 0 THEN EXCLUDED.cost_price    ELSE products.cost_price    END,
           selling_price = CASE WHEN COALESCE(products.selling_price, 0) = 0 THEN EXCLUDED.selling_price ELSE products.selling_price END,
           image_url     = COALESCE(products.image_url, EXCLUDED.image_url)`,
        [r.name, r.sku, r.cost, r.sell, r.image, businessId]
      );
      productsUpserted += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[taagerSync] product catalog transaction rolled back:', err.message);
    throw err;
  } finally {
    client.release();
  }

  return { productsFetched: (products || []).length, productsUpserted, productsSkipped };
}

/**
 * End-to-end Taager sync for one tenant: load creds → backfill product catalog →
 * fetch + UPSERT orders. Product-catalog enrichment is best-effort: a failure
 * there (e.g. unknown endpoint) is logged and never blocks the order sync.
 * Returns { fetched, upserted, productsCreated, skipped, productsFetched,
 *           productsUpserted, productsSkipped }.
 * Throws only when Taager isn't connected or the ORDERS call fails.
 */
async function runTaagerSync(businessId) {
  const creds = await loadAffiliateCreds(businessId);
  const t = creds.taager;
  if (!t.token) {
    const e = new Error('Taager غير مربوط — أضف التوكن أولاً');
    e.code = 'NOT_CONNECTED';
    throw e;
  }

  /* 1. Product catalog first — so order-sync stubs land on already-enriched rows.
        Best-effort: never let a catalog failure abort the order sync. */
  let catalog = { productsFetched: 0, productsUpserted: 0, productsSkipped: 0 };
  try {
    const products = await fetchTaagerProducts(t.url, t.merchant, t.token);
    if (process.env.TAAGER_DEBUG !== 'false' && products.length > 0) {
      console.log(
        '🔎 [Taager DEBUG] First product object (map these keys → the PRODUCT_* ' +
        'candidate arrays in taagerSync.js):\n' + JSON.stringify(products[0], null, 2)
      );
    }
    catalog = await syncTaagerProductsToDB(businessId, products);
  } catch (err) {
    const status = err.response?.status;
    console.warn(
      `[taagerSync] product catalog sync skipped${status ? ` (HTTP ${status})` : ''}: ${err.message}`
    );
  }

  /* 2. Orders (authoritative — failure here propagates to the caller). */
  const orders = await fetchTaagerOrders(t.url, t.merchant, t.token);
  const result = await syncTaagerOrdersToDB(businessId, orders);

  console.log(
    `🔄 [taagerSync] tenant ${businessId}: orders fetched ${orders.length}, upserted ${result.upserted}, ` +
    `new stubs ${result.productsCreated}; catalog fetched ${catalog.productsFetched}, enriched ${catalog.productsUpserted}`
  );
  return { fetched: orders.length, ...result, ...catalog };
}

module.exports = {
  mapTaagerStatus,
  mapTaagerProduct,
  syncTaagerOrdersToDB,
  syncTaagerProductsToDB,
  runTaagerSync,
};
