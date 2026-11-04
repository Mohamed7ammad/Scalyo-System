'use strict';

/* Unit tests for services/pnl.js — no database needed.
   Run: npm test   (from backend/)  or  node --test src/services/pnl.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const pnl    = require('./pnl');

const { T } = pnl;
const VALID = new Set(Object.values(T));

test('every manual category has a sign, a label and a known treatment', () => {
  for (const [code, c] of Object.entries(pnl.MANUAL_CATEGORIES)) {
    assert.ok(['revenue', 'expense'].includes(c.type), `${code}: type`);
    assert.ok(c.label && c.label.trim(), `${code}: label`);
    assert.ok(VALID.has(c.treatment), `${code}: treatment "${c.treatment}"`);
  }
});

test('every system-posted source the code writes has an explicit treatment', () => {
  /* The sources other modules insert into treasury_transactions (treasury.js,
     orderStatus.js, returnCollections.js, bosta.js, shippingWebhook.js). */
  const written = [
    'comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer',
    'deposit', 'bosta_cod', 'return_collection', 'return_review_commission',
    'agent_commission_payout', 'return_shipping_fee',
  ];
  for (const s of written) {
    assert.ok(pnl.AUTO_SOURCES[s], `${s} missing from AUTO_SOURCES`);
    assert.ok(VALID.has(pnl.AUTO_SOURCES[s].treatment), `${s}: treatment`);
  }
});

test('daily profit keeps exactly today\'s expense set, minus the new monthly categories', () => {
  const nonDaily = new Set(pnl.NON_DAILY_SOURCES);
  // excluded before this change — still excluded
  for (const s of ['AD_SPEND', 'INVENTORY_PURCHASE']) assert.ok(nonDaily.has(s), s);
  // the new month-level categories
  for (const s of ['SALARIES', 'SUBSCRIPTIONS', 'FIXED_OPEX', 'PROFIT_DISTRIBUTION']) assert.ok(nonDaily.has(s), s);
  // everything that counted daily before still does
  for (const s of ['OPERATIONAL_EXPENSE', 'PACKAGING_COST', 'SHIPPING_PACKAGE_SUBSCRIPTION',
    'comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer',
    'return_review_commission', 'agent_commission_payout']) {
    assert.ok(!nonDaily.has(s), `${s} must stay in daily profit`);
  }
  assert.equal(pnl.treatmentOf('SOME_CUSTOM_CATEGORY'), T.DAILY, 'unknown expense source → daily, as before');
  assert.deepEqual([...pnl.COMMISSION_SOURCES].sort(),
    ['comm_confirmed', 'comm_delivered', 'comm_no_answer', 'comm_rejected']);
});

test('«يخص شهر» only on monthly and distribution categories', () => {
  assert.equal(pnl.usesPeriodMonth('SALARIES'), true);
  assert.equal(pnl.usesPeriodMonth('SUBSCRIPTIONS'), true);
  assert.equal(pnl.usesPeriodMonth('FIXED_OPEX'), true);
  assert.equal(pnl.usesPeriodMonth('PROFIT_DISTRIBUTION'), true);
  assert.equal(pnl.usesPeriodMonth('OPERATIONAL_EXPENSE'), false);
  assert.equal(pnl.usesPeriodMonth('AD_SPEND'), false);
  assert.equal(pnl.usesPeriodMonth('comm_confirmed'), false);
});

test('normalizePeriodMonth', () => {
  assert.deepEqual(pnl.normalizePeriodMonth('', '2026-10-31'), { ok: true, value: '2026-10-01' });
  assert.deepEqual(pnl.normalizePeriodMonth(null, '2026-09-29'), { ok: true, value: '2026-09-01' });
  assert.deepEqual(pnl.normalizePeriodMonth('2026-10', '2026-09-29'), { ok: true, value: '2026-10-01' });
  assert.deepEqual(pnl.normalizePeriodMonth('2026-10-17', '2026-10-31'), { ok: true, value: '2026-10-01' });
  assert.equal(pnl.normalizePeriodMonth('2026-13', '2026-10-31').ok, false);
  assert.equal(pnl.normalizePeriodMonth('oct', '2026-10-31').ok, false);
  assert.equal(pnl.normalizePeriodMonth('2024-10', '2026-10-31').ok, false, 'mistyped year');
  assert.deepEqual(pnl.normalizePeriodMonth('2025-12', '2026-01-03'), { ok: true, value: '2025-12-01' });
});

