/* ══════════════════════════════════════════════════════════════════════════
   /api/v1 — READ-ONLY API for the owner's other systems (video studio, …).
   Contract + examples: docs/external-api.md.

   • Auth: a key from «مفاتيح API» in the X-Api-Key header (services/apiKeys.js).
   • Read-only by construction: only GET is routed; any other method → 405
     before the key is even checked. The key can't reach any other /api route —
     those only accept a staff login (JWT).
   • No customer data: /orders selects an explicit column list without name,
     phone, address, notes or tracking code.
   • Same numbers as the dashboard: /products and /summary call the SAME
     analytics handlers «التحليلات» uses (no copy of the maths), then reshape.
   • Never slows the system: per-key rate limit, heavy reports cached 2 min,
     one heavy report computed at a time.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const pool    = require('../config/db');
const apiKeys = require('../services/apiKeys');
const ext     = require('../services/externalApi');

const router = express.Router();

/* 1) read-only */
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.set('Allow', 'GET');
  return res.status(405).json({ error: 'read_only', message: 'This API is read-only: GET requests only.' });
});
/* 2) key → req.apiKey (401 / 429 otherwise) */
router.use(apiKeys.authenticateKey);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const requireScope = (scope) => (req, res, next) => (
  (req.apiKey.scopes || []).includes(scope)
    ? next()
    : res.status(403).json({ error: 'scope_missing', message: `This key can't read "${scope}". The account owner can create a key that includes it.` })
);

/* The P&L handlers are built for e-commerce tenants (affiliate tenants have no local orders). */
const ecommerceOnly = (req, res, next) => (
  req.apiKey.plan_type === 'affiliate'
    ? res.status(501).json({ error: 'not_available', message: 'Not available for affiliate accounts yet.' })
    : next()
);

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.code || 'bad_request', message: err.message });
  }
  if (err.status === 503) return res.status(503).json({ error: 'busy', message: 'Busy right now. Retry in a few seconds.' });
  console.error(`[api/v1] ${req.path} key#${req.apiKey?.id}:`, err.message);
  return res.status(500).json({ error: 'internal_error', message: 'Something went wrong on our side.' });
});

/* ── the dashboard's own handlers, called in-process ──────────────────────── */
let handlers = null;
function analyticsHandlers() {
  if (handlers) return handlers;
  const analytics = require('./analytics');
  const find = (path) => {
    const layer = analytics.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
    if (!layer) throw new Error(`analytics route GET ${path} not found`);
    return layer.route.stack[layer.route.stack.length - 1].handle;   // the handler after authenticate
  };
  handlers = { profitability: find('/products-profitability'), dashboard: find('/dashboard') };
  return handlers;
}

/* What the handlers see as req.user: an admin of the key's business with no
   media-buyer filter → the master (all-products) view. Lives only in memory
   for the call; never a token, never leaves the process. */
function principalOf(key) {
  return {
    id:          `api-key-${key.id}`,
    email:       `api-key-${key.id}`,
    role:        'admin',
    roles:       ['admin'],
    permissions: [],
    business_id: key.business_id,
    plan_type:   key.plan_type || 'ecommerce',
    api_key_id:  key.id,
  };
}

function callHandler(handle, user, query) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = { method: 'GET', user, query, params: {}, body: {}, headers: {}, url: '', path: '', get: () => undefined };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      set() { return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
      json(body) { done({ status: this.statusCode, body }); return this; },
      send(body) { done({ status: this.statusCode, body }); return this; },
      end() { done({ status: this.statusCode, body: null }); return this; },
    };
    Promise.resolve()
      .then(() => handle(req, res, (err) => (err ? reject(err) : done({ status: 404, body: null }))))
      .catch(reject);
  });
}

/* One heavy report at a time (the dashboard query fans out over several pool
   connections); others wait up to 20 s, then get 503 «busy». */
