/* ─────────────────────────────────────────────────────────────────────────
   One-off: re-sync Meta Ads spend for a FULL date range.

   WHY: the cron only syncs yesterday + today, so historical campaign-day rows
   keep whatever campaign NAME they had when first synced. After you RENAME
   campaigns in Meta (e.g. to add a Safqa SKU), those historical rows stay stale
   until a full-range re-sync re-fetches them. runMetaSync now REPLACES each
   account's rows within the synced window (delete-in-range + insert), so this
   refreshes the names cleanly with no duplicates / double spend.

   Meta insights return the campaign's CURRENT name for every date, so one full
   re-sync lands the new names across the whole history.

   Usage (from backend/):
     node src/scripts/resyncMetaRange.js 2026-05-01 2026-06-18           # all accounts
     node src/scripts/resyncMetaRange.js 2026-05-01 2026-06-18 5         # only business 5
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const { runMetaSync } = require('../routes/meta');

async function main() {
  const args = process.argv.slice(2);
  const startDate  = args[0];
  const endDate    = args[1];
  const businessId = args[2] ? Number(args[2]) : null;

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(startDate || '') || !DATE_RE.test(endDate || '')) {
    console.error('Usage: node src/scripts/resyncMetaRange.js <startDate YYYY-MM-DD> <endDate YYYY-MM-DD> [businessId]');
    process.exit(1);
  }
  if (args[2] && !Number.isInteger(businessId)) {
    console.error(`Invalid businessId "${args[2]}".`);
    process.exit(1);
  }

  console.log(`🔄 Re-syncing Meta Ads ${startDate} → ${endDate}${businessId ? ` for business ${businessId}` : ' (all active accounts)'} …\n`);
  try {
    /* ignoreCooldown so a prior API-error cooldown doesn't block this manual backfill. */
    const r = await runMetaSync(startDate, endDate, { ignoreCooldown: true, businessId });
    console.log('\n✅ Done.');
    console.log(`   Accounts synced : ${r.accountsSynced}`);
    console.log(`   Days inserted   : ${r.daysInserted}`);
    console.log(`   Campaign rows   : ${r.campaignRowsInserted}`);
    console.log(`   Total spend     : ${r.totalSpend}`);
  } catch (err) {
    console.error('❌ Failed:', err.message);
    process.exitCode = 1;
  }
  process.exit();
}

main();
