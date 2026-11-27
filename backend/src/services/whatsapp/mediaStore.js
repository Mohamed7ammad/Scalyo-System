/* ── WhatsApp — what customers SEND besides text (voice notes, pictures) ──────
   A customer who answers with a voice note or a picture used to leave only
   "[audio]" on the order: nobody could hear it, here or anywhere else (a Cloud
   API number has no inbox). Now the file is fetched from Meta as soon as the
   worker's next minute comes and kept here, so the agent can listen before she
   calls — and it stays available after Meta drops its copy.

   One row per incoming media message (wa_message_id is unique → a webhook
   repeated by Meta never stores twice). `bytes` is the file itself: a voice
   note is ~10 KB, a picture ~100 KB; anything over MAX_BYTES is not stored.
   Status: pending → done | failed (5 attempts). */
'use strict';

const pool = require('../../config/db');

const KINDS = ['audio', 'image', 'video', 'document', 'sticker'];
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

const DDL = `
  CREATE TABLE IF NOT EXISTS whatsapp_media (
    id             BIGSERIAL    PRIMARY KEY,
    business_id    INTEGER      NOT NULL,
    order_id       INTEGER,
    wa_message_id  VARCHAR(128) NOT NULL,
    kind           VARCHAR(12)  NOT NULL,
    media_id       VARCHAR(128) NOT NULL,
    mime           VARCHAR(100),
    size           INTEGER,
    bytes          BYTEA,
    status         VARCHAR(10)  NOT NULL DEFAULT 'pending',
    attempts       SMALLINT     NOT NULL DEFAULT 0,
    last_error     TEXT,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    fetched_at     TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_media_msg_idx ON whatsapp_media (wa_message_id);
  CREATE INDEX IF NOT EXISTS whatsapp_media_order_idx ON whatsapp_media (order_id) WHERE order_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS whatsapp_media_pending_idx ON whatsapp_media (created_at) WHERE status = 'pending';
`;

let schemaP = null;
function ensureSchema() {
  if (!schemaP) schemaP = pool.query(DDL).then(() => true).catch((e) => { schemaP = null; throw e; });
  return schemaP;
}
function _markSchemaReadyForTests() { schemaP = Promise.resolve(true); }

/** A media message arrived for this order: remember it; the worker fetches the file. */
async function enqueue({ businessId, orderId = null, waMessageId, kind, mediaId, mime = null, at = null }) {
  if (!KINDS.includes(kind) || !mediaId || !waMessageId) return false;
  await ensureSchema();
  const { rowCount } = await pool.query(
    `INSERT INTO whatsapp_media (business_id, order_id, wa_message_id, kind, media_id, mime, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [businessId, orderId, String(waMessageId).slice(0, 128), kind, String(mediaId).slice(0, 128), mime ? String(mime).slice(0, 100) : null, at]);
  return rowCount > 0;
}

/* A few files per minute; each row is handed to one worker pass only, and an attempt is counted as it is taken. */
async function claimPending(limit = 3) {
  await ensureSchema();
  const { rows } = await pool.query(
    `UPDATE whatsapp_media SET attempts = attempts + 1
      WHERE id IN (SELECT id FROM whatsapp_media WHERE status = 'pending' AND attempts < $2
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, business_id, order_id, kind, media_id, attempts`, [limit, MAX_ATTEMPTS]);
  return rows;
}

async function saveBytes(id, { mime, bytes }) {
  await pool.query(
    `UPDATE whatsapp_media SET status = 'done', bytes = $2, size = $3, mime = COALESCE($4, mime), last_error = NULL, fetched_at = NOW()
      WHERE id = $1`, [id, bytes, bytes.length, mime ? String(mime).slice(0, 100) : null]);
}

/* Not fetched this time: it stays pending for another try, until the attempts run out. */
async function markFailed(id, error, { final = false } = {}) {
  await pool.query(
    `UPDATE whatsapp_media
        SET last_error = $2, status = CASE WHEN $3 OR attempts >= $4 THEN 'failed' ELSE status END
      WHERE id = $1`, [id, String(error || '').slice(0, 300), final === true, MAX_ATTEMPTS]);
}

/** What the customer sent on this order — no file content, just what there is to play. */
async function listForOrder(businessId, orderId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT id, kind, mime, size, status, created_at FROM whatsapp_media
      WHERE business_id = $1 AND order_id = $2 ORDER BY created_at, id LIMIT 50`, [businessId, orderId]);
  return rows;
}

async function getFile(businessId, id) {
  await ensureSchema();
  const { rows: [r] } = await pool.query(
    `SELECT id, order_id, kind, mime, size, bytes, status FROM whatsapp_media WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return r || null;
}

/* The media messages that arrived before this existed (or before their order was known):
   each is tied to the order its customer had in the flow at that moment. Idempotent. */
async function backfill() {
  await ensureSchema();
  const { rowCount } = await pool.query(
    `INSERT INTO whatsapp_media (business_id, order_id, wa_message_id, kind, media_id, mime, created_at)
     SELECT m.business_id,
            (SELECT f.order_id FROM whatsapp_order_flow f
              WHERE f.business_id = m.business_id AND f.phone = m.phone AND f.created_at <= m.created_at + INTERVAL '1 minute'
              ORDER BY f.created_at DESC LIMIT 1),
            m.wa_message_id, m.payload ->> 'type',
            m.payload -> (m.payload ->> 'type') ->> 'id',
            left(m.payload -> (m.payload ->> 'type') ->> 'mime_type', 100), m.created_at
       FROM whatsapp_messages m
      WHERE m.direction = 'in' AND m.wa_message_id IS NOT NULL
        AND m.payload ->> 'type' = ANY($1::text[])
        AND m.payload -> (m.payload ->> 'type') ->> 'id' IS NOT NULL
        AND m.created_at > NOW() - INTERVAL '20 days'
     ON CONFLICT (wa_message_id) DO NOTHING`, [KINDS]);
  return rowCount;
}

module.exports = {
  DDL, KINDS, MAX_BYTES, MAX_ATTEMPTS, ensureSchema, _markSchemaReadyForTests,
  enqueue, claimPending, saveBytes, markFailed, listForOrder, getFile, backfill,
};
