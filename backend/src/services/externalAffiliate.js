'use strict';

/**
 * externalAffiliate.js — External Affiliate Network integrations (Taager / Safqa).
 * ─────────────────────────────────────────────────────────────────────────────
 * EXCLUSIVE to the "affiliate" SaaS plan.
 *
 * Safqa  → REAL integration via the OFFICIAL PUBLIC API (api-safka-key header).
 *          Fetches the paginated orders list and aggregates the metrics ourselves
 *          (Total Revenue / Orders / Confirmed Rate / Delivered Rate). The private
 *          cookie-authenticated dashboard stats route is intentionally NOT used.
 * Taager → REAL integration. Paginated orders endpoint (Authorization: Bearer),
 *          aggregated the same way as Safqa; orderProfit is summed as commission.
 *
 * MULTI-TENANT: each business configures THREE values per network from the
 * dashboard UI — API URL, Merchant ID, and API Token. Everything is read from
 * the tenant-scoped `settings` table (business_id bound). No global env URLs —
 * nothing is hard-coded here, and no token is ever returned to the client by
 * this module.
 */

const axios = require('axios');
const pool  = require('../config/db');

/* ── Per-network settings keys (3 per network) ───────────────────────────────
   Stored in the generic `settings` table, scoped by business_id.              */
const NETWORK_KEYS = {
  taager: {
    url:      'taager_api_url',
    merchant: 'taager_merchant_id',
    token:    'taager_api_token',
  },
  safqa: {
    url:      'safqa_api_url',
    merchant: 'safqa_merchant_id',
    token:    'safqa_api_token',
  },
};

/* Flat list of every affiliate settings key (used by reads/deletes). */
const AFFILIATE_KEYS = Object.values(NETWORK_KEYS)
  .flatMap((n) => [n.url, n.merchant, n.token]);

const HTTP_TIMEOUT_MS = 10_000;

/* ── Small numeric coercer ───────────────────────────────────────────────── */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Empty/disconnected stat shape — single source of truth for the contract. */
function emptyStat(connected = false) {
  return {
    connected,
    revenue:       0,
    orders:        0,
    confirmed:     0,
    delivered:     0,
    confirmedRate: 0,   // %
    deliveredRate: 0,   // %
  };
}

/**
 * Load the full affiliate config (url + merchantId + token per network) for one
 * tenant. Returns empty strings for anything unset.
 * Strictly scoped — the read is bound by WHERE business_id = $1.
 */
async function loadAffiliateCreds(businessId) {
  const blank = {
    taager: { url: '', merchant: '', token: '' },
    safqa:  { url: '', merchant: '', token: '' },
  };
  if (businessId == null) return blank;

  const { rows } = await pool.query(
    `SELECT key, value FROM settings
      WHERE key = ANY($1::text[]) AND business_id = $2::integer`,
    [AFFILIATE_KEYS, businessId]
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, (r.value || '').trim()]));

  const pick = (net) => ({
    url:      map[NETWORK_KEYS[net].url]      || '',
    merchant: map[NETWORK_KEYS[net].merchant] || '',
    token:    map[NETWORK_KEYS[net].token]    || '',
  });

  return { taager: pick('taager'), safqa: pick('safqa') };
}

/* ── Taager orders-aggregation ───────────────────────────────────────────────
   Taager exposes a clean, paginated orders endpoint:
     GET https://merchant.api.taager.com/api/orders   (Authorization: Bearer)
     params : page (1-indexed), pageSize
     payload: { count, orders: [ { orderId, status, orderProfit, … } ] }
   Statuses seen: delivered, cancelled, return_verified, customer_rejected.
   `orderProfit` is the exact merchant commission, so we sum it directly.       */
const TAAGER_DEFAULT_URL          = 'https://merchant.api.taager.com/api/orders';
const TAAGER_PRODUCTS_DEFAULT_URL = 'https://merchant.api.taager.com/api/products';
const TAAGER_PAGE_SIZE   = 100;
const TAAGER_MAX_PAGES   = 50;   // safety cap → up to 5,000 rows/tenant per refresh

/** Derive the products endpoint from the saved orders URL (…/orders → …/products),
 *  falling back to the documented default when nothing usable is configured. */
function taagerProductsUrl(ordersUrl) {
  const u = (ordersUrl || '').trim();
  if (u && /\/orders\b/i.test(u)) return u.replace(/\/orders\b/i, '/products');
  return TAAGER_PRODUCTS_DEFAULT_URL;
}

