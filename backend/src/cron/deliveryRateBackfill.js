'use strict';

/**
 * DeliveryRate re-enrichment cron (Bosta consignee reputation).
 *
 * enrichDeliveryRate fires fire-and-forget at order creation, but Bosta rate-limits
 * the consignee-ranking endpoint (HTTP 429, errorCode 4029). The shared bostaQueue
 * retries a 429 up to BOSTA_QUEUE_MAX_RETRIES times then GIVES UP — leaving the order
 * stranded at 'بدون' with no further attempt. Under the higher order volume the
 * EasyOrder integration drives into the ecom tenant, that stranded fraction grows
 * (~26% observed) because calls exceed Bosta's ceiling.
 *
 * This sweep re-enqueues a BOUNDED batch of stranded orders every run onto the SAME
 * rate-limited ENRICH lane, so they drain to a real rating over time WITHOUT bursting
 * past the 429 limit. Once an order enriches it is no longer 'بدون' and is never
 * re-picked → idempotent and self-terminating as the backlog clears.
 *
 * Gentle by design: small batch + the global queue does the pacing. Tenant-scoped to
 * businesses with an ACTIVE Bosta integration (enrichDeliveryRate resolves each
 * order's own tenant + token internally). Gated by NODE_ENV=production.
 *
 * Tunables (env-overridable):
 *   DELIVERY_RATE_BACKFILL_BATCH         orders re-enqueued per run   (default 40)
 *   DELIVERY_RATE_BACKFILL_MAX_AGE_DAYS  only retry orders newer than (default 14)
 */

const cron = require('node-cron');
const pool = require('../config/db');
const { enrichDeliveryRate } = require('../services/bostaEnrich');

const BATCH        = Number(process.env.DELIVERY_RATE_BACKFILL_BATCH)        || 40;
const MAX_AGE_DAYS = Number(process.env.DELIVERY_RATE_BACKFILL_MAX_AGE_DAYS) || 14;

function startDeliveryRateBackfillCron() {
  /* Every 20 min at :05/:25/:45 — offset from Meta (:00/:30), Bosta reconcile (:15),
     Safqa reconcile (:30) and ghost-purge (:45 hourly) to spread outbound load. */
  cron.schedule('5,25,45 * * * *', async () => {
    try {
      const { rows } = await pool.query(
        `SELECT o.id, o."Phone"
           FROM orders o
           JOIN shipping_settings s
                ON s.business_id   = o.business_id
               AND s.provider_name = 'bosta'
               AND s.is_active     = true
          WHERE o."DeliveryRate" = 'بدون'
            AND o."Phone" IS NOT NULL AND o."Phone" <> ''
            AND o."createdAt" > NOW() - ($1 || ' days')::interval
          ORDER BY o."createdAt" DESC
          LIMIT $2`,
        [String(MAX_AGE_DAYS), BATCH]
      );
      if (!rows.length) return;
      console.log(`[deliveryRateBackfill] re-enriching ${rows.length} order(s) stranded at بدون`);
      // fire-and-forget onto the rate-limited ENRICH lane; the queue paces them.
      for (const o of rows) enrichDeliveryRate(o.id, o.Phone);
    } catch (e) {
      console.error('[Cron] deliveryRate backfill failed:', e.message);
    }
  });
  console.log(`✅  DeliveryRate re-enrichment cron scheduled (every 20m, batch ${BATCH}, <${MAX_AGE_DAYS}d).`);
}

module.exports = { startDeliveryRateBackfillCron };
