'use strict';

/* Unit tests for the «لا يرد» re-contact picker. Pure — no database, no network.
   Run: npm test (from backend/)  or  node --test src/services/whatsapp/recontact.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../../config/db');
pool.query = async () => ({ rows: [], rowCount: 0 });          // nothing here may reach a database

const recontact = require('./recontact');

const order = (id, over = {}) => ({ id, business_id: 1, FullName: 'منى عادل', Phone: '01001488462', ProductName: 'داش كام',
  quantity: 1, ProductPrice: '1210', City: 'الجيزة', Address: 'الدقي', Status: 'لا يرد', DeliveryRate: 'بدون', ...over });

test('one message per customer: the newest order wins, however the number was typed', () => {
  const r = recontact.pick({
    orders: [order(3), order(2, { Phone: '+20 100 148 8462' }), order(1, { Phone: '01112223334' })],
    messaged: new Set(), busy: new Set(),
  });
  assert.deepEqual(r.chosen.map((c) => [c.order.id, c.phone]), [[3, '201001488462'], [1, '201112223334']]);
  assert.equal(r.skipped.same_customer, 1);
});

test('left out: no sure mobile, already messaged, another order of theirs was reached, nothing to put in the message', () => {
  const r = recontact.pick({
    orders: [
      order(1, { Phone: '0225551234' }),                // landline
      order(2, { Phone: '01011111111' }),               // got a WhatsApp from us this month
      order(3, { Phone: '01022222222' }),               // another order of theirs was reached
      order(4, { Phone: '01033333333', ProductPrice: '' }),
      order(5, { Phone: '01044444444' }),
    ],
    messaged: new Set(['201011111111']), busy: new Set(['201022222222']),
  });
  assert.deepEqual(r.chosen.map((c) => c.order.id), [5]);
  assert.deepEqual(r.skipped, { bad_number: 1, already_messaged: 1, other_order: 1, same_customer: 0, no_amount: 1, control_group: 0 });
});

test('the range: real days, in order, not in the future, not older than 14 days', () => {
  const now = new Date('2026-11-26T14:00:00Z');                 // 16:00 Cairo, 26 Nov
  assert.deepEqual(recontact.checkRange('2026-11-20', '2026-11-25', now), { from: '2026-11-20', to: '2026-11-25' });
  assert.deepEqual(recontact.checkRange('2026-11-26', '2026-11-26', now), { from: '2026-11-26', to: '2026-11-26' });
  assert.throws(() => recontact.checkRange('2026-11-25', '2026-11-20', now), /قبل النهاية/);
  assert.throws(() => recontact.checkRange('2026-11-20', '2026-11-27', now), /بعد النهارده/);
  assert.throws(() => recontact.checkRange('2026-11-01', '2026-11-25', now), /أقدم يوم/);
  assert.throws(() => recontact.checkRange('', '2026-11-25', now), /اختار/);
  assert.throws(() => recontact.checkRange('2026-11-20; DROP', '2026-11-25', now), /اختار/);
});

test('Cairo decides what "today" is: 23:30 UTC on the 25th is already the 26th', () => {
  assert.equal(recontact.cairoDay(new Date('2026-11-25T23:30:00Z')), '2026-11-26');
  assert.doesNotThrow(() => recontact.checkRange('2026-11-26', '2026-11-26', new Date('2026-11-25T23:30:00Z')));
});

test('the half-and-half trial: an agents-only customer who ordered during it is never messaged', () => {
  const auto = { control_half: true, live_since: '2026-11-27T10:00:00Z', live_until: null };
  const isControl = recontact.controlCheck(auto);
  const r = recontact.pick({
    orders: [
      order(1, { Phone: '01011111111', created_at: '2026-11-27T12:00:00Z' }),   // odd, during the trial → control
      order(2, { Phone: '01011111112', created_at: '2026-11-27T12:00:00Z' }),   // even → the WhatsApp half
      order(3, { Phone: '01011111113', created_at: '2026-11-26T12:00:00Z' }),   // odd, but BEFORE the trial
    ],
    messaged: new Set(), busy: new Set(), isControl,
  });
  assert.deepEqual(r.chosen.map((c) => c.order.id), [2, 3]);
  assert.equal(r.skipped.control_group, 1);
  /* after the trial is closed its control orders stay protected; later orders are free again */
  const closed = recontact.controlCheck({ control_half: true, live_since: '2026-11-27T10:00:00Z', live_until: '2026-12-04T10:00:00Z' });
  assert.equal(closed({ created_at: '2026-11-30T00:00:00Z' }, '201011111111'), true);
  assert.equal(closed({ created_at: '2026-12-05T00:00:00Z' }, '201011111111'), false);
  assert.equal(recontact.controlCheck({ control_half: false, live_since: '2026-11-27T10:00:00Z' })({ created_at: '2026-11-28T00:00:00Z' }, '201011111111'), false);
});
