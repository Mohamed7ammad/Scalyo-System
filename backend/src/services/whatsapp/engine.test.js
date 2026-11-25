'use strict';

/* Unit tests for the WhatsApp confirmation engine (step 6). In-memory orders,
   diary and Meta — no database, no network.
   Run: npm test (from backend/)  or  node --test src/services/whatsapp/engine.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../../config/db');
pool.query = async () => ({ rows: [], rowCount: 0 });          // nothing here may reach a database

const engine = require('./engine');
const flow   = require('./flow');

class GraphError extends Error { constructor(code, msg) { super(msg); this.code = code; this.metaMessage = msg; } }

/* A tiny world: orders, the flow diary, Meta, the agents. */
function world({ mode = 'on', testPhones = [], quality = 'GREEN', split = false } = {}) {
  const w = {
    now: new Date('2026-11-25T12:00:00Z'),                      // 14:00 Cairo
    orders: new Map(), flows: new Map(), sentTemplates: [], sentTexts: [], logged: [], assigned: [], changes: [],
    metaFails: null, messages: new Map(), mode,
  };
  const HOLD = flow.HOLD_STATUS;
  w.addOrder = (id, over = {}) => {
    const o = { id, business_id: 1, FullName: 'منى عادل', Phone: '01001488462', ProductName: 'داش كام', quantity: 1,
      ProductPrice: '1210', City: 'الجيزة', Address: 'الدقي', Status: HOLD, DeliveryRate: 'بدون', AssignedTo: null, ...over };
    w.orders.set(id, o);
    return o;
  };
  const flows = {
    getAuto: async () => ({ auto_mode: w.mode, test_phones: testPhones, split_test: split, configured: true }),
    enroll: async ({ orderId, businessId, phone, variant, sendAt, isTest }) => {
      if (w.flows.has(orderId)) return null;
      const f = { order_id: orderId, business_id: businessId, phone, variant, is_test: isTest, state: 'pending', send_at: sendAt,
        reminders_done: 0, messages_sent: 0, customer_replied: false, text_replied: false, tag: null, outcome: null, customer_text: null };
      w.flows.set(orderId, f);
      return f;
    },
    getByOrder: async (b, id) => w.flows.get(id) || null,
    latestByPhone: async (b, phone) => [...w.flows.values()].filter((f) => f.phone === phone).pop() || null,
    claimDueSends: async (now) => [...w.flows.values()].filter((f) => f.state === 'pending' && f.send_at <= now).map((f) => { f.state = 'sending'; return f; }),
    markSent: async (id, s) => Object.assign(w.flows.get(id), { state: 'waiting', sent_at: s.sentAt, hold_until: s.holdUntil,
      reminder1_at: s.reminder1At, reminder2_at: s.reminder2At, messages_sent: w.flows.get(id).messages_sent + 1 }),
    markReleased: async (id, reason, error) => { const f = w.flows.get(id); if (!f) return null;
      if (f.state !== 'done') f.state = 'released'; f.release_reason = f.release_reason || reason; f.last_error = error || f.last_error; return f; },
    dueReleases: async (now) => [...w.flows.values()].filter((f) => f.state === 'waiting' && f.hold_until <= now),
    dueReminders: async (now, n) => [...w.flows.values()].filter((f) => f.reminders_done === n - 1 && f.sent_at
      && ['waiting', 'released'].includes(f.state) && !f.customer_replied && (n === 1 ? f.reminder1_at : f.reminder2_at) <= now),
    markReminder: async (id, n, sent) => { const f = w.flows.get(id); if (f.reminders_done !== n - 1) return false;
      f.reminders_done = n; if (sent) f.messages_sent += 1; return true; },
    markReply: async (id, r) => { const f = w.flows.get(id); f.customer_replied = true; if (r.done) f.state = 'done';
      if (r.outcome) f.outcome = r.outcome; if (r.tag) f.tag = r.tag; if (r.text) f.customer_text = [f.customer_text, r.text].filter(Boolean).join('\n');
      if (r.textReplied) f.text_replied = true; return f; },
    strandedHeldOrders: async () => [],
    ensureOrdersColumn: async () => true,
  };
  const cloud = {
    GraphError,
    sendTemplate: async (settings, m) => { if (w.metaFails) throw w.metaFails; w.sentTemplates.push(m); return { message_id: `wamid.T${w.sentTemplates.length}` }; },
    sendText: async (settings, m) => { w.sentTexts.push(m); return { message_id: `wamid.X${w.sentTexts.length}` }; },
  };
  const store = {
    getSettings: async () => ({ phone_number_id: '1', access_token: 't', quality_rating: quality }),
    logOutbound: async (m) => { w.logged.push(m); if (m.waMessageId) w.messages.set(m.waMessageId, { order_id: m.orderId, kind: m.kind, error_code: m.errorCode }); },
    messageByWamid: async (b, id) => w.messages.get(id) || null,
  };
  const orderStatus = {
    loadOrder: async (b, id) => { const o = w.orders.get(id); return o ? { row: { ...o }, status: o.Status } : null; },
    changeStatus: async ({ orderId, from, to, fields = {}, actor, effects }) => {
      const o = w.orders.get(orderId);
      if (!o) return { ok: false, code: 'NOT_FOUND' };
      if (w.raceOnce) { const r = w.raceOnce; w.raceOnce = null; r(o); }
      if (String(o.Status).trim() !== String(from).trim()) return { ok: false, code: 'STATUS_CONFLICT' };
      Object.assign(o, fields, { Status: to });
      w.changes.push({ orderId, from, to, fields, actor, effects });
      return { ok: true, order: o };
    },
  };
  engine._setDepsForTests({
    flows: () => flows, cloud: () => cloud, store: () => store, orderStatus: () => orderStatus,
    assign: async (orderId) => { const o = w.orders.get(orderId); o.AssignedTo = 'agent@test'; w.assigned.push(orderId); return o; },
    brandOf: async () => 'Product Pulse', now: () => w.now,
  });
  w.advance = (min) => { w.now = new Date(w.now.getTime() + min * 60000); };
  w.tap = (action, orderId, from = '201001488462') => engine.handleInbound(1, { kind: 'button', payload: `wa1:${action}:${orderId}`, from, reply: action });
  w.hold = async (id, over) => { const o = w.addOrder(id, over); await engine.enrollNewOrder(o, { phone: '201001488462', isTest: false, split }); return o; };
  w.sendNow = async () => { w.advance(5); return engine.tick(); };
  return w;
}

