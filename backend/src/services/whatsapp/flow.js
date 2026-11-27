/* ── WhatsApp order confirmation — the rules (roadmap step 6) ─────────────────
   Everything the owner decided on 2026-11-25, as pure functions: what goes in
   the message, when it is sent, how long the order is held away from the
   agents, when reminders go, and what a customer's tap does to the order.
   No I/O here — the worker and the webhook call these and do the writing.

   The rules in one place:
     • confirmation goes `send_delay_min` after the order (5; trial group B: 20),
       at any hour;
     • the order is held (status «بانتظار واتساب», no agent) for `hold_min` (30)
       FROM THE SEND, day and night — released at once when the number has no
       WhatsApp, or the customer taps «إلغاء الطلب» / «طلب الدعم» / writes;
     • reminders: +2 h and +24 h, only while the order is still open and the
       customer never answered; nothing between 00:00 and 10:00 Cairo (moved to
       10:00); at most 3 messages per order;
     • «تأكيد الطلب» → «تم التأكيد», holder «واتساب», no commission — unless
       Bosta rates the customer «ضعيف»: then an agent collects a deposit first
       (and she, not WhatsApp, is the one who confirms and earns);
     • whoever makes the FINAL confirmation owns the order. */
'use strict';

const HOLD_STATUS      = 'بانتظار واتساب';
const NEW_STATUS       = 'جديد';
const CONFIRMED_STATUS = 'تم التأكيد';

/* Statuses in which the customer's own tap still decides the order. Once an
   agent has spoken to them («مؤجل», «معلق حتي الدفع», rejected, …) it doesn't. */
const TAP_DECIDES   = [HOLD_STATUS, NEW_STATUS, 'لا يرد', 'مراجعة جديدة'];
/* Reminders only chase an order nobody has settled yet. */
const REMINDABLE    = [HOLD_STATUS, NEW_STATUS, 'لا يرد', 'مراجعة جديدة'];
const COMMITTED     = [CONFIRMED_STATUS, 'تم الشحن', 'تم التوصيل', 'مغلق - لن يشحن'];

const DEFAULTS = Object.freeze({
  send_delay_min:     5,
  send_delay_b_min:   20,     // trial group B
  hold_min:           30,
  reminder1_min:      120,
  reminder2_min:      24 * 60,
  quiet_from_hour:    0,      // Cairo
  quiet_until_hour:   10,
  max_messages:       3,
});

/* Meta counts the CUSTOMERS we open a conversation with in any 24 hours, per
   business portfolio, and says which tier the account is on
   (whatsapp_business_manager_messaging_limit — read from Meta and stored, never
   assumed: this account turned out to be TIER_2K, not the 250 of a new one).
   New orders stop a little short of it; the owner's batches to old «لا يرد»
   orders stop earlier, and earlier still while the flow is live, so the day's
   new orders always have room. Unknown tier → the smallest real one, 250. */
const TIER_CUSTOMERS = { TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: 1000000 };
function dailyLimits(tier) {
  const key = String(tier ?? '').trim().toUpperCase();
  const meta = TIER_CUSTOMERS[key] || 250;
  return {
    tier: TIER_CUSTOMERS[key] ? key : null,
    meta,
    new_orders:     Math.floor(meta * 0.95),
    recontact:      Math.floor(meta * 0.85),
    recontact_live: Math.floor(meta * 0.6),
  };
}

const bt = (s) => String(s ?? '').replace(/^ +| +$/g, '');
const isOneOf = (list, status) => list.includes(bt(status));

/* ── what goes in the message ───────────────────────────────────────────────── */

