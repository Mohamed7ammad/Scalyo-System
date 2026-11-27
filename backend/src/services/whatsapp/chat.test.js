'use strict';
/* The chat's rules (pure): who may write, until when, and what the page is shown. */
const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../../config/db');
pool.query = async () => ({ rows: [], rowCount: 0 });     // nothing here touches a database
const chat = require('./chat');

const at = (iso) => new Date(iso);
const H = 60 * 60 * 1000;

test('free text is allowed until just under 24 hours after the customer last wrote', () => {
  const last = at('2026-11-27T10:00:00Z');
  assert.equal(chat.windowState(last, at('2026-11-27T10:01:00Z')).open, true);
  assert.equal(chat.windowState(last, at('2026-11-28T09:50:00Z')).open, true);
  assert.equal(chat.windowState(last, at('2026-11-28T09:56:00Z')).open, false, 'we stop 5 minutes before Meta does');
  assert.equal(chat.windowState(last, at('2026-11-28T10:30:00Z')).open, false);
  assert.equal(chat.windowState(last).until.getTime(), last.getTime() + 24 * H - chat.WINDOW_MARGIN_MS);
  assert.deepEqual(chat.windowState(null), { open: false, until: null }, 'a customer who never wrote cannot be written to');
});

test('one customer, two orders: the holder of the newest order still being worked replies', () => {
  const sib = [
    { order_id: 100, status: 'لا يرد', holder: 'mona@x' },
    { order_id: 140, status: 'جديد', holder: 'sara@x' },
    { order_id: 150, status: 'تم الشحن', holder: 'hala@x' },        // shipped: nobody is working it
    { order_id: 160, status: 'تم التأكيد', holder: '' },             // WhatsApp confirmed it: no holder
  ];
  assert.equal(chat.replyOwner(sib).order_id, 140);
  assert.equal(chat.replyOwner([{ order_id: 1, status: 'تم الرفض', holder: 'a@x' }]), null);
  assert.equal(chat.replyOwner([]), null);
});

test('only the holder writes; the reason is told to everybody else', () => {
  const open = { open: true, until: at('2026-11-28T10:00:00Z') };
  const sib = [{ order_id: 100, status: 'لا يرد', holder: 'mona@x' }, { order_id: 140, status: 'جديد', holder: 'Sara@X' }];
  const ask = (email, order, extra = {}) => chat.access({ user: { email }, isAdmin: false, order, siblings: sib, window: open, ...extra });

  assert.deepEqual(ask('sara@x', { holder: 'Sara@X' }), { reply_order_id: 140, can_reply: true, why: null });
  assert.equal(ask('mona@x', { holder: 'mona@x' }).why, 'other_order', 'her order, but the newer one is with somebody else');
  assert.equal(ask('noha@x', { holder: 'mona@x' }).why, 'not_holder');
  assert.equal(ask('sara@x', { holder: 'Sara@X' }, { window: { open: false, until: at('2026-11-26T10:00:00Z') } }).why, 'window');
  assert.equal(ask('sara@x', { holder: 'Sara@X' }, { window: { open: false, until: null } }).why, 'never_wrote');
  assert.equal(ask('sara@x', { holder: 'Sara@X' }, { configured: false }).why, 'unconfigured');
  assert.equal(chat.access({ user: { email: 'a@x' }, isAdmin: false, order: { holder: 'a@x' }, siblings: [{ order_id: 1, status: 'تم الشحن', holder: 'a@x' }], window: open }).why, 'closed');
  /* the owner may answer any conversation, even one WhatsApp confirmed with no holder — but never outside the window */
  assert.equal(chat.access({ user: { email: 'boss@x' }, isAdmin: true, order: { holder: '' }, siblings: [], window: open }).can_reply, true);
  assert.equal(chat.access({ user: { email: 'boss@x' }, isAdmin: true, order: { holder: '' }, siblings: [], window: { open: false, until: null } }).can_reply, false);
});

test('a message is trimmed, bounded, and never carries an unfinished [part]', () => {
  assert.equal(chat.cleanText('  أهلًا \r\n\r\n\r\n\r\nبحضرتك  '), 'أهلًا\n\nبحضرتك');
  assert.throws(() => chat.cleanText('   '), /اكتبي الرسالة/);
  assert.throws(() => chat.cleanText('س'.repeat(chat.MAX_TEXT + 1)), /طويلة/);
  assert.throws(() => chat.cleanText('محتاجين مقدم [المبلغ] على [رقم التحويل]'), /قوسين/);
  assert.equal(chat.cleanText('السعر 1689 ج شامل الشحن'), 'السعر 1689 ج شامل الشحن');
});

