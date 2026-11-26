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
     no_amount        — the order has no product / amount to put in the message.

   Meta's limit is on customers per 24 hours (250 for a new account). We stop at
   SAFE_LIMIT so the new orders of the day always have room. */
'use strict';

const pool  = require('../../config/db');
const flow  = require('./flow');
const flows = require('./flowStore');
const { whatsappNumber, whatsappNumbers } = require('../../utils/phone');

const STATUS        = 'لا يرد';
const DAILY_LIMIT   = 250;      // Meta, new business portfolio — customers in any 24 hours
const SAFE_LIMIT    = 230;
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
function pick({ orders, messaged, busy }) {
  const chosen = [];
  const skipped = { bad_number: 0, already_messaged: 0, other_order: 0, same_customer: 0, no_amount: 0 };
  const seen = new Set();
  for (const o of orders) {
    const phone = whatsappNumber(o.Phone);
    if (!phone)              { skipped.bad_number += 1; continue; }
    if (messaged.has(phone)) { skipped.already_messaged += 1; continue; }
    if (busy.has(phone))     { skipped.other_order += 1; continue; }
    if (seen.has(phone))     { skipped.same_customer += 1; continue; }
    if (!flow.messageParams(o).ok) { skipped.no_amount += 1; continue; }
    seen.add(phone);
    chosen.push({ order: o, phone });
  }
  return { chosen, skipped };
}

/* Three reads, one after the other (the production pooler is small). */
async function gather(businessId, { from, to }) {
  await flows.ensureSchema();
  const { rows: orders } = await pool.query(
    `SELECT o.id, o.business_id, o."FullName", o."Phone", o."ProductName", o.quantity, o."ProductPrice",
            o."City", o."Address", o."Status", o."DeliveryRate", o."depositAmount",
            to_char((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS day
       FROM orders o
      WHERE o.business_id = $1 AND btrim(o."Status") = $2
        AND o."createdAt" >= $3::date - INTERVAL '1 day' AND o."createdAt" < $4::date + INTERVAL '2 days'
        AND ((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo')::date BETWEEN $3::date AND $4::date
        AND NOT EXISTS (SELECT 1 FROM whatsapp_order_flow f WHERE f.order_id = o.id)
      ORDER BY o."createdAt" DESC, o.id DESC LIMIT 3000`,
    [businessId, STATUS, from, to]);

  const { rows: sent } = await pool.query(
    `SELECT phone FROM whatsapp_order_flow WHERE business_id = $1 AND created_at > NOW() - INTERVAL '30 days'
      UNION
     SELECT phone FROM whatsapp_messages
      WHERE business_id = $1 AND direction = 'out' AND template IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'`,
    [businessId]);

  const { rows: others } = await pool.query(
    `SELECT DISTINCT "Phone" FROM orders
      WHERE business_id = $1 AND "createdAt" > (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days' AND btrim("Status") <> $2`,
    [businessId, STATUS]);

  const messaged = new Set(sent.map((r) => String(r.phone)));
  const busy = new Set();
  for (const r of others) for (const n of whatsappNumbers(r.Phone)) busy.add(n);
  return { total: orders.length, ...pick({ orders, messaged, busy }) };
}

async function room(businessId) {
  const used = await flows.customersMessaged24h(businessId);
  return { limit: DAILY_LIMIT, safe: SAFE_LIMIT, used, room: Math.max(0, SAFE_LIMIT - used) };
}

/** What the owner sees before sending: how many, from which days, who is left out, how much room today. */
async function preview(businessId, range, now = new Date()) {
  const r = checkRange(range.from, range.to, now);
  const g = await gather(businessId, r);
  const byDay = new Map();
  for (const c of g.chosen) byDay.set(c.order.day, (byDay.get(c.order.day) || 0) + 1);
  const cap = await room(businessId);
  return {
    ...r,
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
async function queue(businessId, { from, to, count }, now = new Date()) {
  const n = parseInt(count, 10);
  if (!Number.isInteger(n) || n < 1) throw badRequest('اكتب عدد العملاء اللي هنبعتلهم');
  if (n > MAX_BATCH) throw badRequest(`أقصى عدد في المرة الواحدة ${MAX_BATCH}`);
  const r = checkRange(from, to, now);
  if (busyQueueing) throw badRequest('فيه دفعة بتتجهز دلوقتي — استنى ثواني');
  busyQueueing = true;
  try {
    const g = await gather(businessId, r);
    const cap = await room(businessId);
    if (!g.chosen.length) throw badRequest('مفيش أوردرات «لا يرد» ينفع نبعتلها في الأيام دي');
    if (cap.room < 1) throw badRequest(`وصلنا حد اليوم (${cap.used} عميل في آخر 24 ساعة) — كمّل بكرة`);
    const take = g.chosen.slice(0, Math.min(n, cap.room));
    const start = flow.outsideQuietHours(now);
    let queued = 0;
    for (let i = 0; i < take.length; i++) {
      const row = await flows.enroll({
        orderId: take[i].order.id, businessId, phone: take[i].phone, variant: 'A', isTest: false, kind: 'recontact',
        sendAt: flow.addMin(start, Math.floor(i / PER_MINUTE)),
      });
      if (row) queued += 1;
    }
    return { ...r, queued, asked: n, first_at: start, last_at: flow.addMin(start, Math.floor(Math.max(0, take.length - 1) / PER_MINUTE)) };
  } finally {
    busyQueueing = false;
  }
}

module.exports = { STATUS, DAILY_LIMIT, SAFE_LIMIT, MAX_DAYS_BACK, MAX_BATCH, PER_MINUTE, checkRange, pick, preview, queue, cairoDay };
