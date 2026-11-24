/* ── WhatsApp module — storage (Step 2 of the roadmap, 2026-11-24) ───────────
   whatsapp_settings: one row per business — the Meta ids and secrets the OWNER
     pastes on «الربط مع واتساب». Secrets never leave the server: the page only
     learns whether one is saved and its last 4 characters.
   whatsapp_messages: every message we send and every message / button tap we
     receive, with Meta's delivery status (sent → delivered → read, or failed).

   Nothing here sends anything to a customer: Step 2 only connects the number,
   sends a test message to a number the owner types, and records what Meta
   reports. Automatic messages for new orders are a later step, behind their own
   switch. */
'use strict';

const crypto = require('crypto');
const pool   = require('../../config/db');

const DDL = `
  CREATE TABLE IF NOT EXISTS whatsapp_settings (
    business_id      INTEGER      PRIMARY KEY,
    phone_number_id  VARCHAR(32),
    waba_id          VARCHAR(32),
    access_token     TEXT,
    app_secret       VARCHAR(128),
    verify_token     VARCHAR(64)  NOT NULL,
    display_phone    VARCHAR(32),
    verified_name    VARCHAR(160),
    quality_rating   VARCHAR(16),
    last_check_at    TIMESTAMPTZ,
    last_check_error TEXT,
    last_webhook_at  TIMESTAMPTZ,
    updated_by       VARCHAR(255),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id             BIGSERIAL    PRIMARY KEY,
    business_id    INTEGER      NOT NULL,
    order_id       INTEGER,
    direction      VARCHAR(3)   NOT NULL,
    kind           VARCHAR(20)  NOT NULL,
    phone          VARCHAR(20)  NOT NULL,
    template       VARCHAR(80),
    wa_message_id  VARCHAR(128),
    status         VARCHAR(12)  NOT NULL,
    error_code     INTEGER,
    error_text     TEXT,
    reply          VARCHAR(120),
    context_id     VARCHAR(128),
    payload        JSONB,
    created_by     VARCHAR(255),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    status_at      TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_wamid_idx ON whatsapp_messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS whatsapp_messages_recent_idx ON whatsapp_messages (business_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS whatsapp_messages_order_idx ON whatsapp_messages (order_id) WHERE order_id IS NOT NULL;
`;

let schemaP = null;
function ensureSchema() {
  if (!schemaP) {
    schemaP = pool.query(DDL).then(() => true).catch((err) => { schemaP = null; throw err; });
  }
  return schemaP;
}
/* tests and the read-only preview create their own (temporary) tables */
function _markSchemaReadyForTests() { schemaP = Promise.resolve(true); }

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/* ── pure helpers ─────────────────────────────────────────────────────────── */

const ID_RE     = /^\d{5,32}$/;           // Meta object ids are long digit strings
const SECRET_RE = /^[a-f0-9]{32}$/i;      // a Meta app secret: 32 hex characters
const TOKEN_RE  = /^[\x21-\x7e]{30,4096}$/;  // printable ASCII, no spaces (EAA…)

const trimStr = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

/* What the owner typed → what we store. An empty secret field means "keep the
   saved one", so the page never has to hold the real value. */
function cleanSettingsInput(body = {}, existing = null) {
  const phoneNumberId = trimStr(body.phone_number_id);
  const wabaId        = trimStr(body.waba_id);
  const token         = trimStr(body.access_token);
  const secret        = trimStr(body.app_secret);

  if (!phoneNumberId) throw badRequest('اكتب الـ Phone number ID');
  if (!ID_RE.test(phoneNumberId)) throw badRequest('الـ Phone number ID أرقام بس (من صفحة API Setup على ميتا)');
  if (wabaId && !ID_RE.test(wabaId)) throw badRequest('الـ Messaging account ID أرقام بس');
  if (wabaId && wabaId === phoneNumberId) throw badRequest('الـ Phone number ID والـ Messaging account ID رقمين مختلفين — راجعهم من صفحة API Setup');
  if (token && !TOKEN_RE.test(token)) throw badRequest('التوكن شكله مش مظبوط — انسخه كله من ميتا من غير مسافات');
  if (!token && !existing?.access_token) throw badRequest('الزق التوكن (Access token)');
  if (secret && !SECRET_RE.test(secret)) throw badRequest('الـ App secret المفروض 32 حرف ورقم (من صفحة Basic في App settings)');
  if (secret && token && secret === token) throw badRequest('الـ App secret غير التوكن — راجعهم');

  return {
    phone_number_id: phoneNumberId,
    waba_id:         wabaId || null,
    access_token:    token || null,     // null → keep the saved one
    app_secret:      secret || null,
  };
}

const hint = (secret) => (secret ? `…${String(secret).slice(-4)}` : null);

