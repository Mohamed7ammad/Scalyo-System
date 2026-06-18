/* ─────────────────────────────────────────────────────────────────────────
   One-time cleanup: collapse Safqa order DUPLICATES caused by an ID-scheme
   mismatch, and normalise every row to the stable serial key.

   THE BUG IT FIXES
   ────────────────
   The CSV import keyed rows by Safqa's serial ("sk-…", = "كود الطلب"). The live
   webhook keyed rows by the Mongo `_id` (24-hex ObjectId). They are the SAME
   orders under two different keys, so webhook status pushes inserted ObjectId
   rows instead of updating the imported serial rows → the order count grew past
   the real Safqa total.

   recordSafqaOrder now keys on serial_number (going forward), but rows already
   written under an ObjectId key must be reconciled. Every webhook row carries
   the serial inside its `raw` payload (raw->>'serial_number'), so we can:

     1) MERGE — for an ObjectId row whose serial already exists as a row, copy its
        status/total onto the surviving serial row IF the ObjectId row is newer
        (so the latest status wins), then DELETE the ObjectId duplicate.
     2) RE-KEY — for an ObjectId row whose serial has no row yet (a genuinely new
        order only ever seen via the webhook), rewrite external_id = serial.

   Result: exactly one serial-keyed row per order; no duplicates. Idempotent and
   transactional (all-or-nothing). Safe to re-run.

   Usage (from backend/):
     node src/scripts/dedupeSafqaBySerial.js --dry      # preview, no writes
     node src/scripts/dedupeSafqaBySerial.js            # all tenants
     node src/scripts/dedupeSafqaBySerial.js 5          # only business_id = 5
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('../config/db');

/* An ObjectId external_id is exactly 24 lowercase hex chars; a serial is "sk-…". */
const OBJECTID_RE = `external_id ~ '^[0-9a-f]{24}$'`;

async function main() {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const args  = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const DRY   = flags.includes('--dry');
  const bizArg = args[0] ? Number(args[0]) : null;
  if (args[0] && !Number.isInteger(bizArg)) {
    console.error(`❌ Invalid business_id "${args[0]}".`);
    process.exit(1);
  }
  const bizFilter = bizArg ? `AND business_id = ${bizArg}` : '';

  console.log(`🧹 [dedupeSafqaBySerial] ${DRY ? 'DRY RUN — no writes. ' : ''}Scope: ${bizArg ? `business ${bizArg}` : 'ALL tenants'}\n`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* Diagnosis (always shown). */
    const diag = await client.query(`
      WITH oid AS (
        SELECT id, business_id, raw->>'serial_number' AS serial
        FROM external_affiliate_orders
        WHERE network='safqa' AND ${OBJECTID_RE} ${bizFilter}
      )
      SELECT
        (SELECT COUNT(*) FROM external_affiliate_orders WHERE network='safqa' ${bizFilter})::int AS total_before,
        COUNT(*)::int AS objectid_rows,
        COUNT(*) FILTER (WHERE serial IS NULL OR serial = '')::int AS missing_serial,
        COUNT(*) FILTER (WHERE serial IS NOT NULL AND serial <> '' AND EXISTS (
          SELECT 1 FROM external_affiliate_orders e
          WHERE e.network='safqa' AND e.business_id = oid.business_id AND e.external_id = oid.serial))::int AS dupes,
        COUNT(*) FILTER (WHERE serial IS NOT NULL AND serial <> '' AND NOT EXISTS (
          SELECT 1 FROM external_affiliate_orders e
          WHERE e.network='safqa' AND e.business_id = oid.business_id AND e.external_id = oid.serial))::int AS rekey
      FROM oid`);
    const d = diag.rows[0];
    console.log('📊 Before:');
    console.log(`   Total safqa rows      : ${d.total_before}`);
    console.log(`   ObjectId-keyed rows   : ${d.objectid_rows}`);
    console.log(`   → duplicates to merge : ${d.dupes}`);
    console.log(`   → new, to re-key      : ${d.rekey}`);
    console.log(`   → missing serial (skip): ${d.missing_serial}\n`);

    if (DRY) {
      await client.query('ROLLBACK');
      console.log('✅ Dry run complete — NO changes written. Re-run without --dry to apply.');
      return;
    }

    /* 1) MERGE the latest status/total from each ObjectId dupe onto the surviving
          serial row (only when the webhook row is newer), then delete the dupe. */
    const merged = await client.query(`
      UPDATE external_affiliate_orders s
         SET status       = o.status,
             status_ar    = o.status_ar,
             status_class = o.status_class,
             total        = o.total,
             updated_at   = GREATEST(s.updated_at, o.updated_at)
        FROM external_affiliate_orders o
       WHERE o.network='safqa' AND ${OBJECTID_RE.replace(/external_id/g, 'o.external_id')} ${bizFilter ? `AND o.business_id = ${bizArg}` : ''}
         AND o.raw->>'serial_number' IS NOT NULL AND o.raw->>'serial_number' <> ''
         AND s.network='safqa' AND s.business_id = o.business_id
         AND s.external_id = o.raw->>'serial_number'
         AND o.updated_at > s.updated_at
      RETURNING s.id`);

    const deleted = await client.query(`
      DELETE FROM external_affiliate_orders o
       WHERE o.network='safqa' AND ${OBJECTID_RE.replace(/external_id/g, 'o.external_id')} ${bizFilter ? `AND o.business_id = ${bizArg}` : ''}
         AND o.raw->>'serial_number' IS NOT NULL AND o.raw->>'serial_number' <> ''
         AND EXISTS (
           SELECT 1 FROM external_affiliate_orders e
           WHERE e.network='safqa' AND e.business_id = o.business_id
             AND e.external_id = o.raw->>'serial_number')
      RETURNING o.id`);

    /* 2) RE-KEY the remaining ObjectId rows (genuinely new orders) to their serial. */
    const rekeyed = await client.query(`
      UPDATE external_affiliate_orders o
         SET external_id = o.raw->>'serial_number', updated_at = NOW()
       WHERE o.network='safqa' AND ${OBJECTID_RE.replace(/external_id/g, 'o.external_id')} ${bizFilter ? `AND o.business_id = ${bizArg}` : ''}
         AND o.raw->>'serial_number' IS NOT NULL AND o.raw->>'serial_number' <> ''
      RETURNING o.id`);

    const totalAfter = await client.query(
      `SELECT COUNT(*)::int AS n FROM external_affiliate_orders WHERE network='safqa' ${bizFilter}`);

    await client.query('COMMIT');

    console.log('✅ Applied:');
    console.log(`   Status merged onto serial rows : ${merged.rowCount}`);
    console.log(`   Duplicate ObjectId rows deleted: ${deleted.rowCount}`);
    console.log(`   New rows re-keyed to serial    : ${rekeyed.rowCount}`);
    console.log(`   Total safqa rows AFTER         : ${totalAfter.rows[0].n}`);
    console.log('\n✅ Done. Every order is now a single serial-keyed row — duplicate-free.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [dedupeSafqaBySerial] Failed — rolled back, no changes applied:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    process.exit();
  }
}

main();
