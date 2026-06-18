'use strict';

/**
 * safqaCsvImport.js — shared Safqa CSV → external_affiliate_orders import logic.
 * ─────────────────────────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH used by BOTH:
 *   • the CLI script  src/scripts/syncHistoricalSafqa.js  (terminal, has --dry/--replace)
 *   • the API route   POST /api/safqa/import-csv          (self-serve UI upload)
 *
 * Keeping the parsing + UPSERT here (instead of duplicated in each entry point)
 * guarantees the web upload behaves EXACTLY like the proven CLI: same column
 * auto-detection, same primary-product attribution, same serial-keyed UPSERT
 * (via recordSafqaOrder), and the same noon-UTC created_at back-dating.
 */

const XLSX = require('xlsx');
const pool = require('../config/db');
const {
  recordSafqaOrder,
  classifySafqaStatus,
  primarySku,
  primaryProductName,
} = require('./externalAffiliate');

/* The 15 internal Safqa status keys recordSafqaOrder/classifySafqaStatus knows. */
const KNOWN_STATUS_KEYS = [
  'pending', 'skip', 'preparing', 'printing', 'shipped', 'holding',
  'ask_to_exchange', 'available', 'collected', 'returned1', 'returned2',
  'ask_to_return', 'returned_exchange', 'declined1', 'declined2',
];

/* Real Safqa Arabic export labels → internal status keys (case-insensitive,
   trimmed). Note the CSV's exact spelling, incl. the double ي in 'جار التحضيير'. */
const STATUS_OVERRIDES = {
  'معلق':            'pending',
  'جار التحضيير':    'preparing',
  'في الشحن':        'shipped',
  'تم التوصيل':      'collected',
  'تم التحصيل':      'collected',
  'جار الاسترجاع':   'ask_to_return',
  'مرتجع':           'returned1',
  'ملغي':            'declined1',
};

/* Column auto-detection — each logical field maps to header aliases (normalised:
   trimmed + lowercased). First matching header in the CSV wins. */
const COLUMN_ALIASES = {
  id:          ['_id', 'id', 'order id', 'orderid', 'order_id', 'order number', 'order no', 'كود الطلب', 'رقم الطلب', 'رقم', 'الطلب'],
  status:      ['status', 'order status', 'state', 'الحالة', 'الحاله', 'حالة الطلب', 'حالة'],
  status_ar:   ['status_ar', 'arabic status', 'الحالة بالعربية', 'الحالة العربية'],
  /* total = the marketer's EARNINGS (commission "العمولة"), NOT the gross order
     value ("الإجمالي") — mirrors the live webhook's `total`. */
  total:       ['commission', 'earnings', 'profit', 'net', 'العمولة', 'العموله', 'الربح', 'صافي الربح', 'صافي'],
  marketer:    ['marketer', 'moderator', 'affiliate', 'publisher', 'seller', 'موديريتور', 'المسوق', 'المسوّق', 'الناشر', 'البائع'],
  date:        ['created_at', 'createdat', 'created', 'date', 'order date', 'order_date', 'تاريخ الإنشاء', 'التاريخ', 'تاريخ الطلب', 'تاريخ'],
  products:    ['products', 'product', 'product_name', 'اسم المنتج', 'المنتجات', 'المنتج'],
  sku:         ['sku', 'كود المنتج', 'الكود'],
  governorate: ['governorate', 'province', 'city', 'state', 'المحافظة', 'المدينة'],
  note:        ['note', 'notes', 'rejection reason', 'الملاحظة', 'الملاحظه', 'ملاحظة', 'ملاحظات', 'سبب الرفض'],
  qty:         ['qty', 'quantity', 'الكمية', 'العدد'],
};

/* Minimal RFC-4180-ish CSV parser (quotes, commas/newlines in quotes, "" escapes,
   CRLF). No external dependency. */
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

/* Detect DAY-first (DD/MM, Egyptian) vs MONTH-first (MM/DD) from the data: a
   component > 12 can only be the day/month. Defaults to day-first. */
function detectDayFirst(samples) {
  for (const s of samples) {
    const str = String(s ?? '').trim();
    if (/^\d{4}[-/.]/.test(str)) continue;
    const m = str.match(/^(\d{1,2})[\/\-.](\d{1,2})/);
    if (!m) continue;
    if (+m[1] > 12) return true;
    if (+m[2] > 12) return false;
  }
  return true;
}

