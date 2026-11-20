'use strict';

/* Unit tests for services/apiKeys.js — no database (pool.query is stubbed), no network.
   Run: npm test   (from backend/)  or  node --test src/services/apiKeys.test.js */

process.env.API_KEY_REQS_PER_MIN = '3';          // small limit so the rate-limit test is quick

const test   = require('node:test');
const assert = require('node:assert/strict');

/* Stub the DB BEFORE the module loads — a fake api_keys table in memory. */
const pool = require('../config/db');
const fake = { rows: [], queries: [], nextId: 1 };
pool.query = async (sql, params = []) => {
  fake.queries.push(sql);
  if (/CREATE TABLE IF NOT EXISTS api_keys/.test(sql)) return { rows: [] };
  if (/FROM api_keys k/.test(sql)) {                                   // findActiveKey
    const r = fake.rows.find((x) => x.key_hash === params[0] && !x.revoked_at);
    return { rows: r ? [{ ...r, plan_type: 'ecommerce', brand_name: 'Test' }] : [] };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM api_keys/.test(sql)) {
    return { rows: [{ n: fake.rows.filter((x) => x.business_id === params[0] && !x.revoked_at).length }] };
  }
  if (/INSERT INTO api_keys/.test(sql)) {
    const [business_id, name, key_hash, key_hint, scopes, created_by] = params;
    const row = { id: fake.nextId++, business_id, name, key_hash, key_hint, scopes, created_by,
      created_at: new Date(), last_used_at: null, request_count: 0, revoked_at: null, revoked_by: null };
    fake.rows.push(row);
    return { rows: [row] };
  }
  if (/UPDATE api_keys SET revoked_at/.test(sql)) {
    const r = fake.rows.find((x) => x.id === params[0] && x.business_id === params[1] && !x.revoked_at);
    if (!r) return { rows: [] };
    r.revoked_at = new Date(); r.revoked_by = params[2];
    return { rows: [r] };
  }
  if (/UPDATE api_keys\s+SET last_used_at/.test(sql)) {                // batched usage flush
    const r = fake.rows.find((x) => x.id === params[0]);
    if (r) { r.last_used_at = new Date(params[3]); r.last_used_ip = params[1]; r.request_count += params[2]; }
    return { rows: [] };
  }
  if (/FROM api_keys WHERE business_id/.test(sql)) return { rows: fake.rows.filter((x) => x.business_id === params[0]) };
  throw new Error('unexpected SQL in test: ' + sql.slice(0, 80));
};

const k = require('./apiKeys');

/* A tiny Express-like req/res for the middleware. */
function call(headers = {}, ip = '10.0.0.1') {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      set(h, v) { this.headers[h] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers, next: false }); return this; },
    };
    const req = { headers: { 'x-real-ip': ip, ...headers }, socket: {} };
    k.authenticateKey(req, res, () => resolve({ status: 200, apiKey: req.apiKey, headers: res.headers, next: true }));
  });
}

test('keys: 256-bit random, prefixed, hashed, never repeated', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const g = k.generateKey();
    assert.match(g.key, /^scalyo_[A-Za-z0-9_-]{43}$/);
    assert.equal(g.hash, k.sha256(g.key));
    assert.equal(g.hash.length, 64);
    assert.ok(g.hint.startsWith('scalyo_') && g.hint.includes('…'));
    assert.ok(!g.hint.includes(g.key.slice(13, 39)), 'the hint never shows the middle of the key');
    assert.equal(seen.has(g.key), false);
    seen.add(g.key);
  }
  assert.equal(k.looksLikeKey(k.generateKey().key), true);
  assert.equal(k.looksLikeKey('scalyo_short'), false);
  assert.equal(k.looksLikeKey('eyJhbGciOiJIUzI1NiJ9.x.y'), false);
  assert.equal(k.looksLikeKey(null), false);
});

test('scopes and names are cleaned', () => {
  assert.deepEqual(k.cleanScopes(['orders', 'admin', 'products', 'orders']), ['products', 'orders']);
  assert.deepEqual(k.cleanScopes('orders'), []);
  assert.deepEqual(k.cleanScopes(undefined), []);
  assert.equal(k.cleanName('  سيستم   الفيديوهات  '), 'سيستم الفيديوهات');
  assert.equal(k.cleanName('x'.repeat(100)).length, 60);
  assert.equal(k.cleanName(null), '');
});

test('the key is read from headers only (X-Api-Key or Bearer scalyo_…)', () => {
  const key = k.generateKey().key;
  assert.equal(k.keyFromHeaders({ 'x-api-key': ` ${key} ` }), key);
  assert.equal(k.keyFromHeaders({ authorization: `Bearer ${key}` }), key);
  assert.equal(k.keyFromHeaders({ authorization: 'Bearer eyJhbGciOi.jwt.token' }), null, 'a staff JWT is not an API key');
  assert.equal(k.keyFromHeaders({}), null);
});

