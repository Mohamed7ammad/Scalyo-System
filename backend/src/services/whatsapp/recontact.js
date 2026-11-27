/* ── WhatsApp — one message to OLD «لا يرد» orders (owner's request, 2026-11-26) ──
   The confirmation flow only meets an order the moment it arrives. This lets
   the owner pick a range of days and send the SAME confirmation message, once,
   to the customers of the orders the agents could not reach.

   What it does NOT do: it never holds an order, never moves it, never takes it
   from its agent and never reminds. The order stays «لا يرد» with whoever has
   it; only the customer's own tap changes it (engine.handleTap — the same rules
   as every other order: «تأكيد» → «تم التأكيد» by «واتساب», no commission).

   Who is left out, and why:
     bad_number       — not an Egyptian mobile we are sure of;
     already_messaged — this number got a WhatsApp from us in the last 30 days;
     other_order      — the customer has another order in the last 30 days that
                        somebody already reached (confirmed, shipped, rejected,
                        postponed …) — a second message would only annoy them;
     same_customer    — two «لا يرد» orders from one number: only the newest;
     no_amount        — the order has no product / amount to put in the message;
     control_group    — placed during the half-and-half trial by a customer in
                        the agents-only half: a message would spoil the comparison.
   And never a «طلب مفقود» (orders.is_lost_order — an abandoned checkout): it is
   not an order the customer placed, "we received your order" is not true for
   it, and its total lacks the shipping until an agent completes it. They run
   their own flow, like everywhere else in the system (2026-11-27: the first
   batches DID take 50 of them — that was the bug).

   Meta's limit is on customers per 24 hours (250 for a new account). We stop
   short of it (flow.DEFAULTS) — earlier still while the flow is live — so the
   new orders of the day always have room. */
'use strict';

const pool  = require('../../config/db');
const flow  = require('./flow');
const flows = require('./flowStore');
const { whatsappNumber, whatsappNumbers } = require('../../utils/phone');

const STATUS        = 'لا يرد';
/* Which waiting orders a batch may take:
     no_answer — «لا يرد»: the agents called and nobody answered;
     new       — «جديد»: placed while the flow was not on, nobody has called yet
                 (the order stays with its agent; her call simply comes after the
                 message). A customer who ALSO has an old «لا يرد» order is still
                 messaged about the new one — that is not "somebody reached them". */
const KINDS = {
  no_answer: { status: 'لا يرد', notBusy: ['لا يرد'] },
  new:       { status: 'جديد',   notBusy: ['جديد', 'لا يرد'] },
};
const kindOf = (which) => KINDS[which === 'new' ? 'new' : 'no_answer'];
/* Meta's limit for THIS account (stored from Meta, see flow.dailyLimits); less while the flow is live. */
const limitsOf  = (auto) => flow.dailyLimits(auto?.messaging_limit);
const safeLimit = (auto) => (auto?.auto_mode === 'on' ? limitsOf(auto).recontact_live : limitsOf(auto).recontact);
const MAX_DAYS_BACK = 14;
const MAX_BATCH     = 150;
const PER_MINUTE    = 10;       // gentle: the worker also has the day's new orders to send

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const cairoDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(date);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/** The owner's range, checked: real days, in order, not older than MAX_DAYS_BACK, not in the future. */
function checkRange(from, to, now = new Date()) {
  const f = String(from || ''), t = String(to || '');
  if (!DAY_RE.test(f) || !DAY_RE.test(t) || isNaN(Date.parse(f)) || isNaN(Date.parse(t))) throw badRequest('اختار تاريخ البداية والنهاية');
  if (dayDiff(t, f) < 0) throw badRequest('تاريخ البداية لازم يكون قبل النهاية');
  const today = cairoDay(now);
  if (dayDiff(t, today) > 0) throw badRequest('تاريخ النهاية مينفعش يكون بعد النهارده');
  if (dayDiff(today, f) > MAX_DAYS_BACK) throw badRequest(`أقدم يوم مسموح: من ${MAX_DAYS_BACK} يوم`);
  return { from: f, to: t };
}

/** Pure: which of these «لا يرد» orders (newest first) get a message. */
function pick({ orders, messaged, busy, isControl = () => false }) {
  const chosen = [];
  const skipped = { bad_number: 0, already_messaged: 0, other_order: 0, same_customer: 0, no_amount: 0, control_group: 0 };
  const seen = new Set();
  for (const o of orders) {
    const phone = whatsappNumber(o.Phone);
    if (!phone)              { skipped.bad_number += 1; continue; }
    if (isControl(o, phone)) { skipped.control_group += 1; continue; }
    if (messaged.has(phone)) { skipped.already_messaged += 1; continue; }
    if (busy.has(phone))     { skipped.other_order += 1; continue; }
    if (seen.has(phone))     { skipped.same_customer += 1; continue; }
    if (!flow.messageParams(o).ok) { skipped.no_amount += 1; continue; }
    seen.add(phone);
    chosen.push({ order: o, phone });
  }
  return { chosen, skipped };
}

/** Was this order placed inside the half-and-half trial by an agents-only customer? */
function controlCheck(auto) {
  if (!auto?.control_half || !auto.live_since) return () => false;
  const since = new Date(auto.live_since).getTime();
  const until = auto.live_until ? new Date(auto.live_until).getTime() : Infinity;
  return (o, phone) => {
    const at = new Date(o.created_at).getTime();
    return at >= since && at <= until && flow.trialGroup(phone) === 'control';
  };
}