/* The only shape the browser ever sees — no token, no secret. */
function publicSettings(row) {
  if (!row) {
    return {
      configured: false, phone_number_id: null, waba_id: null,
      has_token: false, token_hint: null, has_app_secret: false, app_secret_hint: null,
      verify_token: null, display_phone: null, verified_name: null, quality_rating: null,
      last_check_at: null, last_check_error: null, last_webhook_at: null, updated_at: null, updated_by: null,
    };
  }
  return {
    configured:       Boolean(row.phone_number_id && row.access_token),
    phone_number_id:  row.phone_number_id,
    waba_id:          row.waba_id,
    has_token:        Boolean(row.access_token),
    token_hint:       hint(row.access_token),
    has_app_secret:   Boolean(row.app_secret),
    app_secret_hint:  hint(row.app_secret),
    verify_token:     row.verify_token,
    display_phone:    row.display_phone,
    verified_name:    row.verified_name,
    quality_rating:   row.quality_rating,
    last_check_at:    row.last_check_at,
    last_check_error: row.last_check_error,
    last_webhook_at:  row.last_webhook_at,
    updated_at:       row.updated_at,
    updated_by:       row.updated_by,
  };
}

/* sent → delivered → read only move forward; failed is final. Mirrors the SQL below. */
const STATUS_RANK = { sending: 0, sent: 1, delivered: 2, read: 3, failed: 9 };
const statusMovesForward = (from, to) =>
  to in STATUS_RANK && (STATUS_RANK[from] ?? 0) < STATUS_RANK[to];

/* ── settings ─────────────────────────────────────────────────────────────── */

async function getSettings(businessId) {
  await ensureSchema();
  const { rows: [row] } = await pool.query('SELECT * FROM whatsapp_settings WHERE business_id = $1', [businessId]);
  return row || null;
}

async function saveSettings(businessId, body, actor) {
  const existing = await getSettings(businessId);
  const v = cleanSettingsInput(body, existing);
  const { rows: [row] } = await pool.query(
    `INSERT INTO whatsapp_settings
       (business_id, phone_number_id, waba_id, access_token, app_secret, verify_token, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (business_id) DO UPDATE SET
       phone_number_id  = EXCLUDED.phone_number_id,
       waba_id          = EXCLUDED.waba_id,
       access_token     = COALESCE(EXCLUDED.access_token, whatsapp_settings.access_token),
       app_secret       = COALESCE(EXCLUDED.app_secret,   whatsapp_settings.app_secret),
       /* a new number or a new token → the last connection check no longer applies */
       display_phone    = CASE WHEN whatsapp_settings.phone_number_id IS DISTINCT FROM EXCLUDED.phone_number_id
                                 OR EXCLUDED.access_token IS NOT NULL THEN NULL ELSE whatsapp_settings.display_phone END,
       verified_name    = CASE WHEN whatsapp_settings.phone_number_id IS DISTINCT FROM EXCLUDED.phone_number_id
                                 OR EXCLUDED.access_token IS NOT NULL THEN NULL ELSE whatsapp_settings.verified_name END,
       quality_rating   = CASE WHEN whatsapp_settings.phone_number_id IS DISTINCT FROM EXCLUDED.phone_number_id
                                 OR EXCLUDED.access_token IS NOT NULL THEN NULL ELSE whatsapp_settings.quality_rating END,
       last_check_at    = CASE WHEN whatsapp_settings.phone_number_id IS DISTINCT FROM EXCLUDED.phone_number_id
                                 OR EXCLUDED.access_token IS NOT NULL THEN NULL ELSE whatsapp_settings.last_check_at END,
       last_check_error = CASE WHEN whatsapp_settings.phone_number_id IS DISTINCT FROM EXCLUDED.phone_number_id
                                 OR EXCLUDED.access_token IS NOT NULL THEN NULL ELSE whatsapp_settings.last_check_error END,
       updated_by       = EXCLUDED.updated_by,
       updated_at       = NOW()
     RETURNING *`,
    [businessId, v.phone_number_id, v.waba_id, v.access_token, v.app_secret,
     crypto.randomBytes(18).toString('base64url'), actor]
  );
  return row;
}

async function saveCheckResult(businessId, { info = null, error = null }) {
  await ensureSchema();
  const { rows: [row] } = await pool.query(
    `UPDATE whatsapp_settings
        SET display_phone    = COALESCE($2, display_phone),
            verified_name    = COALESCE($3, verified_name),
            quality_rating   = COALESCE($4, quality_rating),
            last_check_at    = NOW(),
            last_check_error = $5
      WHERE business_id = $1
      RETURNING *`,
    [businessId, info?.display_phone_number || null, info?.verified_name || null,
     info?.quality_rating || null, error ? String(error).slice(0, 500) : null]
  );
  return row || null;
}

