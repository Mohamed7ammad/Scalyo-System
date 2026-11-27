/* ── WhatsApp chat — the agent answers the customer in writing ───────────────
   Day 1 of the live flow (2026-11-27): customers who ANSWER on WhatsApp rarely
   pick up the call that follows (57 answered orders went back to «لا يرد»; of
   those settled, 31 rejected against 16 saved). They want to write, not talk.

   So the conversation shows on the order itself and the agent replies from
   there. Everything goes out from the one business number.

   The owner's rules (2026-11-27):
     · only the agent HOLDING the order replies (and the owner himself);
     · a customer with two orders at two agents: the holder of the newest open
       order replies, the other one reads only;
     · an agent never starts a conversation — Meta allows free text only within
       24 hours of the customer's last message, and we stop a few minutes early.

   Nothing here moves an order: status changes stay with the order row's own
   controls (services/orderStatus.js). The engine keeps handling what the
   customer sends exactly as before. */
'use strict';

const pool  = require('../../config/db');
const store = require('./db');
const media = require('./mediaStore');
const flowStore = require('./flowStore');
const flow  = require('./flow');

const DDL = `
  CREATE TABLE IF NOT EXISTS whatsapp_chat_seen (
    business_id INTEGER      NOT NULL,
    phone       VARCHAR(20)  NOT NULL,
    viewer      VARCHAR(255) NOT NULL,
    seen_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (business_id, phone, viewer)
  );
  CREATE TABLE IF NOT EXISTS whatsapp_quick_replies (
    id            SERIAL       PRIMARY KEY,
    business_id   INTEGER      NOT NULL,
    title         VARCHAR(60)  NOT NULL,
    body          TEXT         NOT NULL,
    category      VARCHAR(30)  NOT NULL DEFAULT 'عام',
    for_tags      TEXT[]       NOT NULL DEFAULT '{}',
    product_match VARCHAR(80),
    sort          INTEGER      NOT NULL DEFAULT 100,
    active        BOOLEAN      NOT NULL DEFAULT TRUE,
    updated_by    VARCHAR(255),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS whatsapp_quick_replies_business_idx ON whatsapp_quick_replies (business_id, sort, id);
  CREATE INDEX IF NOT EXISTS whatsapp_messages_phone_idx ON whatsapp_messages (business_id, phone, created_at DESC);
`;

let schemaP = null;
function ensureSchema() {
  if (!schemaP) {
    schemaP = Promise.all([store.ensureSchema(), flowStore.ensureSchema(), media.ensureSchema()])
      .then(() => pool.query(DDL)).then(() => true)
      .catch((err) => { schemaP = null; throw err; });
  }
  return schemaP;
}
function _markSchemaReadyForTests() { schemaP = Promise.resolve(true); }

const fail = (status, message, code = null) => Object.assign(new Error(message), { status, code });
const bt = (v) => String(v ?? '').trim();
const sameEmail = (a, b) => bt(a) !== '' && bt(a).toLowerCase() === bt(b).toLowerCase();

/* ── the rules (pure) ─────────────────────────────────────────────────────── */

const WINDOW_MS        = 24 * 60 * 60 * 1000;
const WINDOW_MARGIN_MS = 5 * 60 * 1000;      // stop a little before Meta does: a message sent at 23:59 can still be refused
const MAX_TEXT         = 1000;
const PER_MINUTE       = 12;                 // one agent, one minute — a stuck key, not a conversation

/* statuses in which somebody still works the order with the customer */
const CHAT_STATUSES = ['جديد', 'لا يرد', 'مراجعة جديدة', 'مؤجل', 'معلق حتي الدفع', flow.CONFIRMED_STATUS];

/* Free text is allowed until 24 h after the customer's LAST message. */
function windowState(lastInAt, now = new Date()) {
  if (!lastInAt) return { open: false, until: null };
  const until = new Date(new Date(lastInAt).getTime() + WINDOW_MS - WINDOW_MARGIN_MS);
  return { open: now.getTime() < until.getTime(), until };
}