const HEAVY_WAIT_MS = 20 * 1000;
let heavyActive = false;
const heavyQueue = [];
function heavy(fn) {
  const run = async () => {
    try { return await fn(); } finally {
      heavyActive = false;
      const next = heavyQueue.shift();
      if (next) next();
    }
  };
  if (!heavyActive) { heavyActive = true; return run(); }
  return new Promise((resolve, reject) => {
    const start = () => { clearTimeout(timer); heavyActive = true; run().then(resolve, reject); };
    const timer = setTimeout(() => {
      const i = heavyQueue.indexOf(start);
      if (i >= 0) heavyQueue.splice(i, 1);
      reject(Object.assign(new Error('busy'), { status: 503 }));
    }, HEAVY_WAIT_MS);
    heavyQueue.push(start);
  });
}

/* Heavy reports cached 2 min per business + range (same request twice → one query). */
const MEMO_MS = 2 * 60 * 1000;
const memo = new Map();
function cached(key, fn) {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < MEMO_MS) return hit.p;
  const p = fn();
  memo.set(key, { at: now, p });
  p.catch(() => { if (memo.get(key)?.p === p) memo.delete(key); });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return p;
}

async function internal(name, key, range) {
  const out = await callHandler(analyticsHandlers()[name], principalOf(key), { startDate: range.from, endDate: range.to });
  if (out.status !== 200) {
    throw new Error(`analytics ${name} answered ${out.status}: ${JSON.stringify(out.body).slice(0, 300)}`);
  }
  return out.body;
}

const profitability = (key, range) =>
  cached(`${key.business_id}|products|${range.from}|${range.to}`, () => heavy(() => internal('profitability', key, range)));
const dashboard = (key, range) =>
  cached(`${key.business_id}|dashboard|${range.from}|${range.to}`, () => heavy(() => internal('dashboard', key, range)));

const clampInt = (v, dflt, min, max) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/* ── GET /api/v1/me — "is my key working?" ────────────────────────────────── */
router.get('/me', (req, res) => {
  const k = req.apiKey;
  res.json({
    key:                 { name: k.name, hint: k.key_hint, scopes: k.scopes || [], created_at: k.created_at },
    business:            { id: k.business_id, name: k.brand_name || null },
    read_only:           true,
    customer_data:       'hidden',
    requests_per_minute: apiKeys.REQS_PER_MIN,
  });
});

/* ── GET /api/v1/products?from&to — every product's numbers + profit/loss ─── */
router.get('/products', requireScope('products'), ecommerceOnly, wrap(async (req, res) => {
  const range = ext.parseRange(req.query);
  const [rows, cat] = await Promise.all([
    profitability(req.apiKey, range),
    pool.query(
      `SELECT id::text AS id, stock_quantity, selling_price, stopped_at
         FROM products WHERE business_id = $1`,
      [req.apiKey.business_id]
    ),
  ]);
  const products = ext.mapProducts(Array.isArray(rows) ? rows : [], cat.rows);
  res.json({ range, currency: 'EGP', generated_at: new Date().toISOString(), count: products.length, products });
}));

/* ── GET /api/v1/summary?from&to — the business numbers (top cards + charts) ─ */
router.get('/summary', requireScope('summary'), ecommerceOnly, wrap(async (req, res) => {
  const range = ext.parseRange(req.query);
  const [dash, rows] = await Promise.all([dashboard(req.apiKey, range), profitability(req.apiKey, range)]);
  res.json({
    range,
    currency:     'EGP',
    generated_at: new Date().toISOString(),
    ...ext.mapSummary(dash || {}, Array.isArray(rows) ? rows : []),
  });
}));

