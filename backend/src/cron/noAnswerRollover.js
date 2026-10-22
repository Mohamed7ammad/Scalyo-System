'use strict';

/**
 * No-answer («لا يرد») nightly hand-off — 23:30 Cairo.
 *
 * Replaces the Team Leader's manual 7 PM sweep: owner stage (2 days) → review
 * (2 days, a different review/both agent each night) → «ملغي - عدم رد نهائي».
 * See services/noAnswerCycles.js.
 *
 * Scheduled at 23:30 with retries at 23:40 and 23:50: each (business, date)
 * runs ONCE (run row in no_answer_rollover_runs), so the retries only matter
 * when a deploy/restart swallowed the 23:30 tick. Never after midnight — that
 * would be the NEXT day's hand-off. PM2 runs one fork-mode process.
 */

const cron = require('node-cron');
const { runRollover } = require('../services/noAnswerCycles');

let running = false;

async function runNoAnswerRollover() {
  if (running) return;
  running = true;
  try {
    const results = await runRollover();
    for (const r of results) {
      if (r.skipped) continue;
      if (r.error) { console.error(`[CRON] no-answer rollover business ${r.business_id} failed: ${r.error}`); continue; }
      console.log(`[CRON] 📞 no-answer rollover ${r.date} business ${r.business_id}: ` +
        `→review ${r.to_review} · re-dealt ${r.redeal} · rescued ${r.rescue} · closed ${r.close}` +
        (r.stay ? ` · kept ${r.stay}` : '') + (r.stuck ? ` · ⚠️ stuck ${r.stuck} (no eligible reviewer)` : '') +
        (r.raced ? ` · skipped ${r.raced} (changed meanwhile)` : ''));
    }
  } catch (e) {
    console.error('[CRON] no-answer rollover failed:', e.message);
  } finally {
    running = false;
  }
}

function startNoAnswerRolloverCron() {
  cron.schedule('30,40,50 23 * * *', runNoAnswerRollover, { timezone: 'Africa/Cairo' });
  console.log('✅  [CRON] No-answer hand-off REGISTERED — 23:30 Cairo (retries 23:40/23:50, once per day): owner 2d → review 2d → «ملغي - عدم رد نهائي».');
}

module.exports = { startNoAnswerRolloverCron, runNoAnswerRollover };