/**
 * Aggregate a flat list of Taager orders into our dashboard stat shape.
 *   Total Orders  = orders.length
 *   Delivered     = #orders whose status === 'delivered' (strict)
 *   Confirmed     = total − (cancelled + returned + rejected)  → everything not
 *                   explicitly bad counts as confirmed
 *   Total Revenue = Σ orderProfit of DELIVERED orders (realised commission)
 */
function aggregateTaagerOrders(orders) {
  const total = orders.length;
  let delivered = 0, bad = 0, revenue = 0;

  for (const o of orders) {
    const s = String(o.status ?? '').trim().toLowerCase();
    /* cancelled / return_verified / customer_rejected → not confirmed */
    const isBad = STATUS_RETURNED.some((kw) => s.includes(kw.toLowerCase()));
    if (s === 'delivered') {
      delivered += 1;
      revenue   += num(o.orderProfit);   // exact merchant commission, realised on delivery
    }
    if (isBad) bad += 1;
  }
  const confirmed = Math.max(0, total - bad);

  return {
    connected:     true,
    revenue:       Math.round(revenue),
    orders:        total,
    confirmed,
    delivered,
    confirmedRate: total > 0 ? Math.round((confirmed / total) * 1000) / 10 : 0,
    deliveredRate: total > 0 ? Math.round((delivered / total) * 1000) / 10 : 0,
  };
}

/**
 * REAL: fetch live stats for a Taager merchant via their paginated orders API.
 *
 * Params (per-tenant, configured from the dashboard UI):
 *   apiUrl     — orders endpoint; defaults to TAAGER_DEFAULT_URL when left blank
 *   merchantId — optional; sent as a query param if present
 *   apiToken   — the bearer token (Authorization: Bearer …) — REQUIRED to call
 *
 * `connected` is true once a token is configured. On any failure we keep
 * connected=true (card still renders) but degrade to zero and flag `error`.
 */
/**
 * Fetch RAW Taager orders (paginated) — the single source used by BOTH the
 * lightweight stats card (fetchTaagerStats) and the deep DB synchroniser
 * (services/taagerSync). Returns the flat array of order objects.
 * Throws on HTTP error so callers decide how to handle it.
 */
async function fetchTaagerOrders(apiUrl, merchantId, apiToken, { maxPages = TAAGER_MAX_PAGES } = {}) {
  if (!apiToken) return [];

  const baseUrl = (apiUrl || '').trim() || TAAGER_DEFAULT_URL;
  const headers = {
    Accept:        'application/json',
    Authorization: `Bearer ${apiToken}`,
  };

  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await axios.get(baseUrl, {
      timeout: HTTP_TIMEOUT_MS,
      headers,
      params: {
        page,
        pageSize: TAAGER_PAGE_SIZE,
        ...(merchantId ? { merchant_id: merchantId } : {}),
      },
    });

    /* Documented shape is { count, orders: [...] }; fall back to the generic
       envelope extractor just in case the wrapper ever changes. */
    const batch = Array.isArray(data?.orders) ? data.orders : extractOrdersArray(data);
    all.push(...batch);

    /* Stop on a short/empty page — no more data to fetch. */
    if (batch.length < TAAGER_PAGE_SIZE) break;
  }
  return all;
}

async function fetchTaagerStats(apiUrl, merchantId, apiToken) {
  /* Taager authenticates with the bearer token — without it we cannot call. */
  if (!apiToken) return emptyStat(false);

  try {
    const orders = await fetchTaagerOrders(apiUrl, merchantId, apiToken);
    return aggregateTaagerOrders(orders);
  } catch (err) {
    const status = err.response?.status;
    console.warn(
      `[externalAffiliate] Taager fetch failed (merchant ${merchantId || '—'}` +
      `${status ? `, HTTP ${status}` : ''}):`, err.message
    );
    return { ...emptyStat(true), error: true };
  }
}

/**
 * Fetch RAW Taager products catalog (paginated). Used by the deep synchroniser
 * (services/taagerSync) to backfill cost_price / selling_price / image_url onto
 * the product stubs. Endpoint is derived from the tenant's orders URL.
 * Returns the flat array of product objects. Throws on HTTP error.
 */
