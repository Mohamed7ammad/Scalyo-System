'use strict';

/**
 * Automated Meta Ads sync cron job.
 *
 * Runs every 30 minutes and syncs spend + purchase data for:
 *   • yesterday  — catches late-night spend that Meta finalises after midnight
 *   • today      — keeps today's running totals fresh during the day
 *
 * Uses the same runMetaSync() function as the manual POST /api/meta/sync
 * route so the logic is always identical regardless of trigger source.
 *
 * Safety guarantees
 * ─────────────────
 * • If Meta credentials are not configured the first run logs a 400 and skips.
 * • If the Meta API returns any error (blocked account, expired token,
 *   rate-limit) a 2-hour cooldown is automatically activated by runMetaSync.
 *   The cron checks isCronCoolingDown() BEFORE calling the API so it never
 *   hammers a restricted endpoint.
 * • The expenses DB table is NEVER touched when an API error occurs — all
 *   data fetching completes before any DB write begins, and the DELETE has
 *   been permanently disabled.  Existing historical data is always safe.
 * • The dashboard (analytics.js) queries the DB independently of the sync,
 *   so it always serves whatever historical data is stored, regardless of
 *   whether the most recent sync succeeded.
 */

const cron = require('node-cron');
const { runMetaSync, isCronCoolingDown } = require('../routes/meta');

/* ── Date helpers (server local time) ─────────────────────────────────────── */

function localDateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/* ── Cron setup ───────────────────────────────────────────────────────────── */

function startMetaSyncCron() {
  /* Run at :00 and :30 of every hour, every day.
     node-cron v3/v4 uses the standard 5-field cron expression.             */
  cron.schedule('0,30 * * * *', async () => {
    /* ── Cooldown gate ──────────────────────────────────────────────────────
       If the previous sync hit an API error (blocked account, expired token,
       rate-limit) runMetaSync activates a 2-hour cooldown.  We skip this
       tick entirely so we never hammer a restricted endpoint.  The dashboard
       continues serving historical data from the DB during the cooldown.   */
    if (isCronCoolingDown()) {
      console.warn('[Cron] ⏸️  Meta sync skipped — API-error cooldown is active. Dashboard serving historical data. Will retry after cooldown expires.');
      return;
    }

    const yesterday = localDateStr(-1);
    const today     = localDateStr(0);

    console.log(`[Cron] Auto-syncing Meta Ads for ${yesterday} → ${today}`);

    try {
      /* ignoreCooldown is NOT set here — cron syncs are gated by the cooldown.
         (The manual POST /api/meta/sync route passes ignoreCooldown: true so
         the admin can always test a refreshed token immediately from the UI.) */
      const result = await runMetaSync(yesterday, today);
      console.log(
        `[Cron] ✅ Meta sync complete — ` +
        `${result.daysInserted} day(s), ` +
        `${result.campaignRowsInserted} campaign-row(s), ` +
        `total spend: ${result.totalSpend} EGP`
      );
    } catch (err) {
      /* Don't crash the process — log and wait for the next tick.
         The cooldown was already set inside runMetaSync before this throw,
         so the next N ticks will be silently skipped until it expires.      */
      if (err.isCooldown) {
        /* Shouldn't reach here (we check isCronCoolingDown above) but just
           in case of a race between two concurrent syncs.                   */
        return;
      }
      console.error(`[Cron] ⚠️  Meta sync failed (${err.statusCode ?? 'ERR'}): ${err.message}`);
    }
  });

  console.log('✅  Meta Ads auto-sync cron scheduled (every 30 minutes)');
}

module.exports = { startMetaSyncCron };