/* ── a new order ──────────────────────────────────────────────────────────── */

test('switched off (the default) → no order is ever held', async () => {
  world({ mode: 'off' });
  assert.equal(await engine.planForNewOrder(1, '01001488462'), null);
});

test('test mode holds ONLY the numbers on the owner\'s list', async () => {
  world({ mode: 'test', testPhones: ['201015718100'] });
  assert.equal(await engine.planForNewOrder(1, '01001488462'), null, 'a real customer is untouched');
  assert.deepEqual(await engine.planForNewOrder(1, '0101 571 8100'), { phone: '201015718100', isTest: true, split: false, holdStatus: 'بانتظار واتساب' });
});

test('on → every Egyptian mobile; a landline / broken number goes to the agents as always', async () => {
  world({ mode: 'on' });
  assert.equal((await engine.planForNewOrder(1, '+201001488462')).phone, '201001488462');
  assert.equal(await engine.planForNewOrder(1, '0233334444'), null);
  assert.equal(await engine.planForNewOrder(1, ''), null);
});

/* ── the worker ───────────────────────────────────────────────────────────── */

test('message after 5 minutes, then the order is held 30 minutes and released to an agent', async () => {
  const w = world();
  await w.hold(10);
  assert.deepEqual(await engine.tick(), { sent: 0, released: 0, reminders: 0, rescued: 0 }, 'nothing before 5 minutes');
  w.advance(5);
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(w.sentTemplates[0].name, 'order_confirm_v1');
  assert.equal(w.sentTemplates[0].to, '201001488462');
  assert.deepEqual(w.sentTemplates[0].components[0].parameters.map((p) => p.text), ['منى عادل', 'داش كام', '1', '1,210', 'الجيزة، الدقي']);
  assert.equal(w.orders.get(10).Status, 'بانتظار واتساب');
  w.advance(29);
  assert.equal((await engine.tick()).released, 0, 'still held at 29 minutes');
  w.advance(1);
  assert.equal((await engine.tick()).released, 1);
  assert.equal(w.orders.get(10).Status, 'جديد');
  assert.equal(w.orders.get(10).AssignedTo, 'agent@test', 'assigned like any fresh order');
  assert.equal(w.flows.get(10).release_reason, 'timeout');
  assert.equal((await engine.tick()).sent, 0, 'never sent twice');
  assert.equal(w.sentTemplates.length, 1);
});