/* One customer, several orders: the holder of the NEWEST order still being worked replies. */
function replyOwner(siblings) {
  const live = (siblings || []).filter((s) => CHAT_STATUSES.includes(bt(s.status)) && bt(s.holder) !== '');
  if (!live.length) return null;
  return live.reduce((a, b) => (Number(b.order_id) > Number(a.order_id) ? b : a));
}

/* May this user write to this customer now, and if not, why (the page shows the reason). */
function access({ user, isAdmin, order, siblings, window, configured = true }) {
  const owner = replyOwner(siblings);
  const base = { reply_order_id: owner ? Number(owner.order_id) : null };
  if (!configured) return { ...base, can_reply: false, why: 'unconfigured' };
  if (!isAdmin) {
    if (!owner) return { ...base, can_reply: false, why: 'closed' };
    if (!sameEmail(owner.holder, user?.email)) {
      /* her own order, but the customer's newer order is with somebody else */
      return { ...base, can_reply: false, why: sameEmail(order?.holder, user?.email) ? 'other_order' : 'not_holder' };
    }
  }
  if (!window.open) return { ...base, can_reply: false, why: window.until ? 'window' : 'never_wrote' };
  return { ...base, can_reply: true, why: null };
}

function cleanText(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw fail(400, 'اكتبي الرسالة الأول');
  if (text.length > MAX_TEXT) throw fail(400, `الرسالة طويلة — أقصى حاجة ${MAX_TEXT} حرف`);
  /* a ready reply the owner has not finished: «[المبلغ]», «[رقم التحويل]» … must never reach a customer */
  if (/\[[^\]\n]{1,60}\]/.test(text)) throw fail(400, 'في جزء بين قوسين [ ] لسه متكتبش — كمّليه قبل الإرسال');
  return text;
}

const OUT_LABEL = { confirm: 'رسالة تأكيد الطلب', reminder: 'رسالة تذكير', reply: 'رد تلقائي من السيستم' };
const RAW_LABEL = { location: 'لوكيشن', contacts: 'جهة اتصال', sticker: 'ملصق', audio: 'رسالة صوتية', image: 'صورة', video: 'فيديو', document: 'ملف', unsupported: 'رسالة غير مدعومة' };

/* A stored row → what the page draws. No phone numbers leave here. */
function shapeMessage(r) {
  const out = r.direction === 'out';
  const m = {
    id: Number(r.id), dir: out ? 'out' : 'in', at: r.created_at, order_id: r.order_id ? Number(r.order_id) : null,
    type: 'text', text: '', status: out ? r.status : null, by: null, tapped: null, media: null,
  };
  if (out) {
    m.by = r.kind === 'chat' ? bt(r.created_by).split('@')[0] || 'موظفة' : 'السيستم';
    if (r.kind === 'chat') m.text = bt(r.body);
    else {
      m.type = 'system';
      m.text = bt(r.body) || OUT_LABEL[r.kind] || 'رسالة من السيستم';
      if (r.kind !== 'reply' && bt(r.body) === '' && m.order_id) m.text += ` (#${m.order_id})`;
      if (r.kind !== 'reply') m.tapped = bt(r.reply) || null;       // the button the customer pressed on it
    }
    if (r.status === 'failed') m.error = true;
    return m;
  }
  if (r.kind === 'button') { m.type = 'tap'; m.text = bt(r.reply); return m; }
  if (r.kind === 'reaction') { m.type = 'reaction'; m.text = bt(r.reply); return m; }
  if (r.media_id) {
    m.type = 'media';
    m.media = { id: Number(r.media_id), kind: r.media_kind, status: r.media_status };
    m.text = bt(r.caption);
    return m;
  }
  if (r.kind === 'text') { m.text = bt(r.body) || bt(r.reply); return m; }
  m.type = 'other';
  m.text = RAW_LABEL[bt(r.raw_type)] || 'رسالة';
  return m;
}

