'use strict';

/* Unit tests for the WhatsApp module, Step 2 (connect + test message + webhook log).
   No database (the store is stubbed), no network (fetch is stubbed).
   Run: npm test (from backend/)  or  node --test src/services/whatsapp/whatsapp.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http   = require('http');

const hook  = require('./webhook');
const db    = require('./db');
const cloud = require('./cloudApi');

const SECRET_A = 'a'.repeat(32);
const SECRET_B = '0123456789abcdef0123456789abcdef';
const sign = (raw, secret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

/* ── signature ─────────────────────────────────────────────────────────────── */

test('a delivery signed with the saved app secret is accepted, anything else is not', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
  assert.equal(hook.signatureMatches(raw, sign(raw, SECRET_A), SECRET_A), true);
  assert.equal(hook.signatureMatches(raw, sign(raw, SECRET_A).toUpperCase().replace('SHA256=', 'sha256='), SECRET_A), true);
  assert.equal(hook.signatureMatches(raw, sign(raw, SECRET_B), SECRET_A), false, 'other secret');
  assert.equal(hook.signatureMatches(Buffer.from(raw.toString() + ' '), sign(raw, SECRET_A), SECRET_A), false, 'body changed');
  assert.equal(hook.signatureMatches(raw, 'sha1=abc', SECRET_A), false, 'wrong format');
  assert.equal(hook.signatureMatches(raw, undefined, SECRET_A), false, 'no header');
  assert.equal(hook.signatureMatches(raw, sign(raw, SECRET_A), null), false, 'no secret saved');
  assert.equal(hook.signatureMatches(Buffer.alloc(0), sign(Buffer.alloc(0), SECRET_A), SECRET_A), false, 'empty body');
});

test('matchSigners picks only the businesses whose secret signed it', () => {
  const raw = Buffer.from('{"x":1}');
  const c = [
    { business_id: 1, phone_number_id: '111', app_secret: SECRET_A },
    { business_id: 2, phone_number_id: '222', app_secret: SECRET_B },
  ];
  assert.deepEqual(hook.matchSigners(raw, sign(raw, SECRET_B), c).map((s) => s.business_id), [2]);
  assert.deepEqual(hook.matchSigners(raw, sign(raw, 'f'.repeat(32)), c), []);
});

/* ── payload reading ───────────────────────────────────────────────────────── */

const payload = (value, field = 'messages') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '111' }, ...value } }] }],
});

test('delivery reports become status events, with Meta error details on failure', () => {
  const ev = hook.parseEvents(payload({
    statuses: [
      { id: 'wamid.A', status: 'delivered', timestamp: '1764000000', recipient_id: '201001488462' },
      { id: 'wamid.B', status: 'failed', timestamp: '1764000060', recipient_id: '201001488462',
        errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Receiver is incapable' } }] },
      { status: 'read' },                                         // no id → skipped
    ],
  }));
  assert.equal(ev.length, 2);
  assert.deepEqual(
    { ...ev[0], at: ev[0].at.toISOString() },
    { type: 'status', phone_number_id: '111', wa_message_id: 'wamid.A', status: 'delivered',
      at: new Date(1764000000 * 1000).toISOString(), recipient: '201001488462', error_code: null, error_text: null },
  );
  assert.equal(ev[1].error_code, 131026);
  assert.equal(ev[1].error_text, 'Receiver is incapable');
});

test('customer messages: template button, interactive button, text, other', () => {
  const ev = hook.parseEvents(payload({
    contacts: [{ wa_id: '201001488462', profile: { name: 'Mona' } }],
    messages: [
      { id: 'wamid.1', from: '201001488462', timestamp: '1764000100', type: 'button',
        button: { payload: 'CONFIRM:123', text: 'تأكيد الطلب' }, context: { from: 'x', id: 'wamid.OUT' } },
      { id: 'wamid.2', from: '201001488462', timestamp: '1764000101', type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'CANCEL:123', title: 'إلغاء' } } },
      { id: 'wamid.3', from: '201001488462', timestamp: '1764000102', type: 'text', text: { body: 'امتى يوصل؟' } },
      { id: 'wamid.4', from: '201001488462', timestamp: '1764000103', type: 'image', image: { id: 'm1' } },
    ],
  }));
  assert.deepEqual(ev.map((e) => [e.kind, e.reply, e.payload, e.context_id]), [
    ['button', 'تأكيد الطلب', 'CONFIRM:123', 'wamid.OUT'],
    ['button', 'إلغاء', 'CANCEL:123', null],
    ['text', 'امتى يوصل؟', null, null],
    ['other', '[image]', null, null],
  ]);
  assert.ok(ev.every((e) => e.type === 'message' && e.phone_number_id === '111' && e.from === '201001488462'));
});