async function fetchTaagerProducts(apiUrl, merchantId, apiToken, { maxPages = TAAGER_MAX_PAGES } = {}) {
  if (!apiToken) return [];

  const baseUrl = taagerProductsUrl(apiUrl);
  const headers = {
    Accept:        'application/json',
    Authorization: `Bearer ${apiToken}`,
  };

  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await axios.get(baseUrl, {
      timeout: HTTP_TIMEOUT_MS,
      headers,
      params: {
        page,
        pageSize: TAAGER_PAGE_SIZE,
        ...(merchantId ? { merchant_id: merchantId } : {}),
      },
    });

    /* Likely shape { count, products: [...] }; fall back through common wrappers. */
    const batch = Array.isArray(data?.products) ? data.products
      : Array.isArray(data?.data) ? data.data
      : Array.isArray(data) ? data
      : extractOrdersArray(data);
    all.push(...batch);

    if (batch.length < TAAGER_PAGE_SIZE) break;
  }
  return all;
}

/* ── Safqa orders-aggregation tuning knobs ───────────────────────────────────
   Safqa's PUBLIC API exposes the orders list (authenticated with `api-safka-key`),
   NOT a pre-aggregated stats blob — the old `/dashboard/get_statistics` route is
   a PRIVATE, cookie-authenticated dashboard route and rightly rejects API tokens
   with 401. So we fetch the orders list and compute the metrics ourselves.

   The exact JSON field names / status strings below are best-effort candidates
   (Safqa is an Egyptian COD platform → Arabic statuses likely). After you see one
   real order object in the logs, trim these arrays to the exact keys — the logic
   never changes.                                                               */
const SAFQA_PAGE_SIZE = 100;   // orders requested per page
const SAFQA_MAX_PAGES = 50;    // safety cap → up to 5,000 orders/tenant per refresh

/* Where the array of orders may live in the response body. */
const ORDERS_ARRAY_KEYS = ['data', 'orders', 'results', 'items', 'rows', 'list'];
/* Per-order monetary field candidates (first numeric match wins). */
const ORDER_REVENUE_KEYS = ['total', 'totalPrice', 'total_price', 'order_total', 'grandTotal', 'amount', 'price', 'cod', 'value'];
/* Per-order status field candidates. */
const ORDER_STATUS_KEYS  = ['status', 'orderStatus', 'order_status', 'state', 'shipping_status'];
/* Substring keywords (lowercased) used to CLASSIFY an order's status.
   delivered ⊂ confirmed (a delivered order was necessarily confirmed). */
const STATUS_DELIVERED = ['deliver', 'تم التوصيل', 'تم التسليم', 'توصيل', 'تسليم', 'collected', 'done', 'تم الاستلام'];
const STATUS_RETURNED  = ['return', 'مرتجع', 'إرجاع', 'ارجاع', 'reject', 'مرفوض', 'cancel', 'ملغ', 'فشل'];
const STATUS_CONFIRMED = ['confirm', 'تأكيد', 'مؤكد', 'shipped', 'تم الشحن', 'شحن', 'process', 'قيد', 'out for'];

/** Pull the orders array out of whatever envelope the API used. */
function extractOrdersArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const k of ORDERS_ARRAY_KEYS) {
    if (Array.isArray(payload[k])) return payload[k];
    /* one level of nesting, e.g. { data: { orders: [...] } } */
    if (payload[k] && typeof payload[k] === 'object') {
      for (const k2 of ORDERS_ARRAY_KEYS) {
        if (Array.isArray(payload[k][k2])) return payload[k][k2];
      }
    }
  }
  return [];
}

/** Detect the last page number from common pagination meta shapes (else null). */
function extractLastPage(payload) {
  const sources = [payload, payload?.meta, payload?.pagination, payload?.data];
  const keys = ['last_page', 'lastPage', 'total_pages', 'totalPages', 'pages', 'pageCount'];
  for (const src of sources) {
    if (src && typeof src === 'object') {
      for (const k of keys) {
        const v = num(src[k]);
        if (v > 0) return v;
      }
    }
  }
  return null;
}

/** First numeric monetary field on an order, else 0. */
function orderRevenue(order) {
  for (const k of ORDER_REVENUE_KEYS) {
    if (order[k] != null && order[k] !== '') {
      const v = Number(String(order[k]).replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(v)) return v;
    }
  }
  return 0;
}

