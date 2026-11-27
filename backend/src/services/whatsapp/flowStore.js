/* ── WhatsApp order confirmation — storage (step 6) ──────────────────────────
   whatsapp_order_flow: one row per order that entered the WhatsApp flow — when
   its message goes, how long it is held, which reminders went, and what the
   customer answered. The ORDER itself (status, holder, stock, money) is only
   ever changed through services/orderStatus.js; this table is the bot's diary.

   States: pending  → message not sent yet (order held, status «بانتظار واتساب»)
           sending  → being sent right now (a crash here never sends twice)
           waiting  → sent, order still held until hold_until
           released → the order went to the agents (see release_reason)
           done     → the customer's tap settled it (see outcome)
   Automation switch lives on whatsapp_settings: auto_mode off | test | on.

   kind: 'new'       → a fresh order, held for WhatsApp (everything above);
         'recontact' → an OLD «لا يرد» order the owner chose to message once
                       (services/whatsapp/recontact.js). It is never held, never
                       reminded and never handed to anyone: pending → sending →
                       released (reason 'recontact') the moment its message goes. */
'use strict';

const pool = require('../../config/db');
const base = require('./db');

const FLOW_DDL = `
  ALTER TABLE whatsapp_settings
    ADD COLUMN IF NOT EXISTS auto_mode   VARCHAR(8) NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS test_phones TEXT[]     NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS split_test  BOOLEAN    NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS control_half BOOLEAN   NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS live_since  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS live_until  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS messaging_limit VARCHAR(24);
  CREATE TABLE IF NOT EXISTS whatsapp_order_flow (
    order_id         INTEGER      PRIMARY KEY,
    business_id      INTEGER      NOT NULL,
    phone            VARCHAR(20)  NOT NULL,
    state            VARCHAR(12)  NOT NULL DEFAULT 'pending',
    variant          CHAR(1)      NOT NULL DEFAULT 'A',
    is_test          BOOLEAN      NOT NULL DEFAULT false,
    send_at          TIMESTAMPTZ  NOT NULL,
    sent_at          TIMESTAMPTZ,
    hold_until       TIMESTAMPTZ,
    reminder1_at     TIMESTAMPTZ,
    reminder2_at     TIMESTAMPTZ,
    reminders_done   SMALLINT     NOT NULL DEFAULT 0,
    messages_sent    SMALLINT     NOT NULL DEFAULT 0,
    customer_replied BOOLEAN      NOT NULL DEFAULT false,
    text_replied     BOOLEAN      NOT NULL DEFAULT false,
    released_at      TIMESTAMPTZ,
    release_reason   VARCHAR(20),
    tag              VARCHAR(24),
    customer_text    TEXT,
    outcome          VARCHAR(20),
    outcome_at       TIMESTAMPTZ,
    last_error       TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
  ALTER TABLE whatsapp_order_flow ADD COLUMN IF NOT EXISTS kind VARCHAR(12) NOT NULL DEFAULT 'new';
  ALTER TABLE whatsapp_order_flow ADD COLUMN IF NOT EXISTS address_before TEXT;
  CREATE INDEX IF NOT EXISTS whatsapp_order_flow_confirmed_idx ON whatsapp_order_flow (outcome_at) WHERE outcome = 'confirmed';
  CREATE INDEX IF NOT EXISTS whatsapp_order_flow_due_idx ON whatsapp_order_flow (state, send_at) WHERE state IN ('pending', 'sending', 'waiting');
  CREATE INDEX IF NOT EXISTS whatsapp_order_flow_phone_idx ON whatsapp_order_flow (business_id, phone, created_at DESC);
  CREATE INDEX IF NOT EXISTS whatsapp_order_flow_recent_idx ON whatsapp_order_flow (business_id, created_at DESC);
`;
/* On the order itself, so the orders list reads them with no join:
     confirmed_via — «واتساب» as the one who confirmed; survives shipping / delivery;
     wa_tag        — what the customer asked for on WhatsApp (a key of flow.TAGS);
     wa_note       — what the customer wrote. */
