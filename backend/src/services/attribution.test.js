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
    tiktok: 'tiktok', TikTok: 'tiktok', tiktok_ads: 'tiktok',
    'chatgpt.com': 'other', pump: 'other', google: 'other',
  };
  for (const [s, ch] of Object.entries(cases)) {
    assert.deepEqual(at.classify({ utm_source: s, referrer: 'direct' }), { channel: ch, channel_source: 'utm' }, s);
  }
  assert.equal(at.classify({ utm_source: 'fb', referrer: 'tiktok.com' }).channel, 'meta', 'the UTM beats the referrer');
});

test('no UTM → the first-visit referrer (92% of these come from Facebook / Instagram)', () => {
  for (const r of ['m.facebook.com', 'facebook.com', 'l.facebook.com', 'lm.facebook.com', 'adsmanager.facebook.com',
    'instagram.com', 'l.instagram.com', 'threads.com', 'fb.me', 'messenger.com']) {
    assert.deepEqual(at.classify({ referrer: r }), { channel: 'meta', channel_source: 'referrer' }, r);
  }
  assert.deepEqual(at.classify({ referrer: 'tiktok.com' }), { channel: 'tiktok', channel_source: 'referrer' });
  assert.deepEqual(at.classify({ referrer: 'vm.tiktok.com' }), { channel: 'tiktok', channel_source: 'referrer' });
  for (const r of ['direct', '', null, 'productpulse.store', 'deritna-store.myeasyorders.com',
    'com.google.android.googlequicksearchbox', 'notfacebook.com.evil.io', 'myfacebook.company']) {
    assert.deepEqual(at.classify({ referrer: r }), { channel: 'organic', channel_source: 'none' }, String(r));
  }
});

test('a campaign tag without any source → other (seen once: "ROAS")', () => {
  assert.deepEqual(at.classify({ utm_campaign: 'ROAS', referrer: 'direct' }), { channel: 'other', channel_source: 'utm' });
  assert.equal(at.classify({ utm_campaign: 'ROAS', referrer: 'm.facebook.com' }).channel, 'meta', 'a Meta referrer still wins');
  assert.deepEqual(at.classify({}), { channel: 'organic', channel_source: 'none' });
});

test('the ad id rides in utm_campaign after "~"; ref stays the marketer code', () => {
  assert.deepEqual(at.splitCampaign('1790123~1790456'), { campaign: '1790123', ad: '1790456' });
  assert.deepEqual(at.splitCampaign(' 120254187807170202 '), { campaign: '120254187807170202', ad: null }, 'live campaigns: unchanged');
  assert.deepEqual(at.splitCampaign('~777'), { campaign: null, ad: '777' });
  assert.deepEqual(at.splitCampaign('camp~'), { campaign: 'camp', ad: null });
  assert.deepEqual(at.splitCampaign('a~b~c'), { campaign: 'a', ad: 'b~c' }, 'only the first ~ splits');
  assert.deepEqual(at.splitCampaign(null), { campaign: null, ad: null });

  /* a new TikTok campaign: ?utm_source=tiktok&utm_campaign=__CAMPAIGN_ID__~__CID__ */
  const t = at.fromEasyOrder({ utm_source: 'tiktok', utm_campaign: '1820000000001~1820000000099',
    metadata: { referral_code: 'pump', tracking: { referrer: 'direct' } } });
  assert.deepEqual(t, {
    utm_source: 'tiktok', utm_campaign: '1820000000001', ad_ref: '1820000000099', referral_code: 'pump', referrer: 'direct',
    channel: 'tiktok', channel_source: 'utm',
  });
  assert.equal(at.fromEasyOrder({ utm_campaign: '~5' }).channel, 'organic', 'an ad id alone is not a campaign');
});

test('from a real EasyOrder webhook body (a live Meta campaign — no ~)', () => {
  const body = {
    id: 'f88a2389-3dc1-4240-847f-99300755ab5f', full_name: 'x', phone: '010',
    utm_source: 'fb', utm_campaign: '120254187807170202',
    metadata: {
      '01000000000': { delivery_rate_status: 'completed', rate_result: 'high' },
      referral_code: 'new',
      tracking: { referrer: 'm.facebook.com', orders_count: 0, sessions_count: 1 },
    },
  };
  assert.deepEqual(at.fromEasyOrder(body), {
    utm_source: 'fb', utm_campaign: '120254187807170202', ad_ref: null, referral_code: 'new', referrer: 'm.facebook.com',
    channel: 'meta', channel_source: 'utm',
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

test('row values line up with COLUMNS', () => {
  const a = at.fromEasyOrder({ utm_source: 'fb', utm_campaign: 'c~d', metadata: { referral_code: 'r', tracking: { referrer: 'x.com' } } });
  const v = at.rowValues(5, 1, a, 'webhook');
  assert.equal(v.length, at.COLUMNS.length);
  assert.deepEqual(Object.fromEntries(at.COLUMNS.map((c, i) => [c, v[i]])), {
    order_id: 5, business_id: 1, channel: 'meta', channel_source: 'utm', utm_source: 'fb', utm_campaign: 'c',
    ad_ref: 'd', referral_code: 'r', referrer: 'x.com', origin: 'webhook',
  });
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
