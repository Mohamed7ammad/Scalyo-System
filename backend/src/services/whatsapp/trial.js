/* ── WhatsApp — the trial report (WhatsApp group vs control group) ────────────
   While the flow is live with a control group (flow.trialGroup: last digit of
   the customer's number 8 or 9 → the agents alone, about 20%; 0–7 → WhatsApp),
   this compares the two groups on the orders placed since it went live.

   Every order is counted in the half its CUSTOMER belongs to, whatever happened
   to it afterwards — an order of the WhatsApp half that got no message (daily
   limit, a failed send) still counts there. That is what keeps the comparison
   honest: the halves differ by one thing only, which half they were dealt.

   The number that matters is delivered ÷ orders, and it is only final once the
   shipments have landed — `open` and `in_transit` say how much is still moving. */
'use strict';

const pool  = require('../../config/db');
const flow  = require('./flow');
const flows = require('./flowStore');
const { whatsappNumber } = require('../../utils/phone');

const CONFIRMED  = ['تم التأكيد', 'تم الشحن', 'تم التوصيل', 'جاري الإعادة', 'تم الإرجاع', 'مغلق - لن يشحن'];
const RETURNED   = ['تم الإرجاع', 'جاري الإعادة'];
const NO_ANSWER  = ['لا يرد', 'مراجعة جديدة', 'ملغي - عدم رد نهائي'];
const bt = (s) => String(s ?? '').trim();

const emptyGroup = () => ({ orders: 0, confirmed: 0, wa_confirmed: 0, rejected: 0, no_answer: 0, open: 0,
  shipped: 0, in_transit: 0, delivered: 0, returned: 0 });

/** Pure: rows of { Phone, Status, confirmed_via } → the two halves. */
function summarize(rows) {
  const out = { wa: emptyGroup(), control: emptyGroup(), no_mobile: 0 };
  for (const o of rows) {
    const phone = whatsappNumber(o.Phone);
    if (!phone) { out.no_mobile += 1; continue; }            // never eligible for WhatsApp → in neither half
    const g = out[flow.trialGroup(phone)];
    const st = bt(o.Status);
    g.orders += 1;
    if (CONFIRMED.includes(st)) {
      g.confirmed += 1;
      if (bt(o.confirmed_via) === 'whatsapp') g.wa_confirmed += 1;
      if (st === 'تم التوصيل') g.delivered += 1;
      else if (RETURNED.includes(st)) g.returned += 1;
      else if (st === 'تم الشحن') g.in_transit += 1;
      if (st === 'تم التوصيل' || st === 'تم الشحن' || RETURNED.includes(st)) g.shipped += 1;
    } else if (st === 'تم الرفض') g.rejected += 1;
    else if (NO_ANSWER.includes(st)) g.no_answer += 1;
    else g.open += 1;
  }
  return out;
}

/** The comparison since the flow went live (null when it never did). */
async function report(businessId) {
  const auto = await flows.getAuto(businessId);
  if (!auto.live_since) return { started: false };
  const { rows } = await pool.query(
    `SELECT o."Phone", o."Status", to_jsonb(o) ->> 'confirmed_via' AS confirmed_via
       FROM orders o
      WHERE o.business_id = $1 AND o.order_source = 'easyorder'
        AND o."createdAt" >= ($2::timestamptz AT TIME ZONE 'UTC')
        AND ($3::timestamptz IS NULL OR o."createdAt" <= ($3::timestamptz AT TIME ZONE 'UTC'))
      ORDER BY o.id LIMIT 30000`,
    [businessId, auto.live_since, auto.live_until]);
  return {
    started: true, live: auto.auto_mode === 'on', control_half: auto.control_half,
    since: auto.live_since, until: auto.live_until, ...summarize(rows),
  };
}

module.exports = { summarize, report };
