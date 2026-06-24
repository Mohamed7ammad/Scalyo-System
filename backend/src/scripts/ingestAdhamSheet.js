'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Ingest Adham's EasyOrder export (39 rows) into external_affiliate_orders and
   attribute every one to marketer='adham'.

   Safe matching: a sheet row already EXISTS in the DB if its Order ID (UUID)
   matches external_id OR its phone (last-10 digits) matches an existing row —
   this avoids duplicating orders stored under a Safqa 'sk-' serial. Existing rows
   are set to adham; only genuinely MISSING rows are inserted.

   Inserted rows mirror the EasyOrder→affiliate ingest contract: total=0 (the
   marketer commission is realised later from Safqa's العمولة), full product/geo/
   phone, raw = the sheet row, status_class mapped from the EO status.

   READ-ONLY dry-run by default; --apply mutates (transactional, backup-first).
   Usage (from backend/):
     node src/scripts/ingestAdhamSheet.js "C:/Users/User/Downloads/_اوردرات ادهم .xlsx"
     node src/scripts/ingestAdhamSheet.js "<file>" --apply
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const XLSX = require('xlsx');
const pool = require('../config/db');

const FILE  = process.argv.find((a) => /\.xlsx?$/i.test(a)) || 'C:/Users/User/Downloads/_اوردرات ادهم .xlsx';
const APPLY = process.argv.includes('--apply');
const BIZ   = 5;
const BACKUP = 'eao_adham_ingest_bk_20260624';
const PHANTOM_BACKUP = 'eao_adham_phantom_del_bk_20260624';
/* Phantom Safqa import artifacts wrongly credited to Adham: phone-less sk- stove
   rows (noon-timestamp CSV imports) that duplicate the real EO stove orders. */
const PHANTOM_PRED = `business_id=${BIZ} AND network='safqa' AND marketer='adham'
  AND product_name ILIKE '%بوتجاز%' AND external_id LIKE 'sk-%' AND client_phone IS NULL`;

const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const phone10 = (s) => { const d = digits(s); return d.length >= 10 ? d.slice(-10) : d; };
const normPhone = (s) => { const d = digits(s); return d ? (d.length > 11 ? d.slice(-11) : d) : null; };

/* EO status → our status_class. */
function statusClass(s) {
  const t = String(s || '').trim().toLowerCase();
  if (['delivered', 'completed', 'collected', 'received'].includes(t)) return 'delivered';
  if (['returned', 'return', 'refunded'].includes(t)) return 'returned';
  if (['cancelled', 'canceled', 'declined', 'refused', 'rejected'].includes(t)) return 'cancelled';
  if (['processing', 'confirmed', 'shipped', 'preparing', 'out_for_delivery'].includes(t)) return 'confirmed';
  return 'pending';   // pending / new / unknown
}

/* "6/24/26 0:32" → ISO 'YYYY-MM-DD HH:MM:00' (M/D/YY[ H:mm]). */
function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  let [, mo, d, y, hh, mm] = m;
  y = y.length === 2 ? '20' + y : y;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)} ${pad(hh || 0)}:${pad(mm || 0)}:00`;
}

(async () => {
  const client = await pool.connect();
  try {
    const wb = XLSX.readFile(FILE);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: false });
    console.log(`Sheet rows: ${rows.length}`);

    const records = rows.map((r) => ({
      externalId: String(r['Order ID'] ?? r['External Order ID'] ?? r['ID'] ?? '').trim(),
      status:     String(r['Status'] ?? '').trim().toLowerCase(),
      cls:        statusClass(r['Status']),
      product:    r['Product Name'] || null,
      sku:        r['SKU'] || null,
      city:       r['City'] || null,
      note:       r['Note'] || null,
      qty:        parseInt(r['Quantity'], 10) || 1,
      phone:      r['Phone'] || r['Alt Phone'] || null,
      created:    parseDate(r['CreatedAt']),
      raw:        r,
    })).filter((x) => x.externalId);

    // Resolve existence per record (by UUID or phone last-10)
    const toInsert = [], toUpdate = [];
    for (const rec of records) {
      const found = await client.query(
        `SELECT id, external_id, marketer, product_name FROM external_affiliate_orders
          WHERE business_id=$1 AND network='safqa'
            AND ( external_id = $2
                  OR ($3 <> '' AND RIGHT(regexp_replace(COALESCE(client_phone,''),'\\D','','g'),10) = $3) )
          LIMIT 1`,
        [BIZ, rec.externalId, phone10(rec.phone)]);
      if (found.rows.length) toUpdate.push({ rec, row: found.rows[0] });
      else toInsert.push(rec);
    }

    console.log(`\nAlready in DB (→ ensure adham): ${toUpdate.length}`);
    console.log(`Missing (→ insert): ${toInsert.length}`);
    for (const rec of toInsert)
      console.log(`  INSERT ${rec.externalId.slice(0,12)} ${rec.cls.padEnd(10)} ${String(rec.product).slice(0,20).padEnd(22)} sku=${rec.sku} ph=${rec.phone} created=${rec.created}`);
    const notAdham = toUpdate.filter((u) => u.row.marketer !== 'adham');
    console.log(`\nExisting rows NOT yet adham (will flip): ${notAdham.length}`);
    for (const u of notAdham) console.log(`  id=${u.row.id} mk=${u.row.marketer} ${String(u.row.product_name).slice(0,22)}`);

    const phantomN = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE ${PHANTOM_PRED}`)).rows[0].n;
    const curAdham = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa' AND marketer='adham'`)).rows[0].n;
    console.log(`\nPhantom rows to DELETE (phone-less sk- stove): ${phantomN}`);
    console.log(`Adham now: ${curAdham}  →  projected after: ${curAdham - phantomN + toInsert.length} (expect 41)`);

    if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to ingest + attribute.'); return; }

    if (phantomN > 12) throw new Error(`SAFETY ABORT: ${phantomN} phantom rows (> 12 expected) — investigate before deleting.`);

    await client.query('BEGIN');
    // Backup + DELETE the phantom duplicate rows
    await client.query(`DROP TABLE IF EXISTS ${PHANTOM_BACKUP}`);
    await client.query(`CREATE TABLE ${PHANTOM_BACKUP} AS SELECT * FROM external_affiliate_orders WHERE ${PHANTOM_PRED}`);
    const delRes = await client.query(`DELETE FROM external_affiliate_orders WHERE ${PHANTOM_PRED}`);
    console.log(`Deleted ${delRes.rowCount} phantom rows (backup ${PHANTOM_BACKUP}).`);
    // Backup existing rows whose marketer will change
    if (notAdham.length) {
      await client.query(`DROP TABLE IF EXISTS ${BACKUP}`);
      await client.query(
        `CREATE TABLE ${BACKUP} AS SELECT * FROM external_affiliate_orders WHERE id = ANY($1::int[])`,
        [notAdham.map((u) => u.row.id)]);
    }
    // Flip existing → adham
    let updated = 0;
    if (toUpdate.length) {
      const res = await client.query(
        `UPDATE external_affiliate_orders SET marketer='adham', updated_at=NOW()
          WHERE id = ANY($1::int[]) AND marketer IS DISTINCT FROM 'adham'`,
        [toUpdate.map((u) => u.row.id)]);
      updated = res.rowCount;
    }
    // Insert missing
    let inserted = 0;
    for (const rec of toInsert) {
      const res = await client.query(
        `INSERT INTO external_affiliate_orders
           (network, external_id, business_id, status, status_ar, status_class, total, marketer,
            product_name, sku, governorate, note, quantity, client_phone, raw, created_at, updated_at)
         VALUES ('safqa',$1,$2,$3,NULL,$4,0,'adham',$5,$6,$7,$8,$9,$10,$11::jsonb,
                 COALESCE($12::timestamptz, NOW()), NOW())
         ON CONFLICT (network, external_id, business_id)
         DO UPDATE SET marketer='adham', updated_at=NOW()`,
        [rec.externalId, BIZ, rec.status, rec.cls, rec.product, rec.sku, rec.city, rec.note,
         rec.qty, normPhone(rec.phone), JSON.stringify(rec.raw), rec.created]);
      inserted += res.rowCount;
    }
    await client.query('COMMIT');

    const after = (await client.query(
      `SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa' AND marketer='adham'`)).rows[0].n;
    console.log(`\n✅ Applied. Flipped ${updated} existing → adham; inserted ${toInsert.length} (${inserted}). Adham now = ${after}.`);
    if (notAdham.length) console.log(`   Backup of flipped rows: ${BACKUP}`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ ingestAdhamSheet failed (rolled back):', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