/** Classify one order → 'delivered' | 'returned' | 'confirmed' | 'pending'. */
function classifyOrder(order) {
  let raw = '';
  for (const k of ORDER_STATUS_KEYS) {
    if (order[k] != null) { raw = String(order[k]); break; }
  }
  const s = raw.toLowerCase();
  const hit = (arr) => arr.some((kw) => s.includes(kw.toLowerCase()));
  if (hit(STATUS_DELIVERED)) return 'delivered';
  if (hit(STATUS_RETURNED))  return 'returned';
  if (hit(STATUS_CONFIRMED)) return 'confirmed';
  return 'pending';
}

/**
 * Aggregate a flat list of orders into our dashboard stat shape.
 *   Total Orders   = orders.length
 *   Delivered      = #delivered
 *   Confirmed      = #delivered + #confirmed  (delivered implies confirmed)
 *   Total Revenue  = Σ revenue of DELIVERED orders (realised revenue)
 *   confirmedRate  = confirmed / total × 100
 *   deliveredRate  = delivered / total × 100
 */
function aggregateOrders(orders) {
  const total = orders.length;
  let delivered = 0, confirmedOnly = 0, revenue = 0;

  for (const o of orders) {
    const cls = classifyOrder(o);
    if (cls === 'delivered') {
      delivered += 1;
      revenue   += orderRevenue(o);   // realised revenue = delivered orders
    } else if (cls === 'confirmed') {
      confirmedOnly += 1;
    }
  }
  const confirmed = delivered + confirmedOnly;

  return {
    connected:     true,
    revenue:       Math.round(revenue),
    orders:        total,
    confirmed,
    delivered,
    confirmedRate: total > 0 ? Math.round((confirmed / total) * 1000) / 10 : 0,
    deliveredRate: total > 0 ? Math.round((delivered / total) * 1000) / 10 : 0,
  };
}

/** Parse a pre-aggregated stats blob (kept for backward-compat / stats URLs). */
function parseSafqaStatsBlob(p) {
  const orders       = num(p.totalOrders);
  const doneRequests = num(p.totalDoneRequests);
  const deliveredRatio = orders > 0 ? doneRequests / orders : 0;
  const confirmedRatio = num(p.percent) / 100;
  return {
    connected:     true,
    revenue:       num(p.totalIncome),
    orders,
    confirmed:     Math.round(orders * confirmedRatio),
    delivered:     Math.round(orders * deliveredRatio),
    confirmedRate: Math.round(confirmedRatio * 1000) / 10,
    deliveredRate: Math.round(deliveredRatio * 1000) / 10,
  };
}

/**
 * REAL: fetch live stats for a Safqa merchant via the OFFICIAL PUBLIC API.
 *
 * Strategy (see the architectural note above):
 *   • Auth is STRICTLY the `api-safka-key` header — no Bearer, no cookies. This
 *     is what the public API documents; the private dashboard stats route (which
 *     needs a session cookie) is intentionally NOT used.
 *   • If the configured URL is a `…/statistics` endpoint we parse its aggregate
 *     blob directly (parseSafqastatsBlob).
 *   • Otherwise the URL is treated as the ORDERS-LIST endpoint: we paginate
 *     through it (api-safka-key) and compute the metrics ourselves.
 *
 * Params (all per-tenant, configured from the dashboard UI — NO global env):
 *   apiUrl     — the orders-list endpoint (preferred) or a stats endpoint
 *   merchantId — optional Safqa merchant id (sent as a query param if present)
 *   apiToken   — the public API key, sent as `api-safka-key`
 *
 * `connected` reflects that the network is configured (merchant id OR token set).
 * On a missing URL or any failure we keep connected=true (card still renders) but
 * degrade numbers to zero and flag `error` — the dashboard never breaks.
 */
