'use strict';

/**
 * fix-incident.js — one-off remediation for the post-downtime order incident.
 *
 * Symptoms it fixes:
 *   1. Duplicate 'جديد' orders created by a re-run bulk import after the VPS
 *      came back online.
 *   2. 'جديد' orders stuck at DeliveryRate = 'بدون' because the in-memory Bosta
 *      enrichment queue was wiped on restart (or never ran during downtime).
 *
 * It does NOT touch shipped/confirmed orders and NEVER rewrites a Status.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 *   • DRY-RUN BY DEFAULT. Nothing is deleted or enriched unless you pass --apply.
 *   • Deletes run inside a single transaction (all-or-nothing).
 *   • Dedup is scoped per tenant (business_id) so one tenant's customer can
 *     never delete another tenant's order that shares a phone number.
 *
 *   Preview :  node fix-incident.js
 *   Execute :  node fix-incident.js --apply
 *
 * Drop this file in the `backend/` folder (alongside package.json) and run it
 * from there so it picks up backend/.env (DATABASE_URL).
 */

require('dotenv').config();

const pool = require('./src/config/db');
const { enrichDeliveryRate } = require('./src/services/bostaEnrich');

/* ── Config ──────────────────────────────────────────────────────────────────
   The columns that define a "true duplicate". Import re-runs produce rows that
   are identical across all of these. Set to ['business_id', '"Phone"'] for the
   blunter phone-only behaviour (NOT recommended — deletes genuine repeat /
   different-product orders by the same customer).                              */
const DEDUP_KEYS = ['business_id', '"Phone"', '"ProductName"'];

const NEW_STATUS   = 'جديد';
const UNRATED      = 'بدون';
const APPLY        = process.argv.includes('--apply');

const log  = (...a) => console.log(...a);
const rule = () => log('─'.repeat(64));

async function main() {
  rule();
  log(`  fix-incident.js   mode: ${APPLY ? '⚠️  APPLY (writes enabled)' : '🔍 DRY-RUN (read-only)'}`);
  rule();

  /* ── STEP 1: Deduplicate 'جديد' orders ────────────────────────────────────
     For each duplicate group (keyed by DEDUP_KEYS) keep MIN(id) and collect the
     rest for deletion. Scoped to Status='جديد' so nothing in the live pipeline
     is ever at risk.                                                          */
  const partition = DEDUP_KEYS.join(', ');
  const { rows: dupRows } = await pool.query(
    `
    SELECT id, business_id, "Phone", "ProductName", "createdAt"
    FROM (
      SELECT id, business_id, "Phone", "ProductName", "createdAt",
             ROW_NUMBER() OVER (
               PARTITION BY ${partition}
               ORDER BY id ASC
             ) AS rn
      FROM orders
      WHERE "Status" = $1
    ) ranked
    WHERE rn > 1          -- rn = 1 is the keeper (oldest id); rn > 1 are extras
    ORDER BY "Phone", id
    `,
    [NEW_STATUS]
  );

  log(`\n[1] DEDUPLICATION  (key: ${DEDUP_KEYS.join(' + ')})`);
  log(`    Duplicate 'جديد' rows to remove: ${dupRows.length}`);

  if (dupRows.length) {
    // Show a small sample so the operator can sanity-check before --apply.
    const sample = dupRows.slice(0, 10);
    for (const r of sample) {
      log(`      • id=${r.id}  phone=${r.Phone}  product=${r.ProductName ?? '—'}`);
    }
    if (dupRows.length > sample.length) log(`      … and ${dupRows.length - sample.length} more`);
  }

  let deleted = 0;
  if (dupRows.length && APPLY) {
    const ids = dupRows.map((r) => r.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        // Re-assert Status in the DELETE so we can never remove a row that
        // changed state between the SELECT above and now.
        `DELETE FROM orders WHERE id = ANY($1::int[]) AND "Status" = $2`,
        [ids, NEW_STATUS]
      );
      await client.query('COMMIT');
      deleted = res.rowCount;
      log(`    ✅ Deleted ${deleted} duplicate row(s).`);
    } catch (err) {
      await client.query('ROLLBACK');
      log(`    ❌ Delete rolled back (no rows removed): ${err.message}`);
      log(`       (Often a foreign-key reference — those orders are NOT safe to auto-delete.)`);
    } finally {
      client.release();
    }
  } else if (dupRows.length) {
    log(`    (dry-run — pass --apply to delete these ${dupRows.length} row(s))`);
  }

  /* ── STEP 2: Re-enrich stuck 'بدون' orders ────────────────────────────────
     After dedup, find every 'جديد' order still at DeliveryRate='بدون' with a
     usable phone, and push it back through the SAME throttled Bosta enrich queue
     the app uses. enrichDeliveryRate resolves when its queued job completes, so
     awaiting Promise.all drains the entire enrich lane before we exit.        */
  const { rows: stuck } = await pool.query(
    `
    SELECT id, "Phone"
    FROM orders
    WHERE "Status" = $1
      AND "DeliveryRate" = $2
      AND "Phone" IS NOT NULL
      AND btrim("Phone") <> ''
    ORDER BY id ASC
    `,
    [NEW_STATUS, UNRATED]
  );

  log(`\n[2] RE-ENRICHMENT`);
  log(`    'جديد' orders stuck at 'بدون' with a phone: ${stuck.length}`);

  let enrichedFixed = 0;
  if (stuck.length && APPLY) {
    log(`    Re-queuing ${stuck.length} order(s) through the Bosta enrich lane…`);
    log(`    (throttled ~1.5s/call + 429 back-off — this can take a while)`);

    // enrichDeliveryRate always resolves (errors are caught inside the service).
    await Promise.all(stuck.map((o) => enrichDeliveryRate(o.id, o.Phone)));

    // Re-measure: how many actually moved off 'بدون'.
    const { rows: after } = await pool.query(
      `SELECT COUNT(*)::int AS still_stuck
         FROM orders
        WHERE id = ANY($1::int[]) AND "DeliveryRate" = $2`,
      [stuck.map((o) => o.id), UNRATED]
    );
    const stillStuck = after[0].still_stuck;
    enrichedFixed = stuck.length - stillStuck;
    log(`    ✅ Re-enriched: ${enrichedFixed} now rated, ${stillStuck} still 'بدون' (no Bosta history / unreachable).`);
  } else if (stuck.length) {
    log(`    (dry-run — pass --apply to re-enrich these ${stuck.length} order(s))`);
  }

  /* ── Summary ──────────────────────────────────────────────────────────────*/
  rule();
  log(`  SUMMARY  (${APPLY ? 'APPLIED' : 'DRY-RUN — nothing changed'})`);
  log(`    Duplicate 'جديد' rows found      : ${dupRows.length}`);
  log(`    Duplicate rows deleted          : ${APPLY ? deleted : 0}`);
  log(`    Stuck 'بدون' orders found        : ${stuck.length}`);
  log(`    Orders re-enriched (now rated)  : ${APPLY ? enrichedFixed : 0}`);
  rule();
  if (!APPLY) log(`  Re-run with --apply to perform the fix:  node fix-incident.js --apply`);
}

main()
  .catch((err) => {
    console.error('\n❌ fix-incident.js failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();   // close DB pool so the process exits cleanly
  });
