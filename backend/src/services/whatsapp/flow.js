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
/* «تأكيد الطلب» confirms by itself only when nothing needs a person first
   (found on the first live day, 2026-11-27 — every one was a real order):
     reconfirm — the customer had asked for support / to cancel / sent a voice
                 note, and nobody has spoken to them since;
     dup       — the customer has ANOTHER order of ours in play (open, confirmed
                 or on its way): one of the two is probably a duplicate;
     address   — no governorate, or an address too short to deliver to;
     lost      — a «طلب مفقود» (an abandoned checkout, orders.is_lost_order): its
                 total only gets the governorate's shipping when an AGENT
                 completes it, so the amount in our message may be short. The
                 owner's batches no longer message these at all (recontact.js);
                 this covers the 50 that were messaged on 2026-11-26/27.
   Then the order goes to (or stays with) an agent, tagged with the reason. */
const MIN_ADDRESS_CHARS = 10;
function confirmBlocker({ order, flow, otherOrders = 0 }) {
  if (order.is_lost_order === true) return 'lost';
  if (['support', 'cancel', 'voice'].includes(bt(flow?.tag))) return 'reconfirm';
  if (otherOrders > 0) return 'dup';
  if (!bt(order.City) || bt(order.Address).length < MIN_ADDRESS_CHARS) return 'address';
  return null;
}

function decideTap({ action, order, flow = null, otherOrders = 0 }) {
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
    if (isWeak(order)) return { type: 'deposit_needed', tag: 'deposit', release: true, reply: 'deposit' };
    const why = confirmBlocker({ order, flow, otherOrders });
    /* a thin address is the one thing the customer can fix by writing: we ask for it (addressAnswer below) */
    if (why) return { type: 'agent_needed', tag: why, release: true, reply: why === 'address' ? 'address' : 'deposit' };
    return { type: 'confirm', release: true, reply: 'confirmed' };
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
  voice:                'بعت رسالة صوتية',
  reconfirm:            'أكد بعد ما طلب دعم أو إلغاء',
  dup:                  'أكد، وعنده أوردر تاني',
  address:              'أكد، والعنوان ناقص',
  address_in:           'كتب العنوان — راجعيه وأكدي',
  address_done:         'كتب العنوان واتأكد',
  lost:                 'أكد على واتساب — طلب مفقود',
});

/* ── what the customer WROTE ────────────────────────────────────────────────── */

/* Letters and digits only, the way people actually type: no emoji / punctuation /
   tashkeel, أ إ آ → ا, ى → ي, ة → ه, one space between words, lower-case Latin. */