async function fetchSafqaStats(apiUrl, merchantId, apiToken) {
  /* Configured when we have at least an identifier or a token. */
  if (!merchantId && !apiToken) return emptyStat(false);

  const baseUrl = (apiUrl || '').trim();
  if (!baseUrl) {
    console.warn('[externalAffiliate] Safqa URL not configured for this tenant — skipping live fetch.');
    return { ...emptyStat(true), error: true };
  }

  /* Official public-API auth: api-safka-key only. */
  const headers = { Accept: 'application/json' };
  if (apiToken) headers['api-safka-key'] = apiToken;

  try {
    /* ── Mode A: explicit stats endpoint → parse the aggregate blob ───────── */
    if (/statistic|stats/i.test(baseUrl)) {
      const { data } = await axios.get(baseUrl, {
        timeout: HTTP_TIMEOUT_MS,
        headers,
        params: merchantId ? { merchant_id: merchantId } : undefined,
      });
      const p = (data && typeof data === 'object' && data.data && typeof data.data === 'object')
        ? data.data : (data || {});
      return parseSafqaStatsBlob(p);
    }

    /* ── Mode B: orders-list endpoint → fetch all pages, then aggregate ───── */
    const all = [];
    let lastPage = null;
    for (let page = 1; page <= SAFQA_MAX_PAGES; page++) {
      const { data } = await axios.get(baseUrl, {
        timeout: HTTP_TIMEOUT_MS,
        headers,
        params: {
          page,
          limit:    SAFQA_PAGE_SIZE,   // send a few aliases; unknown ones are ignored
          per_page: SAFQA_PAGE_SIZE,
          ...(merchantId ? { merchant_id: merchantId } : {}),
        },
      });

      const batch = extractOrdersArray(data);
      all.push(...batch);

      /* ── ONE-SHOT DEBUG: dump the first real order object so we can map their
         exact JSON keys (status, commission/income, totals…) to our candidate
         arrays above. Fires on the first page only; set SAFQA_DEBUG=false in the
         backend env to silence once the mapping is finalised. ───────────────── */
      if (page === 1 && process.env.SAFQA_DEBUG !== 'false') {
        if (batch.length > 0) {
          console.log(
            '🔎 [Safqa DEBUG] First order object (map these keys, then trim the ' +
            'candidate arrays in externalAffiliate.js):\n' +
            JSON.stringify(batch[0], null, 2)
          );
        } else {
          /* No order rows found under the keys we tried — log the envelope so we
             can see where the array actually lives / whether auth really worked. */
          console.log(
            '🔎 [Safqa DEBUG] No orders array found under known keys. Raw response ' +
            'envelope (top-level keys help locate the list):\n' +
            JSON.stringify(data, null, 2).slice(0, 2000)
          );
        }
      }

      if (lastPage === null) lastPage = extractLastPage(data);

      /* Stop when we know we've hit the last page, or the API returned a short/
         empty page (no more data), whichever comes first. */
      if (lastPage !== null) { if (page >= lastPage) break; }
      else if (batch.length < SAFQA_PAGE_SIZE) break;
    }

    return aggregateOrders(all);
  } catch (err) {
    const status = err.response?.status;
    console.warn(
      `[externalAffiliate] Safqa fetch failed (merchant ${merchantId || '—'}` +
      `${status ? `, HTTP ${status}` : ''}):`, err.message
    );
    return { ...emptyStat(true), error: true };
  }
}

/**
 * Public entry point used by the analytics dashboard.
 * Resolves the tenant's saved config, then returns aggregated external stats.
 *
 * Shape:
 *   {
 *     enabled, taagerRevenue, safqaRevenue, totalRevenue, totalOrders,
 *     taager: { connected, revenue, orders, confirmed, delivered, confirmedRate, deliveredRate, error? },
 *     safqa:  { ...same... },
 *   }
 *
 * Always resolves (never throws) so a flaky external network can't break the
 * core dashboard — failures degrade to zeros.
 */
async function getExternalAffiliateStats(businessId) {
  const empty = {
    enabled:       false,
    taagerRevenue: 0,
    safqaRevenue:  0,
    totalRevenue:  0,
    totalOrders:   0,
    taager:        emptyStat(false),
    safqa:         emptyStat(false),
  };

  try {
    const creds = await loadAffiliateCreds(businessId);
    const [taager, safqa] = await Promise.all([
      fetchTaagerStats(creds.taager.url, creds.taager.merchant, creds.taager.token),
      fetchSafqaStats(creds.safqa.url, creds.safqa.merchant, creds.safqa.token),
    ]);

    return {
      enabled:       taager.connected || safqa.connected,
      taagerRevenue: taager.revenue,
      safqaRevenue:  safqa.revenue,
      totalRevenue:  taager.revenue + safqa.revenue,
      totalOrders:   taager.orders  + safqa.orders,
      taager,
      safqa,
    };
  } catch (err) {
    console.warn('[externalAffiliate] stats fetch failed:', err.message);
    return empty;
  }
}

module.exports = {
  NETWORK_KEYS,
  AFFILIATE_KEYS,
  loadAffiliateCreds,
  getExternalAffiliateStats,
  fetchTaagerOrders,
  fetchTaagerProducts,
};
