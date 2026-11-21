'use strict';

/* Unit tests for services/externalApi.js (the /api/v1 contract) — pure, no DB, no network.
   Run: npm test   (from backend/)  or  node --test src/services/externalApi.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const ext    = require('./externalApi');

test('Cairo calendar day', () => {
  assert.equal(ext.cairoToday(new Date('2026-11-19T22:30:00Z')), '2026-11-20');   // 00:30 in Cairo
  assert.equal(ext.cairoToday(new Date('2026-11-19T21:30:00Z')), '2026-11-19');
});

test('range: defaults, explicit, and every bad input', () => {
  const now = new Date('2026-11-20T10:00:00Z');
  assert.deepEqual(ext.parseRange({}, { now }), { from: '2026-10-22', to: '2026-11-20', days: 30, timezone: 'Africa/Cairo' });
  assert.deepEqual(ext.parseRange({ from: '2026-11-01', to: '2026-11-19' }, { now }).days, 19);
  assert.equal(ext.parseRange({ to: '2026-03-01' }, { now }).from, '2026-01-31');
  for (const bad of [{ from: '2026-02-31' }, { to: '2026-13-01' }, { from: '20261101' }, { from: 'yesterday' }]) {
    assert.throws(() => ext.parseRange(bad, { now }), (e) => e.status === 400);
  }
  assert.throws(() => ext.parseRange({ from: '2026-11-20', to: '2026-11-01' }, { now }), /after/);
  assert.equal(ext.parseRange({ from: '2025-11-20', to: '2026-11-20' }, { now }).days, 366);
  assert.throws(() => ext.parseRange({ from: '2025-11-19', to: '2026-11-20' }, { now }), /max 366/);
});

test('Egypt offset matches the dashboard bounds (winter +02, summer +03)', () => {
  assert.equal(ext.egyptOffset('2026-01-15'), '+02:00');
  assert.equal(ext.egyptOffset('2026-07-15'), '+03:00');
  assert.equal(ext.egyptOffset('2026-11-20'), '+02:00');
  assert.equal(ext.dayStart('2026-11-20'), '2026-11-20T00:00:00+02:00');
  assert.equal(ext.dayEnd('2026-11-20'), '2026-11-20T23:59:59+02:00');
});

test('every live status has a group; unknown → other', () => {
  const live = ['تم التوصيل', 'تم الرفض', 'تم الإرجاع', 'ملغي - عدم رد نهائي', 'لا يرد', 'معلق حتي الدفع',
    'تم الشحن', 'تم التأكيد', 'جاري الإعادة', 'مؤجل', 'جديد', 'مغلق - لن يشحن', 'مغلق - منتج متوقف', 'مراجعة جديدة'];
  for (const s of live) assert.notEqual(ext.groupOf(s), 'other', s);
  assert.equal(ext.groupOf(' تم التوصيل '), 'delivered');
  assert.equal(ext.groupOf('جاري الإعادة'), 'returned');
  assert.equal(ext.groupOf('حالة جديدة غريبة'), 'other');
  assert.equal(ext.groupOf(null), 'other');
});

const profRow = (o) => ({
  product_id: '7', product_name: 'جهاز مساج', sku: 'MSG-1', cost_price: 120,
  units_delivered: 40, units_shipped: 60, delivery_rate: 66.7, total_orders: 150, confirmed_orders: 95, erp_orders: 95,
  delivered_revenue: 36000, attributed_ad_spend: 9000, cogs: 4800, cogs_recovered: 0, refunds: 300, refunded_orders: 1,
  shipping_cost: 3100, return_shipping_cost: 0, opex_allocated: 1500.5, net_profit: 17299.5, cpa: 75.5, meta_orders: 119,
  ...o,
});

test('/products: rates exactly like the dashboard table, stock from the catalogue', () => {
  const [p] = ext.mapProducts([profRow()], [{ id: 7, stock_quantity: 33, selling_price: '899', stopped_at: null }]);
  assert.equal(p.product_id, '7');
  assert.equal(p.orders, 150);
  assert.equal(p.confirmed, 95);
  assert.equal(p.confirmation_rate, parseFloat(((95 / 150) * 100).toFixed(1)));   // 63.3, same as the CR% column
  assert.equal(p.delivery_rate_of_shipped, 66.7);
  assert.equal(p.delivered_of_orders_rate, parseFloat(((40 / 150) * 100).toFixed(1)));
  assert.equal(p.net_profit, 17299.5);
  assert.equal(p.profit_per_delivered, parseFloat((17299.5 / 40).toFixed(2)));
  assert.equal(p.ad_cost_per_order, 60);
  assert.equal(p.stock, 33);
  assert.equal(p.selling_price, 899);
  assert.equal(p.stopped, false);
  assert.equal(p.cost_per_meta_purchase, 75.5);
  assert.equal(p.profit_before_ads, 26299.5, "net profit + this product's ad spend");
});

test('/products: empty products give nulls, never NaN', () => {
  const [p] = ext.mapProducts([profRow({ total_orders: 0, confirmed_orders: 0, units_shipped: 0, units_delivered: 0,
    attributed_ad_spend: 500, net_profit: -500, cpa: null })], [{ id: 7, stock_quantity: null, stopped_at: '2026-11-13' }]);
  assert.equal(p.confirmation_rate, null);
  assert.equal(p.delivery_rate_of_shipped, null);
  assert.equal(p.profit_per_delivered, null);
  assert.equal(p.ad_cost_per_order, null);
  assert.equal(p.cost_per_meta_purchase, null);
  assert.equal(p.stock, null);
  assert.equal(p.stopped, true);
  assert.equal(p.net_profit, -500);
  assert.ok(!JSON.stringify(p).includes('NaN'));
});

test('/summary: net profit = the dashboard formula (all products)', () => {
  const dash = {
    overview: {
      total_orders: 1000, total_confirmed: 600, total_delivered: 300, total_rejected: 200, total_returned: 80, total_pending: 50,
      total_revenue: 270000, total_refunds: 1200, total_expenses: 64000, meta_spend: 60000, meta_orders: 900,
      operating_expenses: 15000, in_transit_count: 44, outstanding_cash: 39000,
      opex_breakdown: [{ source: 'comm_confirmed', label: 'عمولات', amount: 9000 }],
    },
    daily_chart_stats: [{ date: '2026-11-19', orders: 31, erp_orders: 35, confirmed: 20, delivered: 9, revenue: 8100, refunds: 0, ads_spend: 2000 }],
    governorates_stats: [{ governorate: 'القاهرة', total_orders: 300, confirmed: 200, delivered: 120, returned: 20, revenue: 108000 }],
    rejection_reasons: [{ reason: 'السعر', count: 12 }],
  };
  const rows = [{ cogs: 30000, shipping_cost: 21000 }, { cogs: 6000.4, shipping_cost: 'x' }];
  const s = ext.mapSummary(dash, rows);
  const expected = 270000 - 1200 - 36000.4 - 64000 - 15000 - 21000;
  assert.equal(s.net_profit, parseFloat(expected.toFixed(2)));
  assert.equal(s.cogs, 36000.4);
  assert.equal(s.shipping_cost, 21000, 'a malformed product value counts as 0, like the dashboard');
  assert.equal(s.profit_before_ads, parseFloat((expected + 64000).toFixed(2)), 'net profit + all expenses');
  assert.equal(s.confirmation_rate, 60);
  assert.equal(s.delivery_rate_of_confirmed, 50);
  assert.equal(s.delivered_of_orders_rate, 30);
  assert.equal(s.cost_per_meta_purchase, parseFloat((60000 / 900).toFixed(2)));
  assert.equal(s.ad_cost_per_delivered, 200);
  assert.deepEqual(s.in_transit_now, { orders: 44, cash_on_way: 39000 });
  assert.equal(s.daily[0].orders, 35, 'daily orders = the DB count, not the Meta pixel');
  assert.equal(s.daily[0].meta_purchases, 31);
  assert.equal(s.governorates[0].orders, 300);
  assert.deepEqual(s.rejection_reasons, [{ reason: 'السعر', count: 12 }]);
  assert.deepEqual(s.operating_expenses_breakdown, [{ label: 'عمولات', amount: 9000 }]);
});

test('/orders: only whitelisted fields — customer data can never leak', () => {
  const row = {
    id: 18001, source: 'easyorder', external_order_id: 'abc', status: ' تم التوصيل ', product_name: 'جهاز', sku: 'MSG-1',
    quantity: 2, price: '1798.00', deposit: '0', city: 'الجيزة', created_at: new Date('2026-11-19T10:00:00Z'),
    created_day: '2026-11-19', shipped_at: null, delivered_at: null, status_changed_at: null, rejection_reason: null,
    bosta_rating: 'ممتاز ', easyorder_rating: 'high',
    /* even if a query ever selected them by mistake: */
    FullName: 'Ahmed', Phone: '01000000000', Address: 'street', Note: 'call 0100', ShippingNotes: 'x', BostaTrackingCode: '123',
  };
  const o = ext.mapOrder(row);
  assert.deepEqual(Object.keys(o), ext.ORDER_FIELDS);
  for (const leaked of ['Ahmed', '01000000000', 'street', 'call 0100', 'BostaTrackingCode', 'FullName']) {
    assert.ok(!JSON.stringify(o).includes(leaked), leaked);
  }
  assert.equal(o.status, 'تم التوصيل');
  assert.equal(o.status_group, 'delivered');
  assert.equal(o.price, 1798);
  assert.equal(o.quantity, 2);
  assert.equal(o.bosta_rating, 'ممتاز');
});
