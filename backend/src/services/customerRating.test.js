'use strict';

/* Unit tests for services/customerRating.js — no database, no network.
   Run: npm test   (from backend/)  or  node --test src/services/customerRating.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { easyOrderRateOf, bostaBudget } = require('./customerRating');

test('EasyOrder rating: read from metadata["<phone>"] (shape seen on the live API)', () => {
  const order = { metadata: {
    '01220888147': { delivery_rate_status: 'completed', order_delivery_rate_id: 'x', rate_result: 'high' },
    tracking: { orders_count: 0 },
  } };
  assert.deepEqual(easyOrderRateOf(order), { done: true, result: 'high', status: 'completed' });
});

test('EasyOrder rating: every value the live API returned', () => {
  for (const r of ['high', 'moderate', 'low', 'unknown']) {
    const o = { metadata: { '0100': { delivery_rate_status: 'completed', rate_result: r } } };
    assert.equal(easyOrderRateOf(o).result, r);
    assert.equal(easyOrderRateOf(o).done, true);
  }
});

test('EasyOrder rating: not ready yet / missing / odd values', () => {
  assert.equal(easyOrderRateOf({ metadata: { tracking: {} } }), null);
  assert.equal(easyOrderRateOf({}), null);
  assert.equal(easyOrderRateOf(null), null);
  assert.equal(easyOrderRateOf({ metadata: { '0100': { delivery_rate_status: 'pending' } } }).done, false);
  assert.equal(easyOrderRateOf({ metadata: { '0100': { delivery_rate_status: 'completed', rate_result: 'weird' } } }).done, false);
  assert.equal(easyOrderRateOf({ metadata: { '0100': { delivery_rate_status: 'COMPLETED', rate_result: 'High' } } }).result, 'high');
});

test('Bosta budget: spends at most 90 a day and 15 per 4 hours', () => {
  assert.equal(bostaBudget({ calls24h: 0, calls4h: 0 }).allowed, true);
  assert.equal(bostaBudget({ calls24h: 89, calls4h: 14 }).allowed, true);
  assert.equal(bostaBudget({ calls24h: 90, calls4h: 0 }).reason, 'daily budget');
  assert.equal(bostaBudget({ calls24h: 40, calls4h: 15 }).reason, '4-hour budget');
});

test('Bosta budget: after a 429, wait an hour before probing again', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(bostaBudget({ calls24h: 0, calls4h: 0, last429At: '2026-11-20T11:30:00Z', now }).reason, 'blocked');
  assert.equal(bostaBudget({ calls24h: 0, calls4h: 0, last429At: '2026-11-20T10:59:00Z', now }).allowed, true);
});
