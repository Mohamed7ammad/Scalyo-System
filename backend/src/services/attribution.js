/* ══════════════════════════════════════════════════════════════════════════
   Order attribution — which ad platform (and campaign / ad) each order came from.
   Asked for by the owner's video studio (2026-11-22), read through /api/v1.

   What EasyOrder actually gives us (read from its storefront code + 15,789 logged
   webhooks): the store copies ONLY three URL parameters into the order —
     utm_source   → body.utm_source        (Meta ads: fb / ig / th / msg / an)
     utm_campaign → body.utm_campaign      (Meta ads: the campaign id)
     ref          → body.metadata.referral_code   ← put the AD id here (ref={{ad.id}})
   plus the referring site of the first visit: body.metadata.tracking.referrer
   ('m.facebook.com', 'instagram.com', 'direct', …). utm_medium / utm_content /
   utm_term / fbclid / ttclid / the landing URL stop at EasyOrder and never reach us.

   Channel (one per order):
     tiktok   utm_source mentions tiktok, else a tiktok referrer
     meta     utm_source fb/ig/th/msg/an/facebook/instagram/threads/messenger,
              else (no utm_source) a facebook/instagram/threads referrer — 92% of
              the orders that arrive without UTM come from those, so they are Meta
              traffic, not organic
     other    a utm_source we don't recognise (chatgpt.com, …) or a campaign tag
              without any source
     organic  no UTM and no ad-platform referrer (direct, the store itself, google)
     unknown  no attribution row at all: orders typed in / imported, or older than
              the logs (it is the default — COALESCE(…, 'unknown'))

   Stored in its own table (order_attribution), never on orders: adding it touches
   no order row, fires no order trigger and changes no "updatedAt".
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const pool = require('../config/db');

const CHANNELS = ['meta', 'tiktok', 'organic', 'other', 'unknown'];

const DDL = `
  CREATE TABLE IF NOT EXISTS order_attribution (
    order_id     INTEGER     PRIMARY KEY,
    business_id  INTEGER     NOT NULL,
    channel      TEXT        NOT NULL,
    basis        TEXT        NOT NULL,
    utm_source   TEXT,
    utm_campaign TEXT,
    ad_ref       TEXT,
    referrer     TEXT,
    origin       TEXT        NOT NULL,
    captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

/* → { channel, basis } where basis = utm | referrer | none */
function classify({ utm_source, utm_campaign, referrer } = {}) {
  const s = (clean(utm_source) || '').toLowerCase();
  const r = (clean(referrer) || '').toLowerCase();
  if (s) {
    if (s.includes('tiktok')) return { channel: 'tiktok', basis: 'utm' };
    if (META_SOURCES.has(s) || /facebook|instagram|threads|messenger/.test(s)) return { channel: 'meta', basis: 'utm' };
    return { channel: 'other', basis: 'utm' };
  }
  if (r && r !== 'direct') {
    if (r.includes('tiktok')) return { channel: 'tiktok', basis: 'referrer' };
    if (META_HOST.test(r)) return { channel: 'meta', basis: 'referrer' };
  }
  if (clean(utm_campaign)) return { channel: 'other', basis: 'utm' };
  return { channel: 'organic', basis: 'none' };
}

/* An EasyOrder order (webhook body or API order) → the attribution row's fields. */
function fromEasyOrder(order) {
  const o  = order && typeof order === 'object' ? order : {};
  const md = o.metadata && typeof o.metadata === 'object' ? o.metadata : {};
  const tr = md.tracking && typeof md.tracking === 'object' ? md.tracking : {};
  const a = {
    utm_source:   clean(o.utm_source),
    utm_campaign: clean(o.utm_campaign),
    ad_ref:       clean(md.referral_code),
    referrer:     clean(tr.referrer),
  };
  return { ...a, ...classify(a) };
}

const INSERT_SQL = `
  INSERT INTO order_attribution
    (order_id, business_id, channel, basis, utm_source, utm_campaign, ad_ref, referrer, origin)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (order_id) DO NOTHING`;

/* Save a new EasyOrder order's attribution. The webhook calls it WITHOUT awaiting
   and with a .catch — it can never delay or break order creation. */
async function recordEasyOrder(orderId, businessId, order, origin = 'webhook') {
  await ensureSchema();
  const a = fromEasyOrder(order);
  await pool.query(INSERT_SQL, [orderId, businessId, a.channel, a.basis, a.utm_source, a.utm_campaign, a.ad_ref, a.referrer, origin]);
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
  CHANNELS, DDL, ensureSchema, _markSchemaReadyForTests,
  classify, fromEasyOrder, recordEasyOrder, parseChannel, channelPredicate,
};