test('only WhatsApp "messages" changes are read', () => {
  assert.deepEqual(hook.parseEvents(null), []);
  assert.deepEqual(hook.parseEvents({ object: 'page', entry: [] }), []);
  assert.deepEqual(hook.parseEvents(payload({ statuses: [{ id: 'x', status: 'sent' }] }, 'account_update')), []);
});

/* ── settings ──────────────────────────────────────────────────────────────── */

const TOKEN = `EAAG${'x'.repeat(60)}`;

test('settings input: what the owner typed is checked before it is saved', () => {
  const ok = db.cleanSettingsInput({ phone_number_id: ' 106540352242922 ', waba_id: '102290129340398', access_token: ` ${TOKEN} `, app_secret: SECRET_B });
  assert.deepEqual(ok, { phone_number_id: '106540352242922', waba_id: '102290129340398', access_token: TOKEN, app_secret: SECRET_B });

  const bad = (body, existing, re) => assert.throws(() => db.cleanSettingsInput(body, existing), (e) => e.status === 400 && re.test(e.message));
  bad({}, null, /Phone number ID/);
  bad({ phone_number_id: 'abc' }, null, /أرقام بس/);
  bad({ phone_number_id: '106540352242922', waba_id: '12ab' }, null, /Business Account ID/);
  bad({ phone_number_id: '106540352242922', waba_id: '106540352242922', access_token: TOKEN }, null, /رقمين مختلفين/);
  bad({ phone_number_id: '106540352242922' }, null, /الزق التوكن/);
  bad({ phone_number_id: '106540352242922', access_token: 'EAA with spaces in it and more text here' }, null, /التوكن شكله/);
  bad({ phone_number_id: '106540352242922', access_token: TOKEN, app_secret: 'short' }, null, /App secret/);
});

test('an empty token / secret field keeps the saved one', () => {
  const v = db.cleanSettingsInput({ phone_number_id: '106540352242922', access_token: '', app_secret: '' }, { access_token: TOKEN });
  assert.equal(v.access_token, null);
  assert.equal(v.app_secret, null);
  assert.equal(v.waba_id, null);
});

test('the page never receives the token or the app secret', () => {
  const view = db.publicSettings({
    business_id: 1, phone_number_id: '106540352242922', waba_id: '1', access_token: TOKEN, app_secret: SECRET_B,
    verify_token: 'vt', display_phone: '+20 10 0148 8462',
  });
  const json = JSON.stringify(view);
  assert.ok(!json.includes(TOKEN) && !json.includes(SECRET_B));
  assert.equal(view.token_hint, `…${TOKEN.slice(-4)}`);
  assert.equal(view.app_secret_hint, `…${SECRET_B.slice(-4)}`);
  assert.equal(view.configured, true);
  assert.equal(db.publicSettings(null).configured, false);
});

test('delivery status only moves forward; failed is final', () => {
  assert.equal(db.statusMovesForward('sent', 'delivered'), true);
  assert.equal(db.statusMovesForward('delivered', 'read'), true);
  assert.equal(db.statusMovesForward('read', 'delivered'), false);
  assert.equal(db.statusMovesForward('sent', 'failed'), true);
  assert.equal(db.statusMovesForward('failed', 'read'), false);
  assert.equal(db.statusMovesForward('sent', 'sent'), false);
  assert.equal(db.statusMovesForward('sent', 'deleted'), false);
});

/* ── Cloud API client ──────────────────────────────────────────────────────── */

const SETTINGS = { phone_number_id: '106540352242922', access_token: TOKEN };

test('sendTemplate sends the official request shape and returns the message id', async () => {
  let seen = null;
  cloud._setFetchForTests(async (url, opts) => {
    seen = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({
      messaging_product: 'whatsapp', contacts: [{ input: '201001488462', wa_id: '201001488462' }],
      messages: [{ id: 'wamid.HBg', message_status: 'accepted' }] }) };
  });
  const r = await cloud.sendTemplate(SETTINGS, { to: '201001488462', name: 'hello_world', language: 'en_US' });
  assert.deepEqual(r, { wa_id: '201001488462', message_id: 'wamid.HBg', message_status: 'accepted' });
  assert.equal(seen.url, `https://graph.facebook.com/${cloud.VERSION}/106540352242922/messages`);
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(seen.body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '201001488462',
    type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } });
});