const ORDERS_COLUMNS = ['confirmed_via', 'wa_tag', 'wa_note'];
const ORDERS_DDL = `ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_via VARCHAR(16),
                                       ADD COLUMN IF NOT EXISTS wa_tag VARCHAR(32),
                                       ADD COLUMN IF NOT EXISTS wa_note TEXT`;

/* Read-only: are the columns there? The orders list asks (ordersColumnsReady)
   before it names them, so it never breaks on a database that lacks them. */
let ordersColumnsOk = false;
const ordersColumnsReady = () => ordersColumnsOk;
async function ordersColumnsExist() {
  if (ordersColumnsOk) return true;
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = ANY($1::text[])`, [ORDERS_COLUMNS]);
  if (r.n === ORDERS_COLUMNS.length) ordersColumnsOk = true;
  return ordersColumnsOk;
}

/* orders is the busiest table: the columns are added ONCE, only if missing,
   on its own connection with a 4-second lock timeout — so it can never queue the
   whole system behind a long query. A failure is retried later; until then a
   WhatsApp confirmation still works, just without the «واتساب» label / the tag. */
let ordersColumnP = null;
function ensureOrdersColumn() {
  if (!ordersColumnP) {
    ordersColumnP = (async () => {
      if (await ordersColumnsExist()) return true;
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '4s'`);
        await c.query(ORDERS_DDL);
        await c.query('COMMIT');
        ordersColumnsOk = true;
        console.log('✅  WhatsApp flow: orders columns ready (confirmed_via, wa_tag, wa_note)');
        return true;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    })().catch((e) => {
      ordersColumnP = null;
      console.warn('⚠️   WhatsApp flow: orders columns not added yet —', e.message);
      return false;
    });
  }
  return ordersColumnP;
}

let schemaP = null;
function ensureSchema() {
  if (!schemaP) {
    schemaP = base.ensureSchema()
      .then(() => pool.query(FLOW_DDL))
      .then(() => { ensureOrdersColumn(); return true; })       // best effort, never blocks the flow
      .catch((err) => { schemaP = null; throw err; });
  }
  return schemaP;
}
/* ordersColumnsOk is NOT set here: only a real look at the database may tell the orders list the columns exist. */
function _markSchemaReadyForTests() { schemaP = Promise.resolve(true); ordersColumnP = Promise.resolve(true); }

const MODES = ['off', 'test', 'on'];
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/* ── the automation switch ────────────────────────────────────────────────── */

async function getAuto(businessId) {
  await ensureSchema();
  const { rows: [r] } = await pool.query(
    `SELECT auto_mode, test_phones, split_test, control_half, live_since, live_until, messaging_limit,
            (phone_number_id IS NOT NULL AND access_token IS NOT NULL AND waba_id IS NOT NULL) AS configured
       FROM whatsapp_settings WHERE business_id = $1`, [businessId]);
  if (!r) return { auto_mode: 'off', test_phones: [], split_test: false, control_half: false, live_since: null, live_until: null, messaging_limit: null, configured: false };
  return { auto_mode: MODES.includes(r.auto_mode) ? r.auto_mode : 'off', test_phones: r.test_phones || [],
    split_test: r.split_test === true, control_half: r.control_half === true,
    live_since: r.live_since || null, live_until: r.live_until || null,
    messaging_limit: r.messaging_limit || null, configured: r.configured === true };
}

/* live_since / live_until bracket the live run (the trial report reads them):
   set on the way INTO «on», closed on the way out. Every SET expression reads
   the row as it was BEFORE this update. */
