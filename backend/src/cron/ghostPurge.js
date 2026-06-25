'use strict';

/**
 * Ghost-order auto-purge cron (affiliate / Safqa).
 *
 * EasyOrder rows that fail to sync to Safqa (duplicates, test orders) linger in
 * external_affiliate_orders with no Safqa serial and no commission. The dashboard
 * already EXCLUDES them from every financial query the instant they have no serial
 * + no commission (the SAFQA_BACKED predicate), so they never touch the numbers —
 * but we still transition them to a `quarantined` state so the table stays clean.
 *
 * Hourly: quarantine any Safqa row with no 'sk-' serial AND total=0 older than 24h.
 * Idempotent and tenant-agnostic (purgeGhostOrders scans all tenants).
 */

const cron = require('node-cron');
const { purgeGhostOrders } = require('../services/externalAffiliate');

function startGhostPurgeCron() {
  /* Hourly at :45 (offset from Meta :00/:30 and Bosta :15 ticks). */
  cron.schedule('45 * * * *', async () => {
    try {
      await purgeGhostOrders({ graceHours: 24 });
    } catch (e) {
      console.error('[Cron] ghost purge failed:', e.message);
    }
  });
  console.log('✅  Affiliate ghost-order purge cron scheduled (hourly at :45, >24h grace)');
}

module.exports = { startGhostPurgeCron };
