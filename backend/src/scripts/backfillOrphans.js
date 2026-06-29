'use strict';
/* Backfill Safqa-only orphan orders missing from the DB (Business 5).
   Reads the Safqa CSV, finds serials present in the CSV but absent from the DB
   (neither external_id nor safqa_serial), and inserts them as serial-keyed sk-
   orphan rows with the CSV's EXACT status + realized commission (العمولة).
   Idempotent (ON CONFLICT serial). Backup-first. Dry-run default; --apply. */
require('dotenv').config();
const XLSX = require('xlsx');
const pool = require('../config/db');
const BIZ = 5;
const APPLY = process.argv.includes('--apply');
const FILE = process.argv.find(a => /\.xlsx?$/i.test(a)) || 'C:/Users/User/Downloads/orders (14).xlsx';
const BACKUP = 'eao_orphan_backfill_bk_20260628';

const norm = p => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d ? (d.length > 11 ? d.slice(-11) : d) : null; };
const money = v => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n) : 0; };
const AR = {
  'في الشحن': 'confirmed', 'جار التحضير': 'confirmed', 'جار التحضيير': 'confirmed',
  'تم التحصيل': 'delivered', 'تم التوصيل': 'delivered',
  'مرتجع': 'returned', 'جار الاسترجاع': 'returned',
  'ملغي': 'cancelled', 'ملغى': 'cancelled', 'معلق': 'pending',
  'طلب العميل الإستبدال': 'pending',
};
const clsOf = s => AR[String(s == null ? '' : s).trim()] || 'pending';
const parseDate = s => { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return null; let [, mo, d, y] = m; y = y.length === 2 ? '20' + y : y; return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')} 12:00:00`; };

(async () => {
  const client = await pool.connect();
  try {
    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets['Orders'], { defval: null, raw: false });
    const byExt = new Set((await client.query(`SELECT external_id FROM external_affiliate_orders WHERE business_id=$1 AND network='safqa'`, [BIZ])).rows.map(r => r.external_id));
    const bySer = new Set((await client.query(`SELECT safqa_serial FROM external_affiliate_orders WHERE business_id=$1 AND safqa_serial IS NOT NULL`, [BIZ])).rows.map(r => r.safqa_serial));
    const missing = rows.filter(r => { const s = String(r['كود الطلب'] || '').trim(); return s && !byExt.has(s) && !bySer.has(s); });

    const cls = {};
    for (const m of missing) { const c = clsOf(m['الحالة']); cls[c] = cls[c] || { n: 0, sum: 0 }; cls[c].n++; cls[c].sum += money(m['العمولة']); }
    console.log(`Truly-missing orphans to backfill: ${missing.length}`);
    Object.entries(cls).forEach(([k, v]) => console.log(`  ${k}: ${v.n} / ${v.sum} EGP`));

    if (!APPLY) { console.log('\nDry-run. Re-run with --apply (backup taken first).'); return; }

    await client.query('BEGIN');
    await client.query(`DROP TABLE IF EXISTS ${BACKUP}`);
    await client.query(`CREATE TABLE ${BACKUP} AS SELECT * FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa'`);
    let ins = 0;
    for (const r of missing) {
      const serial = String(r['كود الطلب'] || '').trim(); if (!serial) continue;
      const st = String(r['الحالة'] || '').trim();
      const r2 = await client.query(
        `INSERT INTO external_affiliate_orders
           (network, external_id, business_id, status, status_ar, status_class, total, marketer,
            product_name, sku, governorate, note, quantity, client_phone, safqa_serial, created_at, updated_at)
         VALUES ('safqa',$1,$2,$3,$3,$4,$5,'main_account',$6,$7,$8,$9,$10,$11,$1,COALESCE($12::timestamptz,NOW()),NOW())
         ON CONFLICT (network, external_id, business_id) DO UPDATE SET
            status=EXCLUDED.status, status_ar=EXCLUDED.status_ar, status_class=EXCLUDED.status_class,
            total=EXCLUDED.total, safqa_serial=EXCLUDED.safqa_serial, updated_at=NOW()`,
        [serial, BIZ, st, clsOf(st), money(r['العمولة']), r['المنتجات'] || null, r['SKU'] || null,
         r['المحافظة'] || null, r['الملاحظة'] || null, parseInt(r['Qty'], 10) || 1, norm(r['هاتف العميل']), parseDate(r['تاريخ الإنشاء'])]);
      ins += r2.rowCount;
    }
    await client.query('COMMIT');

    const v = (await client.query(`
      SELECT COUNT(*)::int total,
             COUNT(*) FILTER (WHERE status_class='confirmed')::int ip_n,
             ROUND(SUM(total) FILTER (WHERE status_class='confirmed')::numeric) ip_sum,
             ROUND(SUM(total) FILTER (WHERE status_class='delivered')::numeric) del_sum
        FROM external_affiliate_orders WHERE business_id=${BIZ} AND network='safqa'`)).rows[0];
    console.log(`\n✅ Backfilled ${ins} orphans (backup ${BACKUP}).`);
    console.log(`   DB now: ${v.total} orders | IN PROGRESS ${v.ip_n} / ${v.ip_sum} EGP | DELIVERED ${v.del_sum}   [Safqa target: 126 / 33,919]`);
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} console.error('❌ rolled back:', e.message); process.exitCode = 1; }
  finally { client.release(); await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