async function saveAuto(businessId, { auto_mode, test_phones, split_test, control_half }, actor) {
  await ensureSchema();
  if (!MODES.includes(auto_mode)) throw badRequest('وضع التشغيل مش معروف');
  const phones = [...new Set((test_phones || []).map(String))].filter((p) => /^201[0125]\d{8}$/.test(p));
  if (phones.length > 20) throw badRequest('أقصى عدد لأرقام التجربة 20');
  if (auto_mode === 'test' && !phones.length) throw badRequest('اكتب رقم واحد على الأقل للتجربة');
  const { rows: [r] } = await pool.query(
    `UPDATE whatsapp_settings
        SET live_since = CASE WHEN $2 = 'on' AND auto_mode <> 'on' THEN NOW() ELSE live_since END,
            live_until = CASE WHEN $2 = 'on' THEN NULL WHEN auto_mode = 'on' THEN NOW() ELSE live_until END,
            auto_mode = $2, test_phones = $3::text[], split_test = $4, control_half = $6,
            updated_by = $5, updated_at = updated_at
      WHERE business_id = $1 AND phone_number_id IS NOT NULL AND access_token IS NOT NULL
      RETURNING auto_mode, test_phones, split_test, control_half, live_since, live_until`,
    [businessId, auto_mode, phones, split_test === true, actor, control_half === true]);
  if (!r) throw badRequest('احفظ مفاتيح ميتا الأول');
  return r;
}

/* What Meta says about the number right now: its quality (the 2nd reminder stops
   when it drops) and the account's daily limit tier. A null keeps the old value. */
async function saveHealth(businessId, { quality = null, limit = null }) {
  await ensureSchema();
  await pool.query(
    `UPDATE whatsapp_settings
        SET quality_rating = COALESCE($2, quality_rating), messaging_limit = COALESCE($3, messaging_limit), updated_at = updated_at
      WHERE business_id = $1`, [businessId, quality, limit]);
}

/* The accounts worth asking Meta about: one business, or every one whose flow is switched on. */
async function liveSettings(businessId = null) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_settings
      WHERE phone_number_id IS NOT NULL AND access_token IS NOT NULL
        AND (($1::int IS NOT NULL AND business_id = $1) OR ($1::int IS NULL AND auto_mode <> 'off'))`, [businessId]);
  return rows;
}

/* ── one order's diary ────────────────────────────────────────────────────── */

async function enroll({ orderId, businessId, phone, variant, sendAt, isTest, kind = 'new' }) {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_order_flow (order_id, business_id, phone, variant, is_test, send_at, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (order_id) DO NOTHING RETURNING *`,
    [orderId, businessId, phone, variant, isTest === true, sendAt, kind === 'recontact' ? 'recontact' : 'new']);
  return rows[0] || null;
}

async function getByOrder(businessId, orderId) {
  await ensureSchema();
  const { rows: [r] } = await pool.query(
    'SELECT * FROM whatsapp_order_flow WHERE order_id = $1 AND business_id = $2', [orderId, businessId]);
  return r || null;
}

/* The customer wrote instead of tapping: their most recent order in the flow. */
async function latestByPhone(businessId, phone, days = 7) {
  await ensureSchema();
  const { rows: [r] } = await pool.query(
    `SELECT * FROM whatsapp_order_flow
      WHERE business_id = $1 AND phone = $2 AND created_at > NOW() - ($3 || ' days')::interval
      ORDER BY created_at DESC LIMIT 1`, [businessId, phone, String(days)]);
  return r || null;
}

/* ── the worker's queues ──────────────────────────────────────────────────── */

