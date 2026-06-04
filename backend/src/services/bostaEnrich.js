/**
 * bostaEnrich.js
 * Shared Bosta consignee-ranking helper used by both the webhook route
 * and the Google Sheets sync cron job.
 */
const axios = require('axios');
const pool  = require('../config/db');
const { enqueueBosta, LANES } = require('./bostaQueue');

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

/* ── Throttled enrichment via the shared Bosta queue ─────────────────────────
   Bosta rate-limits the consignee-ranking endpoint (HTTP 429). Rather than keep
   a SEPARATE queue here, enrichment now funnels through the SAME global queue
   (services/bostaQueue) that the bulk dispatch uses — so ALL outbound Bosta
   traffic (webhook-triggered enrichment + frontend dispatch) shares one rate
   limiter and can never collectively burst past the limit.                     */

/**
 * PUBLIC, fire-and-forget. Enqueues an enrichment job onto the shared Bosta
 * queue. Same signature as before — callers must NOT await it.
 */
function enrichDeliveryRate(orderId, phone) {
  if (!orderId || !phone) return Promise.resolve();
  // Returns a promise that ALWAYS resolves (errors are caught here), so
  // fire-and-forget callers can ignore it while batch scripts can await it.
  return enqueueBosta(() => processEnrichment(orderId, phone), `enrich order ${orderId}`, LANES.ENRICH)
    .catch((err) => {
      // Retries (incl. 429 back-off) are handled inside the queue; this only
      // fires when they're exhausted or a non-retryable error escaped.
      console.error(`[bostaEnrich] order ${orderId} enrichment failed:`, err.message);
    });
}

/**
 * Does the actual Bosta lookup + DB update for ONE order.
 *
 * - On success  : updates to the mapped Arabic label, returns 'ok'.
 * - On 404      : updates to 'جديد' (no shipping history), returns 'ok'.
 * - On 429      : RE-THROWS so the shared queue backs off + retries.
 * - On any other error : logs and returns 'error' (no retry).
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
      /* Rate-limited — re-throw so the shared bostaQueue backs off and retries. */
      console.warn(`⏳  Bosta 429 (rate limit) for order ${orderId} [${formattedPhone}]`);
      throw err;
    }

    console.error('❌ Bosta Live Sync Failed for phone:', formattedPhone);
    console.error('Status Code:', status);
    console.error('Error Response Data:',
      JSON.stringify(err.response?.data || err.message, null, 2));
    return 'error';
  }
}

module.exports = { enrichDeliveryRate, formatPhone, mapRanking };
