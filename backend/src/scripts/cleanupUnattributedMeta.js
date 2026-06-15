/* ─────────────────────────────────────────────────────────────────────────
   One-off cleanup: purge GARBAGE Meta-sync expense rows — campaigns that had
   no valid product SKU and were historically stored under sku = 'UNATTRIBUTED'.
   These inflate Ad Spend and skew profitability. The sync now drops such
   campaigns at ingestion, but pre-existing rows must be removed once.

   STRICTLY SCOPED — the DELETE only ever touches rows where BOTH hold:
       meta_sync = TRUE          → a synced Meta Ads row (NOT a manual expense;
                                   manual expenses are meta_sync = FALSE)
       sku       = 'UNATTRIBUTED' → the sentinel for "no recognisable SKU"
   Manual expenses (meta_sync = FALSE) and valid-SKU campaign rows (real
   uppercase SKU codes) can NEVER match, so they are never deleted.

   SAFE BY DEFAULT — runs as a DRY RUN (reports what WOULD be deleted, deletes
   nothing). Pass --commit to actually perform the DELETE.

   Usage (from the backend/ directory):
     node src/scripts/cleanupUnattributedMeta.js              # DRY RUN, all tenants
     node src/scripts/cleanupUnattributedMeta.js --commit     # DELETE, all tenants
     node src/scripts/cleanupUnattributedMeta.js 7            # DRY RUN, tenant 7 only
     node src/scripts/cleanupUnattributedMeta.js 7 --commit   # DELETE, tenant 7 only
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('../config/db');

/* The ONLY predicate used for both the preview and the delete — single source
   of truth so the dry run reports EXACTLY what the commit would remove. */
const TARGET_WHERE = `meta_sync = TRUE AND sku = 'UNATTRIBUTED'`;

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

async function main() {
  const args   = process.argv.slice(2);
  const commit = args.includes('--commit');
  const bizArg = args.find((a) => /^\d+$/.test(a));
  const businessId = bizArg ? Number(bizArg) : null;

  /* business_id filter is optional; $1 IS NULL OR ... makes it a no-op when unset. */
  const scopeSql = `${TARGET_WHERE} AND ($1::int IS NULL OR business_id = $1::int)`;
  const params   = [businessId];

  console.log(
    `🧹 [cleanupUnattributedMeta] ${commit ? 'COMMIT (will DELETE)' : 'DRY RUN (no changes)'} — ` +
    `scope: ${businessId ? `tenant ${businessId}` : 'all tenants'}\n`
  );

  /* ── 1. Preview: totals + per-tenant breakdown of the EXACT rows targeted ── */
  const summary = await pool.query(
    `SELECT COUNT(*)::int                         AS rows,
            COALESCE(SUM(amount), 0)              AS spend,
            COALESCE(SUM(meta_purchases), 0)::int AS meta_orders
       FROM expenses
      WHERE ${scopeSql}`,
    params
  );
  const { rows, spend, meta_orders } = summary.rows[0];

  if (rows === 0) {
    console.log('✅ Nothing to clean — no UNATTRIBUTED Meta-sync rows match the scope.');
    await pool.end();
    process.exit(0);
  }

  const perTenant = await pool.query(
    `SELECT business_id,
            COUNT(*)::int            AS rows,
            COALESCE(SUM(amount), 0) AS spend
       FROM expenses
      WHERE ${scopeSql}
      GROUP BY business_id
      ORDER BY business_id`,
    params
  );

  console.log('Rows targeted per tenant:');
  for (const t of perTenant.rows) {
    console.log(`  • tenant ${t.business_id}: ${fmt(t.rows)} row(s), spend ${fmt(parseFloat(t.spend).toFixed(2))} EGP`);
  }
  console.log(
    `\nTOTAL: ${fmt(rows)} row(s) · ${fmt(parseFloat(spend).toFixed(2))} EGP ad spend · ` +
    `${fmt(meta_orders)} Meta order(s) would be removed.`
  );

  /* ── 2. Dry run stops here ── */
  if (!commit) {
    console.log('\nℹ️  DRY RUN — nothing was deleted. Re-run with --commit to apply.');
    await pool.end();
    process.exit(0);
  }

  /* ── 3. Commit: delete exactly the previewed rows ── */
  const del = await pool.query(
    `DELETE FROM expenses WHERE ${scopeSql} RETURNING id`,
    params
  );

  console.log(`\n✅ Deleted ${fmt(del.rowCount)} UNATTRIBUTED Meta-sync row(s). Ad Spend totals are now clean.`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [cleanupUnattributedMeta] Failed:', err.message);
  process.exit(1);
});
