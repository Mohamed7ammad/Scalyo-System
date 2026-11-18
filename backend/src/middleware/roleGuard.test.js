'use strict';

/* Unit tests for middleware/roleGuard.js filterAgentFields — no database needed.
   Run: npm test   (from backend/)  or  node --test src/middleware/roleGuard.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { filterAgentFields } = require('./roleGuard');

/* Runs the middleware; returns { nextCalled, status, body, reqBody }. */
function run(user, body) {
  const req = { user, body: { ...body } };
  const out = { nextCalled: false, status: 200, body: null };
  const res = {
    status(code) { out.status = code; return this; },
    json(payload) { out.body = payload; return this; },
  };
  filterAgentFields(req, res, () => { out.nextCalled = true; });
  return { ...out, reqBody: req.body };
}

const AGENT  = { role: 'agent', roles: ['agent'], permissions: ['orders'] };
const LEADER = { role: 'supervisor', roles: ['supervisor'], permissions: ['orders', 'reassign_orders'] };
const ADMIN  = { role: 'admin', roles: ['admin'], permissions: [] };

test('an agent cannot change the delivery rating: it is dropped, the rest goes through', () => {
  const r = run(AGENT, { DeliveryRate: 'ممتاز', Note: 'اتصلت' });
  assert.equal(r.nextCalled, true);
  assert.deepEqual(r.reqBody, { Note: 'اتصلت' });
});

test('an agent sending ONLY the rating changes nothing', () => {
  const r = run(AGENT, { DeliveryRate: 'ممتاز' });
  assert.equal(r.nextCalled, true);
  assert.deepEqual(r.reqBody, {});
});

test('a team-leader cannot change it either', () => {
  const r = run(LEADER, { DeliveryRate: 'ضعيف', Address: 'شارع ١' });
  assert.equal(r.nextCalled, true);
  assert.deepEqual(r.reqBody, { Address: 'شارع ١' });
});

test('the owner (admin) still can', () => {
  const r = run(ADMIN, { DeliveryRate: 'ممتاز' });
  assert.equal(r.nextCalled, true);
  assert.deepEqual(r.reqBody, { DeliveryRate: 'ممتاز' });
});

test('other forbidden fields are still refused for an agent', () => {
  const r = run(AGENT, { ProductPrice: '10' });
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 403);
});
