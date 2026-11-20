/* ══════════════════════════════════════════════════════════════════════════
   Read-only API keys — another system (the owner's video studio) READS this
   business's numbers through /api/v1: product P&L, business summary, orders
   WITHOUT customer data. Owner decision 2026-11-20.

   • A key = 'scalyo_' + 43 random base64url chars (256 bits). Only its SHA-256
     is stored; the full key is shown ONCE, at creation.
   • Keys are never deleted — «إيقاف» stamps revoked_at (owner rule: nothing is
     ever deleted) and the key stops working at once (one backend process, and
     revoke drops it from the in-memory cache).
   • Usage (last_used_at / request_count) is flushed at most once a minute per
     key, so API traffic adds next to no DB writes.
   • Limits: REQS_PER_MIN per key, and a cap on failed key lookups per source
     address so junk keys can't hammer the DB.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const pool   = require('../config/db');

const KEY_PREFIX   = 'scalyo_';
const KEY_RE       = /^scalyo_[A-Za-z0-9_-]{43}$/;
const SCOPES       = ['products', 'summary', 'orders'];
const MAX_ACTIVE   = 10;          // live keys per business
const CACHE_MS     = 60 * 1000;   // a valid key is re-checked against the DB at most once a minute
const FLUSH_MS     = 60 * 1000;   // usage counters → DB at most once a minute per key
const REQS_PER_MIN = Math.max(1, parseInt(process.env.API_KEY_REQS_PER_MIN || '60', 10) || 60);
const FAILS_PER_10M = 50;         // failed lookups allowed per source address per 10 minutes

const DDL = `
  CREATE TABLE IF NOT EXISTS api_keys (
    id            SERIAL PRIMARY KEY,
    business_id   INTEGER     NOT NULL,
    name          TEXT        NOT NULL,
    key_hash      TEXT        NOT NULL UNIQUE,
    key_hint      TEXT        NOT NULL,
    scopes        TEXT[]      NOT NULL DEFAULT '{}',
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ,
    last_used_ip  TEXT,
    request_count BIGINT      NOT NULL DEFAULT 0,
    revoked_at    TIMESTAMPTZ,
    revoked_by    TEXT
  );
  CREATE INDEX IF NOT EXISTS api_keys_business_idx ON api_keys (business_id, created_at DESC);
`;

let schemaP = null;
function ensureSchema() {
  if (!schemaP) {
    schemaP = pool.query(DDL).then(() => true).catch((err) => { schemaP = null; throw err; });
  }
  return schemaP;
}
/* Tests run inside a READ ONLY transaction with a TEMP api_keys table. */
function _markSchemaReadyForTests() { schemaP = Promise.resolve(true); }

/* ── pure helpers ─────────────────────────────────────────────────────────── */
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function generateKey() {
  const body = crypto.randomBytes(32).toString('base64url');          // 43 chars
  const key  = KEY_PREFIX + body;
  return { key, hash: sha256(key), hint: `${KEY_PREFIX}${body.slice(0, 6)}…${body.slice(-4)}` };
}

const looksLikeKey = (s) => typeof s === 'string' && KEY_RE.test(s);

function cleanScopes(input) {
  const list = Array.isArray(input) ? input.map(String) : [];
  return SCOPES.filter((s) => list.includes(s));
}

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

/* The key from the request: `X-Api-Key: …` or `Authorization: Bearer scalyo_…`.
   Never from the URL — URLs end up in nginx and app logs. */