/* pending → sending, atomically: whoever gets the row back is the only sender. */
async function claimDueSends(now, limit = 20) {
  await ensureSchema();
  const { rows } = await pool.query(
    `UPDATE whatsapp_order_flow SET state = 'sending', updated_at = NOW()
      WHERE order_id IN (SELECT order_id FROM whatsapp_order_flow
                          WHERE state = 'pending' AND send_at <= $1
                          ORDER BY send_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [now, limit]);
  return rows;
}

async function markSent(orderId, { sentAt, holdUntil, reminder1At, reminder2At }) {
  await pool.query(
    `UPDATE whatsapp_order_flow
        SET state = 'waiting', sent_at = $2, hold_until = $3, reminder1_at = $4, reminder2_at = $5,
            messages_sent = messages_sent + 1, last_error = NULL, updated_at = NOW()
      WHERE order_id = $1`, [orderId, sentAt, holdUntil, reminder1At, reminder2At]);
}

/* An old «لا يرد» order got its one message: nothing to hold, nothing to remind. */
async function markRecontactSent(orderId, sentAt) {
  await pool.query(
    `UPDATE whatsapp_order_flow
        SET state = 'released', sent_at = $2, released_at = $2, release_reason = 'recontact',
            messages_sent = messages_sent + 1, last_error = NULL, updated_at = NOW()
      WHERE order_id = $1`, [orderId, sentAt]);
}

/* The order left the hold (or never needed it). Keeps `done` rows done. */
async function markReleased(orderId, reason, error = null) {
  const { rows: [r] } = await pool.query(
    `UPDATE whatsapp_order_flow
        SET state = CASE WHEN state = 'done' THEN state ELSE 'released' END,
            released_at = COALESCE(released_at, NOW()), release_reason = COALESCE(release_reason, $2),
            last_error = COALESCE($3, last_error), updated_at = NOW()
      WHERE order_id = $1 RETURNING *`, [orderId, reason, error ? String(error).slice(0, 300) : null]);
  return r || null;
}

async function dueReleases(now, limit = 50) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_order_flow
      WHERE (state = 'waiting' AND hold_until <= $1)
         OR (state = 'sending' AND updated_at <= $1::timestamptz - INTERVAL '10 minutes')
         OR (state = 'pending' AND send_at <= $1::timestamptz - INTERVAL '60 minutes')
      ORDER BY created_at LIMIT $2`, [now, limit]);
  return rows;
}

/* n = 1 | 2. A reminder is due once, in order, for a flow that got its first message. */
async function dueReminders(now, n, limit = 20) {
  await ensureSchema();
  const col = n === 1 ? 'reminder1_at' : 'reminder2_at';
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_order_flow
      WHERE reminders_done = $2 AND sent_at IS NOT NULL AND state IN ('waiting', 'released')
        AND customer_replied = false AND ${col} <= $1
      ORDER BY ${col} LIMIT $3`, [now, n - 1, limit]);
  return rows;
}

/* Whether or not it was sent, reminder n is over — it is never looked at again. */
async function markReminder(orderId, n, sent) {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_order_flow
        SET reminders_done = $2, messages_sent = messages_sent + $3, updated_at = NOW()
      WHERE order_id = $1 AND reminders_done = $2 - 1`, [orderId, n, sent ? 1 : 0]);
  return rowCount > 0;
}

/* ── the customer's answer ────────────────────────────────────────────────── */

async function markReply(orderId, { outcome = null, tag = null, text = null, done = false, textReplied = false }) {
  const { rows: [r] } = await pool.query(
    `UPDATE whatsapp_order_flow
        SET customer_replied = true,
            state         = CASE WHEN $5 THEN 'done' ELSE state END,
            outcome       = COALESCE($2, outcome),
            outcome_at    = CASE WHEN $2::text IS NOT NULL THEN NOW() ELSE outcome_at END,
            tag           = COALESCE($3, tag),
            customer_text = CASE WHEN $4::text IS NULL THEN customer_text
                                 ELSE left(concat_ws(E'\\n', customer_text, $4::text), 1000) END,
            text_replied  = text_replied OR $6,
            updated_at    = NOW()
      WHERE order_id = $1 RETURNING *`,
    [orderId, outcome, tag, text ? String(text).slice(0, 500) : null, done === true, textReplied === true]);
  return r || null;
}

/* What the agent sees on the order row: the tag and what the customer wrote.
   Two display-only columns — status, holder, money and "updatedAt" are not
   touched, so no report or queue moves because of it. */
async function showOnOrder(businessId, orderId, { tag = null, note = null }) {
  if (!tag && !note) return false;
  if (!(await ensureOrdersColumn())) return false;
  const { rowCount } = await pool.query(
    `UPDATE orders SET wa_tag = COALESCE($3, wa_tag), wa_note = COALESCE($4, wa_note)
      WHERE id = $1 AND business_id = $2`,
    [orderId, businessId, tag ? String(tag).slice(0, 32) : null, note ? String(note).slice(0, 1000) : null]);
  return rowCount > 0;
}

