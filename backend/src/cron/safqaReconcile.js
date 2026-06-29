'use strict';

/**
 * Safqa orphan reconciliation cron (affiliate / Business 5) — Layer 3.
 *
 * Safqa's public API is PUSH-ONLY (GET orders → HTTP 404), so there is nothing to
 * pull; the webhook is the only live source. The webhook (Layer 2) now CREATES an
 * orphan sk- row for any Safqa-only order with no EasyOrder match, and the EasyOrder
 * webhook (Layer 1) ADOPTS that orphan in place if it later arrives. This cron is the
 * SAFETY NET: if Layer-1's phone+product match ever misses (formatting drift), an
 * orphan sk- and a late EO UUID twin for the same order can coexist. Hourly it sweeps
 * the DATABASE and folds any such pair OLDER than GRACE (6h) into the serial-keyed sk-
 * row (the Safqa truth), deleting the EO twin. The grace window leaves in-flight
 * orders for Layer-1 to adopt first. Idempotent.
 *
 * Gated by SAFQA_RECONCILE=true (in addition to the global NODE_ENV=production gate).
 */

const cron = require('node-cron');
const { reconcileOrphanTwins } = require('../services/externalAffiliate');

/* Affiliate tenant(s) to reconcile. Business 5 = "سلعة" / Safqa network. */
const AFFILIATE_BUSINESS_IDS = [5];
const GRACE_HOURS = Number(process.env.SAFQA_RECONCILE_GRACE_HOURS) || 6;

function startSafqaReconcileCron() {
  if (String(process.env.SAFQA_RECONCILE).toLowerCase() !== 'true') {
    console.log('ℹ️  Safqa orphan reconciliation cron NOT started (set SAFQA_RECONCILE=true to enable).');
    return;
  }
  /* Hourly at :30 (offset from Meta :00, Bosta :15, ghost-purge :45). */
  cron.schedule('30 * * * *', async () => {
    for (const businessId of AFFILIATE_BUSINESS_IDS) {
      try {
        await reconcileOrphanTwins(businessId, { graceHours: GRACE_HOURS });
      } catch (e) {
        console.error(`[Cron] Safqa reconcile failed (tenant ${businessId}):`, e.message);
      }
    }
  });
  console.log(`✅  Safqa orphan reconciliation cron scheduled (hourly at :30, ${GRACE_HOURS}h grace).`);
}

module.exports = { startSafqaReconcileCron };
