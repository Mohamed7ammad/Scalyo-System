'use strict';

/**
 * «مؤجل» callbacks — see services/postponedCallbacks.js.
 *
 *   11:30 Cairo  rebalance: due callbacks held by absent / inactive / missing
 *                agents move to present agents (before the 12:00 start; also
 *                run when an agent is marked absent).
 *   23:05 Cairo  expiry: a callback still «مؤجل» the day after its date
 *                becomes «لا يرد» (→ no-answer cycle). Retried at 23:35; both
 *                jobs are idempotent, so a retry or a restart never doubles up.
 */

const cron = require('node-cron');
const { rebalanceDue, expireOverdue } = require('../services/postponedCallbacks');

let busy = false;
const guarded = (name, fn) => async () => {
  if (busy) return;
  busy = true;
  try {
    const r = await fn();
    if (r && (r.moved || r.expired || r.stuck)) console.log(`[CRON] 📞 postponed ${name}:`, JSON.stringify(r));
  } catch (e) {
    console.error(`[CRON] postponed ${name} failed:`, e.message);
  } finally {
    busy = false;
  }
};

function startPostponedCallbacksCron() {
  cron.schedule('30 11 * * *', guarded('rebalance', () => rebalanceDue()), { timezone: 'Africa/Cairo' });
  cron.schedule('5,35 23 * * *', guarded('expiry', () => expireOverdue()), { timezone: 'Africa/Cairo' });
  console.log('✅  [CRON] Postponed callbacks REGISTERED — rebalance 11:30, expiry 23:05/23:35 (Africa/Cairo).');
}

module.exports = { startPostponedCallbacksCron };