/* Parse a date → "YYYY-MM-DDT12:00:00.000Z" (NOON UTC of the calendar date),
   built from components so ::date never drifts by a timezone offset. */
function parseDate(v, dayFirst = true) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const noonUTC = (y, mo, d) => {
    if (!(y >= 1970 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d, 12));
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  };
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return noonUTC(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let [, a, b, yy] = m;
    if (yy.length === 2) yy = '20' + yy;
    return noonUTC(+yy, dayFirst ? +b : +a, dayFirst ? +a : +b);
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return noonUTC(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return null;
}

/**
 * Core import — takes a 2D grid (array of rows; row[0] = header) and upserts into
 * external_affiliate_orders for one tenant. Both the CSV and Excel entry points
 * normalise to this same grid, so parsing/UPSERT logic is shared. UI-agnostic:
 * returns a structured summary; throws on a fatal problem (empty file, missing
 * id/status column) so callers map it to a 400 / CLI error.
 *
 * @param {Array<Array<any>>} grid0      header row + data rows
 * @param {number}            businessId tenant id
 * @param {object}            opts       { dryRun=false, replace=false }
 * @returns {Promise<object>}            summary (counts, detected columns, histograms…)
 */
async function importSafqaGrid(grid0, businessId, opts = {}) {
  const { dryRun = false, replace = false } = opts;
  const bid = Number(businessId);
  if (!Number.isInteger(bid)) throw new Error('Invalid business id.');

  const grid = (Array.isArray(grid0) ? grid0 : [])
    .filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
  if (grid.length < 2) throw new Error('الملف لا يحتوي على صفوف بيانات.');

  const header   = grid[0];
  const dataRows = grid.slice(1);
  const cols     = detectColumns(header);

  /* Human-readable detected-column map for the report (field → header | null). */
  const detectedColumns = {};
  for (const f of Object.keys(COLUMN_ALIASES)) {
    detectedColumns[f] = cols[f] != null ? header[cols[f]] : null;
  }

  if (cols.id == null)     throw new Error('لم يتم العثور على عمود رقم الطلب (مثل "كود الطلب").');
  if (cols.status == null) throw new Error('لم يتم العثور على عمود الحالة (مثل "الحالة").');

  const dayFirst = cols.date != null ? detectDayFirst(dataRows.map((r) => r[cols.date])) : true;
  const sampleDates = (cols.date != null ? dataRows.slice(0, 5) : []).map((r) => ({
    raw: r[cols.date], parsed: parseDate(r[cols.date], dayFirst),
  }));

  const statusHistogram = {};
  const unmapped = {};
  const csvIds = [];
  let processed = 0, inserted = 0, updated = 0, skippedNoId = 0, failed = 0, dated = 0;

  for (const r of dataRows) {
    const rawId = String(r[cols.id] ?? '').trim();
    if (!rawId) { skippedNoId++; continue; }
    csvIds.push(rawId);

    const rawStatus = r[cols.status];
    const sKey = String(rawStatus ?? '').trim() || '(blank)';
    statusHistogram[sKey] = (statusHistogram[sKey] || 0) + 1;
    const resolved = resolveStatus(rawStatus);
    if (resolved === null) unmapped[sKey] = (unmapped[sKey] || 0) + 1;

    /* Pass RAW product/sku — recordSafqaOrder applies primaryProductName/primarySku
       itself (single source), so multi-item upsells collapse to the hero product.
       It also keys the UPSERT on serial_number (here the CSV order code), so a
       re-import or a later webhook updates the SAME row — never a duplicate. */
    const order = {
      _id:          rawId,
      status:       resolved ?? rawStatus,
      status_ar:    cols.status_ar   != null ? r[cols.status_ar]   : undefined,
      total:        cols.total       != null ? parseMoney(r[cols.total]) : 0,
      marketer:     cols.marketer    != null ? r[cols.marketer]    : undefined,
      product_name: cols.products    != null ? r[cols.products]    : undefined,
      sku:          cols.sku         != null ? r[cols.sku]         : undefined,
      governorate:  cols.governorate != null ? r[cols.governorate] : undefined,
      note:         cols.note        != null ? r[cols.note]        : undefined,
      quantity:     cols.qty         != null ? r[cols.qty]         : undefined,
    };
    const isoDate = cols.date != null ? parseDate(r[cols.date], dayFirst) : null;

    if (dryRun) { processed++; continue; }

    try {
      const res = await recordSafqaOrder(order, bid);
      if (!res.ok) { failed++; continue; }
      processed++;
      if (res.inserted) inserted++; else updated++;

      /* Back-date created_at to the real order date so the Date Filter is accurate. */
      if (isoDate) {
        await pool.query(
          `UPDATE external_affiliate_orders SET created_at = $1
             WHERE network = 'safqa' AND external_id = $2 AND business_id = $3`,
          [isoDate, res.externalId || rawId, bid]
        );
        dated++;
      }
    } catch {
      failed++;
    }
  }

  /* --replace (CLI only): prune rows not in the CSV. Runs AFTER upserts so there
     is never an empty-table window. Never exposed to the self-serve web upload. */
  let pruned = 0;
  if (!dryRun && replace && csvIds.length > 0) {
    const del = await pool.query(
      `DELETE FROM external_affiliate_orders
        WHERE network = 'safqa' AND business_id = $1
          AND NOT (external_id = ANY($2::text[]))
        RETURNING id`,
      [bid, csvIds]
    );
    pruned = del.rowCount || 0;
  }

  let totalAfter = null;
  if (!dryRun) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM external_affiliate_orders WHERE network='safqa' AND business_id=$1`,
      [bid]
    );
    totalAfter = rows[0].n;
  }

  return {
    dryRun, replace,
    detectedColumns,
    dateColumnFound: cols.date != null,
    dayFirst,
    sampleDates,
    statusHistogram,
    unmapped,
    dataRowCount: dataRows.length,
    processed, inserted, updated, skippedNoId, failed, dated, pruned,
    totalAfter,
  };
}

/* ── Entry points ────────────────────────────────────────────────────────────
   Both normalise their input to a 2D grid, then delegate to importSafqaGrid. */

/** CSV text → import. (Kept for backward compatibility.) */
async function importSafqaCsv(text, businessId, opts = {}) {
  const clean = String(text || '').replace(/^﻿/, '');   // strip UTF-8 BOM
  return importSafqaGrid(parseCsv(clean), businessId, opts);
}

/** Is this upload an Excel workbook? Checks the extension first, then the file's
 *  magic bytes (XLSX = ZIP "PK"; legacy XLS = OLE2 "D0 CF 11 E0"). */
function isExcelUpload(buffer, filename) {
  if (/\.xlsx?$/i.test(String(filename || ''))) return true;
  if (Buffer.isBuffer(buffer) && buffer.length >= 4) {
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) return true;                       // PK… (zip/xlsx)
    if (buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0) return true; // OLE2/xls
  }
  return false;
}

/** Read the FIRST sheet of an Excel buffer into a 2D grid (array of arrays).
 *  raw:false → use the cell's DISPLAYED text, so Arabic strings and DD/MM date
 *  strings are preserved exactly (no Excel date serials leaking through) and our
 *  existing parseDate/detectColumns keep working. defval:'' keeps columns aligned. */
function gridFromExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('ملف Excel لا يحتوي على أي ورقة عمل.');
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
}

/** Upload (CSV or Excel buffer) → import. The route uses this so clients can
 *  drop .csv / .xlsx / .xls interchangeably; the CLI uses it too. */
async function importSafqaFile(buffer, filename, businessId, opts = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('الملف فارغ أو غير صالح.');
  const grid = isExcelUpload(buffer, filename)
    ? gridFromExcel(buffer)
    : parseCsv(String(buffer.toString('utf8')).replace(/^﻿/, ''));
  return importSafqaGrid(grid, businessId, opts);
}

module.exports = {
  importSafqaGrid,
  importSafqaCsv,
  importSafqaFile,
  isExcelUpload,
  // helpers re-exported so the CLI can format its rich report from one source
  KNOWN_STATUS_KEYS, STATUS_OVERRIDES, COLUMN_ALIASES,
  parseCsv, detectColumns, resolveStatus, parseMoney, parseDate, detectDayFirst,
  classifySafqaStatus, primarySku, primaryProductName,
};
