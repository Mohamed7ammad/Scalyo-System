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
   Automation switch lives on whatsapp_settings: auto_mode off | test | on. */
'use strict';

const pool = require('../../config/db');
const base = require('./db');

const FLOW_DDL = `
  ALTER TABLE whatsapp_settings
    ADD COLUMN IF NOT EXISTS auto_mode   VARCHAR(8) NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS test_phones TEXT[]     NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS split_test  BOOLEAN    NOT NULL DEFAULT false;
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
  CREATE INDEX IF NOT EXISTS whatsapp_order_flow_due_idx ON whatsapp_order_flow (state, send_at) WHERE state IN ('pending', 'sending', 'waiting');
  CREATE INDEX IF NOT EXISTS whatsapp_order_flow_phone_idx ON whatsapp_order_flow (business_id, phone, created_at DESC);
  CREATE INDEX IF NOT EXISTS whatsapp_order_flow_recent_idx ON whatsapp_order_flow (business_id, created_at DESC);
`;
/* «واتساب» as the one who confirmed — survives later status changes (shipping, delivery). */
const ORDERS_DDL = `ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_via VARCHAR(16)`;

/* orders is the busiest table: the column is added ONCE, only if it is missing,
   on its own connection with a 4-second lock timeout — so it can never queue the
   whole system behind a long query. A failure is retried later; until then a
   WhatsApp confirmation still works, just without the «واتساب» label. */
let ordersColumnP = null;
function ensureOrdersColumn() {
  if (!ordersColumnP) {
    ordersColumnP = (async () => {
      const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'confirmed_via'`);
      if (rows.length) return true;
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '4s'`);
        await c.query(ORDERS_DDL);
        await c.query('COMMIT');
        console.log('✅  WhatsApp flow: orders.confirmed_via ready');
        return true;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    })().catch((e) => {
      ordersColumnP = null;
      console.warn('⚠️   WhatsApp flow: orders.confirmed_via not added yet —', e.message);
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
function _markSchemaReadyForTests() { schemaP = Promise.resolve(true); ordersColumnP = Promise.resolve(true); }

const MODES = ['off', 'test', 'on'];
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/* ── the automation switch ────────────────────────────────────────────────── */

async function getAuto(businessId) {
  await ensureSchema();
  const { rows: [r] } = await pool.query(
    `SELECT auto_mode, test_phones, split_test,
            (phone_number_id IS NOT NULL AND access_token IS NOT NULL AND waba_id IS NOT NULL) AS configured
       FROM whatsapp_settings WHERE business_id = $1`, [businessId]);
  if (!r) return { auto_mode: 'off', test_phones: [], split_test: false, configured: false };
  return { auto_mode: MODES.includes(r.auto_mode) ? r.auto_mode : 'off', test_phones: r.test_phones || [],
    split_test: r.split_test === true, configured: r.configured === true };
}

async function saveAuto(businessId, { auto_mode, test_phones, split_test }, actor) {
  await ensureSchema();
  if (!MODES.includes(auto_mode)) throw badRequest('وضع التشغيل مش معروف');
  const phones = [...new Set((test_phones || []).map(String))].filter((p) => /^201[0125]\d{8}$/.test(p));
  if (phones.length > 20) throw badRequest('أقصى عدد لأرقام التجربة 20');
  if (auto_mode === 'test' && !phones.length) throw badRequest('اكتب رقم واحد على الأقل للتجربة');
  const { rows: [r] } = await pool.query(
    `UPDATE whatsapp_settings
        SET auto_mode = $2, test_phones = $3::text[], split_test = $4, updated_by = $5, updated_at = updated_at
      WHERE business_id = $1 AND phone_number_id IS NOT NULL AND access_token IS NOT NULL
      RETURNING auto_mode, test_phones, split_test`,
    [businessId, auto_mode, phones, split_test === true, actor]);
  if (!r) throw badRequest('احفظ مفاتيح ميتا الأول');
  return r;
}

/* ── one order's diary ────────────────────────────────────────────────────── */

async function enroll({ orderId, businessId, phone, variant, sendAt, isTest }) {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_order_flow (order_id, business_id, phone, variant, is_test, send_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (order_id) DO NOTHING RETURNING *`,
    [orderId, businessId, phone, variant, isTest === true, sendAt]);
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

/* For the owner's page: the latest orders that went through the flow. */
async function recentFlows(businessId, limit = 30) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT f.order_id, f.phone, f.state, f.variant, f.is_test, f.send_at, f.sent_at, f.hold_until,
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
  FLOW_DDL, ORDERS_DDL, MODES, ensureSchema, ensureOrdersColumn, _markSchemaReadyForTests,
  getAuto, saveAuto, enroll, getByOrder, latestByPhone,
  claimDueSends, markSent, markReleased, dueReleases, dueReminders, markReminder, markReply,
  strandedHeldOrders, recentFlows,
};