/* The two ready replies that fit this customer best, then the rest stay behind «كل الردود». */
function suggest(replies, { tag = null } = {}, n = 2) {
  if (!tag) return [];
  return (replies || []).filter((r) => (r.for_tags || []).includes(tag)).slice(0, n).map((r) => r.id);
}

const fitsProduct = (reply, product) =>
  !bt(reply.product_match) || bt(product).toLowerCase().includes(bt(reply.product_match).toLowerCase());

/* ── ready replies ────────────────────────────────────────────────────────── */

/* The owner's first list (2026-11-27), written from what customers really asked.
   The ones that state a policy or a figure only he knows start SWITCHED OFF, with
   the open part in [brackets] — cleanText refuses to send brackets. */
const SEED = [
  { title: 'الترحيب', category: 'عام', for_tags: [], active: true,
    body: 'أهلًا بحضرتك، معاك خدمة عملاء {المتجر}. اتفضل، أقدر أساعدك في إيه؟' },
  { title: 'ميعاد التوصيل', category: 'التوصيل', for_tags: [], active: true,
    body: 'الطلب بيوصل خلال يومين من التأكيد، والمندوب بيكلم حضرتك قبل ما ييجي.' },
  { title: 'المندوب يكلمك قبلها', category: 'التوصيل', for_tags: [], active: true,
    body: 'تمام، هنكتب ملاحظة للمندوب يكلم حضرتك قبل ما يتحرك. لو في ميعاد أو يوم يناسبك أكتر قولي عليه.' },
  { title: 'تأجيل ليوم تاني', category: 'التوصيل', for_tags: [], active: true,
    body: 'ولا يهمك. تحب نوصله لحضرتك يوم إيه؟ هنثبته على الميعاد ده.' },
  { title: 'محتاجين العنوان بالتفصيل', category: 'الطلب', for_tags: ['address'], active: true,
    body: 'محتاجين العنوان بالتفصيل عشان المندوب يوصل بسهولة: المحافظة، المنطقة، الشارع، رقم العمارة والدور، وأقرب علامة مميزة.' },
  { title: 'نأكد الطلب؟', category: 'الطلب', for_tags: ['support', 'voice', 'reconfirm', 'dup', 'lost'], active: true,
    body: 'كده كله واضح؟ نأكد الطلب ونجهزه للشحن؟' },
  { title: 'هكلمك دلوقتي', category: 'عام', for_tags: [], active: true,
    body: 'حاضر، هكلم حضرتك دلوقتي. لو الوقت مش مناسب قولي الميعاد اللي يريحك.' },
  { title: 'اتطلب بالغلط', category: 'الطلب', for_tags: [], active: true,
    body: 'تمام يا فندم ولا يهمك، هنلغي الطلب. شكرًا لوقتك.' },
  { title: 'المعاينة قبل الدفع', category: 'السعر والضمان', for_tags: ['cancel', 'support'], active: false,
    body: 'أيوه يا فندم، من حقك تفتح الطرد وتعاين المنتج قدام المندوب قبل ما تدفع. [لو مش عاجبك: هتدفع إيه؟]' },
  { title: 'السعر عالي', category: 'السعر والضمان', for_tags: ['cancel'], active: false,
    body: 'السعر شامل الشحن والمعاينة قبل الدفع، والمنتج [أصلي وعليه ضمان كام؟]. لو لقيته مش زي ما وصفنا مش هتدفع حاجة.' },
  { title: 'أصلي وعليه ضمان', category: 'السعر والضمان', for_tags: [], active: false,
    body: 'المنتج [أصلي؟] ومعاه [ضمان / استبدال خلال كام يوم؟]، وتقدر تعاينه قبل الدفع.' },
  { title: 'تعديل الكمية أو اللون', category: 'الطلب', for_tags: [], active: false,
    body: 'تمام، هنعدّل الطلب. يبقى [الكمية / اللون] والإجمالي [المبلغ] شامل الشحن. نأكد على كده؟' },
  { title: 'طلب المقدم', category: 'الطلب', for_tags: ['deposit'], active: false,
    body: 'عشان نشحن الطلب محتاجين مقدم [المبلغ] على [رقم التحويل والطريقة]. ابعت صورة التحويل هنا وهنأكد الطلب على طول.' },
];

