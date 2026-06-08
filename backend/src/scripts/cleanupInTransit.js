/* ─────────────────────────────────────────────────────────────────────────
   One-off cleanup: purge cancelled / refused ("بدون تحصيل") parcels out of the
   forward "قيد التوصيل" (In Transit) bucket so it is 100% pure.

   A parcel is moved to 'جاري الإعادة' (in-transit return leg) when it is stuck in
   'تم الشحن' or 'تم التأكيد' AND either:

     1. Bosta's AUTHORITATIVE buckets say it is on the return leg / cancelled —
        handled by reconcileInTransitOrders() (matches by Bosta state code, no COD
        guessing). Skipped automatically when the tenant has no Bosta credentials.

     2. Its collectable COD has been ZEROED ("بدون تحصيل") AND it actually had a COD
        to collect (net forward COD = ProductPrice − deposit > 0, so genuinely
        prepaid orders are never touched).

   'جاري الإعادة' is the RETURN LEG: NO stock is restored here. Stock is restocked
   only when the parcel is PHYSICALLY received ('تم الإرجاع' / Bosta code 46) via the
   webhook or the "مزامنة المرتجعات" sync. This script is idempotent — re-running it
   moves nothing new once everything is reconciled.

   Usage (from the backend/ directory):
     node src/scripts/cleanupInTransit.js            # all tenants
     node src/scripts/cleanupInTransit.js 7          # only business_id = 7
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('../config/db');
const { reconcileInTransitOrders } = require('../routes/bosta');

/* net forward COD = ProductPrice (digits only) − deposit. > 0 means a real COD. */
const NET_COD_SQL = `
  (COALESCE(NULLIF(regexp_replace("ProductPrice"::text, '[^0-9.]', '', 'g'), '')::numeric, 0)
   - COALESCE("depositAmount", 0))`;

/* Pass 2 — DB sweep: any 'تم الشحن'/'تم التأكيد' COD order whose expected_cod has
   already been zeroed by Bosta → return leg. */
async function sweepCodZero(businessId) {
  const r = await pool.query(
    `UPDATE orders
        SET "Status" = 'جاري الإعادة',
            expected_cod = 0,
            bosta_action_required = FALSE,
            "updatedAt" = NOW()
      WHERE business_id = $1
        AND "Status" IN ('تم الشحن', 'تم التأكيد')
        AND expected_cod IS NOT NULL
        AND expected_cod = 0
        AND ${NET_COD_SQL} > 0
      RETURNING id`,
    [businessId]
  );
  return r.rowCount || 0;
}

async function main() {
  const argBiz = process.argv[2] ? Number(process.argv[2]) : null;

  let businesses;
  if (argBiz) {
    businesses = [argBiz];
  } else {
    const b = await pool.query(
      `SELECT DISTINCT business_id FROM orders WHERE business_id IS NOT NULL ORDER BY business_id`
    );
    businesses = b.rows.map((r) => r.business_id);
  }

  console.log(`🧹 [cleanupInTransit] Purging cancelled/refused parcels for ${businesses.length} tenant(s): ${businesses.join(', ')}\n`);

  let totalBucket = 0;
  let totalSweep = 0;

  for (const biz of businesses) {
    // Pass 1 — Bosta-authoritative bucket reconcile (best-effort; needs creds).
    let bucket = { reclassified: 0 };
    try {
      const res = await reconcileInTransitOrders(biz);
      if (res && !res.skipped) bucket = res;
      else if (res && res.skipped) console.log(`  • tenant ${biz}: Bosta reconcile skipped (${res.reason})`);
    } catch (e) {
      console.warn(`  • tenant ${biz}: Bosta reconcile failed (continuing with DB sweep): ${e.message}`);
    }

    // Pass 2 — DB COD-zero sweep.
    const swept = await sweepCodZero(biz);

    totalBucket += bucket.reclassified || 0;
    totalSweep += swept;
    console.log(`  • tenant ${biz}: bucket→${bucket.reclassified || 0} reclassified, COD-zero sweep→${swept} moved`);
  }

  console.log(
    `\n✅ [cleanupInTransit] Done. ${totalBucket} via Bosta buckets + ${totalSweep} via COD-zero sweep ` +
    `= ${totalBucket + totalSweep} order(s) moved to 'جاري الإعادة'. "قيد التوصيل" is now pure.`
  );

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [cleanupInTransit] Failed:', err.message);
  process.exit(1);
});
