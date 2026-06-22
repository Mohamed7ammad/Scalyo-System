'use strict';

/* ─────────────────────────────────────────────────────────────────────────
   fix-incident.js — purge the "FALSE-NEW" order batch re-inserted during the
   post-downtime chaos.

   THE INCIDENT (revised diagnosis):
     Before the downtime there were < 10 genuine 'جديد' orders. Afterwards there
     are ~216. A large batch of OLD, already-processed orders was accidentally
     re-imported as fresh 'جديد' rows. These must be DELETED, not re-enriched.

   THE TEST FOR "FALSE-NEW" (deliberately conservative):
     A 'جديد' row is false-new IFF another order for the SAME tenant exists with
     the SAME phone + SAME product but in a NON-'جديد' (processed) state — i.e.
     the order already lives in the system and has moved through the workflow.
     Genuine new orders have NO processed twin, so they are NEVER matched.

   SAFETY — this is irreversible deletion on a LIVE DB, so:
     • DRY-RUN by default. Prints what it WOULD delete; changes nothing.
       You must pass --commit to actually delete.
     • BACKUP-FIRST. On --commit it snapshots every matched row into a
       timestamped table BEFORE deleting, so the delete is fully reversible.
     • SAFETY ABORT. If ZERO processed orders exist, the "re-import" theory is
       wrong (real data loss) — it refuses to run and tells you to restore.
     • TIGHT MATCH + GUARDS. Phone compared on its last 10 digits (format-proof);
       product matched EXACTLY (under-matching is the safe failure direction).
       Rows that carry a Bosta tracking code or a customer deposit are EXCLUDED
       (they represent real activity/money and must be reviewed by hand).
     • TENANT-SCOPED. Twins are only matched within the same business_id.

   Usage (run from the backend/ directory):
     node fix-incident.js                         # DRY RUN, all tenants
     node fix-incident.js --biz 7                 # DRY RUN, only business_id=7
     node fix-incident.js --since 2026-06-21T18:00 # DRY RUN, only rows created at/after the downtime
     node fix-incident.js --since 2026-06-21T18:00 --commit   # BACKUP + DELETE

   RECOMMENDED: run the DRY RUN, eyeball the createdAt burst + twin-status
   breakdown + survivor count (should leave your ~<10 genuine new). Only then
   add --commit. To UNDO after a commit: re-insert from the printed backup table.
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('./src/config/db');

/* ── Args ─────────────────────────────────────────────────────────────────── */
const argv   = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const flagVal = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const argBiz   = flagVal('--biz') ? Number(flagVal('--biz')) : null;
const argSince = flagVal('--since');               // ISO timestamp lower bound on "createdAt"

const NEW = 'جديد';

const log  = (...a) => console.log(...a);
const rule = () => log('─'.repeat(72));

/* ── Shared match predicate ───────────────────────────────────────────────────
   $1 = since (timestamptz | null), $2 = business_id (int | null).
   A candidate 'جديد' row `n` that has a processed twin `t`.
   NOTE: '\\D' in JS source becomes the SQL regex '\D' (any non-digit).         */
const MATCH = `
  FROM orders n
  WHERE n."Status" = '${NEW}'
    AND n."BostaTrackingCode" IS NULL
    AND COALESCE(n."hasDeposit", false) = false
    AND COALESCE(n."depositAmount", 0) = 0
    AND length(regexp_replace(COALESCE(n."Phone",''), '\\D', '', 'g')) >= 10
    AND ($1::timestamptz IS NULL OR n."createdAt" >= $1::timestamptz)
    AND ($2::int IS NULL OR n.business_id = $2::int)
    AND EXISTS (
      SELECT 1 FROM orders t
       WHERE t.business_id = n.business_id
         AND t.id <> n.id
         AND t."Status" <> '${NEW}'                       -- twin already processed
         AND COALESCE(t."ProductName",'') = COALESCE(n."ProductName",'')
         AND right(regexp_replace(COALESCE(t."Phone",''), '\\D', '', 'g'), 10)
           = right(regexp_replace(COALESCE(n."Phone",''), '\\D', '', 'g'), 10)
    )`;