const TAG_KEYS = () => Object.keys(flow.TAGS);

function cleanReply(body = {}) {
  const title = bt(body.title);
  const text  = String(body.body ?? '').replace(/\r\n/g, '\n').trim();
  const category = bt(body.category) || 'عام';
  const product  = bt(body.product_match);
  if (!title) throw fail(400, 'اكتب اسم الرد');
  if (title.length > 60) throw fail(400, 'اسم الرد طويل — أقصى حاجة 60 حرف');
  if (!text) throw fail(400, 'اكتب نص الرد');
  if (text.length > MAX_TEXT) throw fail(400, `نص الرد طويل — أقصى حاجة ${MAX_TEXT} حرف`);
  if (category.length > 30) throw fail(400, 'اسم المجموعة طويل');
  if (product.length > 80) throw fail(400, 'اسم المنتج طويل');
  const tags = Array.isArray(body.for_tags) ? [...new Set(body.for_tags.map(bt))].filter((t) => TAG_KEYS().includes(t)) : [];
  const sort = Number.isInteger(Number(body.sort)) ? Math.max(0, Math.min(9999, Number(body.sort))) : 100;
  const active = body.active !== false;
  /* a reply with an open [part] cannot be switched on: an agent would send it as it is */
  if (active && /\[[^\]\n]{1,60}\]/.test(text)) throw fail(400, 'في جزء بين قوسين [ ] لسه متكتبش — كمّله أو سيب الرد مقفول');
  return { title, body: text, category, for_tags: tags, product_match: product || null, sort, active };
}

const REPLY_COLS = 'id, title, body, category, for_tags, product_match, sort, active, updated_by, updated_at';

const seeded = new Set();              // per process: the count is asked once, not on every open chat
async function seedIfEmpty(businessId) {
  if (seeded.has(businessId)) return;
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM whatsapp_quick_replies WHERE business_id = $1', [businessId]);
  if (n > 0) { seeded.add(businessId); return; }
  let sort = 10;
  for (const s of SEED) {
    await pool.query(
      `INSERT INTO whatsapp_quick_replies (business_id, title, body, category, for_tags, sort, active, updated_by)
       SELECT $1::int, $2::text, $3::text, $4::text, $5::text[], $6::int, $7::boolean, 'system'
        WHERE NOT EXISTS (SELECT 1 FROM whatsapp_quick_replies WHERE business_id = $1::int AND title = $2::text)`,
      [businessId, s.title, s.body, s.category, s.for_tags, sort, s.active]);
    sort += 10;
  }
  seeded.add(businessId);
}

async function listReplies(businessId, { onlyActive = false } = {}) {
  await ensureSchema();
  await seedIfEmpty(businessId);
  const { rows } = await pool.query(
    `SELECT ${REPLY_COLS} FROM whatsapp_quick_replies WHERE business_id = $1 ${onlyActive ? 'AND active' : ''} ORDER BY sort, id`, [businessId]);
  return rows;
}

