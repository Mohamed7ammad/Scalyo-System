'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Quarantine non-Safqa "ghost" orders (business 5).

   A ghost = an EasyOrder row that was never synced to Safqa: no Safqa serial
   (external_id NOT LIKE 'sk-%') AND no realized commission (total=0). These have
   no Safqa wallet backing, so they must not appear in any financial metric.

   The dashboard already EXCLUDES them via the SAFQA_BACKED predicate in
   externalAffiliate.js (serial OR realized commission), so this script is the
   audit/cleanup half: it adds a `quarantined` flag and marks them, so they are
   visibly tagged and can be reviewed (or revived if they later sync to Safqa).
   Idempotent + backup-first. READ-ONLY dry-run unless --apply.

   Usage (from backend/):
     node src/scripts/quarantineGhosts.js          # preview
     node src/scripts/quarantineGhosts.js --apply
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const pool = require('../config/db');

const BIZ    = 5;
const APPLY  = process.argv.includes('--apply');
const BACKUP = 'eao_ghost_quarantine_bk_20260624';
const GHOST_PRED = `business_id = ${BIZ} AND network = 'safqa'
  AND external_id NOT LIKE 'sk-%' AND COALESCE(total, 0) = 0`;

(async () => {
  const client = await pool.connect();
  try {
    const n = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE ${GHOST_PRED}`)).rows[0].n;
    const byMk = await client.query(`
      SELECT marketer, COUNT(*)::int n FROM external_affiliate_orders WHERE ${GHOST_PRED}
       GROUP BY 1 ORDER BY n DESC`);
    console.log(`Ghost orders (UUID + total=0): ${n}`);
    for (const r of byMk.rows) console.log(`   ${String(r.marketer).padEnd(20)} ${r.n}`);

    if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to flag them.'); return; }

    await client.query('BEGIN');
    await client.query(`ALTER TABLE external_affiliate_orders ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`DROP TABLE IF EXISTS ${BACKUP}`);
    await client.query(`CREATE TABLE ${BACKUP} AS SELECT * FROM external_affiliate_orders WHERE ${GHOST_PRED}`);
    const bk = (await client.query(`SELECT COUNT(*)::int n FROM ${BACKUP}`)).rows[0].n;
    const upd = await client.query(`UPDATE external_affiliate_orders SET quarantined = TRUE WHERE ${GHOST_PRED}`);
    await client.query('COMMIT');

    const live = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa' AND NOT quarantined`)).rows[0].n;
    console.log(`\n✅ Flagged ${upd.rowCount} ghosts as quarantined (backup ${BACKUP}, ${bk} rows). Non-quarantined Safqa rows now: ${live} (target 969).`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ quarantineGhosts failed (rolled back):', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
