/* ─────────────────────────────────────────────────────────────────────────
   One-time backfill: import a Safqa CSV export into external_affiliate_orders.

   WHY A CSV (not an API): Safqa has NO public GET orders endpoint — it only
   PUSHES new orders / status updates to our orderHook. Orders that existed (and
   never changed status) BEFORE the webhook was linked were never pushed, so they
   are missing from our DB. The fix is to export the full order list from the
   Safqa panel as CSV and import it here.

   WHAT IT DOES, per row:
     • maps the CSV columns → a Safqa "order" object ({ _id, status, status_ar,
       total, marketer, … }),
     • calls the SAME recordSafqaOrder() the live webhook uses (so status → class
       mapping, totals and idempotency are IDENTICAL to real-time ingestion),
     • back-dates created_at from the CSV's order-date column when present, so the
       global Date Filter places each order in its real month (recordSafqaOrder
       otherwise stamps NOW()).

   IDEMPOTENT: upserts on (network, external_id, business_id) — safe to re-run.
   Re-running reconciles the table to the CSV snapshot (good for hitting 542).

   ── HOW TO USE ──────────────────────────────────────────────────────────────
   1) In the Safqa panel, export ALL orders to CSV (e.g. safqa_export.csv).
   2) Copy it onto the server, e.g. into the backend/ directory.
   3) From backend/, FIRST do a dry run to verify the column + status mapping:
        node src/scripts/syncHistoricalSafqa.js ./safqa_export.csv 5 --dry
      Read the report: detected columns, status histogram, and (critically) any
      UNMAPPED statuses. If some statuses are unmapped, add them to
      STATUS_OVERRIDES below (map → a known key from KNOWN_STATUS_KEYS), then
      re-run --dry until nothing is unmapped.
   4) Run for real:
        node src/scripts/syncHistoricalSafqa.js ./safqa_export.csv 5
   5) Make the table hold EXACTLY the CSV (drop webhook-only orders not in it):
        node src/scripts/syncHistoricalSafqa.js ./safqa_export.csv 5 --replace
      (--replace imports first, then deletes any business-5 Safqa rows whose
       order id is absent from the CSV — never an empty-table window.)
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('../config/db');
const { recordSafqaOrder, classifySafqaStatus } = require('../services/externalAffiliate');

/* The 15 internal Safqa status keys recordSafqaOrder/classifySafqaStatus knows.
   A CSV status is "recognised" when (lowercased) it is one of these. */
const KNOWN_STATUS_KEYS = [
  'pending', 'skip', 'preparing', 'printing', 'shipped', 'holding',
  'ask_to_exchange', 'available', 'collected', 'returned1', 'returned2',
  'ask_to_return', 'returned_exchange', 'declined1', 'declined2',
];

/* ── USER-EXTENSIBLE: map YOUR CSV's status labels → a known key above ────────
   Leave empty and run --dry first; the report lists every status value found and
   flags the ones we couldn't recognise. Add those here, e.g.:
     'تم التوصيل': 'collected',   'مرتجع': 'returned1',   'قيد الشحن': 'shipped',
   Keys are matched case-insensitively after trimming. */
const STATUS_OVERRIDES = {
  /* Real Safqa Arabic export labels → internal status keys (note the CSV's exact
     spelling, incl. the double ي in 'جار التحضيير'). Matched case-insensitively
     after trimming. */
  'معلق':            'pending',        // on hold / awaiting
  'جار التحضيير':    'preparing',      // being prepared (CSV's exact spelling)
  'في الشحن':        'shipped',        // in shipping
  'تم التوصيل':      'collected',      // delivered  → delivered class
  'تم التحصيل':      'collected',      // cash collected → delivered class
  'جار الاسترجاع':   'ask_to_return',  // return in progress → returned class
  'مرتجع':           'returned1',      // returned → returned class
  'ملغي':            'declined1',      // cancelled → returned class
};

/* ── Column auto-detection. Each logical field maps to a list of header aliases
   (normalised: trimmed + lowercased). First matching header in the CSV wins. ── */
const COLUMN_ALIASES = {
  id:        ['_id', 'id', 'order id', 'orderid', 'order_id', 'order number', 'order no', 'كود الطلب', 'رقم الطلب', 'رقم', 'الطلب'],
  status:    ['status', 'order status', 'state', 'الحالة', 'الحاله', 'حالة الطلب', 'حالة'],
  status_ar: ['status_ar', 'arabic status', 'الحالة بالعربية', 'الحالة العربية'],
  /* total = the marketer's EARNINGS (commission) — this mirrors the live Safqa
     webhook, which puts the affiliate's earnings in `total` (NOT the gross order
     value). The export carries BOTH "العمولة" (commission/earnings) and
     "الإجمالي" (gross); we deliberately map to "العمولة" so backfilled PROFIT is
     consistent with the orders already ingested via the webhook. The gross-total
     aliases are intentionally omitted to avoid grabbing the wrong column. */
  total:     ['commission', 'earnings', 'profit', 'net', 'العمولة', 'العموله', 'الربح', 'صافي الربح', 'صافي'],
  marketer:  ['marketer', 'moderator', 'affiliate', 'publisher', 'seller', 'موديريتور', 'المسوق', 'المسوّق', 'الناشر', 'البائع'],
  date:      ['created_at', 'createdat', 'created', 'date', 'order date', 'order_date', 'تاريخ الإنشاء', 'التاريخ', 'تاريخ الطلب', 'تاريخ'],
};

