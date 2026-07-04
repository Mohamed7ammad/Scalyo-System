/* ════════════════════════════════════════════════════════════════════════════
   REPAIR: returned orders corrupted to 'جديد' by the status-dropdown fallback
   ════════════════════════════════════════════════════════════════════════════

   BACKGROUND
   The admin inline status <select> in OrdersTable was missing the return states
   ('جاري الإعادة' / 'تم الإرجاع') from its options, so returned orders DISPLAYED
   as 'جديد' and one click could genuinely overwrite the real status in the DB.
   The UI hole is fixed (commit e2f6340); this script repairs the data.

   SUSPECT DEFINITION
   "Status" = 'جديد' AND "BostaTrackingCode" IS NOT NULL — a fresh order can
   never carry a tracking code. CAVEAT: deliberately reverted orders (an admin
   resetting a returned order to re-work it) match the same signature, which is
   why nothing is written without evidence + an explicit flag.

   EVIDENCE (LOCAL ONLY — ZERO Bosta API calls, account is currently blocked)
     1. product_returns.order_id match
          → the physical return was received & restocked  → 'تم الإرجاع'
     2. return_collections.tracking_number match (same tenant)
          → parcel was in Bosta's returning bucket        → 'جاري الإعادة'
     3. no local evidence
          → provably DISPATCHED, terminal state unknown   → 'تم الشحن'
            (the hourly reconcileInTransitOrders cron — already rate-limit-safe —
             will advance it to its true state once it's back in scope)

   USAGE
     node src/scripts/repairCorruptedReturnedOrders.js                  # dry-run (default)
     node src/scripts/repairCorruptedReturnedOrders.js --apply          # fix evidence-backed rows (buckets 1+2)
     node src/scripts/repairCorruptedReturnedOrders.js --apply --apply-unproven
                                                                        # ALSO move bucket 3 to 'تم الشحن'
     node src/scripts/repairCorruptedReturnedOrders.js --apply --exclude-ids=123,456
                                                                        # skip known deliberate reverts

   SAFETY
     • Dry-run by default — prints the full classification, writes nothing.
     • Only the "Status" column is touched. Stock is NEVER re-processed here:
       the webhook already restocked bucket-1 orders when the return arrived,
       and re-running the restock would double the inventory.
     • Every applied change is recorded in orders_status_repair_log
       (old status, new status, evidence, timestamp) for audit/rollback:
         UPDATE orders o SET "Status" = l.old_status
         FROM orders_status_repair_log l
         WHERE l.order_id = o.id AND l.repaired_at::date = '<run date>';
   ════════════════════════════════════════════════════════════════════════════ */

require('dotenv').config();
const pool = require('../config/db');

const APPLY          = process.argv.includes('--apply');
const APPLY_UNPROVEN = process.argv.includes('--apply-unproven');
const EXCLUDE_IDS = (() => {
  const arg = process.argv.find((a) => a.startsWith('--exclude-ids='));
  if (!arg) return new Set();
  return new Set(
    arg.split('=')[1].split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger)
  );
})();

