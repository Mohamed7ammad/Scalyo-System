/* ─────────────────────────────────────────────────────────────────────────
   One-time backfill: import a Safqa CSV export into external_affiliate_orders.

   This is a THIN CLI wrapper around services/safqaCsvImport.js — the SAME logic
   the self-serve web upload (POST /api/safqa/import-csv) uses, so terminal and UI
   imports behave identically (column auto-detection, primary-product attribution,
   serial-keyed UPSERT, noon-UTC created_at back-dating).

   WHY A CSV (not an API): Safqa has NO public GET orders endpoint — it only
   PUSHES status updates to our orderHook. Orders that never changed status after
   the hook was linked are missing, so we backfill from the panel's CSV export.

   ── USAGE (from backend/) ────────────────────────────────────────────────────
     node src/scripts/syncHistoricalSafqa.js ./safqa_export.csv 5 --dry   # preview
     node src/scripts/syncHistoricalSafqa.js ./safqa_export.csv 5         # import
     node src/scripts/syncHistoricalSafqa.js ./safqa_export.csv 5 --replace
       (--replace imports first, then deletes any business-5 Safqa rows whose
        order id is absent from the CSV — never an empty-table window.)
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const {
  importSafqaCsv, KNOWN_STATUS_KEYS, COLUMN_ALIASES,
  resolveStatus, classifySafqaStatus,
} = require('../services/safqaCsvImport');

async function main() {
  const rawArgs = process.argv.slice(2);
  const flags   = rawArgs.filter((a) => a.startsWith('--'));
  const args    = rawArgs.filter((a) => !a.startsWith('--'));
  const DRY     = flags.includes('--dry');
  const REPLACE = flags.includes('--replace');

  const file       = args[0] || './safqa_export.csv';
  const businessId = args[1] ? Number(args[1]) : 5;
  if (!Number.isInteger(businessId)) {
    console.error(`❌ Invalid business_id "${args[1]}". Usage: node src/scripts/syncHistoricalSafqa.js <file.csv> <businessId> [--dry] [--replace]`);
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ CSV not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`📥 [syncHistoricalSafqa] ${DRY ? 'DRY RUN — no writes. ' : ''}File: ${filePath} → business_id ${businessId}\n`);
  const text = fs.readFileSync(filePath, 'utf8');

  let r;
  try {
    r = await importSafqaCsv(text, businessId, { dryRun: DRY, replace: REPLACE });
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }

  /* ── Detected columns ── */
  console.log('🔎 Detected columns:');
  for (const field of Object.keys(COLUMN_ALIASES)) {
    const h = r.detectedColumns[field];
    console.log(`   • ${field.padEnd(10)} → ${h != null ? `"${h}"` : '— NOT FOUND'}`);
  }
  console.log('');

  if (!r.dateColumnFound) {
    console.warn('⚠️  No order-date column detected — created_at defaults to NOW(), so historical orders land in the CURRENT month for date-filtered views.\n');
  } else {
    console.log(`🗓️  Date format: ${r.dayFirst ? 'DAY-first (DD/MM/YYYY)' : 'MONTH-first (MM/DD/YYYY)'} — created_at stored at NOON UTC of the calendar date.`);
    console.log('   sample dates:\n     ' +
      r.sampleDates.map((s) => `"${s.raw}" → ${s.parsed ?? '(unparsed → NOW())'}`).join('\n     ') + '\n');
  }

  /* ── Status histogram ── */
  console.log('📊 Status values found (raw → count):');
  Object.entries(r.statusHistogram).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => {
    const key = resolveStatus(s);
    console.log(`   ${String(s).padEnd(22)} ${n}   ${key ? `→ ${classifySafqaStatus(key)}` : '⚠️  UNMAPPED → pending'}`);
  });
  console.log('');

  if (Object.keys(r.unmapped).length > 0) {
    console.warn('⚠️  UNMAPPED statuses (classified as "pending"). Add them to STATUS_OVERRIDES in services/safqaCsvImport.js:');
    Object.entries(r.unmapped).forEach(([s, n]) => console.warn(`     '${s}': '<known_key>',   // ${n} row(s)`));
    console.warn(`     known keys: ${KNOWN_STATUS_KEYS.join(', ')}\n`);
  }

  /* ── Summary ── */
  console.log('────────────────────────────────────────────');
  console.log(`   Data rows in CSV     : ${r.dataRowCount}`);
  console.log(`   Processed (valid id) : ${r.processed}`);
  console.log(`   Skipped (no id)      : ${r.skippedNoId}`);
  if (!DRY) {
    console.log(`   Inserted (new)       : ${r.inserted}`);
    console.log(`   Updated (existing)   : ${r.updated}`);
    console.log(`   created_at back-dated: ${r.dated}`);
    console.log(`   Failed               : ${r.failed}`);
    if (REPLACE) console.log(`   Pruned (not in CSV)  : ${r.pruned}`);
  }
  console.log('────────────────────────────────────────────');

  if (DRY) {
    console.log('\n✅ Dry run complete — NO changes written. Re-run without --dry to import.');
  } else {
    console.log(`\n✅ Import complete. external_affiliate_orders now holds ${r.totalAfter} Safqa order(s) for business ${businessId}.`);
  }

  /* Exit without pool.end() — externalAffiliate's fire-and-forget boot migrations
     may still be in flight; process.exit terminates cleanly after our awaited work. */
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [syncHistoricalSafqa] Fatal:', err.message);
  process.exit(1);
});