async function saveReply(businessId, id, body, actor) {
  await ensureSchema();
  const v = cleanReply(body);
  const params = [businessId, v.title, v.body, v.category, v.for_tags, v.product_match, v.sort, v.active, actor];
  if (id) {
    const { rows: [r] } = await pool.query(
      `UPDATE whatsapp_quick_replies SET title = $2, body = $3, category = $4, for_tags = $5::text[], product_match = $6,
              sort = $7, active = $8, updated_by = $9, updated_at = NOW()
        WHERE business_id = $1 AND id = $10 RETURNING ${REPLY_COLS}`, [...params, id]);
    if (!r) throw fail(404, 'الرد ده مش موجود');
    return r;
  }
  const { rows: [r] } = await pool.query(
    `INSERT INTO whatsapp_quick_replies (business_id, title, body, category, for_tags, product_match, sort, active, updated_by)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9) RETURNING ${REPLY_COLS}`, params);
  return r;
}

async function deleteReply(businessId, id) {
  await ensureSchema();
  const { rowCount } = await pool.query('DELETE FROM whatsapp_quick_replies WHERE business_id = $1 AND id = $2', [businessId, id]);
  if (!rowCount) throw fail(404, 'الرد ده مش موجود');
  return true;
}

/* ── the conversation ─────────────────────────────────────────────────────── */

/* The order as the chat needs it, and the customer's WhatsApp number from the flow's own row. */
async function context(businessId, orderId) {
  await ensureSchema();
  const { rows: [r] } = await pool.query(
    `SELECT o.id, btrim(o."Status") AS status, btrim(COALESCE(o."AssignedTo", '')) AS holder, o."FullName" AS name,
            o."ProductName" AS product, o."ProductPrice" AS amount, o.quantity, o."City" AS city, f.tag, f.phone
       FROM orders o JOIN whatsapp_order_flow f ON f.order_id = o.id AND f.business_id = o.business_id
      WHERE o.id = $1 AND o.business_id = $2`, [orderId, businessId]);
  return r || null;
}

async function siblingsOf(businessId, phone) {
  const { rows } = await pool.query(
    `SELECT f.order_id, btrim(o."Status") AS status, btrim(COALESCE(o."AssignedTo", '')) AS holder
       FROM whatsapp_order_flow f JOIN orders o ON o.id = f.order_id AND o.business_id = f.business_id
      WHERE f.business_id = $1 AND f.phone = $2 AND f.created_at > NOW() - INTERVAL '30 days'`, [businessId, phone]);
  return rows;
}

async function messagesOf(businessId, phone, limit = 150) {
  const { rows } = await pool.query(
    `SELECT m.id, m.order_id, m.direction, m.kind, m.status, m.reply, m.created_by, m.created_at,
            COALESCE(m.payload->'text'->>'body', m.payload->>'body') AS body,
            COALESCE(m.payload->'image'->>'caption', m.payload->'video'->>'caption', m.payload->'document'->>'caption') AS caption,
            m.payload->>'type' AS raw_type,
            md.id AS media_id, md.kind AS media_kind, md.status AS media_status
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_media md ON md.business_id = m.business_id AND md.wa_message_id = m.wa_message_id
      WHERE m.business_id = $1 AND m.phone = $2 AND m.kind <> 'test' AND m.created_at > NOW() - INTERVAL '30 days'
      ORDER BY m.created_at DESC, m.id DESC LIMIT $3`, [businessId, phone, limit]);
  return rows.reverse();
}

async function lastInboundAt(businessId, phone) {
  const { rows: [r] } = await pool.query(
    `SELECT MAX(created_at) AS at FROM whatsapp_messages
      WHERE business_id = $1 AND phone = $2 AND direction = 'in' AND created_at > NOW() - INTERVAL '2 days'`, [businessId, phone]);
  return r?.at || null;
}

async function markSeen(businessId, phone, viewer) {
  if (!bt(viewer)) return;
  await pool.query(
    `INSERT INTO whatsapp_chat_seen (business_id, phone, viewer, seen_at) VALUES ($1, $2, lower($3), NOW())
     ON CONFLICT (business_id, phone, viewer) DO UPDATE SET seen_at = NOW()`, [businessId, phone, viewer]);
}