/* ── Minimal RFC-4180-ish CSV parser (handles quotes, commas/newlines in quotes,
   "" escapes, CRLF). No external dependency. ─────────────────────────────────── */
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s) => String(s ?? '').replace(/^﻿/, '').trim().toLowerCase();

/* Build { logicalField → columnIndex } from the header row. */
function detectColumns(header) {
  const idx = {};
  const normHeader = header.map(norm);
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const found = normHeader.findIndex((h) => aliases.includes(h));
    if (found !== -1) idx[field] = found;
  }
  return idx;
}

/* Resolve a raw CSV status → a known internal key (or null if unrecognised). */
function resolveStatus(raw) {
  const s = norm(raw);
  if (!s) return null;
  if (KNOWN_STATUS_KEYS.includes(s)) return s;
  for (const [label, key] of Object.entries(STATUS_OVERRIDES)) {
    if (norm(label) === s) return key;
  }
  return null;
}

/* Clean a money string → float (strip currency text, thousands separators). */
function parseMoney(v) {
  const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/* Parse an order date → ISO string, or null. Native parse first (ISO / yyyy-mm-dd
   / "yyyy-mm-dd hh:mm:ss"), then DD/MM/YYYY (Egypt convention) as a fallback. */
function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let d = new Date(s);
  if (!isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(s)) return d.toISOString();
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let [, dd, mm, yy] = m;
    if (yy.length === 2) yy = '20' + yy;
    d = new Date(Date.UTC(+yy, +mm - 1, +dd, 12));
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  if (!isNaN(d.getTime())) return d.toISOString();   // last resort: whatever native parsed
  return null;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const flags   = rawArgs.filter((a) => a.startsWith('--'));
  const args    = rawArgs.filter((a) => !a.startsWith('--'));
  const DRY     = flags.includes('--dry');
  /* --replace: after importing, DELETE any business_id Safqa rows NOT present in
     the CSV, so the table ends up holding EXACTLY the CSV's orders (drops
     webhook-only orders the CSV — the ground truth — doesn't contain). */
  const REPLACE = flags.includes('--replace');

  const file       = args[0] || './safqa_export.csv';
  const businessId = args[1] ? Number(args[1]) : 5;

  if (!Number.isInteger(businessId)) {
    console.error(`❌ Invalid business_id "${args[1]}". Usage: node src/scripts/syncHistoricalSafqa.js <file.csv> <businessId> [--dry]`);
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ CSV not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`📥 [syncHistoricalSafqa] ${DRY ? 'DRY RUN — no writes. ' : ''}File: ${filePath} → business_id ${businessId}\n`);

  const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');   // strip UTF-8 BOM
  const grid = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (grid.length < 2) {
    console.error('❌ CSV has no data rows.');
    process.exit(1);
  }

  const header  = grid[0];
  const dataRows = grid.slice(1);
  const cols    = detectColumns(header);

  console.log('🔎 Detected columns:');
  for (const field of Object.keys(COLUMN_ALIASES)) {
    console.log(`   • ${field.padEnd(10)} → ${cols[field] != null ? `"${header[cols[field]]}" (col ${cols[field]})` : '— NOT FOUND'}`);
  }
  console.log('');

  if (cols.id == null) {
    console.error('❌ Could not find an order-id column. Add your header to COLUMN_ALIASES.id and re-run.');
    process.exit(1);
  }
  if (cols.status == null) {
    console.error('❌ Could not find a status column. Add your header to COLUMN_ALIASES.status and re-run.');
    process.exit(1);
  }
  if (cols.date == null) {
    console.warn('⚠️  No order-date column detected — created_at will default to NOW(), so historical orders will all land in the CURRENT month for date-filtered views. Add your date header to COLUMN_ALIASES.date to preserve real dates.\n');
  }

  const statusHistogram = {};   // raw status value → count
  const unmapped = {};          // unrecognised raw status → count
  const csvIds = [];            // every valid order id seen in the CSV (for --replace prune)
  let ok = 0, inserted = 0, updated = 0, skippedNoId = 0, failed = 0, dated = 0;

  for (const r of dataRows) {
    const rawId = String(r[cols.id] ?? '').trim();
    if (!rawId) { skippedNoId++; continue; }
    csvIds.push(rawId);

    const rawStatus = r[cols.status];
    statusHistogram[rawStatus] = (statusHistogram[rawStatus] || 0) + 1;

    const resolved = resolveStatus(rawStatus);
    if (resolved === null) unmapped[String(rawStatus ?? '').trim() || '(blank)'] = (unmapped[String(rawStatus ?? '').trim() || '(blank)'] || 0) + 1;

    /* Pass the resolved internal key as `status` so classifySafqaStatus maps it
       correctly. Unresolved → pass the raw value (classify defaults to pending). */
    const order = {
      _id:       rawId,
      status:    resolved ?? rawStatus,
      status_ar: cols.status_ar != null ? r[cols.status_ar] : undefined,
      total:     cols.total != null ? parseMoney(r[cols.total]) : 0,
      marketer:  cols.marketer != null ? r[cols.marketer] : undefined,
    };

    const isoDate = cols.date != null ? parseDate(r[cols.date]) : null;

    if (DRY) { ok++; continue; }

    try {
      const res = await recordSafqaOrder(order, businessId);
      if (!res.ok) { failed++; continue; }
      ok++;
      if (res.inserted) inserted++; else updated++;

      /* Back-date created_at to the real order date so the Date Filter is accurate. */
      if (isoDate) {
        await pool.query(
          `UPDATE external_affiliate_orders SET created_at = $1
             WHERE network = 'safqa' AND external_id = $2 AND business_id = $3`,
          [isoDate, rawId, businessId]
        );
        dated++;
      }
    } catch (err) {
      failed++;
      console.error(`   -- row id=${rawId} failed: ${err.message}`);
    }
  }

  /* ── --replace: prune webhook-only orders not in the CSV (CSV = ground truth) ──
     Runs AFTER the upserts so there is never an empty-table window: every CSV row
     is already present, then we delete only the rows whose external_id is absent
     from the CSV. Scoped strictly to (network='safqa', business_id). */
  let pruned = 0;
  if (!DRY && REPLACE) {
    if (csvIds.length === 0) {
      console.warn('⚠️  --replace skipped: no valid CSV ids parsed (refusing to wipe the table).');
    } else {
      const del = await pool.query(
        `DELETE FROM external_affiliate_orders
          WHERE network = 'safqa'
            AND business_id = $1
            AND NOT (external_id = ANY($2::text[]))
          RETURNING id`,
        [businessId, csvIds]
      );
      pruned = del.rowCount || 0;
    }
  }

  /* ── Report ── */
  console.log('📊 Status values found (raw → count):');
  Object.entries(statusHistogram)
    .sort((a, b) => b[1] - a[1])
    .forEach(([s, n]) => console.log(`   ${String(s).padEnd(22)} ${n}   ${resolveStatus(s) ? `→ ${classifySafqaStatus(resolveStatus(s))}` : '⚠️  UNMAPPED → pending'}`));
  console.log('');

  if (Object.keys(unmapped).length > 0) {
    console.warn('⚠️  UNMAPPED statuses (currently classified as "pending"). Add them to STATUS_OVERRIDES and re-run:');
    Object.entries(unmapped).forEach(([s, n]) => console.warn(`     '${s}': '<known_key>',   // ${n} row(s)`));
    console.warn(`     known keys: ${KNOWN_STATUS_KEYS.join(', ')}\n`);
  }

  console.log('────────────────────────────────────────────');
  console.log(`   Data rows in CSV     : ${dataRows.length}`);
  console.log(`   Processed (valid id) : ${ok}`);
  console.log(`   Skipped (no id)      : ${skippedNoId}`);
  if (!DRY) {
    console.log(`   Inserted (new)       : ${inserted}`);
    console.log(`   Updated (existing)   : ${updated}`);
    console.log(`   created_at back-dated: ${dated}`);
    console.log(`   Failed               : ${failed}`);
    if (REPLACE) console.log(`   Pruned (not in CSV)  : ${pruned}`);
  }
  console.log('────────────────────────────────────────────');

  if (DRY) {
    console.log('\n✅ Dry run complete — NO changes written. Re-run without --dry to import.');
  } else {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM external_affiliate_orders WHERE network='safqa' AND business_id=$1`,
      [businessId]
    );
    console.log(`\n✅ Import complete. external_affiliate_orders now holds ${rows[0].n} Safqa order(s) for business ${businessId}.`);
  }

  /* Exit cleanly WITHOUT pool.end(). Requiring ../services/externalAffiliate runs
     its fire-and-forget boot migrations (CREATE TABLE / ALTER) at import time;
     those can still be in flight when we finish (especially on a fast --dry run),
     and calling pool.end() first makes them error with "Cannot use a pool after
     calling end on the pool". process.exit terminates everything once all of our
     awaited work is done — no stray query, no warning. */
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [syncHistoricalSafqa] Fatal:', err.message);
  process.exit(1);
});
