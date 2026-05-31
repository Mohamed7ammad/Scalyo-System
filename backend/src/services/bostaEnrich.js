/**
 * bostaEnrich.js
 * Shared Bosta consignee-ranking helper used by both the webhook route
 * and the Google Sheets sync cron job.
 */
const axios = require('axios');
const pool  = require('../config/db');

/** '010XXXXXXXX' → '+2010XXXXXXXX', '+2…' → unchanged */
function formatPhone(raw) {
  if (!raw) return '';
  const p = raw.trim();
  if (p.startsWith('+2')) return p;
  if (p.startsWith('01')) return `+2${p}`;
  return p;
}

/**
 * Maps a Bosta consignee-ranking object → Arabic DeliveryRate label.
 *
 *   ranking === null/undefined  → 'جديد'   (no shipping history — new customer)
 *   deliverySuccessRate >= 80   → 'ممتاز'
 *   deliverySuccessRate >= 50   → 'متوسط'
 *   deliverySuccessRate <  50   → 'ضعيف'
 *
 * Returns null ONLY when a ranking object is present but its metrics are
 * unreadable (so the caller can skip rather than mislabel).
 */
function mapRanking(ranking) {
  // Bosta returns `consigneRanking: null` for customers with no history.
  if (!ranking) return 'جديد';

  const successRate = Number(ranking.deliverySuccessRate);
  if (!Number.isFinite(successRate)) return null;   // metrics unreadable

  if (successRate >= 80) return 'ممتاز';
  if (successRate >= 50) return 'متوسط';
  return 'ضعيف';
}

/* ── Throttled enrichment queue ──────────────────────────────────────────────
   Bosta rate-limits the consignee-ranking endpoint (HTTP 429). When a bulk sync
   (Google-Sheet cron / many webhooks) fires, calling enrichDeliveryRate per order
   would burst dozens of concurrent requests → 429s. So every caller now ENQUEUES
   and a single worker drains the queue ONE request at a time, with a fixed gap
   between calls and exponential back-off + retry on 429.                        */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Tunables (overridable via env). */
const ENRICH_DELAY_MS   = Number(process.env.BOSTA_ENRICH_DELAY_MS) || 1500; // gap between calls
const RATE_LIMIT_BASE   = Number(process.env.BOSTA_ENRICH_BACKOFF_MS) || 30_000; // 429 cooldown
const MAX_RETRIES       = 4;     // per-order retries on 429 before giving up

const _queue = [];
let _draining = false;

/**
 * PUBLIC, fire-and-forget. Enqueues an enrichment job and starts the worker.
 * Same signature as before — callers must NOT await it.
 */
function enrichDeliveryRate(orderId, phone) {
  if (!orderId || !phone) return;
  _queue.push({ orderId, phone, attempts: 0 });
  if (_queue.length === 1 && !_draining) console.log(`[bostaEnrich] queued order ${orderId} (queue: ${_queue.length})`);
  drainQueue();   // no await — fire and forget
}

/** Single-flight worker: processes the queue serially with throttling. */
async function drainQueue() {
  if (_draining) return;
  _draining = true;
  try {
    while (_queue.length > 0) {
      const job = _queue.shift();
      const status = await processEnrichment(job.orderId, job.phone);

      if (status === 'ratelimited') {
        if (job.attempts < MAX_RETRIES) {
          job.attempts += 1;
          /* Exponential back-off: 30s, 60s, 120s, 240s … then re-queue. */
          const wait = RATE_LIMIT_BASE * 2 ** (job.attempts - 1);
          console.warn(`[bostaEnrich] 429 — backing off ${Math.round(wait / 1000)}s then retrying order ${job.orderId} (attempt ${job.attempts}/${MAX_RETRIES})`);
          _queue.push(job);            // retry later, at the back of the line
          await sleep(wait);
        } else {
          console.error(`[bostaEnrich] order ${job.orderId} gave up after ${MAX_RETRIES} rate-limited attempts`);
          await sleep(ENRICH_DELAY_MS);
        }
      } else {
        /* Normal spacing between successful/!429 calls. */
        await sleep(ENRICH_DELAY_MS);
      }
    }
  } finally {
    _draining = false;
  }
}

/**
 * Does the actual Bosta lookup + DB update for ONE order.
 * Returns a status the worker uses to decide pacing:
 *   'ok' | 'ratelimited' | 'skipped' | 'error'
 *
 * - On success  : updates to the mapped Arabic label.
 * - On 404      : updates to 'جديد' (customer has no shipping history).
 * - On 429      : returns 'ratelimited' so the worker backs off + retries.
 * - On any other error : logs and returns 'error'.
 *
 * Never throws.
 */
