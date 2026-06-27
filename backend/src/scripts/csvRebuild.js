'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CSV-SERIAL AUTHORITATIVE REBUILD (Business 5 / Safqa).
   The Safqa CSV (كود الطلب = serial) is the absolute truth. We:
     1. Build a phone→marketer map from the EasyOrder (UUID) rows (attribution).
     2. Upsert ONE sk- row per CSV serial with the CSV's exact status + commission
        (العمولة) + product/geo/qty + the transferred marketer.
     3. DELETE every EasyOrder (UUID) row — collapsed into the serial rows.
     4. DELETE any sk- row whose serial is NOT in the CSV (stale duplicates/ghosts).
   Result: DB = exactly the CSV's orders, one canonical row each.
   Full backup first. Dry-run default; --apply to execute.
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const XLSX = require('xlsx');
const pool = require('../config/db');
const BIZ = 5;
const APPLY = process.argv.includes('--apply');
const FILE = process.argv.find(a => /\.xlsx?$/i.test(a)) || 'C:/Users/User/Downloads/orders (13).xlsx';
const BACKUP = 'eao_csv_rebuild_bk_20260628';

const norm = p => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d ? (d.length > 11 ? d.slice(-11) : d) : null; };
const d10  = p => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; };
const money = v => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n) : 0; };
/* CSV Arabic status → our class. ONLY في الشحن + جار التحضير are IN-PROGRESS (confirmed). */
const AR = {
  'في الشحن': 'confirmed', 'جار التحضير': 'confirmed', 'جار التحضيير': 'confirmed',
  'تم التحصيل': 'delivered', 'تم التوصيل': 'delivered',
  'مرتجع': 'returned', 'جار الاسترجاع': 'returned',
  'ملغي': 'cancelled', 'ملغى': 'cancelled', 'معلق': 'pending',
  'طلب العميل الإستبدال': 'pending',
};
const clsOf = s => AR[String(s == null ? '' : s).trim()] || 'pending';
function parseDate(s) { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return null; let [, mo, d, y] = m; y = y.length === 2 ? '20' + y : y; return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')} 12:00:00`; }

(async () => {
  const client = await pool.connect();
  try {
    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets['Orders'], { defval: null, raw: false });
    console.log(`CSV: ${rows.length} orders`);
    // projected in-progress from CSV
    const ip = rows.filter(r => clsOf(r['الحالة']) === 'confirmed');
    console.log(`CSV IN PROGRESS (confirmed): ${ip.length} orders / ${ip.reduce((a, r) => a + money(r['العمولة']), 0)} EGP   [target 119 / ~35,582]`);

    // phone → clean marketer from EO rows (non-main, non-numeric)
    const eo = (await client.query(`SELECT client_phone, marketer FROM external_affiliate_orders WHERE business_id=$1 AND network='safqa' AND external_id NOT LIKE 'sk-%' AND client_phone IS NOT NULL`, [BIZ])).rows;
    const mkMap = new Map();
    for (const r of eo) { const p = d10(r.client_phone); const m = String(r.marketer || ''); if (!m || m === 'main_account' || m === '-' || /^\d+$/.test(m)) continue; if (!mkMap.has(p)) mkMap.set(p, m); }
    console.log(`Marketer map (phone→buyer) entries: ${mkMap.size}`);

    const eoCount = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=$1 AND network='safqa' AND external_id NOT LIKE 'sk-%'`, [BIZ])).rows[0].n;
    const csvSerials = rows.map(r => String(r['كود الطلب'] || '').trim()).filter(Boolean);
    const staleSk = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=$1 AND network='safqa' AND external_id LIKE 'sk-%' AND NOT (external_id = ANY($2::text[]))`, [BIZ, csvSerials])).rows[0].n;
    console.log(`Will: upsert ${rows.length} sk- from CSV | DELETE ${eoCount} EO rows | DELETE ${staleSk} stale sk- (serial not in CSV)`);

    if (!APPLY) { console.log('\nDry-run. Re-run with --apply (full backup taken first).'); return; }

    await client.query('BEGIN');
    await client.query(`DROP TABLE IF EXISTS ${BACKUP}`);
    await client.query(`CREATE TABLE ${BACKUP} AS SELECT * FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa'`);
    const bk = (await client.query(`SELECT COUNT(*)::int n FROM ${BACKUP}`)).rows[0].n;

    let up = 0;
    for (const r of rows) {
      const serial = String(r['كود الطلب'] || '').trim(); if (!serial) continue;
      const phone = norm(r['هاتف العميل']); const mk = (phone && mkMap.get(d10(phone))) || 'main_account';
      const st = String(r['الحالة'] || '').trim();
      await client.query(
        `INSERT INTO external_affiliate_orders
           (network, external_id, business_id, status, status_ar, status_class, total, marketer,
            product_name, sku, governorate, note, quantity, client_phone, safqa_serial, created_at, updated_at)
         VALUES ('safqa',$1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$1,COALESCE($13::timestamptz,NOW()),NOW())
         ON CONFLICT (network, external_id, business_id) DO UPDATE SET
            status=EXCLUDED.status, status_ar=EXCLUDED.status_ar, status_class=EXCLUDED.status_class,
            total=EXCLUDED.total, marketer=COALESCE(NULLIF(EXCLUDED.marketer,'main_account'), external_affiliate_orders.marketer),
            product_name=EXCLUDED.product_name, sku=EXCLUDED.sku, governorate=EXCLUDED.governorate,
            note=EXCLUDED.note, quantity=EXCLUDED.quantity, client_phone=EXCLUDED.client_phone,
            safqa_serial=EXCLUDED.safqa_serial, created_at=EXCLUDED.created_at, updated_at=NOW()`,
        [serial, BIZ, st, clsOf(st), money(r['العمولة']), mk, r['المنتجات'] || null, r['SKU'] || null,
         r['المحافظة'] || null, r['الملاحظة'] || null, parseInt(r['Qty'], 10) || 1, phone, parseDate(r['تاريخ الإنشاء'])]);
      up++;
    }
    const delEo = await client.query(`DELETE FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa' AND external_id NOT LIKE 'sk-%'`);
    const delStale = await client.query(`DELETE FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa' AND external_id LIKE 'sk-%' AND NOT (external_id = ANY($1::text[]))`, [csvSerials]);
    await client.query('COMMIT');

    const res = (await client.query(`
      SELECT COUNT(*)::int total,
             COUNT(*) FILTER (WHERE status_class='confirmed')::int ip_n,
             ROUND(SUM(total) FILTER (WHERE status_class='confirmed')::numeric) ip_sum,
             ROUND(SUM(total) FILTER (WHERE status_class='delivered')::numeric) del_sum
        FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa'`)).rows[0];
    console.log(`\n✅ Rebuilt. backup ${BACKUP} (${bk} rows). upserted ${up}, deleted ${delEo.rowCount} EO + ${delStale.rowCount} stale sk-.`);
    console.log(`   DB now: ${res.total} orders | IN PROGRESS ${res.ip_n} / ${res.ip_sum} EGP | DELIVERED ${res.del_sum}   [Safqa 119 / 35,582 / 98,557]`);
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} console.error('❌ rolled back:', e.message); process.exitCode = 1; }
  finally { client.release(); await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
