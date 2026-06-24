'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Adham attribution — CORRECTED (supersedes fixAdhamAttribution.js).

   New ground truth (FB Ads + dashboard evidence): Adham's tracking comes ONLY
   from the EasyOrder `utm_campaign` field containing "adham" — NOT the Safqa
   moderator hash 69d90ab4fe096ac1b298dc41. So:

     A. The 39 rows currently marketer='adham' (the hash rows — their payloads do
        NOT mention adham) are NOT his → revert to 'main_account'.
     B. The orders whose utm_campaign contains 'adham' (created >= 2026-06-21) ARE
        his → set marketer='adham'. (These were wrongly reverted to main_account
        by the earlier, now-superseded fix.)

   READ-ONLY dry-run by default. Pass --apply to mutate (backup-first).
   Usage (from backend/):
     node src/scripts/fixAdhamUtm.js            # preview
     node src/scripts/fixAdhamUtm.js --apply     # backup + remediate
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const pool = require('../config/db');

const BIZ    = 5;
const SINCE  = '2026-06-21';
const APPLY  = process.argv.includes('--apply');
const BACKUP = 'eao_adham_utm_fix_bk_20260624';

/* A — wrongly-attributed hash rows (current adham, payload does NOT mention adham). */
const REVERT_PRED = `
  business_id = ${BIZ} AND network = 'safqa' AND marketer = 'adham'
  AND raw::text NOT ILIKE '%adham%'`;

/* B — Adham's REAL rows: utm_campaign contains adham, on/after he started. */
const ASSIGN_PRED = `
  business_id = ${BIZ} AND network = 'safqa'
  AND raw->>'utm_campaign' ILIKE '%adham%'
  AND COALESCE(created_at, updated_at) >= '${SINCE}'
  AND marketer IS DISTINCT FROM 'adham'`;

(async () => {
  const client = await pool.connect();
  try {
    const revert = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE ${REVERT_PRED}`)).rows[0].n;
    const assign = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE ${ASSIGN_PRED}`)).rows[0].n;
    const curAdham = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa' AND marketer='adham'`)).rows[0].n;

    console.log('── Adham utm_campaign remediation — preview ──');
    console.log(`  current marketer='adham'      : ${curAdham}`);
    console.log(`  A) hash rows → main_account   : ${revert}`);
    console.log(`  B) utm~adham → adham          : ${assign}`);
    console.log(`  → Adham AFTER                 : ${curAdham - revert + assign}`);

    const aStatus = await client.query(`
      SELECT status_class, COUNT(*)::int n, ROUND(SUM(total)::numeric,0) comm
        FROM external_affiliate_orders WHERE ${ASSIGN_PRED} GROUP BY 1 ORDER BY 1`);
    console.log('  Adham real-order status split [status | n | commission]:');
    for (const r of aStatus.rows) console.log(`     ${String(r.status_class).padEnd(10)} n=${String(r.n).padEnd(3)} comm=${r.comm}`);

    if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to back up and remediate.'); return; }

    await client.query('BEGIN');
    await client.query(`DROP TABLE IF EXISTS ${BACKUP}`);
    await client.query(`CREATE TABLE ${BACKUP} AS
      SELECT *, 'revert_to_main'::text AS _fix_action FROM external_affiliate_orders WHERE ${REVERT_PRED}
      UNION ALL
      SELECT *, 'assign_to_adham'::text AS _fix_action FROM external_affiliate_orders WHERE ${ASSIGN_PRED}`);
    const bk = (await client.query(`SELECT COUNT(*)::int n FROM ${BACKUP}`)).rows[0].n;

    const r1 = await client.query(`UPDATE external_affiliate_orders SET marketer='main_account', updated_at=NOW() WHERE ${REVERT_PRED}`);
    const r2 = await client.query(`UPDATE external_affiliate_orders SET marketer='adham',        updated_at=NOW() WHERE ${ASSIGN_PRED}`);
    await client.query('COMMIT');

    const after = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa' AND marketer='adham'`)).rows[0].n;
    console.log(`\n✅ Applied. Backed up ${bk} rows to ${BACKUP}; reverted ${r1.rowCount}, assigned ${r2.rowCount}. Adham now = ${after}.`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ fixAdhamUtm failed (rolled back):', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