test('caller address: X-Real-IP, then X-Forwarded-For, then the socket', () => {
  assert.equal(k.sourceOf({ headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' } }), '1.2.3.4');
  assert.equal(k.sourceOf({ headers: { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' } }), '5.6.7.8');
  assert.equal(k.sourceOf({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
});

test('fixed-window limiter', () => {
  const lim = k.makeLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(lim.take('a', 0).ok, true);
  assert.equal(lim.take('a', 10).ok, true);
  const third = lim.take('a', 20);
  assert.equal(third.ok, false);
  assert.equal(third.retryAfterSec, 1);
  assert.equal(lim.take('b', 20).ok, true, 'each caller has its own window');
  assert.equal(lim.take('a', 1001).ok, true, 'a new window starts fresh');
});

test('create → only the hash is stored; the key works; list never shows it', async () => {
  k._resetForTests();
  await assert.rejects(k.createKey({ businessId: 1, name: '  ', scopes: ['orders'] }), /اسم/);
  await assert.rejects(k.createKey({ businessId: 1, name: 'x', scopes: ['nope'] }), /حاجة واحدة/);
  const c = await k.createKey({ businessId: 1, name: 'سيستم الفيديوهات', scopes: ['products', 'orders'], createdBy: 'owner@x' });
  assert.match(c.key, /^scalyo_/);
  assert.deepEqual(c.scopes, ['products', 'orders']);
  const stored = fake.rows.find((r) => r.id === c.id);
  assert.equal(stored.key_hash, k.sha256(c.key));
  assert.ok(!JSON.stringify(stored).includes(c.key), 'the plain key is not stored');
  const listed = await k.listKeys(1);
  assert.ok(!JSON.stringify(listed).includes(c.key), 'the plain key is never listed');
  assert.ok(listed.every((r) => !('key_hash' in r)), 'the hash is never listed');

  const ok = await call({ 'x-api-key': c.key });
  assert.equal(ok.next, true);
  assert.equal(ok.apiKey.business_id, 1);
  assert.deepEqual(ok.apiKey.scopes, ['products', 'orders']);
});

test('missing / wrong / revoked keys are refused', async () => {
  k._resetForTests();
  const c = await k.createKey({ businessId: 1, name: 'a', scopes: ['orders'] });
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ 'x-api-key': 'scalyo_nope' })).status, 401);
  assert.equal((await call({ 'x-api-key': k.generateKey().key })).status, 401);
  assert.equal((await call({ 'x-api-key': c.key })).next, true);
  await k.revokeKey({ businessId: 2, id: c.id }).then(() => assert.fail('another business can not stop it'), (e) => assert.equal(e.status, 404));
  await k.revokeKey({ businessId: 1, id: c.id, revokedBy: 'owner' });
  const after = await call({ 'x-api-key': c.key });
  assert.equal(after.status, 401, 'a stopped key stops working at once (cache dropped)');
});

test('rate limit per key: the 4th request in a minute gets 429 + Retry-After', async () => {
  k._resetForTests();
  const c = await k.createKey({ businessId: 1, name: 'rl', scopes: ['orders'] });
  for (let i = 0; i < 3; i++) assert.equal((await call({ 'x-api-key': c.key })).next, true);
  const blocked = await call({ 'x-api-key': c.key });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['Retry-After']) >= 1);
});

test('junk keys from one address are capped without hitting the DB; a known key still passes', async () => {
  k._resetForTests();
  const c = await k.createKey({ businessId: 1, name: 'cap', scopes: ['orders'] });
  assert.equal((await call({ 'x-api-key': c.key }, '7.7.7.7')).next, true);   // now cached
  for (let i = 0; i < 50; i++) assert.equal((await call({ 'x-api-key': k.generateKey().key }, '7.7.7.7')).status, 401);
  const before = fake.queries.length;
  const capped = await call({ 'x-api-key': k.generateKey().key }, '7.7.7.7');
  assert.equal(capped.status, 429);
  assert.equal(fake.queries.length, before, 'no DB lookup once capped');
  assert.equal((await call({ 'x-api-key': c.key }, '7.7.7.7')).next, true, 'the real key (cached) is not blocked');
  assert.equal((await call({ 'x-api-key': k.generateKey().key }, '8.8.8.8')).status, 401, 'other addresses unaffected');
});

test('at most MAX_ACTIVE live keys per business', async () => {
  k._resetForTests();
  fake.rows = [];
  for (let i = 0; i < k.MAX_ACTIVE; i++) await k.createKey({ businessId: 9, name: `k${i}`, scopes: ['orders'] });
  await assert.rejects(k.createKey({ businessId: 9, name: 'one more', scopes: ['orders'] }), /أقصى عدد/);
});

test('usage shows up in the list before it is flushed', async () => {
  k._resetForTests();
  fake.rows = [];
  const c = await k.createKey({ businessId: 3, name: 'u', scopes: ['orders'] });
  await call({ 'x-api-key': c.key });
  await call({ 'x-api-key': c.key });
  const [row] = await k.listKeys(3);
  assert.equal(row.request_count, 2);
  assert.ok(row.last_used_at instanceof Date);
  assert.equal(row.active, true);
});
