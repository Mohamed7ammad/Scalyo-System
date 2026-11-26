'use strict';

/* Unit tests for the WhatsApp confirmation rules (step 6). Pure — no DB, no network.
   Run: npm test (from backend/)  or  node --test src/services/whatsapp/flow.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const flow   = require('./flow');
const tpl    = require('./templates');

const ORDER = { id: 501, FullName: ' منى  عادل ', ProductName: 'داش كام', quantity: 2, ProductPrice: '2420',
  depositAmount: null, City: 'الجيزة', Address: '12 شارع المساحة\nالدور الثالث', Status: 'بانتظار واتساب', DeliveryRate: 'ممتاز' };

/* ── what goes in the message ─────────────────────────────────────────────── */

test('message values: cleaned, in template order, amount = what the courier collects', () => {
  const p = flow.messageParams(ORDER);
  assert.deepEqual(p.confirm, ['منى عادل', 'داش كام', '2', '2,420', 'الجيزة، 12 شارع المساحة الدور الثالث']);
  assert.deepEqual(p.reminder, ['منى عادل', 'داش كام', '2,420']);
  assert.deepEqual(flow.messageParams({ ...ORDER, depositAmount: '200' }).confirm[3], '2,220', 'deposit already paid is not asked for again');
  assert.equal(flow.messageParams({ ...ORDER, ProductPrice: '1,210.50 EGP' }).confirm[3], '1,210.5');
});

test('the values fit the templates the owner approved', () => {
  const [confirm, reminder] = tpl.build('Product Pulse');
  const p = flow.messageParams(ORDER);
  assert.equal(p.confirm.length, confirm.example.length);
  assert.equal(p.reminder.length, reminder.example.length);
  const c = flow.templateComponents('confirm', ORDER).components;
  assert.equal(c.filter((x) => x.type === 'button').length, confirm.buttons.length);
  assert.equal(flow.templateComponents('reminder', ORDER).components.filter((x) => x.type === 'button').length, reminder.buttons.length);
});

test('Meta would refuse newlines / tabs / long runs of spaces in a value — none survive', () => {
  for (const v of flow.messageParams({ ...ORDER, FullName: 'أ\tب\n\nج      د', Address: 'x'.repeat(600) }).confirm) {
    assert.ok(!/[\n\r\t]/.test(v) && !/ {2,}/.test(v), JSON.stringify(v));
    assert.ok(v.length <= 260);
  }
});

test('missing name / address get a safe stand-in; no amount or product → not sent at all', () => {
  const p = flow.messageParams({ ...ORDER, FullName: '', City: null, Address: '' });
  assert.equal(p.confirm[0], 'عميلنا العزيز');
  assert.match(p.confirm[4], /طلب الدعم/);
  assert.deepEqual(flow.messageParams({ ...ORDER, ProductPrice: '' }), { ok: false, reason: 'no_amount' });
  assert.deepEqual(flow.messageParams({ ...ORDER, ProductPrice: '0' }), { ok: false, reason: 'no_amount' });
  assert.deepEqual(flow.messageParams({ ...ORDER, ProductName: '  ' }), { ok: false, reason: 'no_product' });
  assert.equal(flow.templateComponents('confirm', { ...ORDER, ProductPrice: '' }).ok, false);
});

test('each button carries the order and the action; anything else is not a payload', () => {
  const c = flow.templateComponents('confirm', ORDER).components;
  assert.deepEqual(c.slice(1).map((b) => [b.index, b.parameters[0].payload]),
    [['0', 'wa1:confirm:501'], ['1', 'wa1:cancel:501'], ['2', 'wa1:support:501']]);
  assert.deepEqual(flow.parsePayload('wa1:cancel:501'), { action: 'cancel', orderId: 501 });
  for (const bad of [null, '', 'تأكيد الطلب', 'wa1:confirm:', 'wa1:delete:5', 'wa1:confirm:5; DROP', 'wa2:confirm:5']) {
    assert.equal(flow.parsePayload(bad), null, String(bad));
  }
});

/* ── when ─────────────────────────────────────────────────────────────────── */

