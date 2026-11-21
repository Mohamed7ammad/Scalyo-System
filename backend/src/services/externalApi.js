/* ══════════════════════════════════════════════════════════════════════════
   /api/v1 (read-only API for other systems) — pure helpers, no DB, no network.

   The numbers come from the SAME analytics handlers the dashboard uses
   (routes/externalApi.js calls them); this file only reshapes them into a
   stable, documented contract (docs/external-api.md) and repeats the few
   formulas the dashboard computes in the browser, so every figure equals what
   the owner sees on «التحليلات».
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const TZ = 'Africa/Cairo';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ── numbers (rounding exactly like the dashboard: toFixed then parseFloat) ── */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r1  = (v) => parseFloat(num(v).toFixed(1));
const r2  = (v) => parseFloat(num(v).toFixed(2));
const pct = (part, whole) => (num(whole) > 0 ? r1((num(part) / num(whole)) * 100) : null);
const per = (amount, count) => (num(count) > 0 ? r2(num(amount) / num(count)) : null);

/* ── dates (Cairo calendar days, like every dashboard filter) ──────────────── */
function cairoToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/* '2026-02-31' must fail (JS would roll it to March 3). */
function isRealDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'bad_request' });
}

/* ?from=YYYY-MM-DD&to=YYYY-MM-DD (Cairo days, both inclusive).
   Missing to → today; missing from → the last `defaultDays` days up to `to`. */
function parseRange(query = {}, { defaultDays = 30, maxDays = 366, now = new Date() } = {}) {
  const to = query.to === undefined || query.to === '' ? cairoToday(now) : String(query.to);
  if (!isRealDay(to)) throw badRequest('`to` must be a real date: YYYY-MM-DD');
  const from = query.from === undefined || query.from === '' ? addDays(to, -(defaultDays - 1)) : String(query.from);
  if (!isRealDay(from)) throw badRequest('`from` must be a real date: YYYY-MM-DD');
  if (from > to) throw badRequest('`from` is after `to`');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > maxDays) throw badRequest(`Range too long: max ${maxDays} days`);
  return { from, to, days, timezone: TZ };
}

/* Same as routes/analytics.js getEgyptOffset — the offset of a Cairo day
   ('+02:00' winter, '+03:00' summer), so the orders filter uses the exact
   bounds the dashboard uses: [from 00:00:00, to 23:59:59] Cairo time. */
function egyptOffset(day) {
  try {
    const noonUtc = new Date(`${day}T12:00:00.000Z`);
    const cairoHour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(noonUtc), 10);
    const h = cairoHour - 12;
    return `${h >= 0 ? '+' : '-'}${String(Math.abs(h)).padStart(2, '0')}:00`;
  } catch {
    return '+02:00';
  }
}
const dayStart = (day) => `${day}T00:00:00${egyptOffset(day)}`;
const dayEnd   = (day) => `${day}T23:59:59${egyptOffset(day)}`;

/* ── order statuses → stable English groups (statuses stay Arabic too) ─────── */
const STATUS_GROUPS = {
  new:       ['جديد', 'مراجعة جديدة'],
  follow_up: ['لا يرد', 'مؤجل', 'معلق حتي الدفع'],
  confirmed: ['تم التأكيد'],
  shipped:   ['تم الشحن'],
  delivered: ['تم التوصيل'],
  returned:  ['جاري الإعادة', 'تم الإرجاع'],
  rejected:  ['تم الرفض'],
  cancelled: ['ملغي - عدم رد نهائي'],
  closed:    ['مغلق - لن يشحن', 'مغلق - منتج متوقف'],
};
const GROUP_OF = new Map(Object.entries(STATUS_GROUPS).flatMap(([g, list]) => list.map((s) => [s, g])));
const groupOf = (status) => GROUP_OF.get(String(status ?? '').trim()) || 'other';

/* ── /products: one row per catalogue product ─────────────────────────────── */
function mapProducts(rows = [], catalogue = []) {
  const byId = new Map(catalogue.map((p) => [String(p.id), p]));
  return rows.map((r) => {
    const c         = byId.get(String(r.product_id)) || {};
    const orders    = num(r.total_orders);
    const confirmed = num(r.confirmed_orders ?? r.erp_orders);
    const shipped   = num(r.units_shipped);
    const delivered = num(r.units_delivered);
    const adSpend   = num(r.attributed_ad_spend);
    const netProfit = num(r.net_profit);
    return {
      product_id:               String(r.product_id ?? ''),
      name:                     r.product_name ?? '',
      sku:                      r.sku ?? '',
      stopped:                  Boolean(c.stopped_at),
      stock:                    c.stock_quantity == null ? null : num(c.stock_quantity),
      selling_price:            c.selling_price == null ? null : num(c.selling_price),
      cost_price:               num(r.cost_price),
      orders,
      confirmed,
      confirmation_rate:        pct(confirmed, orders),                    // dashboard CR%
      shipped,
      delivered,
      delivery_rate_of_shipped: shipped > 0 ? num(r.delivery_rate) : null, // dashboard DR%
      delivered_of_orders_rate: pct(delivered, orders),                    // dashboard NDR%
      revenue:                  num(r.delivered_revenue),
      refunds:                  num(r.refunds),
      cogs:                     num(r.cogs),
      shipping_cost:            num(r.shipping_cost),
      ad_spend:                 adSpend,
      operating_expenses:       num(r.opex_allocated),
      net_profit:               netProfit,
      profit_before_ads:        r2(netProfit + adSpend),                   // e.g. to subtract TikTok spend yourself
      profit_per_delivered:     per(netProfit, delivered),
      ad_cost_per_order:        per(adSpend, orders),
      meta_purchases:           num(r.meta_orders),
      cost_per_meta_purchase:   r.cpa == null ? null : num(r.cpa),
    };
  });
}

