/* ─────────────────────────────────────────────────────────────────────────
   One-off cleanup: remove stale `comm_no_answer` treasury transactions.

   After tightening the commission rules, a `comm_no_answer` expense is only
   legitimate when the order is:

       Status = 'لا يرد'  AND  no_answer_logs has >= 5 logged attempts

   Everything else is stale and must be deleted:
     • 'مؤجل' (postponed) orders — these no longer earn any automatic commission
     • 'لا يرد' orders with < 5 logged call attempts (anti-abuse rule)
     • any other status that somehow carries a comm_no_answer row

   This runs across ALL tenants (each order_id belongs to exactly one business,
   so the rule is universal). It is idempotent — running it again deletes nothing.

   Usage (from the backend/ directory):
       node src/scripts/cleanupCommissions.js
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('../config/db');

/* Keep a row ONLY when the order is 'لا يرد' with >= 5 attempts; delete the rest. */
const STALE_PREDICATE = `
  t.source = 'comm_no_answer'
  AND NOT (
    o."Status" = 'لا يرد'
    AND COALESCE(jsonb_array_length(o."no_answer_logs"), 0) >= 5
  )
`;

async function main() {
  console.log('🧹 [cleanupCommissions] Starting stale comm_no_answer cleanup…\n');

  // 1) Preview — show what is about to be removed (grouped by order status).
  const preview = await pool.query(`
    SELECT o."Status" AS status,
           COALESCE(jsonb_array_length(o."no_answer_logs"), 0) AS attempts,
           COUNT(*)        AS rows,
           SUM(t.amount)   AS total_amount
    FROM   treasury_transactions t
    JOIN   orders o ON o.id = t.order_id
    WHERE  ${STALE_PREDICATE}
    GROUP  BY o."Status", attempts
    ORDER  BY rows DESC
  `);

  if (preview.rows.length === 0) {
    console.log('✅ Nothing to clean — all comm_no_answer records are already valid.');
    await pool.end();
    process.exit(0);
  }

  console.log('Rows to be deleted (grouped):');
  let totalRows = 0;
  let totalAmount = 0;
  for (const r of preview.rows) {
    totalRows += Number(r.rows);
    totalAmount += Number(r.total_amount || 0);
    console.log(
      `  • status="${r.status}" attempts=${r.attempts} → ${r.rows} row(s), ${Number(r.total_amount || 0).toFixed(2)} EGP`
    );
  }
  console.log(`\n  TOTAL: ${totalRows} row(s), ${totalAmount.toFixed(2)} EGP\n`);

  // 2) Delete.
  const del = await pool.query(`
    DELETE FROM treasury_transactions t
    USING  orders o
    WHERE  t.order_id = o.id
      AND  ${STALE_PREDICATE}
  `);

  console.log(`🗑️  Deleted ${del.rowCount} stale comm_no_answer transaction(s).`);
  console.log('✅ [cleanupCommissions] Done. Agent balances now reflect strict math.');

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [cleanupCommissions] Failed:', err.message);
  process.exit(1);
});