const utc = (s) => new Date(`${s}Z`);                  // Cairo = UTC+2 in November (no summer time)

test('send time: 5 minutes after the order; trial group B (odd ids) 20 minutes', () => {
  const created = utc('2026-11-25T12:00:00');
  assert.equal(flow.variantOf(500, false), 'A');
  assert.equal(flow.variantOf(501, false), 'A', 'no trial → everyone 5 minutes');
  assert.equal(flow.variantOf(500, true), 'A');
  assert.equal(flow.variantOf(501, true), 'B');
  assert.equal(flow.sendAt(created, 'A').toISOString(), '2026-11-25T12:05:00.000Z');
  assert.equal(flow.sendAt(created, 'B').toISOString(), '2026-11-25T12:20:00.000Z');
});

test('after the send: 30 min hold, reminders at +2 h and +24 h', () => {
  const s = flow.scheduleAfterSend(utc('2026-11-25T12:05:00'));       // 14:05 Cairo
  assert.equal(s.hold_until.toISOString(),   '2026-11-25T12:35:00.000Z');
  assert.equal(s.reminder1_at.toISOString(), '2026-11-25T14:05:00.000Z');
  assert.equal(s.reminder2_at.toISOString(), '2026-11-26T12:05:00.000Z');
});

test('no message between midnight and 10:00 Cairo — it waits for 10:00', () => {
  /* sent 23:30 Cairo → +2 h = 01:30 Cairo → 10:00 Cairo (08:00 UTC) */
  const s = flow.scheduleAfterSend(utc('2026-11-25T21:30:00'));
  assert.equal(s.reminder1_at.toISOString(), '2026-11-26T08:00:00.000Z');
  assert.equal(s.hold_until.toISOString(),   '2026-11-25T22:00:00.000Z', 'the hold is 30 minutes at night too');
  /* sent 03:00 Cairo → +24 h = 03:00 Cairo next day → 10:00 */
  assert.equal(flow.scheduleAfterSend(utc('2026-11-25T01:00:00')).reminder2_at.toISOString(), '2026-11-26T08:00:00.000Z');
  /* edges: 09:59 waits, 10:00 and 23:59 go */
  assert.equal(flow.outsideQuietHours(utc('2026-11-25T07:59:30')).toISOString(), '2026-11-25T08:00:00.000Z');
  assert.equal(flow.outsideQuietHours(utc('2026-11-25T08:00:00')).toISOString(), '2026-11-25T08:00:00.000Z');
  assert.equal(flow.outsideQuietHours(utc('2026-11-25T21:59:00')).toISOString(), '2026-11-25T21:59:00.000Z');
});

test('quiet hours follow the Cairo clock in summer time too', () => {
  /* July: Cairo = UTC+3 → 01:00 Cairo is 22:00 UTC the day before → 10:00 Cairo = 07:00 UTC */
  assert.equal(flow.outsideQuietHours(utc('2026-07-10T22:00:00')).toISOString(), '2026-07-11T07:00:00.000Z');
});

/* ── what a tap does ──────────────────────────────────────────────────────── */

const tap = (action, over = {}) => flow.decideTap({ action, order: { ...ORDER, ...over } });

test('«تأكيد الطلب» confirms at once — while the order is held, new, or unanswered', () => {
  for (const Status of ['بانتظار واتساب', 'جديد', ' لا يرد ', 'مراجعة جديدة']) {
    assert.deepEqual(tap('confirm', { Status }), { type: 'confirm', release: true, reply: 'confirmed' }, Status);
  }
});

test('a customer Bosta rates «ضعيف» is NOT confirmed by the tap — an agent collects the deposit', () => {
  assert.deepEqual(tap('confirm', { DeliveryRate: 'ضعيف' }), { type: 'deposit_needed', tag: 'deposit', release: true, reply: 'deposit' });
  for (const rate of ['بدون', null, 'جيد', 'ممتاز']) assert.equal(tap('confirm', { DeliveryRate: rate }).type, 'confirm', String(rate));
});