/* The customer wrote the address we asked for: it goes in the order's address box.
   Compare-and-set on what the box held when we read it and on the order still
   being open — if an agent touched either this very second, hers stands and
   nothing is written. Like the tag, it moves no status, holder, money or date. */
async function setAddress(businessId, orderId, { address, expected, statuses }) {
  const { rowCount } = await pool.query(
    `UPDATE orders SET "Address" = $3
      WHERE id = $1 AND business_id = $2
        AND btrim(COALESCE("Address", '')) = btrim($4::text)
        AND btrim("Status") = ANY($5::text[])`,
    [orderId, businessId, String(address).slice(0, 400), String(expected ?? ''), statuses]);
  return rowCount > 0;
}

/* What the address box held before the customer's words went in (kept once, never overwritten). */
async function keepAddressBefore(orderId, before) {
  await pool.query(
    `UPDATE whatsapp_order_flow SET address_before = COALESCE(address_before, $2), updated_at = NOW() WHERE order_id = $1`,
    [orderId, String(before ?? '')]);
}

/* Safety net: orders still «بانتظار واتساب» long after any hold could last.
   Only the newest 3,000 orders are looked at (a primary-key range, ~1 ms). */
async function strandedHeldOrders(holdStatus, minutes = 90, limit = 50) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT o.id AS order_id, o.business_id FROM orders o
      WHERE o.id > (SELECT COALESCE(MAX(id), 0) FROM orders) - 3000
        AND btrim(o."Status") = $1
        AND o."createdAt" < (NOW() AT TIME ZONE 'UTC') - ($2 || ' minutes')::interval
        AND NOT EXISTS (SELECT 1 FROM whatsapp_order_flow f
                         WHERE f.order_id = o.id AND f.state IN ('pending', 'sending', 'waiting')
                           AND COALESCE(f.hold_until, f.send_at + INTERVAL '60 minutes') > NOW())
      ORDER BY o.id LIMIT $3`, [holdStatus, String(minutes), limit]);
  return rows;
}

/* Meta's limit is on CUSTOMERS we open a conversation with in any 24 hours.
   Counted here: every number that got a template from us in the last 24 hours,
   plus the ones already queued to get one. */
async function customersMessaged24h(businessId) {
  await ensureSchema();
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(DISTINCT phone)::int AS n FROM (
       SELECT phone FROM whatsapp_messages
        WHERE business_id = $1 AND direction = 'out' AND template IS NOT NULL AND status <> 'failed'
          AND created_at > NOW() - INTERVAL '24 hours'
       UNION
       SELECT phone FROM whatsapp_order_flow WHERE business_id = $1 AND state IN ('pending', 'sending')
     ) x`, [businessId]);
  return r?.n || 0;
}

