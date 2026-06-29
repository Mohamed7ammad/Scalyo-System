'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   READ-ONLY production monitor for the 3-layer Safqa orphan failsafe (Business 5).
   Run any time — it NEVER writes. Confirms orphans are being created (Layer 2) and
   adopted (Layer 1) without spawning duplicates, and flags anything Layer 3 will fold.
     node src/scripts/verifyFailsafe.js            # last 24h window
     node src/scripts/verifyFailsafe.js 72         # last 72h window
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const pool = require('../config/db');
const BIZ = 5;
const HOURS = parseInt(process.argv.find(a => /^\d+$/.test(a)), 10) || 24;
const GRACE = Number(process.env.SAFQA_RECONCILE_GRACE_HOURS) || 6;
const CP = c => `TRIM(regexp_replace(regexp_replace(${c}, '^\\s*(\\(\\s*\\d+\\s*\\)\\s*)?(قطعة\\s+)?', ''), '\\s+[-–—].*$', ''))`;
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const n = v => Number(v || 0);

(async () => {
  try {
    console.log(`\n════ Safqa failsafe monitor — Business ${BIZ} — window ${HOURS}h ════`);
    console.log(`flags: SAFQA_RECONCILE=${process.env.SAFQA_RECONCILE ?? '(unset)'} | GRACE=${GRACE}h | NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}`);

    /* 1 ── headline financials vs the wallet ─────────────────────────────────── */
    const fin = (await q(`
      SELECT COUNT(*)::int total,
             COUNT(*) FILTER (WHERE status_class='confirmed')::int ip_n,
             ROUND(SUM(total) FILTER (WHERE status_class='confirmed')::numeric)::int ip_sum,
             ROUND(SUM(total) FILTER (WHERE status_class='delivered')::numeric)::int del_sum
        FROM external_affiliate_orders
       WHERE business_id=$1 AND network='safqa'
         AND (external_id LIKE 'sk-%' OR safqa_serial IS NOT NULL OR COALESCE(total,0)>0)`, [BIZ]))[0];
    console.log(`\n[1] FINANCIALS  total=${fin.total} | IN-PROGRESS ${fin.ip_n} / ${fin.ip_sum} EGP | DELIVERED ${fin.del_sum} EGP`);

    /* 2 ── Layer 2: orphans created in window (sk-, no EO data yet) ───────────── */
    const orph = (await q(`
      SELECT COUNT(*)::int n, ROUND(COALESCE(SUM(total),0)::numeric)::int sum
        FROM external_affiliate_orders
       WHERE business_id=$1 AND network='safqa' AND external_id LIKE 'sk-%'
         AND COALESCE(calc_commission,0)=0 AND marketer='main_account'
         AND created_at >= NOW() - ($2||' hours')::interval`, [BIZ, String(HOURS)]))[0];
    console.log(`[2] LAYER-2 orphans created in ${HOURS}h: ${orph.n} (${orph.sum} EGP)   (Safqa-only orders the webhook recovered)`);

    /* 3 ── Layer 1: adoptions in window (sk- that GAINED EO attribution) ──────── */
    const adopt = (await q(`
      SELECT COUNT(*)::int n FROM external_affiliate_orders
       WHERE business_id=$1 AND network='safqa' AND external_id LIKE 'sk-%'
         AND (marketer <> 'main_account' OR COALESCE(calc_commission,0)>0)
         AND updated_at >= NOW() - ($2||' hours')::interval
         AND updated_at > created_at + INTERVAL '1 minute'`, [BIZ, String(HOURS)]))[0];
    console.log(`[3] LAYER-1 adoptions in ${HOURS}h (orphan later stamped by EasyOrder): ${adopt.n}`);

    /* 4 ── Layer 3: TRUE twin pairs (proximity-guarded, same-order only) by grace ── */
    const PROX = Number(process.env.SAFQA_RECONCILE_PROXIMITY_HOURS) || 12;
    const pairs = await q(`
      SELECT (sk.updated_at < NOW() - ($2||' hours')::interval) AS ripe, COUNT(*)::int n
        FROM external_affiliate_orders sk
        JOIN external_affiliate_orders eo
          ON eo.business_id=sk.business_id AND eo.network='safqa' AND eo.external_id NOT LIKE 'sk-%'
         AND eo.client_phone=sk.client_phone AND ${CP('eo.product_name')}=${CP('sk.product_name')}
         AND ABS(EXTRACT(EPOCH FROM (COALESCE(eo.created_at,eo.updated_at)-COALESCE(sk.created_at,sk.updated_at)))) < $3*3600
       WHERE sk.business_id=$1 AND sk.network='safqa' AND sk.external_id LIKE 'sk-%'
         AND COALESCE(sk.calc_commission,0)=0
       GROUP BY 1`, [BIZ, String(GRACE), PROX]);
    const ripe = n(pairs.find(p => p.ripe)?.n), young = n(pairs.find(p => !p.ripe)?.n);
    console.log(`[4] LAYER-3 TRUE twins (≤${PROX}h apart): ${ripe} ripe (>${GRACE}h → cron folds next run) | ${young} in-grace (Layer-1's first)`);

    /* 5 ── DUPLICATE GUARD: same phone+product with >1 OPEN backed row, classified
       by composition. sk⨯eo = the FAILSAFE failure mode (Layer-1 miss → Layer-3
       folds). eo⨯eo / sk⨯sk = pre-existing repeat-customer / distinct-serial
       ambiguity kept BY DESIGN (primaryCreate), NOT a failsafe regression. */
    const groups = await q(`
      SELECT client_phone, ${CP('product_name')} AS prod,
             COUNT(*) FILTER (WHERE external_id LIKE 'sk-%')::int sk,
             COUNT(*) FILTER (WHERE external_id NOT LIKE 'sk-%')::int eo
        FROM external_affiliate_orders
       WHERE business_id=$1 AND network='safqa' AND status_class IN ('pending','confirmed')
         AND (external_id LIKE 'sk-%' OR safqa_serial IS NOT NULL OR COALESCE(total,0)>0)
         AND client_phone IS NOT NULL
       GROUP BY client_phone, ${CP('product_name')}
      HAVING COUNT(*) > 1`, [BIZ]);
    const skeo = groups.filter(g => g.sk > 0 && g.eo > 0);   // failsafe-relevant
    const other = groups.filter(g => g.sk === 0 || g.eo === 0); // repeat-customer noise
    console.log(`[5] DUPLICATE GUARD (open):  sk⨯EO twins (failsafe) = ${skeo.length}` +
                (skeo.length ? '  ⚠ Layer-3 should fold these' : '  ✅ none — no duplicate factory') +
                `  |  eo⨯eo / sk⨯sk (repeat-customer, by-design) = ${other.length}`);
    skeo.slice(0, 8).forEach(g => console.log(`      ⚠ ${g.client_phone} | ${String(g.prod).slice(0,26)} | ${g.sk}×sk ${g.eo}×eo`));

    console.log(`\nLegend: [2] rising + [3] rising + [5] sk⨯EO=0 ⇒ failsafe healthy (orphans recovered & adopted, no factory).\n`);
  } catch (e) { console.error('verify failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();