/* Three reads, one after the other (the production pooler is small). */
async function gather(businessId, { from, to }, auto, which = 'no_answer') {
  await flows.ensureSchema();
  const kind = kindOf(which);
  const { rows: orders } = await pool.query(
    `SELECT o.id, o.business_id, o."FullName", o."Phone", o."ProductName", o.quantity, o."ProductPrice",
            o."City", o."Address", o."Status", o."DeliveryRate", o."depositAmount",
            to_jsonb(o) ->> 'easyorder_rate' AS easyorder_rate,
            (o."createdAt" AT TIME ZONE 'UTC') AS created_at,
            to_char((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS day
       FROM orders o
      WHERE o.business_id = $1 AND btrim(o."Status") = $2
        AND COALESCE(o.is_lost_order, FALSE) = FALSE
        AND o."createdAt" >= $3::date - INTERVAL '1 day' AND o."createdAt" < $4::date + INTERVAL '2 days'
        AND ((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo')::date BETWEEN $3::date AND $4::date
        AND NOT EXISTS (SELECT 1 FROM whatsapp_order_flow f WHERE f.order_id = o.id)
      ORDER BY o."createdAt" DESC, o.id DESC LIMIT 3000`,
    [businessId, kind.status, from, to]);

  const { rows: sent } = await pool.query(
    `SELECT phone FROM whatsapp_order_flow WHERE business_id = $1 AND created_at > NOW() - INTERVAL '30 days'
      UNION
     SELECT phone FROM whatsapp_messages
      WHERE business_id = $1 AND direction = 'out' AND template IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'`,
    [businessId]);

  const { rows: others } = await pool.query(
    `SELECT DISTINCT "Phone" FROM orders
      WHERE business_id = $1 AND "createdAt" > (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days' AND btrim("Status") <> ALL($2::text[])`,
    [businessId, kind.notBusy]);

  const messaged = new Set(sent.map((r) => String(r.phone)));
  const busy = new Set();
  for (const r of others) for (const n of whatsappNumbers(r.Phone)) busy.add(n);
  return { total: orders.length, ...pick({ orders, messaged, busy, isControl: controlCheck(auto) }) };
}

async function room(businessId, auto) {
  const used = await flows.customersMessaged24h(businessId);
  const safe = safeLimit(auto);
  return { limit: limitsOf(auto).meta, safe, used, room: Math.max(0, safe - used) };
}

/** What the owner sees before sending: how many, from which days, who is left out, how much room today. */
async function preview(businessId, range, now = new Date()) {
  const r = checkRange(range.from, range.to, now);
  const which = range.status === 'new' ? 'new' : 'no_answer';
  const auto = await flows.getAuto(businessId);
  const g = await gather(businessId, r, auto, which);
  const byDay = new Map();
  for (const c of g.chosen) byDay.set(c.order.day, (byDay.get(c.order.day) || 0) + 1);
  const cap = await room(businessId, auto);
  const quiet = flow.outsideQuietHours(now);
  return {
    ...r,
    status:   which,
    /* batches wait for the morning unless the owner asks for "now" */
    quiet_until: quiet.getTime() > now.getTime() ? quiet : null,
    found:    g.total,
    eligible: g.chosen.length,
    weak:     g.chosen.filter((c) => flow.isWeak(c.order)).length,
    by_day:   [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, n]) => ({ day, n })),
    skipped:  g.skipped,
    cap,
    max_batch: MAX_BATCH,
    can_send:  Math.min(g.chosen.length, cap.room, MAX_BATCH),
  };
}

let busyQueueing = false;
/** Put `count` of them (newest first) in the worker's queue. Nothing is sent from here. */
async function queue(businessId, { from, to, count, status, send_now }, now = new Date()) {
  const n = parseInt(count, 10);
  if (!Number.isInteger(n) || n < 1) throw badRequest('اكتب عدد العملاء اللي هنبعتلهم');
  if (n > MAX_BATCH) throw badRequest(`أقصى عدد في المرة الواحدة ${MAX_BATCH}`);
  const r = checkRange(from, to, now);
  if (busyQueueing) throw badRequest('فيه دفعة بتتجهز دلوقتي — استنى ثواني');
  busyQueueing = true;
  try {
    const which = status === 'new' ? 'new' : 'no_answer';
    const auto = await flows.getAuto(businessId);
    const g = await gather(businessId, r, auto, which);
    const cap = await room(businessId, auto);
    if (!g.chosen.length) throw badRequest(`مفيش أوردرات «${kindOf(which).status}» ينفع نبعتلها في الأيام دي`);
    if (cap.room < 1) throw badRequest(`وصلنا حد اليوم (${cap.used} عميل في آخر 24 ساعة) — كمّل بكرة`);
    const take = g.chosen.slice(0, Math.min(n, cap.room));
    /* 00:00–10:00 a batch waits for 10:00, unless the owner chose to send now (his rule for
       a fresh order is "at any hour"; a batch of older ones is his call each time) */
    const start = send_now === true ? now : flow.outsideQuietHours(now);
    let queued = 0;
    for (let i = 0; i < take.length; i++) {
      const row = await flows.enroll({
        orderId: take[i].order.id, businessId, phone: take[i].phone, variant: 'A', isTest: false, kind: 'recontact',
        sendAt: flow.addMin(start, Math.floor(i / PER_MINUTE)),
      });
      if (row) queued += 1;
    }
    return { ...r, status: which, queued, asked: n, first_at: start, last_at: flow.addMin(start, Math.floor(Math.max(0, take.length - 1) / PER_MINUTE)) };
  } finally {
    busyQueueing = false;
  }
}

module.exports = { STATUS, KINDS, MAX_DAYS_BACK, MAX_BATCH, PER_MINUTE, checkRange, pick, controlCheck, preview, queue, cairoDay };
