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
 * Maps consigneeRanking metrics → Arabic DeliveryRate label.
 *   deliveredDeliveriesCount === 0  → 'جديد'
 *   deliverySuccessRate >= 85       → 'ممتاز'
 *   deliverySuccessRate >= 50       → 'متوسط'
 *   deliverySuccessRate <  50       → 'ضعيف'
 * Returns null when the ranking object is missing / unreadable.
 */
function mapRanking(ranking) {
  if (!ranking) return null;
  const delivered   = Number(ranking.deliveredDeliveriesCount ?? -1);
  const successRate = Number(ranking.deliverySuccessRate      ?? -1);
  if (delivered === 0)   return 'جديد';
  if (successRate >= 85) return 'ممتاز';
  if (successRate >= 50) return 'متوسط';
  if (successRate >= 0)  return 'ضعيف';
  return null;
}

/**
 * Fire-and-forget: GETs Bosta's consignee ranking for `phone` and updates
 * the `DeliveryRate` column of `orderId`.
 *
 * - On success  : updates to the mapped Arabic label.
 * - On 404      : updates to 'جديد' (customer has no shipping history).
 * - On any other error : leaves as 'بدون' and logs the full Bosta response
 *   so we can diagnose the exact rejection reason.
 *
 * Never throws — the caller must NOT await this function.
 */
async function enrichDeliveryRate(orderId, phone) {
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
    return;
  }

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return;

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

    const ranking =
      res.data?.data?.consigneeRanking ??
      res.data?.consigneeRanking       ??
      res.data?.data                   ?? null;

    const mapped = mapRanking(ranking);
    if (!mapped) {
      console.warn(`⚠️  Bosta: unrecognised response shape for ${formattedPhone}`, res.data);
      return;
    }

    await pool.query(
      `UPDATE orders SET "DeliveryRate" = $1 WHERE id = $2 AND business_id = $3`,
      [mapped, orderId, businessId]
    );
    console.log(`✅  Bosta enrichment: order ${orderId} [${formattedPhone}] → ${mapped}`);

  } catch (err) {
    if (err.response?.status === 404) {
      await pool.query(
        `UPDATE orders SET "DeliveryRate" = 'جديد' WHERE id = $1 AND business_id = $2`,
        [orderId, businessId]
      ).catch(() => {});
      console.log(`📦  Bosta: order ${orderId} [${formattedPhone}] → جديد (no history)`);
    } else {
      console.error('❌ Bosta Live Sync Failed for phone:', formattedPhone);
      console.error('Status Code:', err.response?.status);
      console.error('Error Response Data:',
        JSON.stringify(err.response?.data || err.message, null, 2));
    }
  }
}

module.exports = { enrichDeliveryRate, formatPhone, mapRanking };
