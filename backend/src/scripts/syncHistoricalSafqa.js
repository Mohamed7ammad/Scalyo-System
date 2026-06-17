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
const { recordSafqaOrder, classifySafqaStatus, primarySku, primaryProductName } = require('../services/externalAffiliate');

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
  /* Product / logistics fields → feed the affiliate dashboard's lower widgets. */
  products:    ['products', 'product', 'product_name', 'اسم المنتج', 'المنتجات', 'المنتج'],
  sku:         ['sku', 'كود المنتج', 'الكود'],
  governorate: ['governorate', 'province', 'city', 'state', 'المحافظة', 'المدينة'],
  note:        ['note', 'notes', 'rejection reason', 'الملاحظة', 'الملاحظه', 'ملاحظة', 'ملاحظات', 'سبب الرفض'],
  qty:         ['qty', 'quantity', 'الكمية', 'العدد'],
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

/* Detect whether ambiguous slash/dash dates are DAY-first (DD/MM/YYYY, Egyptian)
   or MONTH-first (MM/DD/YYYY, American), by scanning the actual values: if any
   first component is > 12 it can only be the day → day-first; if any second
   component is > 12 it can only be the month → month-first. Defaults to day-first
   (Safqa is Egyptian) when every row is ambiguous. ISO (YYYY-…) rows are skipped. */
function detectDayFirst(samples) {
  for (const s of samples) {
    const str = String(s ?? '').trim();
    if (/^\d{4}[-/.]/.test(str)) continue;
    const m = str.match(/^(\d{1,2})[\/\-.](\d{1,2})/);
    if (!m) continue;
    if (+m[1] > 12) return true;    // first comp can't be a month → day-first
    if (+m[2] > 12) return false;   // second comp can't be a month → month-first
  }
  return true;
}

/* Parse a date → "YYYY-MM-DDT12:00:00.000Z" (NOON UTC of the calendar date).
   Built from the date COMPONENTS and anchored at noon — NEVER toISOString() on a
   parsed local/zoned datetime — so the stored value's ::date can't drift by a
   timezone offset (the bug that pushed near-midnight June dates back into May,
   excluding them from the June filter). `dayFirst` picks DD/MM vs MM/DD for
   ambiguous slash/dash formats (auto-detected from the file). */
function parseDate(v, dayFirst = true) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const noonUTC = (y, mo, d) => {
    if (!(y >= 1970 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d, 12));
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  };
  /* 1) ISO-like: YYYY-MM-DD or YYYY/MM/DD (optionally followed by a time). */
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return noonUTC(+m[1], +m[2], +m[3]);
  /* 2) DD/MM/YYYY or MM/DD/YYYY (slash, dash, or dot). */
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let [, a, b, yy] = m;
    if (yy.length === 2) yy = '20' + yy;
    return noonUTC(+yy, dayFirst ? +b : +a, dayFirst ? +a : +b);
  }
  /* 3) Fallback: let JS parse, then anchor ITS calendar date at noon UTC. */
  const d = new Date(s);
  if (!isNaN(d.getTime())) return noonUTC(d.getFullYear(), d.getMonth() + 1, d.getDate());
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

  /* Auto-detect DD/MM vs MM/DD from the data, then show a sample so the mapping
     is verifiable BEFORE writing (this is what was silently wrong before). */
  const dayFirst = cols.date != null
    ? detectDayFirst(dataRows.map((r) => r[cols.date]))
    : true;
  if (cols.date != null) {
    console.log(`🗓️  Date format: ${dayFirst ? 'DAY-first (DD/MM/YYYY)' : 'MONTH-first (MM/DD/YYYY)'} — created_at stored at NOON UTC of the calendar date.`);
    const preview = dataRows.slice(0, 5)
      .map((r) => `"${r[cols.date]}" → ${parseDate(r[cols.date], dayFirst) ?? '(unparsed → NOW())'}`);
    if (preview.length) console.log('   sample dates:\n     ' + preview.join('\n     ') + '\n');
  }

  /* PRIMARY product attribution preview — show how concatenated multi-item
     strings collapse to a single hero product/SKU, so it's verifiable up front. */
  if (cols.products != null || cols.sku != null) {
    console.log('🏷️  Primary product attribution (multi-item orders → first/hero item):');
    const pv = dataRows.slice(0, 5).map((r) => {
      const rawP = cols.products != null ? r[cols.products] : '';
      const rawS = cols.sku != null ? r[cols.sku] : '';
      return `"${rawP}" / "${rawS}"  →  "${primaryProductName(rawP) ?? ''}" / "${primarySku(rawS) ?? ''}"`;
    });
    if (pv.length) console.log('     ' + pv.join('\n     ') + '\n');
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
      _id:          rawId,
      status:       resolved ?? rawStatus,
      status_ar:    cols.status_ar != null ? r[cols.status_ar] : undefined,
      total:        cols.total != null ? parseMoney(r[cols.total]) : 0,
      marketer:     cols.marketer != null ? r[cols.marketer] : undefined,
      /* Product / logistics fields for the affiliate dashboard's lower widgets.
         PRIMARY-product attribution: Safqa concatenates multi-item orders, so we
         keep only the FIRST sku / product (the hook the ad targeted). This is also
         enforced in recordSafqaOrder, so the result is identical for the webhook. */
      product_name: cols.products != null ? primaryProductName(r[cols.products]) : undefined,
      sku:          cols.sku != null ? primarySku(r[cols.sku]) : undefined,
      governorate:  cols.governorate != null ? r[cols.governorate] : undefined,
      note:         cols.note != null ? r[cols.note] : undefined,
      quantity:     cols.qty != null ? r[cols.qty] : undefined,
    };

    const isoDate = cols.date != null ? parseDate(r[cols.date], dayFirst) : null;

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