test('stored rows become what the page draws — and no phone number rides along', () => {
  const base = { created_at: at('2026-11-27T10:00:00Z'), order_id: 20801, phone: '201000000000' };
  const tpl = chat.shapeMessage({ ...base, id: 1, direction: 'out', kind: 'confirm', status: 'read', reply: 'طلب الدعم', created_by: 'whatsapp' });
  assert.deepEqual([tpl.dir, tpl.type, tpl.text, tpl.tapped, tpl.by], ['out', 'system', 'رسالة تأكيد الطلب (#20801)', 'طلب الدعم', 'السيستم']);
  const auto = chat.shapeMessage({ ...base, id: 2, direction: 'out', kind: 'reply', status: 'sent', body: 'تم استلام رسالتك' });
  assert.deepEqual([auto.type, auto.text, auto.tapped], ['system', 'تم استلام رسالتك', null]);
  assert.equal(chat.shapeMessage({ ...base, id: 3, direction: 'out', kind: 'reply', status: 'sent' }).text, 'رد تلقائي من السيستم');
  const mine = chat.shapeMessage({ ...base, id: 4, direction: 'out', kind: 'chat', status: 'failed', body: 'أيوه يا فندم', created_by: 'manar@shop.com' });
  assert.deepEqual([mine.type, mine.text, mine.by, mine.error], ['text', 'أيوه يا فندم', 'manar', true]);
  const tap = chat.shapeMessage({ ...base, id: 5, direction: 'in', kind: 'button', status: 'received', reply: 'إلغاء الطلب' });
  assert.deepEqual([tap.dir, tap.type, tap.text, tap.status], ['in', 'tap', 'إلغاء الطلب', null]);
  /* the full text comes from the payload: the short `reply` column stops at 120 characters */
  const long = 'ك'.repeat(300);
  assert.equal(chat.shapeMessage({ ...base, id: 6, direction: 'in', kind: 'text', reply: long.slice(0, 120), body: long }).text, long);
  const voice = chat.shapeMessage({ ...base, id: 7, direction: 'in', kind: 'other', reply: '[audio]', raw_type: 'audio', media_id: 9, media_kind: 'audio', media_status: 'done' });
  assert.deepEqual([voice.type, voice.media], ['media', { id: 9, kind: 'audio', status: 'done' }]);
  assert.equal(chat.shapeMessage({ ...base, id: 8, direction: 'in', kind: 'other', reply: '[location]', raw_type: 'location' }).text, 'لوكيشن');
  for (const m of [tpl, auto, mine, tap, voice]) assert.equal(JSON.stringify(m).includes('201000000000'), false);
});

test('two ready replies are offered for what the customer asked; the rest stay in the list', () => {
  const replies = [
    { id: 1, for_tags: [] }, { id: 2, for_tags: ['cancel'] }, { id: 3, for_tags: ['cancel', 'support'] },
    { id: 4, for_tags: ['cancel'] }, { id: 5, for_tags: ['deposit'] },
  ];
  assert.deepEqual(chat.suggest(replies, { tag: 'cancel' }), [2, 3]);
  assert.deepEqual(chat.suggest(replies, { tag: 'deposit' }), [5]);
  assert.deepEqual(chat.suggest(replies, { tag: null }), []);
  assert.equal(chat.fitsProduct({ product_match: 'داش كام' }, 'داش كام للسيارة 4 عدسات'), true);
  assert.equal(chat.fitsProduct({ product_match: 'داش كام' }, 'سوار ذكي'), false);
  assert.equal(chat.fitsProduct({ product_match: null }, 'أي منتج'), true);
});

test('a ready reply with an open [part] can be saved switched off, never switched on', () => {
  const draft = { title: 'طلب المقدم', body: 'مقدم [المبلغ] على [رقم التحويل]', category: 'الطلب', for_tags: ['deposit', 'not-a-tag'] };
  assert.throws(() => chat.cleanReply({ ...draft, active: true }), /قوسين/);
  const v = chat.cleanReply({ ...draft, active: false });
  assert.deepEqual([v.active, v.for_tags, v.product_match, v.sort], [false, ['deposit'], null, 100]);
  assert.throws(() => chat.cleanReply({ title: '', body: 'x' }), /اسم الرد/);
  assert.throws(() => chat.cleanReply({ title: 'x', body: '' }), /نص الرد/);
  /* the first list: every switched-on reply is complete, every unfinished one is off */
  for (const s of chat.SEED) assert.equal(/\[[^\]]+\]/.test(s.body), !s.active, s.title);
  assert.ok(chat.SEED.filter((s) => s.active).length >= 6);
});
