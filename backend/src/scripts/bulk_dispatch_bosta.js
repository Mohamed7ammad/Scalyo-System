/* ─────────────────────────────────────────────────────────────────────────
   bulk_dispatch_bosta.js — one-off backlog processor.

   Pushes EVERY order stuck at receiving-status (DeliveryRate) 'بدون' through the
   shared Bosta queue (services/bostaQueue) to re-run the Bosta consignee-ranking
   lookup that fills in حالة الاستلام. These orders are stuck because the earlier
   429 rate-limit storm blocked their enrichment, leaving DeliveryRate = 'بدون'.

   Why a script (not the UI): ~350 orders × the queue gap can take many minutes —
   far longer than a browser request would tolerate. Running in the terminal lets
   you watch it drain slowly and safely.

   GUARANTEE: every call goes through enqueueBosta, so it strictly respects
   BOSTA_QUEUE_GAP_MS (set to 3000ms in your .env) + 429 back-off. No bursts.

   Usage (from the backend/ directory, so .env is loaded):
       node src/scripts/bulk_dispatch_bosta.js
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('../config/db');
const { enrichDeliveryRate } = require('../services/bostaEnrich');
const { bostaQueueLength, LANES } = require('../services/bostaQueue');

const PENDING_RATE = 'بدون';   // receiving-status default that enrichment overwrites

async function main() {
  const gap = Number(process.env.BOSTA_QUEUE_GAP_MS) || 1500;
  console.log('🚚 [bulk_dispatch_bosta] Starting backlog processor…');
  console.log(`   ⏱  Queue gap: ${gap}ms between Bosta calls (BOSTA_QUEUE_GAP_MS)`);
  const etaMin = (n) => Math.ceil((n * gap) / 1000 / 60);

  /* 1) Fetch every order stuck at DeliveryRate = 'بدون' with a usable phone.
        Spans all tenants — enrichDeliveryRate resolves each order's own
        business_id + Bosta credentials internally, so isolation is preserved. */
  const { rows } = await pool.query(
    `SELECT id, "Phone"
       FROM orders
      WHERE "DeliveryRate" = $1
        AND "Phone" IS NOT NULL
        AND TRIM("Phone") <> ''
      ORDER BY id ASC`,
    [PENDING_RATE]
  );

  if (rows.length === 0) {
    console.log(`✅ No orders stuck at DeliveryRate='${PENDING_RATE}'. Nothing to do.`);
    await pool.end();
    process.exit(0);
  }

  const total = rows.length;
  console.log(`📦 Found ${total} order(s) at '${PENDING_RATE}'. Estimated time: ~${etaMin(total)} min.`);
  console.log('   Feeding them into the shared Bosta queue (one at a time)…\n');

  /* 2) Enqueue each order. enqueueBosta drains serially with the gap + 429
        back-off. We attach a per-order progress log as each completes. */
  let done = 0;
  let ok = 0;
  let failed = 0;

  const tasks = rows.map((o) =>
    enrichDeliveryRate(o.id, o.Phone)
      .then(() => { ok += 1; })
      .catch(() => { failed += 1; })   // enrichDeliveryRate already swallows errors; defensive
      .finally(() => {
        done += 1;
        if (done % 10 === 0 || done === total) {
          console.log(
            `⏳ Progress: ${done}/${total} processed ` +
            `(${bostaQueueLength(LANES.ENRICH)} still waiting in queue) — ` +
            `~${etaMin(total - done)} min left`
          );
        }
      })
  );

  await Promise.all(tasks);

  console.log(`\n🎉 Done. Processed ${total} order(s) — ${ok} ok, ${failed} errored.`);
  console.log('   (Per-order results are logged above by bostaEnrich.)');
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ [bulk_dispatch_bosta] Fatal error:', err.message);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
