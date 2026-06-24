'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Fix Adham's attribution (business 5).

   FINDING: 72 rows are currently marketer='adham'. Only the 39 carrying Adham's
   Safqa moderator hash (69d90ab4fe096ac1b298dc41) are genuinely his. The other 33
   (10 EasyOrder-webhook rows with NO referral_code + 23 organic Safqa rows) were
   originally 'main_account' and were wrongly swept into 'adham' by a prior manual
   backfill. This reverts those 33 back to 'main_account', leaving Adham = 39.

   The 39 to KEEP are identified as the current-adham rows whose external_id is
   recorded with marketer = the hash in the pre-restore snapshot
   eao_filesync_bk_20260624 (verified to contain exactly those 39).

   READ-ONLY dry-run by default. Pass --apply to mutate (backup-first).
   Usage (from backend/):
     node src/scripts/fixAdhamAttribution.js            # preview only
     node src/scripts/fixAdhamAttribution.js --apply     # backup + revert
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const pool = require('../config/db');

const BIZ   = 5;
const HASH  = '69d90ab4fe096ac1b298dc41';
const APPLY = process.argv.includes('--apply');
const BACKUP = 'eao_adham_revert_bk_20260624';

/* The 39 genuine rows: current adham rows whose serial is hash-marked in the
   pre-restore snapshot. Everything else currently adham gets reverted. */
const KEEP_PREDICATE = `
  e.business_id = ${BIZ} AND e.network = 'safqa' AND e.marketer = 'adham'
  AND e.external_id IN (
    SELECT external_id FROM eao_filesync_bk_20260624
     WHERE LOWER(marketer) = '${HASH}')`;

const REVERT_PREDICATE = `
  e.business_id = ${BIZ} AND e.network = 'safqa' AND e.marketer = 'adham'
  AND e.external_id NOT IN (
    SELECT external_id FROM eao_filesync_bk_20260624
     WHERE LOWER(marketer) = '${HASH}')`;

(async () => {
  const client = await pool.connect();
  try {
    const keep   = await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders e WHERE ${KEEP_PREDICATE}`);
    const revert = await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders e WHERE ${REVERT_PREDICATE}`);
    const total  = await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa' AND marketer='adham'`);

    console.log('── Adham attribution fix — preview ──');
    console.log(`  current adham total : ${total.rows[0].n}`);
    console.log(`  KEEP as adham (39)  : ${keep.rows[0].n}`);
    console.log(`  REVERT→main_account : ${revert.rows[0].n}`);

    // Show the revert set split by status for transparency
    const split = await client.query(`
      SELECT (e.external_id LIKE 'sk-%') AS safqa_serial, e.status_class,
             COUNT(*)::int n, ROUND(SUM(e.total)::numeric,0) comm
        FROM external_affiliate_orders e WHERE ${REVERT_PREDICATE}
       GROUP BY 1,2 ORDER BY 1,2`);
    console.log('  revert set [type | status | n | commission]:');
    for (const r of split.rows)
      console.log(`     ${r.safqa_serial ? 'sk-' : 'EO '} ${String(r.status_class).padEnd(10)} n=${String(r.n).padEnd(3)} comm=${r.comm}`);

    if (!APPLY) {
      console.log('\nDry-run only. Re-run with --apply to back up and revert.');
      return;
    }

    if (keep.rows[0].n !== 39) {
      throw new Error(`SAFETY ABORT: expected to keep 39 rows, computed ${keep.rows[0].n}. No changes made.`);
    }

    await client.query('BEGIN');
    // 1. Snapshot the rows we are about to change (full row, for rollback)
    await client.query(`DROP TABLE IF EXISTS ${BACKUP}`);
    await client.query(`CREATE TABLE ${BACKUP} AS
      SELECT * FROM external_affiliate_orders e WHERE ${REVERT_PREDICATE}`);
    const bk = await client.query(`SELECT COUNT(*)::int n FROM ${BACKUP}`);
    // 2. Revert
    const upd = await client.query(`
      UPDATE external_affiliate_orders e
         SET marketer = 'main_account', updated_at = NOW()
       WHERE ${REVERT_PREDICATE}`);
    await client.query('COMMIT');

    const after = await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa' AND marketer='adham'`);
    console.log(`\n✅ Applied. Backed up ${bk.rows[0].n} rows to ${BACKUP}; reverted ${upd.rowCount}. Adham now = ${after.rows[0].n}.`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ fixAdhamAttribution failed (rolled back):', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