const firstName = (name) => bt(name).split(/\s+/)[0] || '';
const moneyText = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? String(Math.round(n)) : ''; };

/** Everything the chat screen shows for one order. Whether the user may open the
    order was decided by the route. `light` = the open chat asking "anything new?"
    every few seconds: the messages and who may write, nothing else. */
async function thread(businessId, orderId, user, { isAdmin = false, seen = false, brand = '', light = false } = {}) {
  const ctx = await context(businessId, orderId);
  if (!ctx) throw fail(404, 'الأوردر ده ملوش محادثة واتساب', 'NO_CHAT');
  const [rows, siblings, settings, replies] = await Promise.all([
    messagesOf(businessId, ctx.phone), siblingsOf(businessId, ctx.phone),
    light ? null : store.getSettings(businessId), light ? null : listReplies(businessId, { onlyActive: true }),
  ]);
  const lastIn = [...rows].reverse().find((r) => r.direction === 'in');
  const window = windowState(lastIn?.created_at || null);
  const acc = access({ user, isAdmin, order: ctx, siblings, window,
    configured: light ? true : Boolean(settings?.phone_number_id && settings?.access_token) });   // send() checks again
  if (seen && !isAdmin) await markSeen(businessId, ctx.phone, user?.email).catch(() => {});
  const head = {
    order: { id: Number(ctx.id), status: ctx.status, holder: ctx.holder ? ctx.holder.split('@')[0] : null, name: bt(ctx.name),
      product: bt(ctx.product), amount: moneyText(ctx.amount), quantity: ctx.quantity, city: bt(ctx.city), tag: ctx.tag || null },
    messages: rows.map(shapeMessage),
    window: { open: window.open, until: window.until },
    ...acc,
  };
  if (light) return head;
  const mine = replies.filter((r) => fitsProduct(r, ctx.product))
    .map((r) => ({ id: r.id, title: r.title, body: r.body, category: r.category, for_tags: r.for_tags, product: Boolean(bt(r.product_match)) }));
  return {
    ...head,
    replies: mine,
    suggested: suggest(mine, { tag: ctx.tag }),
    vars: { 'العميل': firstName(ctx.name), 'المنتج': bt(ctx.product), 'المبلغ': moneyText(ctx.amount), 'المتجر': bt(brand) },
  };
}

/** The agent's (or the owner's) written answer. Returns the stored message as the page draws it. */
async function send(businessId, orderId, user, body, { isAdmin = false, cloud = require('./cloudApi') } = {}) {
  const text = cleanText(body);
  const ctx = await context(businessId, orderId);
  if (!ctx) throw fail(404, 'الأوردر ده ملوش محادثة واتساب', 'NO_CHAT');
  const [siblings, settings, lastIn] = await Promise.all([
    siblingsOf(businessId, ctx.phone), store.getSettings(businessId), lastInboundAt(businessId, ctx.phone)]);
  const window = windowState(lastIn);
  const acc = access({ user, isAdmin, order: ctx, siblings, window,
    configured: Boolean(settings?.phone_number_id && settings?.access_token) });
  if (!acc.can_reply) throw fail(acc.why === 'window' || acc.why === 'never_wrote' ? 409 : 403, WHY_TEXT[acc.why] || 'مش متاح الرد على العميل ده', acc.why);

  const who = bt(user?.email) || String(user?.id ?? '');
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_messages
      WHERE business_id = $1 AND direction = 'out' AND kind = 'chat' AND created_by = $2 AND created_at > NOW() - INTERVAL '1 minute'`,
    [businessId, who]);
  if (n >= PER_MINUTE) throw fail(429, 'رسايل كتير ورا بعض — استني دقيقة');

  let sent = null;
  let error = null;
  try {
    sent = await cloud.sendText(settings, { to: ctx.phone, body: text });
  } catch (e) {
    if (!(e instanceof cloud.GraphError)) throw e;
    error = e;
  }
  const row = await store.logOutbound({
    businessId, orderId: Number(ctx.id), kind: 'chat', phone: ctx.phone, waMessageId: sent?.message_id || null,
    status: sent ? 'sent' : 'failed', errorCode: Number.isInteger(error?.code) ? error.code : null,
    errorText: error?.metaMessage || error?.message || null, payload: { body: text }, createdBy: who,
  });
  if (error) throw fail(502, error.message || 'ميتا رفضت الرسالة', 'META');
  if (!isAdmin) await markSeen(businessId, ctx.phone, user?.email).catch(() => {});
  console.log(`[whatsapp chat] order #${ctx.id}: ${who} replied (${text.length} chars)`);
  return shapeMessage({ ...row, body: text });
}

