'use strict';

/* Unit tests for services/capital.js (the pure parts) — no database, no network.
   Run: npm test   (from backend/)  or  node --test src/services/capital.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const cap    = require('./capital');

test('the shelf: units × cost price; no-cost and negative stock are flagged, not counted', () => {
  const w = cap.summarizeWarehouse([
    { id: 'a', name: 'داش كام', stock_quantity: 72, cost_price: '900.00' },
    { id: 'b', name: 'سوار', stock_quantity: 10, cost_price: 300 },
    { id: 'c', name: 'منتج بدون تكلفة', stock_quantity: 5, cost_price: null },
    { id: 'd', name: 'سالب', stock_quantity: -11, cost_price: 200 },
    { id: 'e', name: 'صفر', stock_quantity: 0, cost_price: 500 },
  ]);
  assert.equal(w.cost, 72 * 900 + 10 * 300);
  assert.equal(w.units, 87);
  assert.equal(w.products, 3);
  assert.deepEqual(w.items.map((x) => x.name), ['داش كام', 'سوار', 'منتج بدون تكلفة']);
  assert.deepEqual(w.missing_cost, [{ product_id: 'c', name: 'منتج بدون تكلفة', units: 5 }]);
  assert.deepEqual(w.negative, [{ product_id: 'd', name: 'سالب', units: -11 }]);
});

test('goods off the shelf: each status in its bucket, the order snapshot cost first', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  const old = '2026-11-05T10:00:00Z';
  const fresh = '2026-11-20T10:00:00Z';
  const g = cap.summarizeGoodsOut([
    { id: 1, status: 'تم الشحن', quantity: 1, unit_cost_price: '880', product_cost: 900, product_id: 'a', product_name: 'داش كام', since: fresh },
    { id: 2, status: 'تم الشحن', quantity: 2, unit_cost_price: null, product_cost: 900, product_id: 'a', product_name: 'داش كام', since: old },
    { id: 3, status: ' تم التأكيد ', quantity: 1, unit_cost_price: 300, product_cost: 300, product_id: 'b', product_name: 'سوار', since: old },
    { id: 4, status: 'جاري الإعادة', quantity: 1, unit_cost_price: 0, product_cost: 300, product_id: 'b', product_name: 'سوار', since: old },
    { id: 5, status: 'تم الشحن', quantity: 1, unit_cost_price: null, product_cost: null, product_id: null, order_product: 'منتج مش في المخزون', since: fresh },
    { id: 6, status: 'مؤجل', quantity: 1, unit_cost_price: 500, product_cost: 500, product_id: 'c', product_name: 'تابلت', since: fresh },
  ], now);

  assert.equal(g.in_transit.orders, 3);
  assert.equal(g.in_transit.units, 4);
  assert.equal(g.in_transit.cost, 880 + 2 * 900 + 0, 'snapshot 880 wins over the current 900; a missing cost counts 0');
  assert.deepEqual(g.in_transit.stale, { orders: 1, cost: 1800 }, `older than ${cap.STALE_DAYS} days`);
  assert.deepEqual(g.in_transit.items.map((x) => [x.name, x.units, x.cost]), [['داش كام', 3, 2680], ['منتج مش في المخزون', 1, 0]]);
  assert.equal(g.in_transit.items[0].unit_cost, parseFloat((2680 / 3).toFixed(2)));

  assert.equal(g.confirmed.cost, 300);
  assert.deepEqual(g.confirmed.stale, { orders: 0, cost: 0 }, 'confirmed orders are on our shelf, never «late»');
  assert.equal(g.returning.cost, 300, 'a 0 snapshot falls back to the product cost');
  assert.equal(g.returning.stale.orders, 1);

  assert.equal(g.other.length, 1);
  assert.equal(g.other[0].status, 'مؤجل');
  assert.equal(g.other[0].cost, 500);
  assert.deepEqual(g.missing_cost, [{ order_id: 5, product: 'منتج مش في المخزون', status: 'تم الشحن' }]);
});

test('the total = money + goods; a failed wallet read marks it incomplete', () => {
  const out = cap.summarizeGoodsOut([
    { id: 1, status: 'تم الشحن', quantity: 1, unit_cost_price: 900, since: new Date() },
    { id: 2, status: 'تم التأكيد', quantity: 1, unit_cost_price: 300, since: new Date() },
    { id: 3, status: 'جاري الإعادة', quantity: 1, unit_cost_price: 100, since: new Date() },
  ]);
  const warehouse = { cost: 1000 };
  const treasury = { balance: 80281.5 };
  assert.deepEqual(cap.total({ wallet: { ok: true, balance: 783599.09 }, treasury, warehouse, out }),
    { money: 863880.59, goods: 2300, capital: 866180.59, complete: true });
  assert.deepEqual(cap.total({ wallet: { ok: false, balance: null }, treasury, warehouse, out }),
    { money: 80281.5, goods: 2300, capital: 82581.5, complete: false });
});

test('Cairo day', () => {
  assert.equal(cap.cairoDay(new Date('2026-11-22T22:30:00Z')), '2026-11-23');
  assert.equal(cap.cairoDay(new Date('2026-11-22T21:30:00Z')), '2026-11-22');
});
