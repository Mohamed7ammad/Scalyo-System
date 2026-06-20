/* ─────────────────────────────────────────────────────────────────────────
   ONE-OFF INCIDENT CLEANUP — delete the duplicate 'جديد' orders created when the
   backend was booted locally (NODE_ENV unset) and the Google-Sheets sync
   re-INSERTed sheet rows as fresh orders.

   This script is DELIBERATELY conservative:
     • DRY-RUN by default — prints what it WOULD delete and changes nothing.
       You must pass --commit to actually delete.
     • SAFETY ABORT — if NO confirmed/shipped/delivered orders exist at all, the
       "duplicate" theory is wrong (real data was lost), so it refuses to run and
       tells you to restore from a Supabase backup / PITR instead.
     • BACKUP-FIRST — on --commit it snapshots every matched row into a
       timestamped backup table BEFORE deleting, so the delete is reversible.
     • PRECISE MATCH — only targets a new-window row that is 'جديد' + 'بدون' +
       has NO Bosta tracking + has NO sheet_row_index (i.e. inserted by the old
       pre-idempotency code) AND has an OLDER twin (same Phone + ProductName that
       already existed BEFORE the incident window). Genuinely-new orders that
       happen to be 'جديد' are therefore NOT touched.

   Usage (from the backend/ directory):
     node src/scripts/cleanup-duplicates.js                      # DRY RUN, default tenant, last 2h
     node src/scripts/cleanup-duplicates.js 7 3                  # DRY RUN, business_id=7, last 3h
     node src/scripts/cleanup-duplicates.js 7 3 --commit         # DELETE (backup-first)

   Recommended: run the DRY RUN first, confirm the count ≈ the ~600 you expect,
   then re-run with --commit. To undo after a --commit, re-insert from the
   printed backup table name.
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('../config/db');

const COMMIT = process.argv.includes('--commit');
/* positional args (ignore the --commit flag) */
const positional = process.argv.slice(2).filter((a) => a !== '--commit');
const argBiz   = positional[0] ? Number(positional[0]) : null;
const argHours = positional[1] ? Number(positional[1]) : 2;

const CONFIRMED_STATUSES = ['تم التأكيد', 'تم الشحن', 'تم التوصيل', 'جاري الإعادة', 'تم الإرجاع'];

/* The duplicate fingerprint, shared by the preview SELECT and the backup INSERT.
   $1 = business_id, $2 = window hours. */
const MATCH_WHERE = `
  FROM orders n
  WHERE n.business_id = $1
    AND n."createdAt"      > NOW() - make_interval(hours => $2::int)
    AND n."Status"         = 'جديد'
    AND n."DeliveryRate"   = 'بدون'
    AND n."BostaTrackingCode" IS NULL
    AND n.sheet_row_index  IS NULL          -- inserted by the OLD pre-idempotency sync
    AND EXISTS (
      SELECT 1 FROM orders o
       WHERE o.business_id = n.business_id
         AND o.id <> n.id
         AND o."Phone" = n."Phone"
         AND COALESCE(o."ProductName",'') = COALESCE(n."ProductName",'')
         AND o."createdAt" < NOW() - make_interval(hours => $2::int)   -- the pre-incident original
    )`;

async function resolveBusinessId() {
  if (argBiz) return argBiz;
  /* The sheet sync claims orders for the ORIGINAL tenant (lowest business_profile.id). */
  const { rows } = await pool.query('SELECT MIN(id) AS id FROM business_profile');
  return rows[0]?.id ?? null;
}

async function main() {
  const businessId = await resolveBusinessId();
  if (!businessId) {
    console.error('❌ Could not resolve a business_id (no business_profile rows?). Aborting.');
    process.exit(1);
  }

  console.log(`\n🧹 [cleanup-duplicates] tenant=${businessId} · window=${argHours}h · mode=${COMMIT ? 'COMMIT (will delete)' : 'DRY RUN'}\n`);

  /* ── SAFETY GATE — confirmed orders must still exist ──────────────────────
     If they don't, this is NOT a duplicate-insertion incident; real rows were
     deleted/mutated and the only safe recovery is a Supabase backup / PITR. */
  const { rows: confRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders
      WHERE business_id = $1 AND "Status" = ANY($2)`,
    [businessId, CONFIRMED_STATUSES]
  );
  const confirmedLike = confRows[0].n;
  console.log(`   confirmed/shipped/delivered orders currently present: ${confirmedLike}`);
  if (confirmedLike === 0) {
    console.error(
      '\n🛑 ABORT: zero confirmed-like orders exist. This is real data loss, NOT duplicates.\n' +
      '   Do NOT delete anything. Restore from Supabase Backups / PITR to just before the\n' +
      '   local boot, then re-run this only if duplicates remain.\n'
    );
    await pool.end();
    process.exit(2);
  }

  /* ── Preview the matched duplicates ──────────────────────────────────────── */
  const { rows: matched } = await pool.query(
    `SELECT n.id, n."FullName", n."Phone", n."ProductName", n."createdAt" ${MATCH_WHERE}
     ORDER BY n."createdAt" DESC`,
    [businessId, argHours]
  );
  console.log(`   duplicate rows matched: ${matched.length}`);
  console.log('   sample (newest 20):');
  for (const r of matched.slice(0, 20)) {
    console.log(`     #${r.id}  ${r.Phone || '—'}  ${r.ProductName || '—'}  ${new Date(r.createdAt).toISOString()}`);
  }

  if (matched.length === 0) {
    console.log('\n✅ Nothing matches the duplicate fingerprint. Nothing to do.\n');
    await pool.end();
    process.exit(0);
  }

  if (!COMMIT) {
    console.log(
      `\nℹ️  DRY RUN — nothing was changed. If the ${matched.length} row(s) above look right,\n` +
      `   re-run with --commit to back them up and delete them:\n` +
      `     node src/scripts/cleanup-duplicates.js ${argBiz ?? ''} ${argHours} --commit\n`
    );
    await pool.end();
    process.exit(0);
  }

  /* ── COMMIT path: backup-first, then delete ──────────────────────────────── */
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const backupTable = `orders_dupe_backup_${stamp}`;

  await pool.query(
    `CREATE TABLE ${backupTable} AS
       SELECT n.* ${MATCH_WHERE}`,
    [businessId, argHours]
  );
  const { rows: bk } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${backupTable}`);
  console.log(`\n💾 Backed up ${bk[0].n} row(s) into table "${backupTable}".`);

  const del = await pool.query(
    `DELETE FROM orders WHERE id IN (SELECT id FROM ${backupTable}) RETURNING id`
  );
  console.log(`🗑️  Deleted ${del.rowCount} duplicate order(s).`);
  console.log(
    `\n✅ Done. To UNDO: \n` +
    `     INSERT INTO orders SELECT * FROM ${backupTable};\n` +
    `   Once you're satisfied, drop the backup: DROP TABLE ${backupTable};\n`
  );

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [cleanup-duplicates] Failed:', err.message);
  process.exit(1);
});
