/* ══════════════════════════════════════════════════════════════════════════
   Order attribution — which ad platform (and campaign / ad) each order came from.
   Asked for by the owner's video studio (2026-11-22), read through /api/v1.

   What EasyOrder actually gives us (read from its storefront code + 15,789 logged
   webhooks): the store copies ONLY three URL parameters into the order —
     utm_source   → body.utm_source            (Meta ads: fb / ig / th / msg / an)
     utm_campaign → body.utm_campaign          (Meta ads: the campaign id)
     ref          → body.metadata.referral_code
   plus the referring site of the first visit: body.metadata.tracking.referrer
   ('m.facebook.com', 'instagram.com', 'direct', …). utm_medium / utm_content /
   utm_term / fbclid / ttclid / the landing URL stop at EasyOrder and never reach us.

   `ref` is NOT free: it is EasyOrder's «كود الإحالة الخاص بالمسوق» (its «إنشاء
   روابط إحالة» page builds ?ref=<marketer> links "to track sales and commissions",
   and the order page / invoice show it). This store used it for marketers (new /
   pump / Smart, June–August). So the AD id rides inside utm_campaign instead:
       utm_campaign=<campaign id>~<ad id>      e.g. 1790123~1790456
   → utm_campaign = '1790123', ad_ref = '1790456'. `ref` stays the marketer code
   (referral_code). Live campaigns without '~' are read exactly as before.

   Channel (one per order) and channel_source (what decided it):
     tiktok   utm_source mentions tiktok                              → utm
     meta     utm_source fb/ig/th/msg/an/facebook/instagram/…         → utm
     other    any other utm_source (chatgpt.com…), or a campaign but no source → utm
     tiktok   no UTM, a tiktok referrer                               → referrer
     meta     no UTM, a facebook/instagram/threads referrer — 92% of the
              no-UTM orders come from those, so they are Meta traffic → referrer
     organic  no UTM and no ad-platform referrer (direct, the store, google) → none
     unknown  no attribution row at all: orders typed in / imported, or older than
              the logs (it is the default — COALESCE(…, 'unknown'))

   Stored in its own table (order_attribution), never on orders: adding it touches
   no order row, fires no order trigger and changes no "updatedAt".
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const pool = require('../config/db');

const CHANNELS = ['meta', 'tiktok', 'organic', 'other', 'unknown'];
const AD_SEPARATOR = '~';

const DDL = `
  CREATE TABLE IF NOT EXISTS order_attribution (
    order_id       INTEGER     PRIMARY KEY,
    business_id    INTEGER     NOT NULL,
    channel        TEXT        NOT NULL,
    channel_source TEXT        NOT NULL,
    utm_source     TEXT,
    utm_campaign   TEXT,
    ad_ref         TEXT,
    referral_code  TEXT,
    referrer       TEXT,
    origin         TEXT        NOT NULL,
    captured_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS order_attribution_biz_channel_idx ON order_attribution (business_id, channel);
`;

let schemaP = null;
function ensureSchema() {
  if (!schemaP) {
    schemaP = pool.query(DDL).then(() => true).catch((err) => { schemaP = null; throw err; });
  }
  return schemaP;
}
/* Tests run inside a READ ONLY transaction with a TEMP order_attribution table. */
function _markSchemaReadyForTests() { schemaP = Promise.resolve(true); }

const clean = (v) => {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim();
  return s ? s.slice(0, 200) : null;
};

const META_SOURCES = new Set(['fb', 'ig', 'th', 'msg', 'an', 'meta', 'facebook', 'instagram', 'threads', 'messenger']);
const META_HOST    = /(^|\.)(facebook|instagram|threads|messenger)\.(com|net)$|(^|\.)fb\.(com|me)$/;

/* → { channel, channel_source } where channel_source = utm | referrer | none */
function classify({ utm_source, utm_campaign, referrer } = {}) {
  const s = (clean(utm_source) || '').toLowerCase();
  const r = (clean(referrer) || '').toLowerCase();
  if (s) {
    if (s.includes('tiktok')) return { channel: 'tiktok', channel_source: 'utm' };
    if (META_SOURCES.has(s) || /facebook|instagram|threads|messenger/.test(s)) return { channel: 'meta', channel_source: 'utm' };
    return { channel: 'other', channel_source: 'utm' };
  }
  if (r && r !== 'direct') {
    if (r.includes('tiktok')) return { channel: 'tiktok', channel_source: 'referrer' };
    if (META_HOST.test(r)) return { channel: 'meta', channel_source: 'referrer' };
  }
  if (clean(utm_campaign)) return { channel: 'other', channel_source: 'utm' };
  return { channel: 'organic', channel_source: 'none' };
}

/* 'campaign~ad' → { campaign, ad }; no '~' → the whole value is the campaign. */
function splitCampaign(value) {
  const v = clean(value);
  if (!v) return { campaign: null, ad: null };
  const i = v.indexOf(AD_SEPARATOR);
  if (i < 0) return { campaign: v, ad: null };
  return { campaign: clean(v.slice(0, i)), ad: clean(v.slice(i + 1)) };
}

/* An EasyOrder order (webhook body or API order) → the attribution row's fields. */
function fromEasyOrder(order) {
  const o  = order && typeof order === 'object' ? order : {};
  const md = o.metadata && typeof o.metadata === 'object' ? o.metadata : {};
  const tr = md.tracking && typeof md.tracking === 'object' ? md.tracking : {};
  const { campaign, ad } = splitCampaign(o.utm_campaign);
  const a = {
    utm_source:    clean(o.utm_source),
    utm_campaign:  campaign,
    ad_ref:        ad,
    referral_code: clean(md.referral_code),
    referrer:      clean(tr.referrer),
  };
  return { ...a, ...classify(a) };
}

const COLUMNS = ['order_id', 'business_id', 'channel', 'channel_source', 'utm_source', 'utm_campaign', 'ad_ref', 'referral_code', 'referrer', 'origin'];
const INSERT_SQL = `
  INSERT INTO order_attribution (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
  ON CONFLICT (order_id) DO NOTHING`;
const rowValues = (orderId, businessId, a, origin) =>
  [orderId, businessId, a.channel, a.channel_source, a.utm_source, a.utm_campaign, a.ad_ref, a.referral_code, a.referrer, origin];

/* Save a new EasyOrder order's attribution. The webhook calls it WITHOUT awaiting
   and with a .catch — it can never delay or break order creation. */
async function recordEasyOrder(orderId, businessId, order, origin = 'webhook') {
  await ensureSchema();
  const a = fromEasyOrder(order);
  await pool.query(INSERT_SQL, rowValues(orderId, businessId, a, origin));
  return a;
}

/* ?channel= → { ok, channel } (channel null when absent). */
function parseChannel(v) {
  if (v === undefined || v === null || v === '') return { ok: true, channel: null };
  const c = String(v).trim().toLowerCase();
  return CHANNELS.includes(c) ? { ok: true, channel: c } : { ok: false, channel: null };
}

/* SQL predicate "this order is in channel $n" — an order with no row is 'unknown'.
   orderIdExpr: the outer query's order id column (e.g. 'o.id', 'orders.id'). */
const channelPredicate = (orderIdExpr, paramRef) =>
  `COALESCE((SELECT oa.channel FROM order_attribution oa WHERE oa.order_id = ${orderIdExpr}), 'unknown') = ${paramRef}::text`;

module.exports = {
  CHANNELS, AD_SEPARATOR, DDL, COLUMNS, ensureSchema, _markSchemaReadyForTests,
  classify, splitCampaign, fromEasyOrder, rowValues, recordEasyOrder, parseChannel, channelPredicate,
};