/* Real descriptions from the ledger (Jun–Nov 2026). */
const sug = (description, amount, transaction_date, source = 'OPERATIONAL_EXPENSE') =>
  pnl.suggestCategory({ description, amount, transaction_date, source });

test('suggestions: salaries, with the month read from the text', () => {
  assert.deepEqual(sug('راتب ادهم مقدم لشهر 10', 5055, '2026-09-29'),
    { source: 'SALARIES', period_month: '2026-10', reason: 'راتب' });
  assert.equal(sug('راتب ادهم شهر 8', 5000, '2026-07-19').period_month, '2026-08');
  assert.equal(sug('راتب ادهم شهر 9', 5055, '2026-08-29').period_month, '2026-09');
  assert.equal(sug('راتب المرتجعات', 1500, '2026-10-31').period_month, '2026-10');
  assert.equal(sug('راتب وكوميشن شيمائ', 3750, '2026-10-31').source, 'SALARIES');
  assert.equal(sug('كوميشن شيماء', 880, '2026-09-30').source, 'SALARIES');
  assert.equal(sug('عمولة مو\\ريتر', 540, '2026-10-31').source, 'SALARIES');
  assert.equal(sug('راتب', 1000, '2025-12-30', 'PACKAGING_COST').source, 'SALARIES');
});

test('suggestions: distributions and subscriptions', () => {
  assert.deepEqual(sug('ارباح الادارة 10% شهر 9', 8966, '2026-09-30'),
    { source: 'PROFIT_DISTRIBUTION', period_month: '2026-09', reason: 'أرباح' });
  assert.equal(sug('ارباح عبدالرحمن', 6081, '2026-08-29').source, 'PROFIT_DISTRIBUTION');
  for (const d of ['كلود', 'سيرفر', 'سيستم الوينر', 'سيستم فيديوهات', 'كريدت للسيستم', 'كلود 18\\6']) {
    assert.equal(sug(d, 1000, '2026-10-31').source, 'SUBSCRIPTIONS', d);
  }
  for (const d of ['تامين', 'باقة شهد', 'باقه لهنا', 'خطين بباقه', 'خط', 'خطين وباقة لمني']) {
    assert.equal(sug(d, 100, '2026-10-31').source, 'FIXED_OPEX', d);
  }
});

test('suggestions: real daily costs are left alone', () => {
  for (const d of ['ايزي اوردر', 'ايزي اوردر 9\\6', 'شحن ايزي اوردر', 'اعلانات وايزي', 'غلطه سيستم',
    'لغبطه سيستم', 'فيزا', 'مشكلة فيزا', 'عمولة انستاباي', 'عمولة الفرشه الكهربائية',
    'عموله الراجل فالعتلبه ورسوم تحويلات', 'مرتجع', 'تغليف', 'كراتين', '']) {
    assert.equal(sug(d, 600, '2026-10-31'), null, d || '(empty)');
  }
  // a bare «عمولة» of a few pounds is a transfer fee (Jul 14: 10 EGP)
  assert.equal(sug('عمولة', 10, '2026-07-14'), null);
  // only rows filed under a DAILY manual category are candidates
  assert.equal(sug('راتب', 5000, '2026-10-31', 'SALARIES'), null);
  assert.equal(sug('راتب', 5000, '2026-10-31', 'AD_SPEND'), null);
  assert.equal(sug('راتب', 5000, '2026-10-31', 'comm_confirmed'), null);
});

test('period from text picks the nearest year', () => {
  assert.equal(pnl.periodFromText('راتب شهر 12', '2027-01-02'), '2026-12');
  assert.equal(pnl.periodFromText('راتب شهر 1', '2026-12-30'), '2027-01');
  assert.equal(pnl.periodFromText('راتب شهر ١٠', '2026-09-29'), '2026-10', 'Arabic-Indic digits');
  assert.equal(pnl.periodFromText('ارباح 10%', '2026-09-30'), '2026-09', 'a percentage is not a month');
});
