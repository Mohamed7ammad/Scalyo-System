/* ── WhatsApp webhook — signature check and payload reading (pure) ───────────
   Meta POSTs delivery reports (sent / delivered / read / failed) and customer
   messages (button taps, text) to /api/whatsapp/webhook. Every delivery is
   signed: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, RAW body).
   A delivery no saved app secret signed is rejected; a change for a phone
   number that isn't the signer's own is ignored. No I/O here. */
'use strict';

const crypto = require('crypto');

function signatureMatches(rawBody, header, appSecret) {
  if (!rawBody || !rawBody.length || !header || !appSecret) return false;
  const m = /^sha256=([a-f0-9]{64})$/i.exec(String(header).trim());
  if (!m) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/* The businesses whose saved app secret signed this delivery (usually one). */
function matchSigners(rawBody, header, candidates) {
  return (candidates || []).filter((c) => signatureMatches(rawBody, header, c.app_secret));
}

const toDate = (ts) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

const short = (s, n = 120) => (s === undefined || s === null ? null : String(s).slice(0, n));

/* What the customer did, in one short line. */
function readMessage(m) {
  switch (m?.type) {
    case 'button':                       // a quick-reply button on one of our templates
      return { kind: 'button', reply: short(m.button?.text || m.button?.payload), payload: short(m.button?.payload, 200) };
    case 'interactive': {
      const r = m.interactive?.button_reply || m.interactive?.list_reply || {};
      return { kind: 'button', reply: short(r.title || r.id), payload: short(r.id, 200) };
    }
    case 'text':
      return { kind: 'text', reply: short(m.text?.body), payload: null };
    case 'reaction':
      return { kind: 'reaction', reply: short(m.reaction?.emoji || 'تفاعل'), payload: null };
    default:
      return { kind: 'other', reply: `[${m?.type || 'رسالة'}]`, payload: null };
  }
}

/* Meta's nested payload → a flat list of events. */
function parseEvents(payload) {
  const out = [];
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return out;
  for (const entry of payload.entry) {
    for (const change of entry?.changes || []) {
      if (change?.field !== 'messages') continue;
      const v = change.value || {};
      const phoneNumberId = v.metadata?.phone_number_id ? String(v.metadata.phone_number_id) : null;
      for (const s of v.statuses || []) {
        if (!s?.id || !s?.status) continue;
        const e = Array.isArray(s.errors) && s.errors[0] ? s.errors[0] : null;
        out.push({
          type:            'status',
          phone_number_id: phoneNumberId,
          wa_message_id:   String(s.id),
          status:          String(s.status),
          at:              toDate(s.timestamp),
          recipient:       s.recipient_id ? String(s.recipient_id) : null,
          error_code:      e && Number.isInteger(Number(e.code)) ? Number(e.code) : null,
          error_text:      e ? short(e.error_data?.details || e.message || e.title, 500) : null,
        });
      }
      for (const m of v.messages || []) {
        if (!m?.id) continue;
        const r = readMessage(m);
        out.push({
          type:            'message',
          phone_number_id: phoneNumberId,
          wa_message_id:   String(m.id),
          from:            m.from ? String(m.from) : '',
          at:              toDate(m.timestamp),
          kind:            r.kind,
          reply:           r.reply,
          payload:         r.payload,
          context_id:      m.context?.id ? String(m.context.id) : null,
          raw:             m,
        });
      }
    }
  }
  return out;
}

module.exports = { signatureMatches, matchSigners, parseEvents, readMessage };