test('Meta refuses the send → the order goes to the agents at once, nothing is lost', async () => {
  const w = world();
  await w.hold(11);
  w.metaFails = new GraphError(132001, 'Template name does not exist');
  await w.sendNow();
  assert.equal(w.orders.get(11).Status, 'جديد');
  assert.equal(w.orders.get(11).AssignedTo, 'agent@test');
  assert.equal(w.flows.get(11).release_reason, 'send_failed');
  assert.equal(w.logged[0].status, 'failed');
});

test('an order with no amount is not messaged — released; one an admin already moved is left alone', async () => {
  const w = world();
  await w.hold(12, { ProductPrice: '' });
  await w.hold(13);
  w.orders.get(13).Status = 'تم الرفض';                          // an admin handled it during the 5 minutes
  await w.sendNow();
  assert.equal(w.sentTemplates.length, 0);
  assert.equal(w.orders.get(12).Status, 'جديد');
  assert.equal(w.flows.get(12).release_reason, 'no_amount');
  assert.equal(w.orders.get(13).Status, 'تم الرفض', 'untouched');
  assert.deepEqual(w.assigned, [12]);
});

test('worker was down for an hour → the late message is NOT sent; the order goes to the agents', async () => {
  const w = world();
  await w.hold(14);
  w.advance(5 + 50);
  await engine.tick();
  assert.equal(w.sentTemplates.length, 0);
  assert.equal(w.orders.get(14).Status, 'جديد');
  assert.equal(w.flows.get(14).release_reason, 'late');
});

test('switched off while orders wait → they are released, not messaged', async () => {
  const w = world();
  await w.hold(15);
  w.mode = 'off';
  await w.sendNow();
  assert.equal(w.sentTemplates.length, 0);
  assert.equal(w.orders.get(15).Status, 'جديد');
});

test('Meta reports the number has no WhatsApp → released without waiting the 30 minutes', async () => {
  const w = world();
  await w.hold(16);
  await w.sendNow();
  w.messages.get('wamid.T1').error_code = 131026;
  assert.equal(await engine.handleFailedStatus(1, 'wamid.T1'), true);
  assert.equal(w.orders.get(16).Status, 'جديد');
  assert.equal(w.flows.get(16).release_reason, 'no_whatsapp');
  assert.equal(await engine.handleFailedStatus(1, 'wamid.T1'), false, 'only once');
});

/* ── the customer taps ────────────────────────────────────────────────────── */

test('«تأكيد الطلب» while held → «تم التأكيد», holder «واتساب», no commission, thank-you sent', async () => {
  const w = world();
  await w.hold(20);
  await w.sendNow();
  assert.deepEqual(await w.tap('confirm', 20), { handled: true, type: 'confirm' });
  const o = w.orders.get(20);
  assert.equal(o.Status, 'تم التأكيد');
  assert.equal(o.confirmed_via, 'whatsapp');
  assert.equal(o.AssignedTo, null);
  assert.deepEqual(w.changes[0].effects, { commission: false });
  assert.equal(w.changes[0].actor.label, 'whatsapp');
  assert.deepEqual(w.assigned, [], 'never reached an agent');
  assert.match(w.sentTexts[0].body, /^تم تأكيد طلبك ✅/);
  assert.match(w.sentTexts[0].body, /Product Pulse/);
  assert.equal(w.flows.get(20).state, 'done');
  w.advance(200);
  assert.deepEqual(await engine.tick(), { sent: 0, released: 0, reminders: 0, rescued: 0 }, 'no release, no reminder after a confirmation');
});