async function main() {
  console.log(`\n🔧 [repair] Corrupted-returned-orders repair — ${APPLY ? 'APPLY MODE' : 'DRY-RUN (nothing will be written)'}\n`);

  /* Audit log table (idempotent). */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders_status_repair_log (
      id          SERIAL PRIMARY KEY,
      order_id    INTEGER      NOT NULL,
      business_id INTEGER,
      old_status  VARCHAR(50),
      new_status  VARCHAR(50),
      evidence    TEXT,
      repaired_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  /* One pass: suspects + both evidence joins. LEFT JOINs keep no-evidence rows. */
  const { rows: suspects } = await pool.query(`
    SELECT o.id,
           o.business_id,
           o."FullName"          AS full_name,
           o."Phone"             AS phone,
           o."ProductName"       AS product_name,
           o."BostaTrackingCode" AS tracking,
           o."updatedAt"         AS updated_at,
           (pr.id  IS NOT NULL)  AS physically_returned,
           (rc.id  IS NOT NULL)  AS in_returning_bucket
    FROM   orders o
    LEFT   JOIN product_returns    pr ON pr.order_id = o.id
    LEFT   JOIN return_collections rc ON rc.tracking_number = o."BostaTrackingCode"
                                     AND rc.business_id     = o.business_id
    WHERE  o."Status" = 'جديد'
      AND  o."BostaTrackingCode" IS NOT NULL
      AND  TRIM(o."BostaTrackingCode") <> ''
    ORDER  BY o.business_id, o.id
  `);

  if (!suspects.length) {
    console.log('✅ No suspect rows found (Status=جديد with a Bosta tracking code). Nothing to repair.\n');
    return;
  }

  /* Classify. Physical return (bucket 1) outranks returning-bucket (bucket 2). */
  const buckets = { returned: [], returning: [], unproven: [], excluded: [] };
  for (const s of suspects) {
    if (EXCLUDE_IDS.has(s.id))       { buckets.excluded.push(s); continue; }
    if (s.physically_returned)       { buckets.returned.push(s);  continue; }
    if (s.in_returning_bucket)       { buckets.returning.push(s); continue; }
    buckets.unproven.push(s);
  }

  const printBucket = (title, rows, target) => {
    console.log(`\n── ${title} — ${rows.length} order(s)${target ? ` → '${target}'` : ''} ──`);
    for (const r of rows) {
      console.log(
        `   #${String(r.id).padEnd(7)} biz=${String(r.business_id).padEnd(3)} ` +
        `${(r.full_name || '—').slice(0, 22).padEnd(24)} ${(r.phone || '—').padEnd(13)} ` +
        `${(r.tracking || '—').padEnd(16)} updated=${new Date(r.updated_at).toISOString().slice(0, 10)}`
      );
    }
  };

  printBucket('Bucket 1: physical return logged (product_returns)', buckets.returned, 'تم الإرجاع');
  printBucket('Bucket 2: seen in Bosta returning bucket (return_collections)', buckets.returning, 'جاري الإعادة');
  printBucket('Bucket 3: NO local evidence — dispatched, terminal state unknown', buckets.unproven, APPLY_UNPROVEN ? 'تم الشحن' : null);
  if (buckets.excluded.length) printBucket('Excluded via --exclude-ids (untouched)', buckets.excluded, null);

  console.log(
    `\n📋 Summary: ${suspects.length} suspect(s) → ` +
    `${buckets.returned.length} تم الإرجاع, ${buckets.returning.length} جاري الإعادة, ` +
    `${buckets.unproven.length} unproven, ${buckets.excluded.length} excluded.`
  );
  if (buckets.unproven.length && !APPLY_UNPROVEN) {
    console.log(
      `⚠️  Bucket 3 rows may include DELIBERATE manual reverts (re-work flow).\n` +
      `   Review them with the team first; re-run with --apply-unproven to move\n` +
      `   them to 'تم الشحن' so the hourly Bosta reconcile resolves their true state,\n` +
      `   or exclude specific ids via --exclude-ids=…`
    );
  }

  if (!APPLY) {
    console.log(`\n💡 Dry-run complete. Re-run with --apply to write the fixes above.\n`);
    return;
  }

  /* ── Apply — status column ONLY, one transaction, full audit trail ───────── */
  const plan = [
    { rows: buckets.returned,  status: 'تم الإرجاع',   evidence: 'product_returns.order_id match (restock already done by webhook)' },
    { rows: buckets.returning, status: 'جاري الإعادة', evidence: 'return_collections tracking match (Bosta returning bucket)' },
  ];
  if (APPLY_UNPROVEN) {
    plan.push({ rows: buckets.unproven, status: 'تم الشحن', evidence: 'no local evidence — restored to dispatched state for the reconcile cron to resolve' });
  }

  const client = await pool.connect();
  let fixed = 0;
  try {
    await client.query('BEGIN');
    for (const { rows, status, evidence } of plan) {
      for (const r of rows) {
        /* Guarded UPDATE: only flips the row if it is STILL 'جديد' right now,
           so a concurrent webhook/agent write between scan and apply wins. */
        const upd = await client.query(
          `UPDATE orders SET "Status" = $1, "updatedAt" = NOW()
           WHERE id = $2 AND business_id = $3 AND "Status" = 'جديد'
           RETURNING id`,
          [status, r.id, r.business_id]
        );
        if (!upd.rows.length) {
          console.log(`   ↷ #${r.id} skipped — status changed since the scan.`);
          continue;
        }
        await client.query(
          `INSERT INTO orders_status_repair_log (order_id, business_id, old_status, new_status, evidence)
           VALUES ($1, $2, 'جديد', $3, $4)`,
          [r.id, r.business_id, status, evidence]
        );
        fixed++;
      }
    }
    await client.query('COMMIT');
    console.log(`\n✅ Applied: ${fixed} order(s) repaired. Audit trail in orders_status_repair_log.\n`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ [repair] Failed:', err);
    process.exit(1);
  });
