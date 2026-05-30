'use strict';

/**
 * Automated Taager order-sync cron job.
 *
 * Every 2 hours, finds EVERY tenant that has a `taager_api_token` configured and
 * runs runTaagerSync(businessId) for each — pulling their latest Taager orders
 * into our internal DB so Products Profitability + the unified dashboard stay
 * fresh without anyone clicking "sync".
 *
 * Safety guarantees
 * ─────────────────
 * • Per-tenant isolation: each tenant runs in its own try/catch, so one failing
 *   merchant (bad token, API down) never aborts the others.
 * • Sequential execution: tenants are processed one-by-one to avoid hammering
 *   Taager's API and to keep DB connection usage flat.
 * • Re-entrancy guard: if a previous tick is still running (slow API / many
 *   tenants) the next tick is skipped instead of piling up.
 * • Uses the SAME runTaagerSync() as the manual POST /api/affiliate/taager/sync
 *   route, so behaviour is identical regardless of trigger source.
 */

const cron = require('node-cron');
const pool = require('../config/db');
const { NETWORK_KEYS } = require('../services/externalAffiliate');
const { runTaagerSync } = require('../services/taagerSync');

let _running = false;

/** Tenants (business_id) that have a non-empty Taager token saved. */
async function tenantsWithTaager() {
  const { rows } = await pool.query(
    `SELECT business_id
       FROM settings
      WHERE key = $1
        AND COALESCE(value, '') <> ''
        AND business_id IS NOT NULL`,
    [NETWORK_KEYS.taager.token]
  );
  return rows.map((r) => r.business_id);
}

async function runAllTenants() {
  if (_running) {
    console.warn('[Cron] ⏸️  Taager sync skipped — previous run still in progress.');
    return;
  }
  _running = true;

  try {
    const tenants = await tenantsWithTaager();
    if (tenants.length === 0) {
      console.log('[Cron] Taager sync — no tenants connected. Nothing to do.');
      return;
    }

    console.log(`[Cron] Taager sync starting for ${tenants.length} tenant(s)…`);
    let ok = 0, failed = 0;

    for (const businessId of tenants) {
      try {
        const r = await runTaagerSync(businessId);
        ok += 1;
        console.log(
          `[Cron] ✅ Taager tenant ${businessId}: ` +
          `fetched ${r.fetched}, upserted ${r.upserted}, new products ${r.productsCreated}`
        );
      } catch (err) {
        failed += 1;
        const status = err.response?.status;
        console.error(
          `[Cron] ⚠️  Taager tenant ${businessId} failed` +
          `${status ? ` (HTTP ${status})` : ''}: ${err.message}`
        );
        /* swallow — continue with the next tenant */
      }
    }

    console.log(`[Cron] Taager sync finished — ${ok} ok, ${failed} failed.`);
  } catch (err) {
    /* Never let the cron tick crash the process. */
    console.error('[Cron] ⚠️  Taager sync tick errored:', err.message);
  } finally {
    _running = false;
  }
}

function startTaagerSyncCron() {
  /* Every 2 hours, on the hour (00:00, 02:00, 04:00, …). */
  cron.schedule('0 */2 * * *', runAllTenants);
  console.log('✅  Taager order auto-sync cron scheduled (every 2 hours)');
}

module.exports = { startTaagerSyncCron, runAllTenants };
