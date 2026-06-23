'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Safqa reconciliation audit — READ-ONLY.

   Compares a fresh Safqa export (.xlsx/.csv) against what's stored in
   external_affiliate_orders for a tenant, so you can spot drift in a monthly
   audit WITHOUT touching the database. It NEVER writes.

   What it reports:
     1. PROFIT buckets (commission) per status_class — FILE vs DB, with deltas.
     2. The headline KPIs the dashboard shows (PROFIT all / delivered / in-progress).
     3. Coverage gaps — orders in the file but missing from the DB, and DB orders
        not in the file (matched by serial, then phone fallback).
     4. Commission drift — rows whose stored `total` ≠ the file commission.

   Usage (from backend/):
     node src/scripts/reconcileSafqa.js "C:/path/to/orders.xlsx"            # business 5 (default)
     node src/scripts/reconcileSafqa.js "C:/path/to/orders.xlsx" 5

   Expected file columns (Arabic or English headers auto-detected):
     • كود الطلب / serial            → external_id
     • العمولة / commission          → the marketer commission (compared to total)
     • هاتف العميل / phone           → fallback match key
     • الحالة / status               → mapped to status_class
   Exit code: 0 = clean, 1 = drift detected (handy for cron/CI).
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const XLSX = require('xlsx');
const pool = require('../config/db');

const FILE = process.argv[2];
const BIZ  = process.argv[3] ? Number(process.argv[3]) : 5;
if (!FILE) {
  console.error('Usage: node src/scripts/reconcileSafqa.js "<path-to-export.xlsx|csv>" [businessId=5]');
  process.exit(1);
}

/* Header alias detection (mirrors safqaCsvImport.js conventions). */
const ALIASES = {
  serial: ['كود الطلب', 'serial', 'serial_number', 'order code', 'كود'],
  comm:   ['العمولة', 'العموله', 'commission', 'earnings', 'الربح', 'صافي الربح'],
  phone:  ['هاتف العميل', 'phone', 'client_phone', 'رقم الهاتف', 'الهاتف', 'موبايل'],
  status: ['الحالة', 'status', 'state'],
};
const AR_CLASS = {
  'ملغي':'cancelled', 'تم التحصيل':'delivered', 'تم التوصيل':'delivered',
  'مرتجع':'returned', 'جار الاسترجاع':'returned', 'في الشحن':'confirmed',
  'جار التحضيير':'confirmed', 'معلق':'pending',
  // English fallbacks
  declined1:'cancelled', collected:'delivered', available:'delivered', returned1:'returned',
  ask_to_return:'returned', shipped:'confirmed', preparing:'confirmed', pending:'pending',
};
const CLASSES = ['delivered', 'confirmed', 'returned', 'cancelled', 'pending'];

const norm  = p => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length >= 11 ? d.slice(-11) : d; };
const money = v => { if (v == null) return 0; const s = String(v).replace(/[^0-9.\-]/g, ''); const n = parseFloat(s); return Number.isFinite(n) ? Math.round(n*100)/100 : 0; };
const classOf = s => AR_CLASS[String(s ?? '').trim()] || AR_CLASS[String(s ?? '').trim().toLowerCase()] || 'pending';

function detect(headers, aliases) {
  for (const a of aliases) { const hit = headers.find(h => String(h).trim().toLowerCase() === a.toLowerCase()); if (hit) return hit; }
  for (const a of aliases) { const hit = headers.find(h => String(h).trim().toLowerCase().includes(a.toLowerCase())); if (hit) return hit; }
  return null;
}

