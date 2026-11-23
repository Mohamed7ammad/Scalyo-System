'use strict';

/* Unit tests for services/capital.js (the pure parts) — no database, no network.
   Run: npm test   (from backend/)  or  node --test src/services/capital.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const cap    = require('./capital');

test('the shelf counts only goods that exist; the inventory page total (negatives included) is kept for reconciliation', () => {
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
  assert.deepEqual(w.negative, [{ product_id: 'd', name: 'سالب', units: -11, unit_cost: 200, cost: -2200, no_goods_confirmed: 0, gap: 11 }], 'no confirmed orders → flagged as a gap');
  assert.equal(w.inventory_page_total, 72 * 900 + 10 * 300 - 11 * 200, 'the inventory page subtracts the negatives');

  /* the hair cap: −7 with 13 confirmed → nothing free on the shelf, 7 confirmed units have no goods */
  const w2 = cap.summarizeWarehouse([{ id: 'cap', name: 'كاب', stock_quantity: -7, cost_price: 850 }, { id: 'a', name: 'داش كام', stock_quantity: 2, cost_price: 900 }],
    new Map([['cap', 13]]));
  assert.equal(w2.cost, 2 * 900, 'a product below zero adds nothing to the shelf');
  assert.equal(w2.inventory_page_total, 2 * 900 - 7 * 850);
  assert.deepEqual(w2.negative, [{ product_id: 'cap', name: 'كاب', units: -7, unit_cost: 850, cost: -5950, no_goods_confirmed: 7, gap: 0 }]);
  assert.equal(w2.products, 1);
  /* −10 with only 3 confirmed: 3 confirmed have no goods, the other 7 are a recorded-stock gap */
  const w3 = cap.summarizeWarehouse([{ id: 'y', name: 'y', stock_quantity: -10, cost_price: 100 }], new Map([['y', 3]]));
  assert.equal(w3.cost, 0);
  assert.deepEqual([w3.negative[0].no_goods_confirmed, w3.negative[0].gap], [3, 7]);
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

test('confirmed orders beyond the shelf have no goods → counted nowhere (oldest confirmations are the covered ones)', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  /* the hair cap: recorded stock −7, 13 confirmed orders of 1 unit → 6 really on the shelf */
  const cap13 = Array.from({ length: 13 }, (_, i) => ({
    id: 100 + i, status: 'تم التأكيد', quantity: 1, unit_cost_price: 850, product_cost: 850,
    product_id: 'cap', product_name: 'كاب', product_stock: -7, since: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(),
  }));
  const g = cap.summarizeGoodsOut(cap13, now);
  assert.equal(g.confirmed.units, 6);
  assert.equal(g.confirmed.cost, 6 * 850);
  assert.equal(g.confirmed_unbacked.units, 7);
  const shelf = cap.summarizeWarehouse([{ id: 'cap', name: 'كاب', stock_quantity: -7, cost_price: 850 }], cap.confirmedUnitsByProduct(cap13));
  assert.equal(shelf.cost + g.confirmed.cost, 6 * 850, 'shelf + confirmed = the 6 units physically there');
  assert.equal(shelf.inventory_page_total + g.confirmed.cost + g.confirmed_unbacked.cost, 6 * 850, 'and the inventory page total reconciles: its −7 are exactly the 7 with no goods');
  assert.equal(g.confirmed_unbacked.cost, 7 * 850);
  assert.deepEqual(g.confirmed_unbacked.order_ids, [106, 107, 108, 109, 110, 111, 112], 'the 7 newest have no goods');
  assert.deepEqual(g.stock_gaps, []);

  /* one order of 2 units with only 1 on the shelf → split */
  const split = cap.summarizeGoodsOut([{ id: 1, status: 'تم التأكيد', quantity: 2, unit_cost_price: 100,
    product_id: 'x', product_name: 'x', product_stock: -1, since: now.toISOString() }], now);
  assert.deepEqual([split.confirmed.units, split.confirmed_unbacked.units], [1, 1]);

  /* still below zero after the confirmed units → a recorded-stock gap */
  const gap = cap.summarizeGoodsOut([{ id: 2, status: 'تم التأكيد', quantity: 3, unit_cost_price: 100,
    product_id: 'y', product_name: 'y', product_stock: -10, since: now.toISOString() }], now);
  assert.equal(gap.confirmed.units, 0);
  assert.equal(gap.confirmed_unbacked.units, 3);
  assert.deepEqual(gap.stock_gaps, [{ product_id: 'y', name: 'y', units_below_zero: 7 }]);

  /* a non-negative shelf covers every confirmed unit */
  const ok = cap.summarizeGoodsOut([{ id: 3, status: 'تم التأكيد', quantity: 5, unit_cost_price: 10,
    product_id: 'z', product_name: 'z', product_stock: 0, since: now.toISOString() }], now);
  assert.deepEqual([ok.confirmed.units, ok.confirmed_unbacked.units], [5, 0]);
});

test(`shipments untouched for more than ${cap.OLD_DAYS} days are not counted — shown apart`, () => {
  const now = new Date('2026-11-22T12:00:00Z');
  const g = cap.summarizeGoodsOut([
    { id: 1, status: 'تم الشحن', quantity: 1, unit_cost_price: 900, since: '2026-11-20T00:00:00Z' },   // normal
    { id: 2, status: 'تم الشحن', quantity: 1, unit_cost_price: 900, since: '2026-11-05T00:00:00Z' },   // 17 days: late, counted
    { id: 3, status: 'تم الشحن', quantity: 2, unit_cost_price: 900, since: '2026-08-05T00:00:00Z' },   // ghost
    { id: 4, status: 'جاري الإعادة', quantity: 1, unit_cost_price: 300, since: '2026-09-29T00:00:00Z' }, // old return
  ], now);
  assert.equal(g.in_transit.orders, 2);
  assert.equal(g.in_transit.cost, 1800);
  assert.deepEqual(g.in_transit.stale, { orders: 1, cost: 900 });
  assert.deepEqual([g.old.in_transit.orders, g.old.in_transit.units, g.old.in_transit.cost, g.old.in_transit.oldest], [1, 2, 1800, '2026-08-05']);
  assert.deepEqual(g.old.in_transit.order_ids, [3]);
  assert.equal(g.returning.orders, 0);
  assert.equal(g.old.returning.cost, 300);
  const t = cap.total({ wallet: { ok: true, balance: 0 }, treasury: { balance: 0 }, warehouse: { cost: 0 }, out: g });
  assert.equal(t.goods, 1800, 'old shipments are left out of the total');
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