async function processEnrichment(orderId, phone) {
  /* ── TENANT: resolve the owning business of this order first ────────
     Every downstream read (Bosta creds) and write (DeliveryRate) is then
     scoped to this tenant so one business can never enrich/overwrite
     another tenant's order, nor borrow another tenant's Bosta token.   */
  let businessId = null;
  try {
    const { rows: ownRows } = await pool.query(
      `SELECT business_id FROM orders WHERE id = $1`,
      [orderId]
    );
    businessId = ownRows[0]?.business_id ?? null;
  } catch (ownErr) {
    console.warn('[enrichDeliveryRate] Could not resolve order tenant:', ownErr.message);
  }

  /* ── Read bearer_token from DB (Phase 1: SaaS credential store) ────
     Scoped to the order's tenant. Falls back to process.env.BOSTA_BEARER_TOKEN
     so existing deployments that haven't migrated to the DB yet keep working. */
  let bearerToken;
  try {
    const { rows: credRows } = await pool.query(
      `SELECT bearer_token FROM shipping_settings
       WHERE provider_name = 'bosta' AND is_active = true AND business_id = $1`,
      [businessId]
    );
    bearerToken = credRows[0]?.bearer_token || process.env.BOSTA_BEARER_TOKEN || null;
  } catch (credErr) {
    console.warn('[enrichDeliveryRate] Could not read shipping_settings, falling back to .env:', credErr.message);
    bearerToken = process.env.BOSTA_BEARER_TOKEN || null;
  }

  if (!bearerToken) {
    console.warn('⚠️  enrichDeliveryRate: bearer_token not found in shipping_settings DB or .env');
    return 'skipped';
  }

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return 'skipped';

  try {
    const res = await axios.get(
      'https://app.bosta.co/api/v2/consignee/ranking',
      {
        params:  { phone: formattedPhone },
        headers: {
          // Full value from .env already includes the "Bearer " prefix
          Authorization:          bearerToken,
          Origin:                 'https://business.bosta.co',
          Referer:                'https://business.bosta.co/',
          'x-device-fingerprint': 'ko54zl',
          'x-device-id':          '01KNF2HWY0F6XTPBF0YXGS0PVQ',
          'User-Agent':           'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 Edg/148.0.0.0',
          Accept:                 'application/json, text/plain, */*',
        },
        timeout: 10_000,
      }
    );

    /* Bosta nests the ranking under data.data and — note — MISSPELLS the key as
       "consigneRanking" (no second "e"). We read the misspelt key first, tolerate
       the correct spelling, and crucially distinguish:
         • key present & null  → new customer (no history)  → 'جديد'
         • key present & object → map by deliverySuccessRate
         • key entirely absent  → genuinely unknown shape    → skip            */
    const payload =
      (res.data && typeof res.data.data === 'object' && res.data.data !== null)
        ? res.data.data
        : (res.data || {});

    const hasRankingKey =
      Object.prototype.hasOwnProperty.call(payload, 'consigneRanking') ||
      Object.prototype.hasOwnProperty.call(payload, 'consigneeRanking');

    if (!hasRankingKey) {
      console.warn(`⚠️  Bosta: unrecognised response shape for ${formattedPhone}`, res.data);
      return 'skipped';
    }

    const ranking = payload.consigneRanking ?? payload.consigneeRanking ?? null;

    const mapped = mapRanking(ranking);   // null ranking → 'جديد'
    if (!mapped) {
      console.warn(`⚠️  Bosta: ranking present but metrics unreadable for ${formattedPhone}`, res.data);
      return 'skipped';
    }

    await pool.query(
      `UPDATE orders SET "DeliveryRate" = $1 WHERE id = $2 AND business_id = $3`,
      [mapped, orderId, businessId]
    );
    console.log(`✅  Bosta enrichment: order ${orderId} [${formattedPhone}] → ${mapped}`);
    return 'ok';

  } catch (err) {
    const status = err.response?.status;

    if (status === 404) {
      await pool.query(
        `UPDATE orders SET "DeliveryRate" = 'جديد' WHERE id = $1 AND business_id = $2`,
        [orderId, businessId]
      ).catch(() => {});
      console.log(`📦  Bosta: order ${orderId} [${formattedPhone}] → جديد (no history)`);
      return 'ok';
    }

    if (status === 429) {
      /* Rate-limited — signal the worker to back off and retry. */
      console.warn(`⏳  Bosta 429 (rate limit) for order ${orderId} [${formattedPhone}]`);
      return 'ratelimited';
    }

    console.error('❌ Bosta Live Sync Failed for phone:', formattedPhone);
    console.error('Status Code:', status);
    console.error('Error Response Data:',
      JSON.stringify(err.response?.data || err.message, null, 2));
    return 'error';
  }
}

module.exports = { enrichDeliveryRate, formatPhone, mapRanking };