(async () => {
  const wb = XLSX.readFile(FILE);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  if (!rows.length) { console.error('Empty file.'); process.exit(1); }

  const headers = Object.keys(rows[0]);
  const col = { serial: detect(headers, ALIASES.serial), comm: detect(headers, ALIASES.comm),
                phone: detect(headers, ALIASES.phone), status: detect(headers, ALIASES.status) };
  console.log(`Sheet "${wb.SheetNames[0]}" — ${rows.length} rows. Detected columns:`, JSON.stringify(col));
  if (!col.serial || !col.comm || !col.status) {
    console.error('❌ Could not detect required columns (serial / commission / status). Check headers.'); process.exit(1);
  }

  // ── FILE aggregation ──
  const fileByClass = Object.fromEntries(CLASSES.map(c => [c, { n: 0, comm: 0 }]));
  const fileSerials = new Set(), filePhones = new Set();
  const fileBySerial = new Map();
  for (const r of rows) {
    const serial = String(r[col.serial] ?? '').trim();
    const cls = classOf(r[col.status]);
    const comm = money(r[col.comm]);
    const phone = norm(r[col.phone]);
    fileByClass[cls].n++; fileByClass[cls].comm += comm;
    if (serial) { fileSerials.add(serial); fileBySerial.set(serial, comm); }
    if (phone.length === 11) filePhones.add(phone);
  }

  // ── DB aggregation ──
  const db = (await pool.query(
    `SELECT external_id, status_class, total::numeric(12,2) AS total, client_phone
       FROM external_affiliate_orders WHERE business_id=$1 AND network='safqa'`, [BIZ])).rows;
  const dbByClass = Object.fromEntries(CLASSES.map(c => [c, { n: 0, total: 0 }]));
  const dbSerials = new Set(), dbPhones = new Set();
  let commMismatch = 0; const mismatchSamples = [];
  for (const d of db) {
    const cls = CLASSES.includes(d.status_class) ? d.status_class : 'pending';
    dbByClass[cls].n++; dbByClass[cls].total += Number(d.total);
    dbSerials.add(d.external_id);
    const p = norm(d.client_phone); if (p.length === 11) dbPhones.add(p);
    if (fileBySerial.has(d.external_id)) {
      const fc = fileBySerial.get(d.external_id);
      if (Math.abs(fc - Number(d.total)) > 0.01) { commMismatch++; if (mismatchSamples.length < 10) mismatchSamples.push({ serial: d.external_id, db_total: Number(d.total), file_comm: fc }); }
    }
  }

  // ── Report 1: buckets ──
  const round = n => Math.round(n);
  const bucketRows = CLASSES.map(c => ({
    status_class: c,
    file_orders: fileByClass[c].n, file_commission: round(fileByClass[c].comm),
    db_orders: dbByClass[c].n,     db_total: round(dbByClass[c].total),
    Δ_commission: round(dbByClass[c].total - fileByClass[c].comm),
  }));
  console.log('\n===== PROFIT buckets — FILE vs DB ====='); console.table(bucketRows);

  // ── Report 2: headline KPIs ──
  const fAll = CLASSES.reduce((s,c)=>s+fileByClass[c].comm,0);
  const dAll = CLASSES.reduce((s,c)=>s+dbByClass[c].total,0);
  const fInprog = fileByClass.confirmed.comm, dInprog = dbByClass.confirmed.total;
  const fDeliv = fileByClass.delivered.comm,  dDeliv = dbByClass.delivered.total;
  console.log('\n===== Headline KPIs ====='); console.table([
    { kpi: 'PROFIT (all)',        file: round(fAll),    db: round(dAll),    delta: round(dAll-fAll) },
    { kpi: 'PROFIT DELIVERED',    file: round(fDeliv),  db: round(dDeliv),  delta: round(dDeliv-fDeliv) },
    { kpi: 'PROFIT IN PROGRESS',  file: round(fInprog), db: round(dInprog), delta: round(dInprog-fInprog) },
  ]);

  // ── Report 3: coverage gaps ──
  const missingFromDb = [...fileSerials].filter(s => !dbSerials.has(s) && true);
  // a file order counts as truly missing only if neither its serial nor (best-effort) phone is in DB
  let trulyMissing = 0;
  for (const r of rows) {
    const s = String(r[col.serial] ?? '').trim(); const p = norm(r[col.phone]);
    if (s && !dbSerials.has(s) && !(p.length===11 && dbPhones.has(p))) trulyMissing++;
  }
  const dbNotInFile = db.filter(d => !fileSerials.has(d.external_id) && !(norm(d.client_phone).length===11 && filePhones.has(norm(d.client_phone)))).length;
  console.log('\n===== Coverage ====='); console.table([
    { metric: 'file rows',                       value: rows.length },
    { metric: 'DB rows',                         value: db.length },
    { metric: 'file serials missing from DB (serial-only)', value: missingFromDb.length },
    { metric: 'file orders truly missing (serial+phone)',   value: trulyMissing },
    { metric: 'DB orders not in file (serial+phone)',       value: dbNotInFile },
    { metric: 'commission mismatches (matched serials)',    value: commMismatch },
  ]);
  if (mismatchSamples.length) { console.log('\nCommission mismatch samples:'); console.table(mismatchSamples); }

  // ── Verdict ──
  const tol = 1; // EGP rounding tolerance
  const drift = Math.abs(dAll-fAll) > tol || Math.abs(dInprog-fInprog) > tol || Math.abs(dDeliv-fDeliv) > tol
             || trulyMissing > 0 || commMismatch > 0;
  console.log(`\n${drift ? '⚠️  DRIFT DETECTED — review the tables above.' : '✅ CLEAN — DB matches the Safqa export within tolerance.'}`);
  console.log('(DB orders not in file are usually legitimate post-export new orders — verify their dates before acting.)');

  await pool.end();
  process.exit(drift ? 1 : 0);
})().catch(e => { console.error('reconcileSafqa failed:', e.message); process.exit(2); });
