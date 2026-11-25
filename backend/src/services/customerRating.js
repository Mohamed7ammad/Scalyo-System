'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Customer delivery rating — two sources, shown side by side (owner, 2026-11-20)
   ════════════════════════════════════════════════════════════════════════════
   • Bosta  → orders."DeliveryRate"  (ممتاز / متوسط / ضعيف / جديد, «بدون» = none)
     Bosta allows ~100 ranking lookups a day, then blocks ~24 h (429, errorCode
     4029) — so lookups are BUDGETED (bostaBudget below) and spent on the orders
     that still need a decision, newest first.
   • EasyOrder → orders.easyorder_rate (high / moderate / low / unknown)
     EasyOrder rates every order it receives across many couriers. Not in the
     documented API, but GET /external-apps/orders/:id carries it in
     metadata["<phone>"] = { delivery_rate_status: 'completed', rate_result }.
     It is ready a few minutes after the order is placed.                      */

const EASY_RESULTS = ['high', 'moderate', 'low', 'unknown'];

/* The only orders whose customer is looked up — from EITHER source (owner,
   2026-11-20): new orders and no-answer ones (مراجعة جديدة = a no-answer order
   handed to a review account). A confirmed / closed order is never looked up. */
/* «بانتظار واتساب» = held for the customer's WhatsApp answer (services/whatsapp/flow.js):
   a «ضعيف» rating must be known BEFORE their tap may confirm the order. */
const RATE_STATUSES = ['جديد', 'لا يرد', 'مراجعة جديدة', 'بانتظار واتساب'];

/* EasyOrder rating object from an order (or null if it isn't there yet). */
function easyOrderRateOf(order) {
  const meta = order && typeof order.metadata === 'object' && order.metadata ? order.metadata : {};
  for (const v of Object.values(meta)) {
    if (v && typeof v === 'object' && ('rate_result' in v || 'delivery_rate_status' in v)) {
      const result = String(v.rate_result ?? '').trim().toLowerCase();
      return {
        done: String(v.delivery_rate_status ?? '').toLowerCase() === 'completed' && EASY_RESULTS.includes(result),
        result: EASY_RESULTS.includes(result) ? result : null,
        status: v.delivery_rate_status ?? null,
      };
    }
  }
  return null;
}

/* ── Bosta lookup budget ──────────────────────────────────────────────────────
   Spread ≤ `per24h` lookups over any rolling 24 h (≤ `per4h` per 4 h so the
   whole budget isn't burnt by morning), and after a 429 wait an hour before
   probing again (a probe during the block doesn't extend it). */
function bostaBudget({ calls24h, calls4h, last429At, now = Date.now(), per24h = 90, per4h = 15 }) {
  if (last429At && now - new Date(last429At).getTime() < 60 * 60 * 1000) return { allowed: false, reason: 'blocked' };
  if (calls24h >= per24h) return { allowed: false, reason: 'daily budget' };
  if (calls4h >= per4h) return { allowed: false, reason: '4-hour budget' };
  return { allowed: true, reason: 'ok' };
}

module.exports = { easyOrderRateOf, bostaBudget, EASY_RESULTS, RATE_STATUSES };
