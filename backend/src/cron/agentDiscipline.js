'use strict';

/**
 * Confirmation-team discipline cron — Stage 1.
 *
 * Every minute, in Cairo time:
 *   1. seed today's rows for every enrolled, present agent (idempotent; the
 *      first tick after midnight creates the day);
 *   2. close breaks that reached their cap;
 *   3. mark checkpoints missed once due + grace + 1 min passes, and withdraw
 *      those agents' 'جديد' + 'لا يرد' orders to compliant agents.
 * Every step is idempotent, so a restart or a slow tick never double-withdraws,
 * and a restart at 11:44 still catches the 11:30 checkpoint on the next tick.
 * PM2 runs this backend as ONE fork-mode process, so the job fires once per
 * minute; if it ever moves to cluster mode, guard run() with
 * pg_try_advisory_lock.
 * (Stage 2 adds the 15-minute inactivity check to this same tick.)
 */

const cron = require('node-cron');
const {
  schemaReady, seedToday, closeExpiredBreaks, enforceCheckpoints,
} = require('../services/agentDiscipline');

let running = false;   // never overlap two ticks in this process

async function runDisciplineTick() {
  if (running) return;
  running = true;
  try {
    await schemaReady;
    await seedToday();
    await closeExpiredBreaks();
    const withdrawn = await enforceCheckpoints();
    if (withdrawn.length) {
      console.log(`[CRON] ⛔ discipline: ${withdrawn.length} agent(s) withdrawn — ` +
        withdrawn.map((w) => `${w.email} @${w.checkpoint} (${w.orders_moved} orders)`).join(', '));
    }
  } catch (e) {
    console.error('[CRON] discipline tick failed:', e.message);
  } finally {
    running = false;
  }
}

function startAgentDisciplineCron() {
  cron.schedule('* * * * *', runDisciplineTick, { timezone: 'Africa/Cairo' });
  console.log('✅  [CRON] Confirmation-team discipline REGISTERED — every minute (Africa/Cairo): seeding, breaks, 15-min auto-withdrawal.');
}

module.exports = { startAgentDisciplineCron, runDisciplineTick };