test('tap «تأكيد» after the order reached an agent who has not answered it → WhatsApp confirms, order leaves her', async () => {
  const w = world();
  await w.hold(21);
  await w.sendNow();
  w.advance(30); await engine.tick();
  assert.equal(w.orders.get(21).AssignedTo, 'agent@test');
  w.orders.get(21).Status = 'لا يرد';                            // she called, no answer
  await w.tap('confirm', 21);
  assert.equal(w.orders.get(21).Status, 'تم التأكيد');
  assert.equal(w.orders.get(21).AssignedTo, null);
  assert.equal(w.changes.at(-1).from, 'لا يرد');
});

test('a «ضعيف» customer taps «تأكيد» → NOT confirmed: straight to an agent, tagged for the deposit', async () => {
  const w = world();
  await w.hold(22, { DeliveryRate: 'ضعيف' });
  await w.sendNow();
  assert.equal((await w.tap('confirm', 22)).type, 'deposit_needed');
  assert.equal(w.orders.get(22).Status, 'جديد');
  assert.equal(w.orders.get(22).AssignedTo, 'agent@test');
  assert.equal(w.orders.get(22).confirmed_via, undefined);
  assert.equal(w.flows.get(22).tag, 'deposit');
  assert.match(w.sentTexts[0].body, /استلمنا تأكيدك/);
});

test('«إلغاء الطلب» never cancels — the order goes to an agent now, tagged «عايز يلغي»', async () => {
  const w = world();
  await w.hold(23);
  await w.sendNow();
  assert.equal((await w.tap('cancel', 23)).type, 'cancel_requested');
  assert.equal(w.orders.get(23).Status, 'جديد');
  assert.equal(w.orders.get(23).AssignedTo, 'agent@test');
  assert.equal(flow.TAGS[w.flows.get(23).tag], 'عايز يلغي');
  assert.match(w.sentTexts[0].body, /وصلنا طلب الإلغاء/);
  await w.tap('cancel', 23);
  assert.equal(w.sentTexts.length, 1, 'tapping again gets no second answer');
});

test('«طلب الدعم» on an order already with an agent only tags it', async () => {
  const w = world();
  await w.hold(24);
  await w.sendNow();
  w.advance(30); await engine.tick();
  const before = w.changes.length;
  assert.equal((await w.tap('support', 24)).type, 'support_requested');
  assert.equal(w.changes.length, before, 'no status change');
  assert.equal(w.flows.get(24).tag, 'support');
});

test('an agent confirms in the same second as the tap → compare-and-set keeps hers', async () => {
  const w = world();
  await w.hold(25);
  await w.sendNow();
  w.advance(30); await engine.tick();
  w.raceOnce = (o) => { o.Status = 'تم التأكيد'; };              // she wins the race
  assert.deepEqual(await w.tap('confirm', 25), { handled: true, type: 'already_confirmed' });
  assert.equal(w.orders.get(25).AssignedTo, 'agent@test', 'the order stays hers — and so does the commission');
  assert.equal(w.orders.get(25).confirmed_via, undefined);
  assert.match(w.sentTexts[0].body, /متأكد عندنا بالفعل/);
});

test('a tap on an order an agent rejected changes nothing — it only tells the team', async () => {
  const w = world();
  await w.hold(26);
  await w.sendNow();
  w.advance(30); await engine.tick();
  w.orders.get(26).Status = 'تم الرفض';
  const before = w.changes.length;
  assert.equal((await w.tap('confirm', 26)).type, 'closed_interest');
  assert.equal(w.orders.get(26).Status, 'تم الرفض');
  assert.equal(w.changes.length, before);
  assert.equal(flow.TAGS[w.flows.get(26).tag], 'داس «تأكيد» بعد ما الأوردر اتقفل');
});