async function main() {
  rule();
  log(`  fix-incident.js — FALSE-NEW purge`);
  log(`  mode  : ${COMMIT ? '⚠️  COMMIT (will back up then DELETE)' : '🔍 DRY-RUN (read-only)'}`);
  log(`  scope : ${argBiz ? `business_id=${argBiz}` : 'ALL tenants'}` +
      `${argSince ? ` · createdAt >= ${argSince}` : ' · no time window'}`);
  rule();

  const params = [argSince, argBiz];

  /* ── SAFETY GATE: processed orders must still exist ──────────────────────── */
  const { rows: procRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders
      WHERE "Status" <> '${NEW}' ${argBiz ? 'AND business_id = $1' : ''}`,
    argBiz ? [argBiz] : []
  );
  const processed = procRows[0].n;
  log(`  processed (non-'${NEW}') orders present : ${processed}`);
  if (processed === 0) {
    log(`\n🛑 ABORT: zero processed orders exist. That is real data loss, NOT a`);
    log(`   re-import. Do NOT delete anything — restore from a Supabase backup / PITR.\n`);
    return;
  }

  /* ── Counts: total new vs. matched false-new ─────────────────────────────── */
  const { rows: totRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders
      WHERE "Status" = '${NEW}'
        ${argSince ? `AND "createdAt" >= $1::timestamptz` : ''}
        ${argBiz ? `AND business_id = ${argSince ? '$2' : '$1'}::int` : ''}`,
    argSince && argBiz ? [argSince, argBiz] : argSince ? [argSince] : argBiz ? [argBiz] : []
  );
  const totalNew = totRows[0].n;

  const { rows: matched } = await pool.query(
    `SELECT n.id, n.business_id, n."FullName", n."Phone", n."ProductName", n."createdAt" ${MATCH}
      ORDER BY n."createdAt" DESC, n.id DESC`,
    params
  );

  log(`\n[ANALYSIS]`);
  log(`  total '${NEW}' orders in scope        : ${totalNew}`);
  log(`  └─ matched as FALSE-NEW (to delete) : ${matched.length}`);
  log(`  └─ survivors (genuine new, kept)    : ${totalNew - matched.length}`);

  if (matched.length === 0) {
    log(`\n✅ Nothing matches the false-new fingerprint in this scope. Nothing to do.`);
    log(`   (If you expected matches, widen scope or check --since / --biz.)\n`);
    return;
  }

  /* ── Twin-status breakdown: WHAT states the originals are in ─────────────── */
  const { rows: twinBreak } = await pool.query(
    `SELECT t."Status" AS twin_status, COUNT(DISTINCT n.id)::int AS n
       FROM orders n
       JOIN orders t
         ON t.business_id = n.business_id
        AND t.id <> n.id
        AND t."Status" <> '${NEW}'
        AND COALESCE(t."ProductName",'') = COALESCE(n."ProductName",'')
        AND right(regexp_replace(COALESCE(t."Phone",''), '\\D','','g'),10)
          = right(regexp_replace(COALESCE(n."Phone",''), '\\D','','g'),10)
      WHERE n."Status" = '${NEW}'
        AND n."BostaTrackingCode" IS NULL
        AND COALESCE(n."hasDeposit", false) = false
        AND ($1::timestamptz IS NULL OR n."createdAt" >= $1::timestamptz)
        AND ($2::int IS NULL OR n.business_id = $2::int)
      GROUP BY t."Status" ORDER BY n DESC`,
    params
  );
  log(`\n  twin (original) states of the matched batch:`);
  for (const r of twinBreak) log(`     ${String(r.n).padStart(5)}  ×  twin in '${r.twin_status}'`);

  /* ── createdAt burst: confirm it's a clustered re-import, not organic ───── */
  const { rows: hist } = await pool.query(
    `SELECT to_char(date_trunc('hour', n."createdAt"), 'YYYY-MM-DD HH24:00') AS hour,
            COUNT(*)::int AS n ${MATCH} GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
    params
  );
  log(`\n  createdAt histogram (matched rows, newest 12 hours):`);
  for (const r of hist) log(`     ${r.hour}   ${'█'.repeat(Math.min(40, r.n))} ${r.n}`);

  log(`\n  sample (newest 15):`);
  for (const r of matched.slice(0, 15)) {
    log(`     #${r.id} biz=${r.business_id}  ${r.Phone || '—'}  ${(r.ProductName || '—').slice(0, 28)}` +
        `  ${new Date(r.createdAt).toISOString()}`);
  }

  if (!COMMIT) {
    rule();
    log(`  DRY-RUN — nothing changed.`);
    log(`  If the histogram looks like a burst, the twins are processed states,`);
    log(`  and survivors ≈ your genuine new count, re-run with --commit:`);
    log(`     node fix-incident.js${argBiz ? ` --biz ${argBiz}` : ''}` +
        `${argSince ? ` --since ${argSince}` : ''} --commit`);
    rule();
    return;
  }

  /* ── COMMIT: backup-first, then delete in one transaction ────────────────── */
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupTable = `orders_falsenew_backup_${stamp}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TABLE ${backupTable} AS SELECT n.* ${MATCH}`,
      params
    );
    const { rows: bk } = await client.query(`SELECT COUNT(*)::int AS n FROM ${backupTable}`);
    const del = await client.query(
      `DELETE FROM orders WHERE id IN (SELECT id FROM ${backupTable})
         AND "Status" = '${NEW}' RETURNING id`
    );
    await client.query('COMMIT');
    rule();
    log(`  💾 Backed up ${bk[0].n} row(s) → table "${backupTable}"`);
    log(`  🗑️  Deleted   ${del.rowCount} false-new order(s)`);
    log(`  ✅ Survivors remaining ('${NEW}'): ${totalNew - del.rowCount}`);
    log(`\n  UNDO if needed:   INSERT INTO orders SELECT * FROM ${backupTable};`);
    log(`  When satisfied:   DROP TABLE ${backupTable};`);
    rule();
  } catch (err) {
    await client.query('ROLLBACK');
    log(`\n❌ Rolled back — nothing deleted: ${err.message}`);
    log(`   (A foreign-key reference here means an order isn't safe to auto-delete.)`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => { console.error('\n❌ fix-incident.js failed:', err); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