test('«إلغاء الطلب» and «طلب الدعم» never close the order — they go to an agent, tagged', () => {
  assert.deepEqual(tap('cancel'),  { type: 'cancel_requested', tag: 'cancel', release: true, reply: 'cancel' });
  assert.deepEqual(tap('support'), { type: 'support_requested', tag: 'support', release: true, reply: 'support' });
  assert.equal(flow.TAGS.cancel, 'عايز يلغي');
  assert.equal(flow.TAGS.deposit, 'أكد على واتساب، محتاج عربون');
});

test('once an agent settled the order, a tap changes nothing — it only tells an agent', () => {
  assert.deepEqual(tap('confirm', { Status: 'تم التأكيد' }), { type: 'already_confirmed', release: false, reply: 'already_confirmed' });
  assert.equal(tap('confirm', { Status: 'تم الشحن' }).type, 'already_confirmed');
  assert.deepEqual(tap('cancel', { Status: 'تم التأكيد' }), { type: 'closed_interest', tag: 'cancel_after_confirm', release: false, reply: 'support' });
  /* …but when WhatsApp itself confirmed it (nobody holds it) and it has not shipped, it goes back to an agent */
  assert.deepEqual(tap('cancel', { Status: 'تم التأكيد', confirmed_via: 'whatsapp' }),
    { type: 'reopened', outcome: 'cancel_requested', tag: 'cancel', release: false, reopen: true, reply: 'cancel' });
  assert.equal(tap('support', { Status: 'تم التأكيد', confirmed_via: 'whatsapp' }).reopen, true);
  assert.equal(tap('confirm', { Status: 'تم التأكيد', confirmed_via: 'whatsapp' }).type, 'already_confirmed');
  assert.equal(tap('cancel', { Status: 'تم الشحن', confirmed_via: 'whatsapp' }).type, 'closed_interest', 'already shipped → only the tag');
  for (const Status of ['تم الرفض', 'مؤجل', 'معلق حتي الدفع', 'ملغي - عدم رد نهائي', 'تم الإرجاع']) {
    const r = tap('confirm', { Status });
    assert.equal(r.type, 'closed_interest', Status);
    assert.equal(r.tag, 'confirm_after_close');
    assert.equal(r.release, false);
  }
});

test('auto-replies: the texts the owner approved', () => {
  const r = flow.replyText('confirmed', { brand: 'Product Pulse' });
  assert.match(r, /^تم تأكيد طلبك ✅/);
  assert.match(r, /هيوصلك خلال يومين/);
  assert.match(r, /شكرًا لثقتك في Product Pulse/);
  assert.match(flow.replyText('deposit', { brand: 'Product Pulse' }), /فريق Product Pulse/);
  assert.match(flow.replyText('cancel'), /وصلنا طلب الإلغاء/);
  assert.match(flow.replyText('support', {}), /حد من فريقنا هيكلمك/);
  assert.match(flow.replyText('text'), /وصلتنا رسالتك/);
  assert.equal(flow.replyText('nope'), null);
  for (const k of ['confirmed', 'deposit', 'cancel', 'support', 'text', 'already_confirmed']) {
    assert.ok(flow.replyText(k, { brand: 'X' }).length <= 1024, k);
  }
});

test('reminders: only an open order, a silent customer, and at most 3 messages', () => {
  const ok = { order: { Status: 'جديد' }, flow: { customer_replied: false, messages_sent: 1 } };
  assert.equal(flow.canRemind(ok), true);
  assert.equal(flow.canRemind({ ...ok, order: { Status: 'لا يرد' } }), true);
  assert.equal(flow.canRemind({ ...ok, order: { Status: 'تم التأكيد' } }), false);
  assert.equal(flow.canRemind({ ...ok, order: { Status: 'تم الرفض' } }), false);
  assert.equal(flow.canRemind({ ...ok, order: { Status: 'مؤجل' } }), false, 'an agent already spoke to them');
  assert.equal(flow.canRemind({ ...ok, flow: { customer_replied: true, messages_sent: 1 } }), false);
  assert.equal(flow.canRemind({ ...ok, flow: { customer_replied: false, messages_sent: 3 } }), false);
});