/* Meta refuses a parameter with a newline, a tab, or more than 4 spaces in a row. */
function cleanParam(value, max = 200) {
  const s = String(value ?? '').replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/* "1210" / "1,210.00 EGP" / 1210.5 → "1,210" / "1,210.5". Null when there is no real amount. */
function formatAmount(raw) {
  const n = parseFloat(String(raw ?? '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/* What the customer pays at the door: the order total minus any deposit (same as the courier's COD). */
function amountDue(order) {
  const total = parseFloat(String(order.ProductPrice ?? '').replace(/[^0-9.]/g, '')) || 0;
  const deposit = Math.max(0, parseFloat(order.depositAmount) || 0);
  return Math.max(0, total - deposit);
}

/** The values for {{1}}… of each template, or the reason the order can't be messaged. */
function messageParams(order) {
  const amount = formatAmount(amountDue(order));
  const product = cleanParam(order.ProductName, 120);
  if (!amount) return { ok: false, reason: 'no_amount' };
  if (!product) return { ok: false, reason: 'no_product' };
  const name = cleanParam(order.FullName, 60) || 'عميلنا العزيز';
  const qty = String(Math.max(1, parseInt(order.quantity, 10) || 1));
  const city = cleanParam(order.City, 60);
  const addr = cleanParam(order.Address, 220);
  const address = cleanParam([city, addr].filter(Boolean).join('، '), 260) || 'غير مكتوب — دوس «طلب الدعم» عشان نكمّله';
  return { ok: true, confirm: [name, product, qty, amount, address], reminder: [name, product, amount] };
}

/* A tap comes back with the payload we attached to that button. */
const PAYLOAD_RE = /^wa1:(confirm|cancel|support):(\d{1,12})$/;
const buttonPayload = (action, orderId) => `wa1:${action}:${orderId}`;
function parsePayload(payload) {
  const m = PAYLOAD_RE.exec(String(payload ?? ''));
  return m ? { action: m[1], orderId: Number(m[2]) } : null;
}

/** The `components` of a template send: body values + one payload per button. */
function templateComponents(kind, order) {
  const p = messageParams(order);
  if (!p.ok) return p;
  const actions = kind === 'reminder' ? ['confirm', 'cancel'] : ['confirm', 'cancel', 'support'];
  const values = kind === 'reminder' ? p.reminder : p.confirm;
  return {
    ok: true,
    components: [
      { type: 'body', parameters: values.map((text) => ({ type: 'text', text })) },
      ...actions.map((a, i) => ({
        type: 'button', sub_type: 'quick_reply', index: String(i),
        parameters: [{ type: 'payload', payload: buttonPayload(a, order.id) }],
      })),
    ],
  };
}

/* ── when ───────────────────────────────────────────────────────────────────── */

const cairoParts = (date) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const get = (t) => Number(p.find((x) => x.type === t).value);
  return { hour: get('hour') % 24, minute: get('minute'), second: get('second') };
};

/** The same moment, or 10:00 Cairo if it falls in the quiet hours (00:00–10:00). */
function outsideQuietHours(date, cfg = DEFAULTS) {
  let d = new Date(date);
  for (let i = 0; i < 3; i++) {                       // a second pass covers a clock change in between
    const c = cairoParts(d);
    if (!(c.hour >= cfg.quiet_from_hour && c.hour < cfg.quiet_until_hour)) return d;
    const wait = ((cfg.quiet_until_hour - c.hour) * 60 - c.minute) * 60 - c.second;
    d = new Date(d.getTime() + wait * 1000);
  }
  return d;
}

const addMin = (date, min) => new Date(new Date(date).getTime() + min * 60000);

/* Trial: even order ids → group A (5 min), odd → group B (20 min). Stable per order. */
const variantOf = (orderId, split) => (split && Number(orderId) % 2 === 1 ? 'B' : 'A');
function sendAt(createdAt, variant, cfg = DEFAULTS) {
  return addMin(createdAt, variant === 'B' ? cfg.send_delay_b_min : cfg.send_delay_min);
}

/** Everything that follows a confirmation that was really sent at `sentAt`. */
function scheduleAfterSend(sentAt, cfg = DEFAULTS) {
  return {
    hold_until:   addMin(sentAt, cfg.hold_min),
    reminder1_at: outsideQuietHours(addMin(sentAt, cfg.reminder1_min), cfg),
    reminder2_at: outsideQuietHours(addMin(sentAt, cfg.reminder2_min), cfg),
  };
}

/* ── what a tap does ────────────────────────────────────────────────────────── */

/* Who needs a deposit before WhatsApp may confirm them.
   Bosta's «ضعيف» always. But Bosta rates only ~30% of new orders in their first
   day (about 15 lookups per 4 hours), while EasyOrder rates ~100% within
   minutes — so when Bosta has NO opinion («بدون» / «جديد» / empty), EasyOrder's
   «low» counts too (measured 2026-11-26: 58% of EasyOrder-«low» customers are
   Bosta-«ضعيف»). A Bosta «ممتاز» / «متوسط» is never overruled. */
const BOSTA_NO_OPINION = ['', 'بدون', 'جديد'];
const WEAK_FROM_EASYORDER = true;
const isWeak = (order) => {
  const bosta = bt(order.DeliveryRate);
  if (bosta === 'ضعيف') return true;
  return WEAK_FROM_EASYORDER && BOSTA_NO_OPINION.includes(bosta)
    && bt(order.easyorder_rate).toLowerCase() === 'low';
};

/* The first live week keeps a CONTROL group: about one customer in five is
   handled by the agents exactly as before, so the two groups can be compared
   on delivery (owner, 2026-11-27: 80/20 — use the feature on most orders, keep
   a yardstick). The split is by the customer number itself — last digit 8 or 9
   → the agents (measured: 19.1% of orders, over 7 and over 30 days), 0–7 →
   WhatsApp — so one customer is always in the same group, whatever they order.
   (The setting is still called control_half: it only means "keep a control".) */
const CONTROL_DIGITS = ['8', '9'];
const trialGroup = (waPhone) => (CONTROL_DIGITS.includes(String(waPhone ?? '').slice(-1)) ? 'control' : 'wa');

/**
 * The customer tapped a button (or wrote). Returns what to do:
 *   confirm          → «تم التأكيد», holder «واتساب», no commission
 *   deposit_needed   → to an agent, tagged «أكد على واتساب، محتاج عربون»
 *   cancel_requested → to an agent, tagged «عايز يلغي»
 *   support_requested→ to an agent, tagged «طلب الدعم» (free text lands here too)
 *   already_confirmed→ nothing changes (the order is confirmed / shipped / delivered)
 *   reopened         → «إلغاء» / «طلب الدعم» AFTER WhatsApp confirmed it, before it
 *                      shipped: back to «جديد» with an agent, so it cannot ship first
 *   closed_interest  → nothing changes, but an agent is told the customer came back
 * `release` = the order must leave the hold now; `reply` = which auto-reply to send.
 */
function decideTap({ action, order }) {
  const status = bt(order.Status);
  if (isOneOf(COMMITTED, status)) {
    if (action === 'confirm') return { type: 'already_confirmed', release: false, reply: 'already_confirmed' };
    /* WhatsApp itself confirmed it and it has not shipped: NOBODY holds the order,
       so a tag alone would be seen by no one and it would ship against the
       customer's word. It goes back to an agent first (engine.reopenForAgent). */
    if (status === CONFIRMED_STATUS && bt(order.confirmed_via) === 'whatsapp') {
      return action === 'cancel'
        /* tag «عايز يلغي», not «داس إلغاء بعد التأكيد»: once it is «جديد» again that is what the agent must read */
        ? { type: 'reopened', outcome: 'cancel_requested', tag: 'cancel', release: false, reopen: true, reply: 'cancel' }
        : { type: 'reopened', outcome: 'support_requested', tag: 'support', release: false, reopen: true, reply: 'support' };
    }
    return { type: 'closed_interest', tag: action === 'cancel' ? 'cancel_after_confirm' : 'support', release: false, reply: 'support' };
  }
  if (!isOneOf(TAP_DECIDES, status)) {
    /* an agent already settled it (rejected, postponed, waiting for payment, cancelled…) */
    return { type: 'closed_interest', tag: action === 'confirm' ? 'confirm_after_close' : 'support', release: false,
      reply: action === 'cancel' ? 'cancel' : 'support' };
  }
  if (action === 'confirm') {
    return isWeak(order)
      ? { type: 'deposit_needed', tag: 'deposit', release: true, reply: 'deposit' }
      : { type: 'confirm', release: true, reply: 'confirmed' };
  }
  if (action === 'cancel') return { type: 'cancel_requested', tag: 'cancel', release: true, reply: 'cancel' };
  return { type: 'support_requested', tag: 'support', release: true, reply: 'support' };
}

/* What the agent sees on the order. */
const TAGS = Object.freeze({
  deposit:              'أكد على واتساب، محتاج عربون',
  cancel:               'عايز يلغي',
  support:              'طلب الدعم',
  confirm_after_close:  'داس «تأكيد» بعد ما الأوردر اتقفل',
  cancel_after_confirm: 'داس «إلغاء» بعد التأكيد',
});

/* Free-form replies inside the 24 h window the tap opens — free, editable, no Meta review. */
function replyText(key, { brand = '' } = {}) {
  const b = cleanParam(brand, 60);
  const team = b ? `فريق ${b}` : 'فريقنا';
  switch (key) {
    case 'confirmed':
      return `تم تأكيد طلبك ✅\nهنجهزه ونسلمه لشركة الشحن، وهيوصلك خلال يومين. المندوب هيتصل بيك قبل ما ييجي، فخلّي تليفونك متاح.${b ? `\nشكرًا لثقتك في ${b} 🙏` : ''}`;
    case 'deposit':
      return `استلمنا تأكيدك ✅\nهيتواصل معاك حد من ${team} قريب عشان نكمّل الطلب.`;
    case 'cancel':
      return 'وصلنا طلب الإلغاء.\nلو فيه حاجة نقدر نساعدك فيها (السعر، ميعاد التوصيل، أو أي استفسار) اكتبهالنا هنا، وهيتواصل معاك حد من فريقنا.';
    case 'support':
      return `تمام 👍 حد من ${team} هيكلمك في أقرب وقت.\nلو حابب، اكتب استفسارك أو التعديل اللي عايزه هنا، عشان نجهّزه قبل المكالمة.`;
    case 'text':
      return 'وصلتنا رسالتك، وهيرد عليك حد من فريقنا في أقرب وقت.';
    case 'already_confirmed':
      return 'طلبك متأكد عندنا بالفعل ✅ وهيوصلك في ميعاده.';
    default:
      return null;
  }
}

/** May a reminder still go for this order? */
function canRemind({ order, flow, cfg = DEFAULTS }) {
  if (!isOneOf(REMINDABLE, order.Status)) return false;
  if (flow.customer_replied) return false;
  return (flow.messages_sent || 0) < cfg.max_messages;
}

module.exports = {
  HOLD_STATUS, NEW_STATUS, CONFIRMED_STATUS, TAP_DECIDES, REMINDABLE, COMMITTED, DEFAULTS, TAGS,
  cleanParam, formatAmount, amountDue, messageParams, buttonPayload, parsePayload, templateComponents,
  outsideQuietHours, addMin, variantOf, sendAt, scheduleAfterSend, isWeak, trialGroup, dailyLimits, decideTap, replyText, canRemind,
};
