'use strict';
/* Post-rebuild marketer correction (Business 5 / Safqa).
   1. Clean slate: every Safqa sk- row → 'main_account' (kills the 69d90ab4 hash + FB-ID junk).
   2. Re-tag Adham 1:1 from the backup's utm_campaign='adham' EO rows, matched by phone count
      (per phone, tag exactly as many CSV rows as Adham had EO orders for that phone).
   Adham = utm_campaign='adham' is the SOLE attribution truth. Dry-run default; --apply. */
require('dotenv').config();
const pool = require('../config/db');
const BIZ = 5;
const APPLY = process.argv.includes('--apply');
const BACKUP = 'eao_csv_rebuild_bk_20260628';

(async () => {
  const client = await pool.connect();
  try {
    // Adham per-phone order count from the EO backup (utm truth)
    const counts = (await client.query(`
      SELECT RIGHT(regexp_replace(client_phone,'\\D','','g'),10) AS p10, COUNT(*)::int k
        FROM ${BACKUP}
       WHERE external_id NOT LIKE 'sk-%' AND marketer='adham' AND client_phone IS NOT NULL
       GROUP BY 1`)).rows.filter(r => r.p10 && r.p10.length === 10);
    console.log(`Adham EO phones: ${counts.length} (Σ orders ${counts.reduce((a, r) => a + r.k, 0)})`);

    if (!APPLY) {
      // project how many CSV rows would match
      let match = 0;
      for (const c of counts) {
        const n = (await client.query(`SELECT COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=$1 AND network='safqa' AND RIGHT(regexp_replace(client_phone,'\\D','','g'),10)=$2`, [BIZ, c.p10])).rows[0].n;
        match += Math.min(n, c.k);
      }
      console.log(`Projected: clean ALL → main_account, then tag ~${match} CSV rows as adham. Re-run with --apply.`);
      return;
    }

    await client.query('BEGIN');
    await client.query(`UPDATE external_affiliate_orders SET marketer='main_account' WHERE business_id=$1 AND network='safqa'`, [BIZ]);
    let tagged = 0;
    for (const c of counts) {
      // tag up to k CSV rows for this phone (prefer Stove QSMEFF3, then lowest id) as adham
      const r = await client.query(`
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY (UPPER(COALESCE(sku,'')) LIKE '%QSMEFF3%') DESC, id) rn
            FROM external_affiliate_orders
           WHERE business_id=$1 AND network='safqa'
             AND RIGHT(regexp_replace(client_phone,'\\D','','g'),10)=$2)
        UPDATE external_affiliate_orders o SET marketer='adham'
          FROM ranked WHERE o.id=ranked.id AND ranked.rn <= $3`, [BIZ, c.p10, c.k]);
      tagged += r.rowCount;
    }
    await client.query('COMMIT');

    const mk = (await client.query(`SELECT COALESCE(NULLIF(marketer,''),'(null)') m, COUNT(*)::int n FROM external_affiliate_orders WHERE business_id=$1 AND network='safqa' GROUP BY 1 ORDER BY 2 DESC`, [BIZ])).rows;
    console.log(`✅ Cleaned + tagged ${tagged} adham rows.`);
    console.log('Marketer split now:'); mk.rows ? null : null; mk.forEach(r => console.log('  ' + r.m + ': ' + r.n));
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} console.error('❌ rolled back:', e.message); process.exitCode = 1; }
  finally { client.release(); await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
