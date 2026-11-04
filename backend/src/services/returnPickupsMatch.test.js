'use strict';

/* Unit tests for services/returnPickupsMatch.js — no database needed.
   Fixtures mirror real Bosta docs (2026-10-31 pickup, 2026-11-03 exchange) with
   personal data replaced. */

const test   = require('node:test');
const assert = require('node:assert/strict');
const m      = require('./returnPickupsMatch');

/* The real catalogue names (tenant 1, 2026-11-05). */
const PRODUCTS = [
  { id: 'game',  name: 'Game TV stick 8k', sku: 'GAME-STICK', aliases: ['game-stick'] },
  { id: 'whoop', name: 'سوار ذكي لمتابعة صحتك ولياقتك - WHOOP', sku: 'WHOOP', aliases: ['WHOOP'] },
  { id: 'sf',    name: 'جهاز الالعاب الاسلكي SF3500 Retro', sku: 'SF3500-RETRO', aliases: [] },
  { id: 'ipl2',  name: 'جهاز ليزر lPL ضمان سنتين', sku: 'IPL-PRO-01', aliases: ['ipl'] },
  { id: 'ipl1',  name: 'ليزر IPL 1M', sku: 'IPL-1MIL', aliases: [] },
  { id: 'uvpro', name: 'كشاف الفحص الاحترافي بالأشعة فوق البنفسجية', sku: 'FLASHUV', aliases: ['flashuv'] },
  { id: 'uvusb', name: 'كشاف محمول UV للفحص بالأشعة فوق البنفسجية', sku: 'UV-USB', aliases: ['UV-USB'] },
  { id: 's2',    name: 'نظارة S2 Max الذكية', sku: 'S2-MAX', aliases: ['S2-Max'] },
  { id: 'mg',    name: 'نظاره شمسية ذكية MG100', sku: 'MG100', aliases: ['MG100'] },
];

const CRP_DOC = {
  trackingNumber: '99203289', cod: 0, shipmentFees: 95,
  state: { value: 'Returned to business', code: 46, returnedToBusiness: '2026-10-31T14:06:24.607Z' },
  receiver: { phone: '+201001234988', firstName: 'محمد', lastName: '', fullName: 'محمد' },
  type: { code: 25, value: 'Customer Return Pickup' },
  createdAt: '2026-10-27T21:01:54.000Z',
  specs: { packageDetails: { itemsCount: 1 } },
  returnSpecs: { packageDetails: { itemsCount: 1, description: 'سوار ذكي لمتابعة صحتك ولياقتك - WHOOP' } },
};
const EXCHANGE_DOC = {
  trackingNumber: '1473708353', cod: 100, shipmentFees: 105,
  state: { value: 'Returned to business', code: 46, returnedToBusiness: '2026-11-03T16:35:37.727Z' },
  receiver: { phone: '01112345498', fullName: 'Mary' },
  type: { code: 30, value: 'Exchange' },
  createdAt: '2026-10-31T12:20:44.000Z',
  specs: { packageDetails: { itemsCount: 1, description: 'Game TV stick 8k' } },
  returnSpecs: { packageDetails: { itemsCount: 1, description: ' Game TV stick 8k ', descriptionAr: 'جهاز ألعاب تي في ستيك 8K' } },
};

test('kindOf: pickup / exchange / not ours', () => {
  assert.equal(m.kindOf('CUSTOMER_RETURN_PICKUP'), 'pickup');
  assert.equal(m.kindOf('EXCHANGE'), 'exchange');
  assert.equal(m.kindOf({ code: 25, value: 'Customer Return Pickup' }), 'pickup');
  assert.equal(m.kindOf({ code: 30, value: 'Exchange' }), 'exchange');
  assert.equal(m.kindOf(25), 'pickup');
  assert.equal(m.kindOf('RTO'), null, 'an RTO leg is the order\'s own parcel — not a post-delivery return');
  assert.equal(m.kindOf('SEND'), null);
  assert.equal(m.kindOf(undefined), null);
});

test('parseDoc: customer return pickup', () => {
  const d = m.parseDoc(CRP_DOC, 'pickup');
  assert.equal(d.customer_phone, '1001234988', 'last 10 digits');
  assert.equal(d.return_desc, 'سوار ذكي لمتابعة صحتك ولياقتك - WHOOP');
  assert.equal(d.return_qty, 1);
  assert.equal(d.forward_desc, null);
  assert.equal(d.forward_qty, 0);
  assert.equal(d.pickup_fee, 108.3, 'shipmentFees 95 + 14% VAT');
  assert.equal(d.collected_cod, 0);
  assert.equal(d.state_code, 46);
  assert.equal(d.received_at.toISOString(), '2026-10-31T14:06:24.607Z');
});

test('parseDoc: exchange carries the replacement sent out', () => {
  const d = m.parseDoc(EXCHANGE_DOC, 'exchange');
  assert.equal(d.customer_phone, '1112345498');
  assert.equal(d.return_desc, 'Game TV stick 8k — جهاز ألعاب تي في ستيك 8K', 'both languages, de-duplicated');
  assert.equal(d.forward_desc, 'Game TV stick 8k');
  assert.equal(d.forward_qty, 1);
  assert.equal(d.collected_cod, 100);
  assert.equal(d.pickup_fee, 119.7);
});

test('matchProductText: real Bosta descriptions → catalogue', () => {
  assert.equal(m.matchProductText(PRODUCTS, 'سوار ذكي لمتابعة صحتك ولياقتك - WHOOP').id, 'whoop');
  assert.equal(m.matchProductText(PRODUCTS, 'Game TV stick 8k — جهاز ألعاب تي في ستيك 8K').id, 'game');
  assert.equal(m.matchProductText(PRODUCTS, ' Game TV stick 8k ').id, 'game');
  assert.equal(m.matchProductText(PRODUCTS, 'نظارة S2 Max').id, 's2', 'name contained');
  assert.equal(m.matchProductText(PRODUCTS, 'MG100').id, 'mg', 'sku / alias');
  assert.equal(m.matchProductText(PRODUCTS, 'ليزر IPL 1M').id, 'ipl1', 'longest key wins over the short «ipl» alias');
  assert.equal(m.matchProductText(PRODUCTS, 'كشاف محمول UV للفحص بالاشعه').id, 'uvusb', 'hamza / taa-marbuta folded');
});

test('matchProductText: vague text matches nothing (the order decides, or a person)', () => {
  assert.equal(m.matchProductText(PRODUCTS, 'كشاف'), null, 'two different كشاف products');
  assert.equal(m.matchProductText(PRODUCTS, 'ليزر'), null);
  assert.equal(m.matchProductText(PRODUCTS, ''), null);
  assert.equal(m.matchProductText(PRODUCTS, null), null);
  assert.equal(m.matchProductText(PRODUCTS, 'شنطة'), null);
});