/* ── /summary: the top cards of «التحليلات», all products ─────────────────────
   The browser computes net profit from /dashboard's overview + the products
   list (analytics/page.tsx). For "all products" that is:
     revenue − refunds − Σ product COGS − all expenses (ads + manual)
             − operating expenses − Σ product shipping. */
function mapSummary(dash = {}, productRows = []) {
  const ov        = dash.overview || {};
  const sumOf     = (k) => productRows.reduce((s, p) => s + (Number.isFinite(Number(p[k])) ? Number(p[k]) : 0), 0);
  const cogs      = sumOf('cogs');
  const shipping  = sumOf('shipping_cost');
  const orders    = num(ov.total_orders);
  const confirmed = num(ov.total_confirmed);
  const delivered = num(ov.total_delivered);
  const revenue   = num(ov.total_revenue);
  const refunds   = num(ov.total_refunds);
  const expenses  = num(ov.total_expenses);
  const opex      = num(ov.operating_expenses);
  const metaSpend = num(ov.meta_spend);
  const metaOrd   = num(ov.meta_orders);
  const netProfit = revenue - refunds - cogs - expenses - opex - shipping;

  return {
    orders,
    confirmed,
    delivered,
    rejected:                   num(ov.total_rejected),
    returned:                   num(ov.total_returned),
    pending:                    num(ov.total_pending),
    confirmation_rate:          pct(confirmed, orders),
    delivery_rate_of_confirmed: pct(delivered, confirmed),
    delivered_of_orders_rate:   pct(delivered, orders),
    revenue,
    refunds,
    cogs:                       r2(cogs),
    shipping_cost:              r2(shipping),
    ad_spend:                   metaSpend,
    expenses_total:             expenses,
    operating_expenses:         opex,
    operating_expenses_breakdown: (ov.opex_breakdown || []).map((o) => ({ label: o.label, amount: num(o.amount) })),
    net_profit:                 r2(netProfit),
    profit_before_ads:          r2(netProfit + expenses),
    profit_per_delivered:       per(netProfit, delivered),
    meta_purchases:             metaOrd,
    cost_per_meta_purchase:     per(metaSpend, metaOrd),
    ad_cost_per_delivered:      per(metaSpend, delivered),
    in_transit_now: {
      orders:       num(ov.in_transit_count),
      cash_on_way:  num(ov.outstanding_cash),
    },
    daily: (dash.daily_chart_stats || []).map((d) => ({
      date:           d.date,
      orders:         num(d.erp_orders),
      confirmed:      num(d.confirmed),
      delivered:      num(d.delivered),
      revenue:        num(d.revenue),
      refunds:        num(d.refunds),
      ad_spend:       num(d.ads_spend),
      meta_purchases: num(d.orders),
    })),
    governorates: (dash.governorates_stats || []).map((g) => ({
      governorate: g.governorate,
      orders:      num(g.total_orders),
      confirmed:   num(g.confirmed),
      delivered:   num(g.delivered),
      returned:    num(g.returned),
      revenue:     num(g.revenue),
    })),
    rejection_reasons: (dash.rejection_reasons || []).map((x) => ({ reason: x.reason, count: num(x.count) })),
  };
}

/* ── /orders: one order WITHOUT customer data ─────────────────────────────────
   The SELECT in routes/externalApi.js never reads name, phone, address, notes
   or tracking code; this keeps the output to an explicit whitelist anyway. */
const ORDER_FIELDS = [
  'id', 'source', 'external_order_id', 'status', 'status_group', 'product_name', 'sku',
  'quantity', 'price', 'deposit', 'city', 'created_at', 'created_day', 'shipped_at',
  'delivered_at', 'status_changed_at', 'rejection_reason', 'bosta_rating', 'easyorder_rating',
  'channel', 'channel_basis', 'utm_source', 'utm_campaign', 'ad_ref', 'referrer',
];

function mapOrder(r = {}) {
  const status = String(r.status ?? '').trim();
  const out = {
    id:                Number(r.id),
    source:            r.source || null,
    external_order_id: r.external_order_id || null,
    status,
    status_group:      groupOf(status),
    product_name:      r.product_name == null ? null : String(r.product_name).trim(),
    sku:               r.sku || null,
    quantity:          r.quantity == null ? 1 : num(r.quantity),
    price:             num(r.price),
    deposit:           num(r.deposit),
    city:              r.city ?? null,
    created_at:        r.created_at ?? null,
    created_day:       r.created_day ?? null,
    shipped_at:        r.shipped_at ?? null,
    delivered_at:      r.delivered_at ?? null,
    status_changed_at: r.status_changed_at ?? null,
    rejection_reason:  r.rejection_reason || null,
    bosta_rating:      r.bosta_rating ? String(r.bosta_rating).trim() : null,
    easyorder_rating:  r.easyorder_rating || null,
    /* Which ad platform / campaign / ad (services/attribution.js) */
    channel:           r.channel || 'unknown',
    channel_basis:     r.channel_basis || null,      // utm | referrer | none
    utm_source:        r.utm_source || null,
    utm_campaign:      r.utm_campaign || null,
    ad_ref:            r.ad_ref || null,             // the store link's ?ref= — put the ad id there
    referrer:          r.referrer || null,           // the site of the first visit (m.facebook.com, direct…)
  };
  return Object.fromEntries(ORDER_FIELDS.map((k) => [k, out[k]]));
}

module.exports = {
  TZ, num, r1, r2, pct, per,
  cairoToday, isRealDay, addDays, parseRange, egyptOffset, dayStart, dayEnd, badRequest,
  STATUS_GROUPS, groupOf,
  mapProducts, mapSummary, mapOrder, ORDER_FIELDS,
};
