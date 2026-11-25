'use strict';

/* Unit tests for the WhatsApp message templates (step 5). No DB, no network.
   Run: npm test (from backend/)  or  node --test src/services/whatsapp/templates.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const tpl    = require('./templates');
const cloud  = require('./cloudApi');

test('the two templates the owner approved, built for the brand', () => {
  const [confirm, reminder] = tpl.build('Product Pulse');
  assert.equal(confirm.name, 'order_confirm_v1');
  assert.equal(confirm.language, 'ar');
  assert.equal(confirm.category, 'UTILITY');
  assert.deepEqual(confirm.buttons, ['تأكيد الطلب', 'إلغاء الطلب', 'طلب الدعم']);
  assert.ok(confirm.body.includes('استلمنا طلبك من Product Pulse:'));
  assert.ok(confirm.body.includes('دوس «طلب الدعم» وهنكلمك'));
  assert.equal(confirm.example.length, 5);
  assert.equal(reminder.name, 'order_confirm_reminder_v1');
  assert.deepEqual(reminder.buttons, ['تأكيد الطلب', 'إلغاء الطلب']);
  assert.equal(reminder.example.length, 3);
});

test("every template passes Meta's shape rules before we ever submit it", () => {
  for (const t of tpl.build('Product Pulse')) {
    assert.deepEqual(tpl.validate(t.body, t), [], t.name);
    assert.ok(!/\{\{\d+\}\}/.test(tpl.preview(t)), 'preview fills every variable');
    assert.ok(!/خصم|عرض|اشتري|كوبون/.test(t.body), 'nothing promotional (stays UTILITY)');
  }
});

test('validate catches what Meta would reject', () => {
  const t = { example: ['a', 'b'], buttons: ['ok'] };
  assert.ok(tpl.validate('{{1}} مرحبا {{2}} تمام', t).some((p) => /start or end/.test(p)));
  assert.ok(tpl.validate('أهلًا {{1}}{{2}} تمام', t).some((p) => /touch/.test(p)));
  assert.ok(tpl.validate('أهلًا {{1}} و {{3}} تمام', t).some((p) => /variables must be/.test(p)));
  assert.ok(tpl.validate('أهلًا {{1}}\n\n\n{{2}} تمام', t).some((p) => /empty line/.test(p)));
  assert.ok(tpl.validate('أهلًا {{1}} و {{2}} تمام', { ...t, buttons: ['x'.repeat(26)] }).some((p) => /25 characters/.test(p)));
});

test('the brand name is cleaned, and a missing one is a clear 400', () => {
  assert.ok(tpl.build('  Product\n Pulse {{9}} ')[0].body.includes('استلمنا طلبك من Product Pulse 9:'));
  assert.throws(() => tpl.build(''), (e) => e.status === 400 && /اسم البراند/.test(e.message));
  assert.throws(() => tpl.build(null), (e) => e.status === 400);
});

test("the submit payload is Meta's create-template shape", () => {
  const [confirm] = tpl.build('Product Pulse');
  const p = tpl.toMetaPayload(confirm);
  assert.deepEqual(Object.keys(p), ['name', 'language', 'category', 'components']);
  assert.equal(p.components[0].type, 'BODY');
  assert.deepEqual(p.components[0].example, { body_text: [confirm.example] });
  assert.deepEqual(p.components[1], { type: 'BUTTONS', buttons: [
    { type: 'QUICK_REPLY', text: 'تأكيد الطلب' }, { type: 'QUICK_REPLY', text: 'إلغاء الطلب' }, { type: 'QUICK_REPLY', text: 'طلب الدعم' }] });
});

test('listTemplates / createTemplate call the Messaging account', async () => {
  const st = { phone_number_id: '1', waba_id: '1526082952717718', access_token: 'EAAG' + 'x'.repeat(40) };
  const calls = [];
  cloud._setFetchForTests(async (url, opts) => {
    calls.push([opts.method, url, opts.body ? JSON.parse(opts.body).name : null]);
    const body = opts.method === 'POST' ? { id: '99', status: 'PENDING', category: 'UTILITY' }
      : { data: [{ id: '5', name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US', rejected_reason: 'NONE' },
                 { id: '6', name: 'order_confirm_v1', status: 'REJECTED', category: 'UTILITY', language: 'ar', rejected_reason: 'INVALID_FORMAT' }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  const list = await cloud.listTemplates(st);
  assert.equal(list[0].rejected_reason, null, '"NONE" is not a reason');
  assert.equal(list[1].rejected_reason, 'INVALID_FORMAT');
  assert.deepEqual(await cloud.createTemplate(st, tpl.toMetaPayload(tpl.build('Product Pulse')[0])), { id: '99', status: 'PENDING', category: 'UTILITY' });
  assert.equal(calls[0][0], 'GET');
  assert.ok(calls[0][1].startsWith(`https://graph.facebook.com/${cloud.VERSION}/1526082952717718/message_templates?`));
  assert.deepEqual(calls[1], ['POST', `https://graph.facebook.com/${cloud.VERSION}/1526082952717718/message_templates`, 'order_confirm_v1']);
});

test('a failure Meta reports later is shown by its Arabic meaning', () => {
  assert.match(cloud.friendlyForCode(131042, 'Message failed to send because…'), /الدفع/);
  assert.equal(cloud.friendlyForCode(999999, 'Something new'), 'Something new');
  assert.equal(cloud.friendlyForCode(null, null), null);
});