function keyFromHeaders(headers = {}) {
  const x = headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+scalyo_/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

/* Who is calling (for the failed-lookup cap and the «آخر استخدام» IP). nginx on
   scalyoo.com/api sets X-Real-IP; anything else falls back to the socket. */
function sourceOf(req) {
  const real = req.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

/* Fixed-window counter: take(k) counts one hit and says whether it is allowed. */
function makeLimiter({ limit, windowMs }) {
  const hits = new Map();
  const slot = (k, now) => {
    let h = hits.get(k);
    if (!h || now - h.start >= windowMs) {
      h = { start: now, n: 0 };
      hits.set(k, h);
      if (hits.size > 5000) {                       // forget stale windows
        for (const [key, v] of hits) if (now - v.start >= windowMs) hits.delete(key);
      }
    }
    return h;
  };
  return {
    take(k, now = Date.now()) {
      const h = slot(k, now);
      h.n += 1;
      return {
        ok:            h.n <= limit,
        limit,
        remaining:     Math.max(0, limit - h.n),
        retryAfterSec: Math.max(1, Math.ceil((h.start + windowMs - now) / 1000)),
      };
    },
    blocked(k, now = Date.now()) { return slot(k, now).n >= limit; },
    reset() { hits.clear(); },
  };
}

const perKey   = makeLimiter({ limit: REQS_PER_MIN,  windowMs: 60 * 1000 });
const failures = makeLimiter({ limit: FAILS_PER_10M, windowMs: 10 * 60 * 1000 });

/* ── usage counters (batched) ─────────────────────────────────────────────── */
const usage = new Map();   // key id → { n, ip, at, flushedAt }
let flushTimer = null;

function flushUsage(id) {
  const u = usage.get(id);
  if (!u || u.n === 0) return Promise.resolve();
  const n = u.n;
  u.n = 0;
  u.flushedAt = Date.now();
  return pool.query(
    `UPDATE api_keys
        SET last_used_at  = to_timestamp($4::double precision / 1000),
            last_used_ip  = $2,
            request_count = request_count + $3
      WHERE id = $1`,
    [id, u.ip, n, u.at]
  ).catch((err) => { u.n += n; console.warn('[api-keys] usage flush failed:', err.message); });
}

function flushAllUsage() {
  return Promise.all([...usage.keys()].map((id) => flushUsage(id)));
}

function noteUse(id, ip, now = Date.now()) {
  const u = usage.get(id) || { n: 0, ip: null, at: 0, flushedAt: 0 };
  u.n += 1;
  u.ip = ip;
  u.at = now;
  usage.set(id, u);
  if (now - u.flushedAt >= FLUSH_MS) flushUsage(id);
  if (!flushTimer) {
    flushTimer = setInterval(flushAllUsage, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
}

/* ── lookups ──────────────────────────────────────────────────────────────── */
const cache = new Map();   // sha256 → { row, at }

function cachedRow(hash, now = Date.now()) {
  const hit = cache.get(hash);
  return hit && now - hit.at < CACHE_MS ? hit.row : null;
}

async function findActiveKey(key) {
  if (!looksLikeKey(key)) return null;
  const hash = sha256(key);
  const hit = cachedRow(hash);
  if (hit) return hit;
  await ensureSchema();
  const { rows: [row] } = await pool.query(
    `SELECT k.id, k.business_id, k.name, k.key_hint, k.scopes, k.created_at,
            COALESCE(bp.plan_type, 'ecommerce') AS plan_type, bp.brand_name
       FROM api_keys k
       LEFT JOIN business_profile bp ON bp.id = k.business_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hash]
  );
  if (row) {
    cache.set(hash, { row, at: Date.now() });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  } else {
    cache.delete(hash);
  }
  return row || null;
}

/* Express middleware for /api/v1: a valid, live key → req.apiKey; else 401/429.
   Express 4 ignores a middleware's promise and this process has no global
   unhandledRejection handler (an escaped rejection would stop the backend), so
   the async body is wrapped: whatever happens, the caller gets an answer. */
function authenticateKey(req, res, next) {
  authenticateKeyInner(req, res, next).catch((err) => {
    console.error('[api-keys] auth failed unexpectedly:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: 'Something went wrong on our side.' });
  });
}

async function authenticateKeyInner(req, res, next) {
  const key = keyFromHeaders(req.headers);
  const src = sourceOf(req);
  if (!key) {
    return res.status(401).json({ error: 'missing_key', message: 'Send your key in the X-Api-Key header.' });
  }
  const known = looksLikeKey(key) && cachedRow(sha256(key));
  if (!known && failures.blocked(src)) {
    return res.status(429).json({ error: 'too_many_failed_attempts', message: 'Too many invalid keys from this address. Try again later.' });
  }
  let row;
  try {
    row = known || await findActiveKey(key);
  } catch (err) {
    console.error('[api-keys] lookup failed:', err.message);
    return res.status(503).json({ error: 'unavailable', message: 'Temporarily unavailable. Retry shortly.' });
  }
  if (!row) {
    failures.take(src);
    return res.status(401).json({ error: 'invalid_key', message: 'This key is wrong or was stopped.' });
  }
  const rl = perKey.take(row.id);
  res.set('X-RateLimit-Limit', String(rl.limit));
  res.set('X-RateLimit-Remaining', String(rl.remaining));
  if (!rl.ok) {
    res.set('Retry-After', String(rl.retryAfterSec));
    return res.status(429).json({ error: 'rate_limited', message: `Max ${rl.limit} requests per minute.`, retry_after_seconds: rl.retryAfterSec });
  }
  noteUse(row.id, src);
  req.apiKey = row;
  return next();
}

/* ── admin management (JWT, admin only — see routes/apiKeys.js) ─────────── */
const PUBLIC_COLS = `id, name, key_hint, scopes, created_by, created_at, last_used_at,
                     request_count, revoked_at, revoked_by`;

/* DB row + the not-yet-flushed usage, so the page shows live numbers. */
function publicRow(r) {
  const u = usage.get(r.id);
  const pendingAt = u && u.at ? new Date(u.at) : null;
  const last = r.last_used_at ? new Date(r.last_used_at) : null;
  return {
    id:            r.id,
    name:          r.name,
    key_hint:      r.key_hint,
    scopes:        r.scopes || [],
    created_by:    r.created_by || null,
    created_at:    r.created_at,
    last_used_at:  pendingAt && (!last || pendingAt > last) ? pendingAt : last,
    request_count: Number(r.request_count || 0) + (u ? u.n : 0),
    revoked_at:    r.revoked_at || null,
    revoked_by:    r.revoked_by || null,
    active:        !r.revoked_at,
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function listKeys(businessId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLS} FROM api_keys WHERE business_id = $1
      ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
    [businessId]
  );
  return rows.map(publicRow);
}

async function createKey({ businessId, name, scopes, createdBy }) {
  const nm = cleanName(name);
  const sc = cleanScopes(scopes);
  if (!businessId) throw httpError(400, 'الحساب مش مربوط ببيزنس');
  if (!nm) throw httpError(400, 'اكتب اسم للمفتاح');
  if (!sc.length) throw httpError(400, 'اختار حاجة واحدة على الأقل يشوفها المفتاح');
  await ensureSchema();
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM api_keys WHERE business_id = $1 AND revoked_at IS NULL`,
    [businessId]
  );
  if (n >= MAX_ACTIVE) throw httpError(400, `أقصى عدد ${MAX_ACTIVE} مفاتيح شغالة — وقّف مفتاح مش مستخدم الأول`);
  const g = generateKey();
  const { rows: [row] } = await pool.query(
    `INSERT INTO api_keys (business_id, name, key_hash, key_hint, scopes, created_by)
     VALUES ($1, $2, $3, $4, $5::text[], $6)
     RETURNING ${PUBLIC_COLS}`,
    [businessId, nm, g.hash, g.hint, sc, createdBy || null]
  );
  return { ...publicRow(row), key: g.key };
}

async function revokeKey({ businessId, id, revokedBy }) {
  const keyId = parseInt(id, 10);
  if (!Number.isInteger(keyId) || keyId <= 0) throw httpError(400, 'مفتاح غير صحيح');
  await ensureSchema();
  const { rows: [row] } = await pool.query(
    `UPDATE api_keys SET revoked_at = NOW(), revoked_by = $3
      WHERE id = $1 AND business_id = $2 AND revoked_at IS NULL
      RETURNING ${PUBLIC_COLS}`,
    [keyId, businessId, revokedBy || null]
  );
  for (const [hash, c] of cache) if (c.row && Number(c.row.id) === keyId) cache.delete(hash);
  if (!row) throw httpError(404, 'المفتاح مش موجود أو متوقف بالفعل');
  return publicRow(row);
}

module.exports = {
  SCOPES, MAX_ACTIVE, REQS_PER_MIN, DDL,
  ensureSchema, _markSchemaReadyForTests,
  sha256, generateKey, looksLikeKey, cleanScopes, cleanName, keyFromHeaders, sourceOf, makeLimiter,
  authenticateKey, findActiveKey, flushAllUsage,
  listKeys, createKey, revokeKey,
  _resetForTests() { cache.clear(); usage.clear(); perKey.reset(); failures.reset(); },
};