function normText(s) {
  return String(s ?? '').normalize('NFC').toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

/* The button's own words typed by hand count as the tap — ONLY when they are the
   whole message. «تأكيد الطلب بس غيّروا العنوان» is a message for an agent. */
const TYPED = {
  confirm: ['تاكيد الطلب', 'تاكيد', 'اكد', 'اكد الطلب', 'تم التاكيد', 'confirm'],
  cancel:  ['الغاء الطلب', 'الغاء', 'الغي', 'الغي الطلب', 'cancel'],
};
function typedAction(text) {
  const t = normText(text);
  if (!t) return null;
  if (TYPED.confirm.includes(t)) return 'confirm';
  if (TYPED.cancel.includes(t)) return 'cancel';
  return null;
}

/* ── the customer writes the address ────────────────────────────────────────
   «تأكيد» was stopped by a thin address only (tag 'address') and we asked for
   it. A written answer that reads like an address goes into the order; anything
   we are not sure of stays a message for a person. Erring towards "a person
   reads it" is the safe side: a wrong address is a shipment that comes back.

   It reads like an address when it has a word addresses are built from (street,
   building, floor, next to…), is long enough, and has none of the words of a
   question, a change of mind or a request. A phone number inside → a person. */
const ADDRESS_TEXT_MIN = 15;
const ADDRESS_TEXT_MAX = 300;
const ADDRESS_WORDS = new Set([
  'ش', 'شارع', 'عماره', 'عمارات', 'عماير', 'برج', 'ابراج', 'دور', 'شقه', 'بجوار', 'جنب', 'امام', 'قصاد', 'قدام', 'خلف', 'ورا',
  'قريه', 'مركز', 'مدينه', 'حي', 'منطقه', 'مساكن', 'عزبه', 'كفر', 'نجع', 'ميدان', 'طريق', 'محطه', 'موقف', 'مسجد', 'جامع', 'كنيسه',
  'مدرسه', 'صيدليه', 'مستشفي', 'منزل', 'بيت', 'فيلا', 'كوبري', 'بلوك', 'ناصيه', 'نزله', 'مدخل', 'قسم', 'نادي', 'بنك', 'مجاوره',
  'حاره', 'زقاق', 'درب', 'عطفه', 'متفرع', 'تقاطع', 'كمبوند', 'سنتر', 'مول', 'سوق', 'بنزينه', 'مخبز', 'فرن', 'عزب', 'شياخه',
]);
const NOT_ADDRESS_WORDS = new Set([
  'الغاء', 'الغي', 'الغو', 'الغوا', 'الغيه', 'كنسل', 'كام', 'بكام', 'سعر', 'السعر', 'سعره', 'امتي', 'متي', 'ليه', 'ازاي', 'هل', 'ممكن',
  'استفسار', 'اتصل', 'اتصلوا', 'اتصلي', 'كلمني', 'كلموني', 'يكلمني', 'اغير', 'تغيير', 'غيروا', 'غيرو', 'استبدال', 'بدل', 'لون', 'اللون',
  'مقاس', 'المقاس', 'تاجيل', 'اجل', 'اجلوا', 'بكره', 'مش', 'لا', 'مو', 'عايز', 'عاوز', 'عايزه', 'عاوزه', 'اريد', 'محتاج', 'محتاجه',
  'ابعتلي', 'هبعت', 'هبعتلك', 'هبعتلكم', 'لوكيشن', 'اللوكيشن', 'غلط', 'جنيه', 'خصم', 'عرض', 'الساعه', 'مسافر', 'مسافره', 'استلم',
  'هستلم', 'استني', 'استنوا', 'لسه', 'بعدين', 'ضمان', 'اصلي', 'معاينه', 'اعاين', 'افتح', 'مقدم', 'عربون', 'فودافون', 'كاش', 'تحويل',
  'اسعار', 'الاسعار', 'اقل', 'ارخص', 'غالي', 'اغلي', 'ابعت', 'ابعتوا', 'ابعتوه', 'ابعته', 'ابعتهولي', 'وصلوه', 'شكرا',
]);
const latinDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
/* «بالشارع» / «والدور» / «للعماره» are the same words with a letter in front */
const isAddressWord = (w) => ADDRESS_WORDS.has(w) || ADDRESS_WORDS.has(w.replace(/^ال/, ''))
  || (w.length > 4 && ADDRESS_WORDS.has(w.replace(/^[وبلف]/, '').replace(/^ل?ل/, '').replace(/^ال/, '')));
function looksLikeAddress(text) {
  const raw = String(text ?? '');
  if (/[?؟]/.test(raw)) return false;                              // a question
  const t = normText(raw);
  if (t.length < ADDRESS_TEXT_MIN || t.length > ADDRESS_TEXT_MAX) return false;
  if (/\d{9,}/.test(latinDigits(t).replace(/(\d) (?=\d)/g, '$1'))) return false;   // a phone number: a person reads it
  const words = t.split(' ');
  if (words.length < 3) return false;
  if (words.some((w) => NOT_ADDRESS_WORDS.has(w))) return false;
  return words.some(isAddressWord);
}

/* What goes in the address box: the customer's words; what was there before stays
   in front of them unless they already say it (nothing the order had is dropped). */
function mergeAddress(before, text) {
  const next = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, ADDRESS_TEXT_MAX);
  const old = bt(String(before ?? '').replace(/\s+/g, ' '));
  const o = normText(old);
  if (!o || normText(next).includes(o)) return next;
  return `${old} - ${next}`;
}

/** The address the customer just wrote for this order, or null (then it is an ordinary message). */
function addressAnswer({ order, flow, text }) {
  if (bt(flow?.tag) !== 'address') return null;                        // we are not waiting for an address
  if (!isOneOf(TAP_DECIDES, order?.Status)) return null;               // somebody already settled the order
  if (bt(order.Address).length >= MIN_ADDRESS_CHARS) return null;      // somebody already completed the address
  if (isAutoReply(text) || !looksLikeAddress(text)) return null;
  return { address: mergeAddress(order.Address, text) };
}

