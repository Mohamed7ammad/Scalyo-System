/* ─────────────────────────────────────────────────────────────────────────
   One-time migration: re-home misrouted Safqa webhook orders.

   The Safqa orderHook was registered against the WRONG tenant for a while
   (business_id = 1) before being corrected to the real tenant (business_id = 5).
   Valid historical orders are therefore stuck under business_id = 1 and never
   appear on tenant 5's affiliate dashboard. This script moves them.

   SAFE BY DESIGN:
     • Scoped strictly to network = 'safqa' AND business_id = <FROM>. No other
       network / tenant rows are ever touched.
     • The table's unique key is (network, external_id, business_id). If the SAME
       Safqa order was ALSO pushed to the correct tenant after the fix, a blind
       UPDATE would violate that unique index. So we only move rows whose
       external_id does NOT already exist under <TO>; genuine duplicates are
       reported (and only removed when you pass --purge-dupes).
     • Runs inside a transaction — all-or-nothing.

   Usage (from the backend/ directory):
     node src/scripts/migrateSafqaOrders.js                 # 1 → 5 (default)
     node src/scripts/migrateSafqaOrders.js 1 5             # explicit from → to
     node src/scripts/migrateSafqaOrders.js 1 5 --purge-dupes   # also delete leftover dups under FROM
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('../config/db');

async function main() {
  const args   = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flags  = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const FROM   = args[0] ? Number(args[0]) : 1;
  const TO     = args[1] ? Number(args[1]) : 5;
  const PURGE  = flags.includes('--purge-dupes');

  if (!Number.isInteger(FROM) || !Number.isInteger(TO) || FROM === TO) {
    console.error(`❌ Invalid arguments. FROM and TO must be distinct integers (got FROM=${args[0]}, TO=${args[1]}).`);
    process.exit(1);
  }

  console.log(`🔁 [migrateSafqaOrders] Moving Safqa orders: business_id ${FROM} → ${TO}${PURGE ? ' (will purge leftover duplicates)' : ''}\n`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* Snapshot before */
    const before = await client.query(
      `SELECT COUNT(*)::int AS n FROM external_affiliate_orders WHERE network = 'safqa' AND business_id = $1`,
      [FROM]
    );
    const totalUnderFrom = before.rows[0].n;

    if (totalUnderFrom === 0) {
      console.log(`ℹ️  No Safqa rows found under business_id = ${FROM}. Nothing to migrate.`);
      await client.query('COMMIT');
      return;
    }

    /* Move ONLY rows that won't collide with an existing (network, external_id) under TO. */
    const moved = await client.query(
      `UPDATE external_affiliate_orders u
          SET business_id = $2,
              updated_at  = NOW()
        WHERE u.network = 'safqa'
          AND u.business_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM external_affiliate_orders e
             WHERE e.network = 'safqa'
               AND e.business_id = $2
               AND e.external_id = u.external_id
          )
        RETURNING u.id`,
      [FROM, TO]
    );

    /* Whatever still sits under FROM after the move are duplicates already present under TO. */
    const leftover = await client.query(
      `SELECT external_id FROM external_affiliate_orders WHERE network = 'safqa' AND business_id = $1`,
      [FROM]
    );
    const dupes = leftover.rows.map((r) => r.external_id);

    let purged = 0;
    if (PURGE && dupes.length > 0) {
      const del = await client.query(
        `DELETE FROM external_affiliate_orders
          WHERE network = 'safqa' AND business_id = $1
          RETURNING id`,
        [FROM]
      );
      purged = del.rowCount;
    }

    await client.query('COMMIT');

    console.log(`✅ [migrateSafqaOrders] Done.`);
    console.log(`   • Rows under ${FROM} before : ${totalUnderFrom}`);
    console.log(`   • Moved ${FROM} → ${TO}      : ${moved.rowCount}`);
    console.log(`   • Duplicates kept under ${TO}: ${dupes.length}${dupes.length ? `  (external_ids: ${dupes.slice(0, 20).join(', ')}${dupes.length > 20 ? '…' : ''})` : ''}`);
    if (dupes.length > 0 && !PURGE) {
      console.log(`   ↳ ${dupes.length} duplicate row(s) remain under ${FROM} (already exist under ${TO}).`);
      console.log(`     Re-run with --purge-dupes to delete those redundant copies.`);
    }
    if (PURGE) {
      console.log(`   • Purged leftover dups under ${FROM}: ${purged}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [migrateSafqaOrders] Failed — rolled back, no changes applied:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