const WHY_TEXT = {
  unconfigured: 'رقم الواتساب مش متوصل',
  closed:       'الأوردر مش مع موظفة دلوقتي',
  not_holder:   'الرد للموظفة اللي ماسكة الأوردر بس',
  other_order:  'العميل عنده أوردر أحدث مع موظفة تانية — هي اللي بترد',
  window:       'عدّى 24 ساعة على آخر رسالة من العميل — واتساب مبيسمحش بالكتابة، كلميه تليفون',
  never_wrote:  'العميل مبعتش حاجة على واتساب — مينفعش نبدأ إحنا المحادثة',
};

/* Which of the user's orders have a conversation, and how many customer messages
   she has not opened yet. One light query — the orders list itself is untouched.
   "Unread" only counts the last 24 hours: an older message cannot be answered in
   writing any more (Meta's window), and on the day this went live nobody should
   open the page to a week of old messages marked new. */
async function inbox(businessId, user, { all = false } = {}) {
  await ensureSchema();
  const viewer = bt(user?.email).toLowerCase();
  if (!all && !viewer) return [];
  const { rows } = await pool.query(
    `SELECT f.order_id,
            ${all ? '0' : `COUNT(m.id) FILTER (WHERE m.created_at > NOW() - INTERVAL '24 hours'
                                           AND m.created_at > COALESCE(s.seen_at, '-infinity'::timestamptz))::int`} AS unread,
            MAX(m.created_at) AS last_in_at, MAX(o."FullName") AS name, MAX(f.tag) AS tag
       FROM whatsapp_order_flow f
       JOIN orders o ON o.id = f.order_id AND o.business_id = f.business_id
       JOIN whatsapp_messages m ON m.business_id = f.business_id AND m.phone = f.phone AND m.direction = 'in'
                               AND m.created_at > NOW() - INTERVAL '7 days'
       LEFT JOIN whatsapp_chat_seen s ON s.business_id = f.business_id AND s.phone = f.phone AND s.viewer = $2::text
      WHERE f.business_id = $1 AND f.customer_replied AND f.created_at > NOW() - INTERVAL '14 days'
        AND btrim(o."Status") = ANY($3::text[])
        ${all ? '' : `AND lower(btrim(COALESCE(o."AssignedTo", ''))) = $2::text`}
      GROUP BY f.order_id
      ORDER BY MAX(m.created_at) DESC
      LIMIT 400`, [businessId, viewer, CHAT_STATUSES]);
  return rows.map((r) => ({ order_id: Number(r.order_id), unread: Number(r.unread) || 0, last_in_at: r.last_in_at,
    name: firstName(r.name), tag: r.tag || null }));
}

module.exports = {
  DDL, ensureSchema, _markSchemaReadyForTests, WINDOW_MS, WINDOW_MARGIN_MS, MAX_TEXT, PER_MINUTE, CHAT_STATUSES, SEED, WHY_TEXT,
  windowState, replyOwner, access, cleanText, shapeMessage, suggest, fitsProduct, cleanReply,
  listReplies, saveReply, deleteReply, context, thread, send, inbox, markSeen,
};