/* For the webhook: which businesses could have signed a delivery. */
async function webhookCandidates() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT business_id, phone_number_id, app_secret FROM whatsapp_settings
      WHERE app_secret IS NOT NULL AND phone_number_id IS NOT NULL`
  );
  return rows;
}

async function verifyTokenExists(token) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT 1 FROM whatsapp_settings WHERE verify_token = $1 LIMIT 1', [String(token)]);
  return rows.length > 0;
}

async function touchWebhook(businessId) {
  await pool.query('UPDATE whatsapp_settings SET last_webhook_at = NOW() WHERE business_id = $1', [businessId]);
}

/* ── message log ──────────────────────────────────────────────────────────── */

const MESSAGE_COLS = `id, order_id, direction, kind, phone, template, wa_message_id, status,
  error_code, error_text, reply, created_by, created_at, status_at`;

async function logOutbound({ businessId, orderId = null, kind, phone, template = null, waMessageId = null,
  status, errorCode = null, errorText = null, payload = null, createdBy = null }) {
  await ensureSchema();
  const { rows: [row] } = await pool.query(
    `INSERT INTO whatsapp_messages
       (business_id, order_id, direction, kind, phone, template, wa_message_id, status,
        error_code, error_text, payload, created_by, status_at)
     VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     RETURNING ${MESSAGE_COLS}`,
    [businessId, orderId, kind, phone, template, waMessageId, status,
     Number.isInteger(errorCode) ? errorCode : null, errorText ? String(errorText).slice(0, 500) : null,
     payload ? JSON.stringify(payload) : null, createdBy]
  );
  return row;
}

/* A delivery report from Meta. Only moves forward (a late "delivered" never
   overwrites "read"); a report for a message we didn't send is ignored. */
async function applyStatus(businessId, ev) {
  await ensureSchema();
  const err = ev.error_code !== undefined && ev.error_code !== null;
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_messages
        SET status     = $3::text,
            status_at  = $4,
            error_code = CASE WHEN $5::int IS NOT NULL THEN $5::int ELSE error_code END,
            error_text = CASE WHEN $6::text IS NOT NULL THEN $6::text ELSE error_text END
      WHERE business_id = $1 AND wa_message_id = $2 AND direction = 'out'
        AND (CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 9 ELSE 0 END)
          < (CASE $3::text WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 9 ELSE 0 END)`,
    [businessId, ev.wa_message_id, ev.status, ev.at || new Date(),
     err && Number.isInteger(Number(ev.error_code)) ? Number(ev.error_code) : null,
     err ? String(ev.error_text || '').slice(0, 500) || null : null]
  );
  return rowCount > 0;
}

/* A message or button tap from a customer. Meta can deliver the same one twice —
   the unique message id makes the second a no-op. A tap on a button of OUR
   message also notes the answer on that message. */
async function recordInbound(businessId, ev) {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_messages
       (business_id, direction, kind, phone, wa_message_id, status, reply, context_id, payload, created_at, status_at)
     VALUES ($1, 'in', $2, $3, $4, 'received', $5, $6, $7, $8, $8)
     ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [businessId, ev.kind, String(ev.from || '').slice(0, 20), ev.wa_message_id,
     ev.reply ? String(ev.reply).slice(0, 120) : null, ev.context_id || null,
     ev.raw ? JSON.stringify(ev.raw) : null, ev.at || new Date()]
  );
  const inserted = rows.length > 0;
  if (inserted && ev.context_id && ev.reply) {
    await pool.query(
      `UPDATE whatsapp_messages SET reply = $3
        WHERE business_id = $1 AND wa_message_id = $2 AND direction = 'out'`,
      [businessId, ev.context_id, String(ev.reply).slice(0, 120)]
    );
  }
  return inserted;
}

async function recentMessages(businessId, limit = 30) {
  await ensureSchema();
  const n = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const { rows } = await pool.query(
    `SELECT ${MESSAGE_COLS} FROM whatsapp_messages WHERE business_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [businessId, n]
  );
  return rows;
}

async function countRecentTests(businessId) {
  await ensureSchema();
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_messages
      WHERE business_id = $1 AND kind = 'test' AND created_at > NOW() - INTERVAL '1 hour'`,
    [businessId]
  );
  return n;
}

module.exports = {
  DDL, ensureSchema, _markSchemaReadyForTests,
  cleanSettingsInput, publicSettings, statusMovesForward, STATUS_RANK,
  getSettings, saveSettings, saveCheckResult, webhookCandidates, verifyTokenExists, touchWebhook,
  logOutbound, applyStatus, recordInbound, recentMessages, countRecentTests,
};
