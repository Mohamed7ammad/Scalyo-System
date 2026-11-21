'use strict';

/* Unit tests for services/attribution.js — no database, no network.
   Run: npm test   (from backend/)  or  node --test src/services/attribution.test.js */

const test   = require('node:test');
const assert = require('node:assert/strict');
const at     = require('./attribution');

test('utm_source decides first — every value seen in 15,789 real EasyOrder orders', () => {
  const cases = {
    fb: 'meta', ig: 'meta', th: 'meta', msg: 'meta', an: 'meta',      // Meta {{site_source_name}}
    FB: 'meta', ' Instagram ': 'meta', facebook: 'meta', 'facebook.com': 'meta', threads: 'meta',
    tiktok: 'tiktok', TikTok: 'tiktok', 'tiktok_ads': 'tiktok',
    'chatgpt.com': 'other', pump: 'other', google: 'other',
  };
  for (const [s, ch] of Object.entries(cases)) {
    assert.deepEqual(at.classify({ utm_source: s, referrer: 'direct' }), { channel: ch, basis: 'utm' }, s);
  }
  assert.equal(at.classify({ utm_source: 'fb', referrer: 'tiktok.com' }).channel, 'meta', 'the UTM beats the referrer');
});

test('no UTM → the first-visit referrer (92% of these come from Facebook / Instagram)', () => {
  for (const r of ['m.facebook.com', 'facebook.com', 'l.facebook.com', 'lm.facebook.com', 'adsmanager.facebook.com',
    'instagram.com', 'l.instagram.com', 'threads.com', 'fb.me', 'messenger.com']) {
    assert.deepEqual(at.classify({ referrer: r }), { channel: 'meta', basis: 'referrer' }, r);
  }
  assert.deepEqual(at.classify({ referrer: 'tiktok.com' }), { channel: 'tiktok', basis: 'referrer' });
  assert.deepEqual(at.classify({ referrer: 'vm.tiktok.com' }), { channel: 'tiktok', basis: 'referrer' });
  for (const r of ['direct', '', null, 'productpulse.store', 'deritna-store.myeasyorders.com',
    'com.google.android.googlequicksearchbox', 'notfacebook.com.evil.io', 'myfacebook.company']) {
    assert.deepEqual(at.classify({ referrer: r }), { channel: 'organic', basis: 'none' }, String(r));
  }
});

test('a campaign tag without any source → other (seen once: "ROAS")', () => {
  assert.deepEqual(at.classify({ utm_campaign: 'ROAS', referrer: 'direct' }), { channel: 'other', basis: 'utm' });
  assert.equal(at.classify({ utm_campaign: 'ROAS', referrer: 'm.facebook.com' }).channel, 'meta', 'a Meta referrer still wins');
  assert.deepEqual(at.classify({}), { channel: 'organic', basis: 'none' });
});

test('from a real EasyOrder webhook body', () => {
  const body = {
    id: 'f88a2389-3dc1-4240-847f-99300755ab5f', full_name: 'x', phone: '010',
    utm_source: 'fb', utm_campaign: '120254187807170202',
    metadata: {
      '01000000000': { delivery_rate_status: 'completed', rate_result: 'high' },
      referral_code: 'AD-777',
      tracking: { referrer: 'm.facebook.com', orders_count: 0, sessions_count: 1 },
    },
  };
  assert.deepEqual(at.fromEasyOrder(body), {
    utm_source: 'fb', utm_campaign: '120254187807170202', ad_ref: 'AD-777', referrer: 'm.facebook.com',
    channel: 'meta', basis: 'utm',
  });
  /* the spec's test link: ?utm_source=tiktok&utm_medium=paid&utm_campaign=test&utm_content=test —
     EasyOrder forwards only utm_source + utm_campaign */
  const t = at.fromEasyOrder({ utm_source: 'tiktok', utm_campaign: 'test', metadata: { tracking: { referrer: 'direct' } } });
  assert.equal(t.channel, 'tiktok');
  assert.equal(t.utm_campaign, 'test');
  assert.equal(at.fromEasyOrder(null).channel, 'organic');
  assert.equal(at.fromEasyOrder({ utm_source: { evil: 1 }, metadata: 'x' }).channel, 'organic', 'odd shapes never throw');
  assert.equal(at.fromEasyOrder({ utm_campaign: 'x'.repeat(500) }).utm_campaign.length, 200);
});

test('?channel= parsing and the SQL predicate', () => {
  assert.deepEqual(at.parseChannel(undefined), { ok: true, channel: null });
  assert.deepEqual(at.parseChannel(''), { ok: true, channel: null });
  assert.deepEqual(at.parseChannel(' TikTok '), { ok: true, channel: 'tiktok' });
  for (const c of at.CHANNELS) assert.equal(at.parseChannel(c).channel, c);
  assert.equal(at.parseChannel('snapchat').ok, false);
  assert.equal(at.parseChannel(['meta', 'tiktok']).ok, false);
  assert.equal(at.channelPredicate('o.id', '$7'),
    `COALESCE((SELECT oa.channel FROM order_attribution oa WHERE oa.order_id = o.id), 'unknown') = $7::text`);
});
