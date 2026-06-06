'use strict';

/**
 * Bosta in-transit reconciliation cron.
 *
 * Webhooks can be missed and Bosta's intermediate return-leg states (the ":R"
 * state codes, e.g. 21:R) don't carry a status string our webhook acts on — so a
 * parcel being processed for RETURN can linger in our DB as 'تم الشحن' with its
 * original price, inflating the dashboard's in-transit count + Outstanding Cash.
 *
 * Every hour we pull Bosta's authoritative returning + action-required buckets and
 * reconcile each tenant's 'تم الشحن' orders (see reconcileInTransitOrders):
 *   • returning bucket → 'جاري الإعادة' (out of the forward pipeline)
 *   • action-required  → expected_cod ← Bosta's live COD
 *
 * The reconcile is idempotent and tenant-scoped, so re-runs converge safely.
 */

const cron = require('node-cron');
const pool = require('../config/db');
const { reconcileInTransitOrders } = require('../routes/bosta');

function startBostaReconcileCron() {
  /* Hourly at :15 (offset from the Meta sync's :00/:30 ticks). */
  cron.schedule('15 * * * *', async () => {
    let tenants = [];
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT business_id
           FROM shipping_settings
          WHERE provider_name = 'bosta' AND is_active = true AND business_id IS NOT NULL`
      );
      tenants = rows.map((r) => r.business_id);
    } catch (e) {
      console.error('[Cron] Bosta reconcile — tenant lookup failed:', e.message);
      return;
    }

    for (const businessId of tenants) {
      try {
        await reconcileInTransitOrders(businessId);
      } catch (e) {
        console.error(`[Cron] Bosta reconcile failed for tenant ${businessId}: ${e.message}`);
      }
    }
  });

  console.log('✅  Bosta in-transit reconciliation cron scheduled (hourly at :15)');
}

module.exports = { startBostaReconcileCron };
