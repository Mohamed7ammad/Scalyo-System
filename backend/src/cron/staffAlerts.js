'use strict';

/**
 * Automated staff-alert cron job.
 *
 * Every 12 hours, emails staff members who have pending orders ('جديد'/'مؤجل')
 * that have gone stale (no activity past the threshold). Uses the same
 * checkAndSendStaffAlerts() as the admin manual-trigger endpoint, so behaviour
 * is identical regardless of trigger source.
 *
 * Safety: a re-entrancy guard prevents overlapping runs, and the alert function
 * itself never throws — so a tick can never crash the process.
 */

const cron = require('node-cron');
const { checkAndSendStaffAlerts } = require('../services/alerts');

let _running = false;

async function runTick() {
  if (_running) {
    console.warn('[Cron] ⏸️  Staff alerts skipped — previous run still in progress.');
    return;
  }
  _running = true;
  try {
    console.log('[Cron] Staff alerts — scanning for delayed pending orders…');
    const r = await checkAndSendStaffAlerts();
    console.log(`[Cron] ✅ Staff alerts complete — ${r.alerted_staff_count} staff alerted (${r.groups} group(s)).`);
  } catch (err) {
    console.error('[Cron] ⚠️  Staff alerts tick errored:', err.message);
  } finally {
    _running = false;
  }
}

function startStaffAlertsCron() {
  /* Every 12 hours, on the hour (00:00 and 12:00). */
  cron.schedule('0 */12 * * *', runTick);
  console.log('✅  Staff-alerts cron scheduled (every 12 hours)');
}

module.exports = { startStaffAlertsCron };
