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

test('who needs a deposit: Bosta «ضعيف» always; EasyOrder «low» only when Bosta has no opinion', () => {
  assert.equal(flow.isWeak({ DeliveryRate: 'ضعيف', easyorder_rate: 'high' }), true);
  for (const bosta of ['بدون', 'جديد', '', null, undefined]) assert.equal(flow.isWeak({ DeliveryRate: bosta, easyorder_rate: 'low' }), true, String(bosta));
  assert.equal(flow.isWeak({ DeliveryRate: 'بدون', easyorder_rate: ' LOW ' }), true);
  for (const bosta of ['ممتاز', 'متوسط']) assert.equal(flow.isWeak({ DeliveryRate: bosta, easyorder_rate: 'low' }), false, bosta);
  for (const eo of ['high', 'moderate', 'unknown', null, undefined, '']) assert.equal(flow.isWeak({ DeliveryRate: 'بدون', easyorder_rate: eo }), false, String(eo));
});

test('the trial group is the customer\u2019s own number: last digit 8 or 9 → the agents (about 20%), 0–7 → WhatsApp', () => {
  for (const d of '01234567') assert.equal(flow.trialGroup(`20100148846${d}`), 'wa', d);
  for (const d of '89') assert.equal(flow.trialGroup(`20100148846${d}`), 'control', d);
});

test('daily limits follow the tier Meta reports; an unknown tier is treated as the smallest (250)', () => {
  assert.deepEqual(flow.dailyLimits('TIER_2K'), { tier: 'TIER_2K', meta: 2000, new_orders: 1900, recontact: 1700, recontact_live: 1200 });
  assert.deepEqual(flow.dailyLimits('TIER_250'), { tier: 'TIER_250', meta: 250, new_orders: 237, recontact: 212, recontact_live: 150 });
  for (const t of [null, undefined, '', 'SOMETHING_NEW']) assert.equal(flow.dailyLimits(t).meta, 250, String(t));
  assert.equal(flow.dailyLimits(' tier_10k ').meta, 10000);
});

test('the button\u2019s words typed by hand count as the tap only when they are the whole message', () => {
  for (const t of ['تأكيد الطلب', 'تاكيد الطلب', ' تأكيد  ', 'أكد', 'تأكيد الطلب ✅', 'تَأكِيد الطلب.', 'Confirm']) assert.equal(flow.typedAction(t), 'confirm', t);
  for (const t of ['إلغاء الطلب', 'الغاء', 'إلغاء!', 'الغي الطلب']) assert.equal(flow.typedAction(t), 'cancel', t);
  for (const t of ['تأكيد الطلب بس غيروا العنوان', 'مش عايز الغاء', 'تمام', '', null, '👍']) assert.equal(flow.typedAction(t), null, String(t));
});

test('an acknowledgement asks for nothing; anything else needs a human', () => {
  for (const t of ['تمام', 'تمام شكرا', 'شكراً جزيلاً', '👍', '🙏❤️', 'Ok 👌', 'تمام منتظر', 'إن شاء الله', 'حاضر يا باشا', 'ايوه تمام']) assert.equal(flow.isAck(t), true, t);
  for (const t of ['هل بتيجي معاه الكارت الميموري', 'لا انا عايز يوم 20/12', 'عنواني المرج القديمة', 'شكرا أهم حاجة لون أسود',
    'اهم حاجه يكون اصلي', 'تمام بس عايز المندوب يكلمني', '[audio]', '[location]', 'ممكن صور']) assert.equal(flow.isAck(t), false, t);
});

test('media in a message: voice notes and pictures have a file to fetch; text and locations do not', () => {
  assert.deepEqual(flow.mediaOf({ type: 'audio', audio: { id: 77, mime_type: 'audio/ogg; codecs=opus', voice: true } }), { kind: 'audio', id: '77', mime: 'audio/ogg; codecs=opus' });
  assert.deepEqual(flow.mediaOf({ type: 'image', image: { id: 'abc' } }), { kind: 'image', id: 'abc', mime: null });
  for (const raw of [{ type: 'text', text: { body: 'x' } }, { type: 'location', location: {} }, { type: 'audio', audio: {} }, null, undefined]) assert.equal(flow.mediaOf(raw), null);
});

