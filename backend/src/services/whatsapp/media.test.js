'use strict';

/* Unit tests for fetching a customer's file from Meta. No network: fetch is replaced.
   Run: npm test (from backend/)  or  node --test src/services/whatsapp/media.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');

const cloud = require('./cloudApi');

const SETTINGS = { phone_number_id: '1', access_token: 'SECRET-TOKEN' };
const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const file = (bytes, status = 200) => ({ ok: status < 400, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

function withFetch(handler) {
  const calls = [];
  cloud._setFetchForTests(async (url, opts) => { calls.push({ url: String(url), auth: opts?.headers?.Authorization || null }); return handler(String(url)); });
  return calls;
}

test('a voice note: Meta\'s link is looked up, then the file is downloaded from Meta\'s own host', async () => {
  const bytes = Buffer.from('OggS-voice');
  const calls = withFetch((url) => (url.includes('graph.facebook.com')
    ? json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=9', mime_type: 'audio/ogg', file_size: bytes.length })
    : file(bytes)));
  const r = await cloud.fetchMedia(SETTINGS, '9');
  assert.equal(r.mime, 'audio/ogg');
  assert.equal(r.size, bytes.length);
  assert.equal(r.bytes.toString(), 'OggS-voice');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /^https:\/\/lookaside\.fbsbx\.com\//);
});

test('the token is NEVER sent to a host that is not Meta\'s, whatever the link says', async () => {
  for (const bad of ['https://evil.example.com/x', 'https://fbsbx.com.evil.example/x', 'https://notfacebook.com/x', 'not a url']) {
    const calls = withFetch((url) => (url.includes('graph.facebook.com') ? json({ url: bad, mime_type: 'audio/ogg', file_size: 5 }) : file(Buffer.from('x'))));
    await assert.rejects(() => cloud.fetchMedia(SETTINGS, '9'), (e) => e instanceof cloud.GraphError && e.code === 'bad_media_host', bad);
    assert.equal(calls.length, 1, `only the lookup was made for ${bad}`);
  }
});

test('too large, no link, or a failed download → a GraphError the worker understands', async () => {
  withFetch(() => json({ url: 'https://lookaside.fbsbx.com/f', file_size: 50 * 1024 * 1024 }));
  await assert.rejects(() => cloud.fetchMedia(SETTINGS, '9'), (e) => e.code === 'media_too_large');
  withFetch(() => json({ id: '9' }));
  await assert.rejects(() => cloud.fetchMedia(SETTINGS, '9'), (e) => e.code === 'no_media_url');
  withFetch((url) => (url.includes('graph.facebook.com') ? json({ url: 'https://lookaside.fbsbx.com/f', file_size: 5 }) : file(Buffer.from(''), 404)));
  await assert.rejects(() => cloud.fetchMedia(SETTINGS, '9'), (e) => e.code === 'media_download' && e.httpStatus === 404);
  withFetch(() => json({ error: { message: 'Unsupported get request', code: 100 } }, 400));
  await assert.rejects(() => cloud.fetchMedia(SETTINGS, '9'), (e) => e instanceof cloud.GraphError && e.code === 100);
});