/* A reply that only says "fine / thanks" — nothing an agent has to act on.
   Every word must be one of these, and there are few of them; an emoji alone
   counts. Anything else (a question, an address, a colour, a date) is NOT an
   acknowledgement, and after a WhatsApp confirmation it sends the order to an
   agent before it ships. Erring towards "needs a human" is the safe side. */
const ACK_WORDS = new Set([
  'تمام', 'تمم', 'شكرا', 'جزيلا', 'لك', 'ليك', 'لكم', 'ليكم', 'اوك', 'اوكي', 'اوكيه', 'ok', 'okay', 'okey',
  'ماشي', 'حاضر', 'تم', 'منتظر', 'منتظرك', 'منتظركم', 'منتظرين', 'في', 'الانتظار', 'انتظاركم', 'انتظارك',
  'ان', 'شاء', 'انشاء', 'الله', 'باذن', 'يبارك', 'فيك', 'فيكم', 'تسلم', 'تسلموا', 'مرسي', 'thanks', 'thank', 'you',
  'يا', 'باشا', 'فندم', 'ربنا', 'يخليك', 'يكرمك', 'الف', 'جميل', 'طيب', 'اه', 'ايوه', 'ايوا', 'نعم', 'yes',
]);
function isAck(text) {
  const t = normText(text);
  if (!t) return true;                                   // an emoji, a sticker caption, punctuation
  const words = t.split(' ');
  return words.length <= 6 && words.every((w) => ACK_WORDS.has(w));
}

/* WhatsApp Business' own greeting / away message, sent by the customer's phone
   the second our message lands — not the customer speaking. It must not count
   as an answer: no tag, no release, and the reminders go on. */
const AUTO_REPLY_MARKS = [
  'شكرا لك علي تواصلك', 'شكرا لتواصلك', 'شكرا علي تواصلك', 'اخبرنا كيف يمكننا', 'كيف يمكننا خدمتك', 'كيف يمكننا مساعدتك',
  'شكرا لك علي رسالتك', 'نحن غير متاحين', 'غير متاحين الان', 'سنرد عليك في اقرب وقت',
  'thank you for contacting', 'thanks for contacting', 'thank you for your message', 'thanks for your message',
  'how can we help', 'let us know how we can help', 'we re unavailable right now', 'we are unavailable right now', 'will respond as soon as possible',
];
function isAutoReply(text) {
  const t = normText(text);
  return !!t && AUTO_REPLY_MARKS.some((m) => t.includes(m));
}

/* A voice note / picture / file in Meta's message object → what to fetch, or null. */
const MEDIA_KINDS = ['audio', 'image', 'video', 'document', 'sticker'];
function mediaOf(raw) {
  const kind = raw && MEDIA_KINDS.includes(raw.type) ? raw.type : null;
  const m = kind ? raw[kind] : null;
  if (!m || !m.id) return null;
  return { kind, id: String(m.id), mime: m.mime_type ? String(m.mime_type) : null };
}

/* Free-form replies inside the 24 h window the tap opens — free, editable, no Meta review. */
function replyText(key, { brand = '' } = {}) {
  const b = cleanParam(brand, 60);
  const team = b ? `فريق ${b}` : 'فريقنا';
  switch (key) {
    case 'confirmed':
      return `تم تأكيد طلبك ✅\nهنجهزه ونسلمه لشركة الشحن، وهيوصلك خلال يومين. المندوب هيتصل بيك قبل ما ييجي، فخلّي تليفونك متاح.${b ? `\nشكرًا لثقتك في ${b} 🙏` : ''}`;
    case 'deposit':
      return `استلمنا تأكيدك ✅\nهيتواصل معاك حد من ${team} قريب عشان نكمّل الطلب.`;
    case 'address':
      return 'استلمنا تأكيدك ✅\nبس العنوان اللي عندنا ناقص، والمندوب مش هيعرف يوصل بيه.\nاكتبلنا هنا العنوان بالتفصيل: المنطقة، الشارع، رقم العمارة والدور، وأقرب علامة مميزة.';
    case 'address_kept':
      return `وصلنا العنوان ✅\nهيتواصل معاك حد من ${team} قريب عشان نكمّل الطلب.`;
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
  normText, typedAction, isAck, isAutoReply, mediaOf, confirmBlocker, MIN_ADDRESS_CHARS,
  looksLikeAddress, mergeAddress, addressAnswer,
};