/* What became of the old «لا يرد» orders the owner messaged. */
async function recontactResults(businessId) {
  await ensureSchema();
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int                                                            AS total,
            COUNT(*) FILTER (WHERE f.state IN ('pending', 'sending'))::int           AS queued,
            COUNT(*) FILTER (WHERE f.sent_at IS NOT NULL)::int                       AS sent,
            COUNT(*) FILTER (WHERE m.status IN ('delivered', 'read'))::int           AS delivered,
            COUNT(*) FILTER (WHERE m.status = 'read')::int                           AS read,
            COUNT(*) FILTER (WHERE m.status = 'failed')::int                         AS failed,
            COUNT(*) FILTER (WHERE f.sent_at IS NULL AND f.state = 'released')::int  AS not_sent,
            COUNT(*) FILTER (WHERE f.outcome = 'confirmed')::int                     AS confirmed,
            COUNT(*) FILTER (WHERE f.outcome = 'deposit_needed')::int                AS deposit,
            COUNT(*) FILTER (WHERE f.outcome = 'cancel_requested')::int              AS cancel,
            COUNT(*) FILTER (WHERE f.outcome = 'support_requested')::int             AS support,
            MAX(f.created_at)                                                        AS last_at
       FROM whatsapp_order_flow f
       LEFT JOIN LATERAL (SELECT status FROM whatsapp_messages m
                           WHERE m.order_id = f.order_id AND m.kind = 'confirm' ORDER BY m.id DESC LIMIT 1) m ON true
      WHERE f.business_id = $1 AND f.kind = 'recontact'`, [businessId]);
  return r;
}

/* WhatsApp confirmed the order, then the customer rating arrived and it is a
   weak one (the SQL mirrors flow.isWeak — the engine checks again with the real
   function before it moves anything). Only while the order has not shipped. */
async function confirmedNowWeak(limit = 20) {
  await ensureSchema();
  if (!(await ordersColumnsExist())) return [];
  const { rows } = await pool.query(
    `SELECT f.* FROM whatsapp_order_flow f
       JOIN orders o ON o.id = f.order_id AND o.business_id = f.business_id
      WHERE f.outcome = 'confirmed' AND f.outcome_at > NOW() - INTERVAL '10 days'
        AND btrim(o."Status") = 'تم التأكيد' AND o.confirmed_via = 'whatsapp'
        AND (btrim(COALESCE(o."DeliveryRate", '')) = 'ضعيف'
             OR (btrim(COALESCE(o."DeliveryRate", '')) IN ('', 'بدون', 'جديد')
                 AND lower(btrim(COALESCE(to_jsonb(o) ->> 'easyorder_rate', ''))) = 'low'))
      ORDER BY f.outcome_at LIMIT $1`, [limit]);
  return rows;
}

/* To read BEFORE shipping: orders WhatsApp itself confirmed (no agent ever spoke
   to the customer) whose customer also WROTE something — a new address, a
   question, a change of mind. Only while they are still «تم التأكيد». */
async function confirmedWithText(businessId, limit = 50) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT f.order_id, f.customer_text, f.tag, f.outcome_at, f.updated_at, o."ProductName" AS product
       FROM whatsapp_order_flow f
       JOIN orders o ON o.id = f.order_id AND o.business_id = f.business_id
      WHERE f.business_id = $1 AND f.customer_text IS NOT NULL AND f.created_at > NOW() - INTERVAL '30 days'
        AND btrim(o."Status") = 'تم التأكيد' AND to_jsonb(o) ->> 'confirmed_via' = 'whatsapp'
      ORDER BY f.updated_at DESC LIMIT $2`, [businessId, limit]);
  return rows;
}

/* For the owner's page: the latest orders that went through the flow. */
async function recentFlows(businessId, limit = 30) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT f.order_id, f.phone, f.state, f.variant, f.is_test, f.kind, f.send_at, f.sent_at, f.hold_until,
            f.reminders_done, f.messages_sent, f.customer_replied, f.released_at, f.release_reason,
            f.tag, f.customer_text, f.outcome, f.outcome_at, f.last_error, f.created_at,
            btrim(o."Status") AS order_status, o."ProductName" AS product, o."AssignedTo" AS holder,
            to_jsonb(o) ->> 'confirmed_via' AS confirmed_via      -- reads fine before the column exists
       FROM whatsapp_order_flow f LEFT JOIN orders o ON o.id = f.order_id AND o.business_id = f.business_id
      WHERE f.business_id = $1 ORDER BY f.created_at DESC LIMIT $2`,
    [businessId, Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100)]);
  return rows;
}

module.exports = {
  FLOW_DDL, ORDERS_DDL, ORDERS_COLUMNS, MODES, ensureSchema, ensureOrdersColumn, ordersColumnsExist, ordersColumnsReady,
  _markSchemaReadyForTests, showOnOrder, setAddress, keepAddressBefore,
  getAuto, saveAuto, saveHealth, liveSettings, enroll, getByOrder, latestByPhone,
  claimDueSends, markSent, markRecontactSent, markReleased, dueReleases, dueReminders, markReminder, markReply,
  strandedHeldOrders, recentFlows, customersMessaged24h, recontactResults, confirmedWithText, confirmedNowWeak,
};
