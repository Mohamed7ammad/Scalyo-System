'use strict';
/* Surgical dedup of in-progress dual-webhook pairs. For each sk- row that has an
   in-progress EO twin (same phone + canonical product): inject the Safqa serial +
   status into the EO row (keeping its calc_commission), then DELETE the sk-.
   Backup-first. Dry-run default; --apply to execute. */
require('dotenv').config();
const pool = require('../config/db');
const BIZ = 5;
const APPLY = process.argv.includes('--apply');
const BACKUP = 'eao_surgical_dedup_bk_20260628';
const cn = c => `TRIM(regexp_replace(regexp_replace(${c}, '^\\s*(\\(\\s*\\d+\\s*\\)\\s*)?(قطعة\\s+)?', ''), '\\s+[-–—].*$', ''))`;

/* DISTINCT ON (sk.id) → each sk- matched to exactly ONE EO twin (1:1, closest date). */
const PAIRS_SQL = `
  SELECT DISTINCT ON (sk.id)
         sk.id AS sk_id, sk.external_id AS serial, sk.status AS sk_status, sk.status_class AS sk_class,
         eo.id AS eo_id
    FROM external_affiliate_orders sk
    JOIN external_affiliate_orders eo
      ON eo.business_id=sk.business_id AND eo.network='safqa' AND eo.external_id NOT LIKE 'sk-%'
     AND COALESCE(eo.total,0)>0 AND eo.status_class='confirmed'
     AND eo.client_phone = sk.client_phone AND ${cn('eo.product_name')} = ${cn('sk.product_name')}
   WHERE sk.business_id=$1 AND sk.network='safqa' AND sk.external_id LIKE 'sk-%' AND sk.status_class='confirmed'
   ORDER BY sk.id, ABS(EXTRACT(EPOCH FROM (COALESCE(eo.created_at,eo.updated_at)-COALESCE(sk.created_at,sk.updated_at)))) ASC, eo.id`;

(async () => {
  const client = await pool.connect();
  try {
    const pairs = (await client.query(PAIRS_SQL, [BIZ])).rows;
    // ensure each EO is used once (avoid mapping 2 sk- to the same EO)
    const usedEo = new Set(); const final = [];
    for (const p of pairs) { if (usedEo.has(p.eo_id)) continue; usedEo.add(p.eo_id); final.push(p); }
    console.log(`In-progress dual-webhook pairs to merge: ${final.length}`);

    if (!APPLY) { console.log('Dry-run. Re-run with --apply.'); return; }
    if (final.length > 40) throw new Error(`SAFETY ABORT: ${final.length} pairs (>40) — investigate.`);

    await client.query('BEGIN');
    const skIds = final.map(p => p.sk_id);
    await client.query(`DROP TABLE IF EXISTS ${BACKUP}`);
    await client.query(`CREATE TABLE ${BACKUP} AS SELECT * FROM external_affiliate_orders WHERE id = ANY($1::int[])`, [skIds]);
    let merged = 0;
    for (const p of final) {
      // inject serial + Safqa status into the canonical EO row (keep its commission/marketer)
      await client.query(
        `UPDATE external_affiliate_orders
            SET safqa_serial = COALESCE(safqa_serial, $1),
                status = $2, status_class = $3, updated_at = NOW()
          WHERE id = $4 AND business_id = $5`,
        [p.serial, p.sk_status, p.sk_class, p.eo_id, BIZ]);
      merged++;
    }
    const del = await client.query(`DELETE FROM external_affiliate_orders WHERE id = ANY($1::int[])`, [skIds]);
    await client.query('COMMIT');

    const ip = (await client.query(`
      SELECT COUNT(*)::int n, ROUND(SUM(total)::numeric) sum FROM external_affiliate_orders
       WHERE business_id=$1 AND network='safqa' AND status_class='confirmed'
         AND (external_id LIKE 'sk-%' OR safqa_serial IS NOT NULL OR COALESCE(total,0)>0)`, [BIZ])).rows[0];
    console.log(`✅ Merged ${merged} EO rows (serial injected), deleted ${del.rowCount} sk- (backup ${BACKUP}).`);
    console.log(`   IN PROGRESS now: ${ip.n} orders / ${ip.sum} EGP   [Safqa: 119 / 35,886]`);
  } catch (e) { try{await client.query('ROLLBACK');}catch{} console.error('❌ rolled back:', e.message); process.exitCode=1; }
  finally { client.release(); await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