test('the address the customer writes: what reads like one, what does not, and what goes in the box', () => {
  for (const yes of ['82 ش ترسا الكوم الاخضر هرم برج الزمرده', '٥ شارع النصر بجوار مسجد الرحمن', 'قرية ميت غمر بيت الحاج محمد جنب المدرسة',
    'بالشارع الرئيسي امام البنك الاهلي', 'للعمارة رقم 5 والدور التاني في فيصل', 'غرب اربيلا عماره ٢١٤ حي ٤/٣']) assert.equal(flow.looksLikeAddress(yes), true, yes);
  for (const no of ['الدور التالت', 'خلي الطلب 2 بس', 'عايز اغير العنوان', 'هو الطلب هيوصل امتى', 'شارع النصر فين؟', 'تمام شكرا يا فندم',
    'رقمي التاني 01012345678 شارع النصر', 'رقمي ٠١٠ ١٢٣٤ ٥٦٧٨ شارع النصر', 'وفية اسعار اقل ف السوق', 'ابعتوه على عنوان الشغل في مدينة نصر',
    'مش هستلم من البيت خالص', '', null, 'ش'.repeat(400)]) assert.equal(flow.looksLikeAddress(no), false, String(no).slice(0, 40));

  assert.equal(flow.mergeAddress('هرم', '82 ش ترسا هرم برج'), '82 ش ترسا هرم برج', 'already said');
  assert.equal(flow.mergeAddress('ش الهرم', 'عمارة 12\nالدور التالت'), 'ش الهرم - عمارة 12 الدور التالت');
  assert.equal(flow.mergeAddress(' . ', 'عمارة 12 الدور التالت'), 'عمارة 12 الدور التالت', 'punctuation alone is not an address');
  assert.equal(flow.mergeAddress(null, '  عمارة 12  '), 'عمارة 12');

  const order = { Status: 'جديد', City: 'الجيزة', Address: 'هرم' };
  const text = '82 ش ترسا الكوم الاخضر برج الزمردة';
  assert.deepEqual(flow.addressAnswer({ order, flow: { tag: 'address' }, text }), { address: `هرم - ${text}` });
  assert.equal(flow.addressAnswer({ order, flow: { tag: 'support' }, text }), null, 'we never asked this customer for an address');
  assert.equal(flow.addressAnswer({ order, flow: null, text }), null);
  assert.equal(flow.addressAnswer({ order: { ...order, Status: 'تم الرفض' }, flow: { tag: 'address' }, text }), null, 'the order is settled');
  assert.equal(flow.addressAnswer({ order: { ...order, Address: 'الهرم - شارع ترسا 82' }, flow: { tag: 'address' }, text }), null, 'already completed');
  assert.equal(flow.addressAnswer({ order, flow: { tag: 'address' }, text: 'هو الطلب هيوصل امتى' }), null);
  assert.equal(flow.addressAnswer({ order, flow: { tag: 'address' }, text: 'شكرا لك على تواصلك مع ورشة النجارة بجوار المسجد' }), null, 'their phone’s auto-reply');

  const ok = { Status: 'جديد', DeliveryRate: 'بدون', City: 'الجيزة', Address: 'الدقي - شارع التحرير 12' };
  assert.deepEqual(flow.decideTap({ action: 'confirm', order: { ...ok, Address: 'هرم' } }), { type: 'agent_needed', tag: 'address', release: true, reply: 'address' });
  assert.match(flow.replyText('address'), /اكتبلنا هنا العنوان بالتفصيل/);
  assert.match(flow.replyText('address_kept', { brand: 'Product Pulse' }), /وصلنا العنوان.*\n.*فريق Product Pulse/);
});

test('what stops «تأكيد» from confirming by itself: an earlier request, a second order, a thin address', () => {
  const ok = { Status: 'جديد', DeliveryRate: 'بدون', City: 'الجيزة', Address: 'الدقي - شارع التحرير 12' };
  assert.equal(flow.confirmBlocker({ order: ok, flow: { tag: null }, otherOrders: 0 }), null);
  for (const tag of ['support', 'cancel', 'voice']) assert.equal(flow.confirmBlocker({ order: ok, flow: { tag }, otherOrders: 0 }), 'reconfirm', tag);
  assert.equal(flow.confirmBlocker({ order: ok, flow: { tag: 'deposit' }, otherOrders: 0 }), null, 'a deposit tag is decided by the rating, not here');
  assert.equal(flow.confirmBlocker({ order: ok, flow: null, otherOrders: 1 }), 'dup');
  assert.equal(flow.confirmBlocker({ order: { ...ok, City: '  ' }, flow: null }), 'address');
  assert.equal(flow.confirmBlocker({ order: { ...ok, Address: 'المنصورة' }, flow: null }), 'address');
  assert.equal(flow.confirmBlocker({ order: { ...ok, Address: null }, flow: null }), 'address');
  assert.deepEqual(flow.decideTap({ action: 'confirm', order: ok, flow: { tag: 'support' } }), { type: 'agent_needed', tag: 'reconfirm', release: true, reply: 'deposit' });
  assert.equal(flow.decideTap({ action: 'cancel', order: ok, flow: { tag: 'support' }, otherOrders: 3 }).type, 'cancel_requested', 'only «تأكيد» is gated');
});

test('WhatsApp Business greetings and away messages are recognised; a real sentence is not', () => {
  for (const t of ['‏شكرا لك على تواصلك مع هاني القصاص قسم نجاره. من فضلك أخبرنا كيف يمكننا خدمتك.', 'شكرًا لك على رسالتك. نحن غير متاحين الآن، ولكننا سنرد عليك في أقرب وقت ممكن.',
    'Thank you for contacting Acme! Please let us know how we can help you.', "Thank you for your message. We're unavailable right now, but will respond as soon as possible."]) assert.equal(flow.isAutoReply(t), true, t);
  for (const t of ['شكرا', 'تمام شكرا لك', 'عايز اعرف هيوصل امتى', 'تأكيد الطلب', '', null]) assert.equal(flow.isAutoReply(t), false, String(t));
});

test('a lost order (abandoned checkout) never confirms by a tap, whatever else is fine', () => {
  const ok = { Status: 'لا يرد', DeliveryRate: 'بدون', City: 'الجيزة', Address: 'الدقي - شارع التحرير 12', is_lost_order: true };
  assert.equal(flow.confirmBlocker({ order: ok, flow: { tag: null } }), 'lost');
  assert.equal(flow.decideTap({ action: 'confirm', order: ok }).type, 'agent_needed');
  assert.equal(flow.decideTap({ action: 'confirm', order: { ...ok, is_lost_order: false } }).type, 'confirm');
  assert.equal(flow.TAGS.lost, 'أكد على واتساب — طلب مفقود');
});