test('a payload for somebody else\'s order, or an unknown one, is ignored', async () => {
  const w = world();
  await w.hold(27);
  await w.sendNow();
  assert.deepEqual(await w.tap('confirm', 27, '201112223334'), { handled: false, why: 'not_their_order' });
  assert.deepEqual(await w.tap('confirm', 999), { handled: false, why: 'not_their_order' });
  assert.equal(w.orders.get(27).Status, 'بانتظار واتساب');
});

test('the customer writes instead of tapping → «طلب الدعم», text kept, one acknowledgement', async () => {
  const w = world();
  await w.hold(28);
  await w.sendNow();
  await engine.handleInbound(1, { kind: 'text', from: '201001488462', reply: 'عايز أغيّر العنوان' });
  await engine.handleInbound(1, { kind: 'text', from: '201001488462', reply: 'شارع 9' });
  assert.equal(w.orders.get(28).Status, 'جديد');
  assert.equal(w.orders.get(28).AssignedTo, 'agent@test');
  assert.equal(w.flows.get(28).tag, 'support');
  assert.equal(w.flows.get(28).customer_text, 'عايز أغيّر العنوان\nشارع 9');
  assert.equal(w.sentTexts.length, 1);
  assert.deepEqual(await engine.handleInbound(1, { kind: 'text', from: '201999999999', reply: 'hi' }), { handled: false, why: 'no_flow' });
});

/* ── reminders ────────────────────────────────────────────────────────────── */

test('reminders: +2 h and next day, only while the order is open and the customer silent', async () => {
  const w = world();
  await w.hold(30);
  await w.sendNow();                                              // 14:05 Cairo
  w.advance(30); await engine.tick();                             // released to an agent
  w.advance(89);
  assert.equal((await engine.tick()).reminders, 0, 'not before 2 hours');
  w.advance(1);
  assert.equal((await engine.tick()).reminders, 1);
  assert.equal(w.sentTemplates[1].name, 'order_confirm_reminder_v1');
  assert.deepEqual(w.sentTemplates[1].components[0].parameters.map((p) => p.text), ['منى عادل', 'داش كام', '1,210']);
  w.advance(22 * 60);                                             // next day 14:05
  assert.equal((await engine.tick()).reminders, 1);
  w.advance(24 * 60);
  assert.equal((await engine.tick()).reminders, 0, 'three messages at most');
  assert.equal(w.sentTemplates.length, 3);
});

test('no reminder once an agent settled the order, or the customer answered', async () => {
  const w = world();
  await w.hold(31); await w.hold(32);
  await w.sendNow();
  w.advance(30); await engine.tick();
  w.orders.get(31).Status = 'تم التأكيد';                        // the agent confirmed #31
  await w.tap('support', 32);                                     // the customer of #32 answered
  w.advance(24 * 60);
  assert.equal((await engine.tick()).reminders, 0);
  assert.equal(w.sentTemplates.length, 2, 'only the two confirmations');
  assert.equal(w.flows.get(31).reminders_done, 2, 'both reminders are closed — never looked at again');
});

test('a reminder that falls at night waits for 10:00; the 2nd stops if the number\'s quality drops', async () => {
  const w = world({ quality: 'YELLOW' });
  w.now = new Date('2026-11-25T20:30:00Z');                       // 22:30 Cairo
  await w.hold(33);
  await w.sendNow();                                              // sent 22:35 → +2 h = 00:35 → moved to 10:00
  w.advance(30); await engine.tick();
  w.now = new Date('2026-11-26T07:59:00Z');                       // 09:59 Cairo
  assert.equal((await engine.tick()).reminders, 0);
  w.now = new Date('2026-11-26T08:00:30Z');                       // 10:00 Cairo
  assert.equal((await engine.tick()).reminders, 1);
  w.now = new Date('2026-11-26T20:40:00Z');                       // next day, 2nd reminder due
  assert.equal((await engine.tick()).reminders, 0, 'quality is not high → no second reminder');
  assert.equal(w.flows.get(33).reminders_done, 2);
});
