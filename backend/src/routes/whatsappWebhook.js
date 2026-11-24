/* ── /api/whatsapp/webhook — what Meta tells us ──────────────────────────────
   GET : the one-time handshake when the owner saves the Callback URL on Meta
         (hub.verify_token must be the one «الربط مع واتساب» shows him).
   POST: delivery reports + customer messages. Mounted in index.js BEFORE
         express.json(), because the signature is over the RAW body.

   Answers 200 only after the events are stored; on a database error it answers
   500 so Meta delivers again (stored ids make a repeat harmless).
   Step 2: events are only RECORDED — no order changes here yet. */
'use strict';

const express = require('express');
const store   = require('../services/whatsapp/db');
const { matchSigners, parseEvents } = require('../services/whatsapp/webhook');

const router = express.Router();

let lastRejectLog = 0;
const logRejected = (why) => {
  if (Date.now() - lastRejectLog < 60_000) return;      // at most one line a minute
  lastRejectLog = Date.now();
  console.warn(`[whatsapp webhook] rejected: ${why}`);
};

router.get('/', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || !token || typeof challenge !== 'string' || !challenge) {
    return res.sendStatus(403);
  }
  try {
    if (await store.verifyTokenExists(token)) {
      console.log('✅  [whatsapp webhook] Meta verified the callback URL');
      return res.status(200).type('text/plain').send(challenge);
    }
    logRejected('verify token does not match');
    return res.sendStatus(403);
  } catch (err) {
    console.error('[whatsapp webhook] verify failed:', err.message);
    return res.sendStatus(500);
  }
});

/* type: () => true — read the bytes even if a proxy dropped the Content-Type */
router.post('/', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const signers = matchSigners(raw, req.get('x-hub-signature-256'), await store.webhookCandidates());
    if (!signers.length) {
      logRejected('no saved app secret matches the signature');
      return res.sendStatus(401);
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch {
      logRejected('body is not JSON');
      return res.sendStatus(400);
    }

    let stored = 0;
    for (const ev of parseEvents(payload)) {
      const owner = signers.find((s) => String(s.phone_number_id) === ev.phone_number_id);
      if (!owner) continue;                    // not this app's number → ignore
      if (ev.type === 'status') {
        if (await store.applyStatus(owner.business_id, ev)) stored += 1;
      } else if (await store.recordInbound(owner.business_id, ev)) {
        stored += 1;
      }
    }
    /* a correctly signed delivery proves the Callback URL is wired, even Meta's
       own «Test» button (its sample uses a made-up phone number id) */
    for (const s of signers) await store.touchWebhook(s.business_id);
    if (stored) console.log(`📩  [whatsapp webhook] ${stored} event(s) stored`);
    return res.sendStatus(200);
  } catch (err) {
    console.error('[whatsapp webhook] failed:', err.message);
    return res.sendStatus(500);
  }
});

module.exports = router;