test('Meta errors come back as plain Arabic the owner can act on — never with the token', async () => {
  const metaError = (code, message) => async () => ({ ok: false, status: 400,
    text: async () => JSON.stringify({ error: { message, type: 'OAuthException', code, fbtrace_id: 'X' } }) });

  cloud._setFetchForTests(metaError(190, 'Error validating access token'));
  await assert.rejects(cloud.checkPhoneNumber(SETTINGS), (e) => e instanceof cloud.GraphError && e.code === 190 && /التوكن انتهى/.test(e.message) && !e.message.includes(TOKEN));

  cloud._setFetchForTests(metaError(131030, 'Recipient phone number not in allowed list'));
  await assert.rejects(cloud.sendTemplate(SETTINGS, { to: '201001488462', name: 'hello_world', language: 'en_US' }),
    (e) => e.code === 131030 && /قائمة أرقام التجربة/.test(e.message));

  cloud._setFetchForTests(metaError(999999, 'Something new'));
  await assert.rejects(cloud.checkPhoneNumber(SETTINGS), (e) => e.message === 'ميتا ردّت: Something new');

  cloud._setFetchForTests(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(cloud.checkPhoneNumber(SETTINGS), (e) => e.code === 'network');

  cloud._setFetchForTests(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  await assert.rejects(cloud.checkPhoneNumber(SETTINGS), (e) => e.code === 'timeout');

  await assert.rejects(cloud.checkPhoneNumber({ phone_number_id: '1' }), (e) => e.code === 'missing_token');
});

/* ── the webhook route, end to end over HTTP (store stubbed) ───────────────── */

test('webhook: handshake, signature, routing by phone number, 500 on a store error', async () => {
  const express = require('express');
  const calls = { status: [], inbound: [], touched: [] };
  const fakeStore = {
    verifyTokenExists: async (t) => t === 'good-token',
    webhookCandidates: async () => [
      { business_id: 1, phone_number_id: '111', app_secret: SECRET_A },
      { business_id: 2, phone_number_id: '222', app_secret: SECRET_B },
    ],
    applyStatus: async (b, ev) => { calls.status.push([b, ev.wa_message_id, ev.status]); return true; },
    recordInbound: async (b, ev) => { calls.inbound.push([b, ev.wa_message_id, ev.reply]); return true; },
    touchWebhook: async (b) => { calls.touched.push(b); },
  };
  /* swap the store the route uses, then load the route fresh */
  const storePath = require.resolve('./db');
  const realStore = require.cache[storePath].exports;
  require.cache[storePath].exports = fakeStore;
  delete require.cache[require.resolve('../../routes/whatsappWebhook')];
  const router = require('../../routes/whatsappWebhook');
  require.cache[storePath].exports = realStore;

  const app = express();
  app.use('/api/whatsapp/webhook', router);
  app.use(express.json());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const req = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });

  try {
    /* handshake */
    assert.deepEqual(await req('GET', '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=good-token&hub.challenge=1158201444'),
      { status: 200, body: '1158201444' });
    assert.equal((await req('GET', '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1')).status, 403);
    assert.equal((await req('GET', '/api/whatsapp/webhook')).status, 403);

    /* events for both numbers, signed by business 1's app */
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        { id: 'W1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' },
          statuses: [{ id: 'wamid.S1', status: 'read', timestamp: '1764000000' }],
          messages: [{ id: 'wamid.M1', from: '201001488462', timestamp: '1764000001', type: 'button', button: { payload: 'P', text: 'تأكيد' } }] } }] },
        { id: 'W2', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '222' },
          statuses: [{ id: 'wamid.S2', status: 'read', timestamp: '1764000000' }] } }] },
      ],
    });
    const headers = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(Buffer.from(body), SECRET_A) };
    assert.equal((await req('POST', '/api/whatsapp/webhook', body, headers)).status, 200);
    assert.deepEqual(calls.status, [[1, 'wamid.S1', 'read']], "business 2's number is not business 1's to write");
    assert.deepEqual(calls.inbound, [[1, 'wamid.M1', 'تأكيد']]);
    assert.deepEqual(calls.touched, [1]);

    /* unsigned / wrongly signed / not JSON */
    assert.equal((await req('POST', '/api/whatsapp/webhook', body, { 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await req('POST', '/api/whatsapp/webhook', body, { ...headers, 'X-Hub-Signature-256': sign(Buffer.from(body), 'f'.repeat(32)) })).status, 401);
    const notJson = 'hello';
    assert.equal((await req('POST', '/api/whatsapp/webhook', notJson, { 'X-Hub-Signature-256': sign(Buffer.from(notJson), SECRET_A) })).status, 400);

    /* a store error → 500 so Meta retries */
    fakeStore.applyStatus = async () => { throw new Error('db down'); };
    assert.equal((await req('POST', '/api/whatsapp/webhook', body, headers)).status, 500);
  } finally {
    server.close();
  }
});