/* ── GET /api/v1/orders — orders WITHOUT customer data ─────────────────────── */
const PRICE = `COALESCE(NULLIF(REGEXP_REPLACE(COALESCE(o."ProductPrice"::text, ''), '[^0-9.]', '', 'g'), '')::numeric, 0)`;
/* "createdAt" is a timestamp WITHOUT time zone holding UTC wall-clock time. */
const ORDER_COLS = `
  o.id, o.order_source AS source, o.external_order_id, btrim(o."Status") AS status,
  o."ProductName" AS product_name, o.sku, o.quantity, ${PRICE} AS price,
  COALESCE(o."depositAmount", 0) AS deposit, o."City" AS city,
  (o."createdAt" AT TIME ZONE 'UTC') AS created_at,
  to_char((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS created_day,
  o.shipped_at, o.delivered_at, o.status_changed_at,
  o."rejectionReason" AS rejection_reason, o."DeliveryRate" AS bosta_rating,
  (to_jsonb(o) ->> 'easyorder_rate') AS easyorder_rating`;

router.get('/orders', requireScope('orders'), wrap(async (req, res) => {
  const range = ext.parseRange(req.query);
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const page  = clampInt(req.query.page, 1, 1, 1000000);
  const biz   = req.apiKey.business_id;

  const params = [biz, ext.dayStart(range.from), ext.dayEnd(range.to)];
  let where = `o.business_id = $1 AND o."createdAt" >= $2::timestamptz AND o."createdAt" <= $3::timestamptz`;

  if (req.query.status) {
    params.push(String(req.query.status).trim());
    where += ` AND btrim(o."Status") = $${params.length}`;
  }
  if (req.query.group) {
    const g = String(req.query.group);
    const list = Object.prototype.hasOwnProperty.call(ext.STATUS_GROUPS, g) ? ext.STATUS_GROUPS[g] : null;   // not ?group=constructor
    if (!list) throw ext.badRequest(`Unknown group. Use one of: ${Object.keys(ext.STATUS_GROUPS).join(', ')}`);
    params.push(list);
    where += ` AND btrim(o."Status") = ANY($${params.length}::text[])`;
  }
  if (req.query.product_id) {
    const pid = String(req.query.product_id).trim();                      // products.id is a UUID
    if (!/^[0-9A-Za-z-]{1,64}$/.test(pid)) throw ext.badRequest('`product_id` must be a product_id from /products');
    const { rows: [p] } = await pool.query(
      `SELECT sku, name FROM products WHERE id::text = $1 AND business_id = $2`, [pid, biz]);
    if (!p) throw Object.assign(new Error('Unknown product_id'), { status: 404, code: 'not_found' });
    /* The exact product↔order match of the products report (SKU first, name
       fallback only for an order whose SKU matches no product), so the count
       here equals that product's `orders` in /products for the same range. */
    params.push(p.sku || '', p.name || '');
    const s = `$${params.length - 1}`;
    const n = `$${params.length}`;
    where += ` AND (
        ( COALESCE(o.sku, '') <> '' AND UPPER(o.sku) = UPPER(${s}) )
        OR ( UPPER(TRIM(COALESCE(o."ProductName", ''))) = UPPER(TRIM(${n}))
             AND NOT EXISTS (SELECT 1 FROM products px
                              WHERE px.business_id = $1 AND COALESCE(o.sku, '') <> ''
                                AND UPPER(px.sku) = UPPER(o.sku)) ) )`;
  }
  if (req.query.sku) {
    params.push(String(req.query.sku).trim());
    where += ` AND UPPER(o.sku) = UPPER($${params.length})`;
  }

  const [list, count] = await Promise.all([
    pool.query(
      `SELECT ${ORDER_COLS} FROM orders o WHERE ${where}
        ORDER BY o."createdAt" DESC, o.id DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM orders o WHERE ${where}`, params),
  ]);
  const total = count.rows[0]?.n || 0;
  res.json({
    range,
    currency: 'EGP',
    page,
    limit,
    total,
    has_more: page * limit < total,
    orders:   list.rows.map(ext.mapOrder),
  });
}));

router.use((req, res) => res.status(404).json({ error: 'not_found', message: 'Unknown endpoint. Available: /me, /products, /summary, /orders' }));

module.exports = router;
module.exports._internals = { analyticsHandlers, callHandler, principalOf, heavy, cached, ORDER_COLS };
