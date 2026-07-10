/* ═══════════════════════════════════════════════════════════════════════════
   profileOrdersPerf.js — READ-ONLY latency profile of the Order Confirmation
   page's SQL (GET /api/orders pagination + GET /api/orders/stats aggregates).

   Run on the server (same env as the app so DATABASE_URL resolves):

       cd backend && node scripts/profileOrdersPerf.js            # busiest tenant
       cd backend && node scripts/profileOrdersPerf.js 5          # specific business_id

   What it checks, in order:
     1. The phase-5 indexes EXIST and are VALID. This is the #1 suspect:
        CREATE INDEX CONCURRENTLY that fails mid-build (timeout, conflict,
        restart) leaves an INVALID index behind — and because initTenancy uses
        IF NOT EXISTS, it will NEVER retry. An invalid index is dead weight:
        the planner ignores it and every query falls back to scans.
     2. Planner statistics freshness + seq-scan ratio on the orders table.
     3. Wall-clock timing (3 runs each) + EXPLAIN ANALYZE plans for the exact
        queries the two endpoints run: page-1, a deep cursor page, the stats
        counters, byStatus, and byAgent.

   Nothing here writes. EXPLAIN ANALYZE executes the SELECTs but discards
   output. Safe to run on the live DB during business hours.
   ═══════════════════════════════════════════════════════════════════════════ */
require('dotenv').config();
const pool = require('../src/config/db');

const EXPECTED_INDEXES = [
  'orders_tenant_keyset_idx',
  'orders_tenant_status_idx',
  'orders_tenant_assigned_idx',
];

const ms = (t0) => `${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms`;

async function timed(label, sql, params) {
  // Warm-up + 3 timed runs → report best (steady-state) and worst (cold-ish).
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const t0 = process.hrtime.bigint();
    await pool.query(sql, params);
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
    if (i > 0) runs.push(elapsed);
  }
  const best = Math.min(...runs).toFixed(1);
  const worst = Math.max(...runs).toFixed(1);
  console.log(`   ${label}: best ${best} ms / worst ${worst} ms`);
  return Number(best);
}

async function explain(label, sql, params) {
  const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
  const usesSeqScan = /Seq Scan on orders/.test(plan);
  const usesIndex = EXPECTED_INDEXES.filter((i) => plan.includes(i));
  console.log(`\n   ── PLAN: ${label} ${usesSeqScan ? '⚠️  SEQ SCAN' : '✅'} ${usesIndex.length ? `(uses ${usesIndex.join(', ')})` : ''}`);
  console.log(plan.split('\n').map((l) => '   │ ' + l).join('\n'));
}

(async () => {
  try {
    console.log('═'.repeat(70));
    console.log('1. INDEX HEALTH');
    console.log('═'.repeat(70));
    const { rows: idx } = await pool.query(`
      SELECT c.relname AS index_name,
             i.indisvalid,
             i.indisready,
             pg_size_pretty(pg_relation_size(c.oid)) AS size
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
       WHERE t.relname = 'orders'
       ORDER BY c.relname`);
    for (const r of idx) {
      const flag = r.indisvalid ? '✅' : '❌ INVALID — planner will NOT use it';
      console.log(`   ${flag}  ${r.index_name}  (${r.size})`);
    }
    const missing = EXPECTED_INDEXES.filter((e) => !idx.some((r) => r.index_name === e));
    const invalid = idx.filter((r) => EXPECTED_INDEXES.includes(r.index_name) && !r.indisvalid);
    if (missing.length) console.log(`\n   ❌ MISSING: ${missing.join(', ')} — phase 5 never completed. Fix SQL below.`);
    if (invalid.length) console.log(`\n   ❌ INVALID: ${invalid.map((r) => r.index_name).join(', ')} — a CONCURRENTLY build failed and IF NOT EXISTS will never retry. Fix SQL below.`);
    if (missing.length || invalid.length) {
      console.log('\n   FIX (run each line separately, NOT in one transaction):');
      for (const name of [...invalid.map((r) => r.index_name), ...missing]) {
        console.log(`     DROP INDEX IF EXISTS ${name};`);
      }
      console.log(`     CREATE INDEX CONCURRENTLY orders_tenant_keyset_idx   ON orders (business_id, is_lost_order, "createdAt" DESC, id DESC);`);
      console.log(`     CREATE INDEX CONCURRENTLY orders_tenant_status_idx   ON orders (business_id, is_lost_order, "Status");`);
      console.log(`     CREATE INDEX CONCURRENTLY orders_tenant_assigned_idx ON orders (business_id, is_lost_order, "AssignedTo");`);
    }

    console.log('\n' + '═'.repeat(70));
    console.log('2. TABLE HEALTH');
    console.log('═'.repeat(70));
    const { rows: [st] } = await pool.query(`
      SELECT n_live_tup, seq_scan, idx_scan, last_analyze, last_autoanalyze
        FROM pg_stat_user_tables WHERE relname = 'orders'`);
    console.log(`   live rows ~${st.n_live_tup} | seq_scans ${st.seq_scan} vs idx_scans ${st.idx_scan}`);
    console.log(`   last analyze: ${st.last_analyze ?? st.last_autoanalyze ?? 'NEVER — run: ANALYZE orders;'}`);

    // Tenant to profile: CLI arg or the busiest one.
    let businessId = parseInt(process.argv[2], 10);
    if (!businessId) {
      const { rows: [b] } = await pool.query(
        `SELECT business_id, COUNT(*) n FROM orders GROUP BY 1 ORDER BY n DESC LIMIT 1`);
      businessId = b.business_id;
      console.log(`   profiling busiest tenant: business_id=${businessId} (${b.n} orders)`);
    }

    console.log('\n' + '═'.repeat(70));
    console.log(`3. QUERY TIMINGS (business_id=${businessId}) — target: every one < 50 ms`);
    console.log('═'.repeat(70));

    const pageSql = `SELECT id, "FullName", "Phone", "Status", "createdAt" FROM orders
       WHERE business_id = $1 AND is_lost_order = false
       ORDER BY "createdAt" DESC, id DESC LIMIT 50`;
    await timed('page 1 (50 rows)', pageSql, [businessId]);

    // Deep page: cursor from ~2000 rows in (worst realistic keyset depth).
    const { rows: deep } = await pool.query(
      `SELECT "createdAt", id FROM orders WHERE business_id = $1 AND is_lost_order = false
        ORDER BY "createdAt" DESC, id DESC OFFSET 2000 LIMIT 1`, [businessId]);
    if (deep.length) {
      await timed('deep cursor page', `SELECT id FROM orders
         WHERE business_id = $1 AND is_lost_order = false
           AND ("createdAt", id) < ($2, $3)
         ORDER BY "createdAt" DESC, id DESC LIMIT 50`,
        [businessId, deep[0].createdAt, deep[0].id]);
    }

    const statsSql = `SELECT COUNT(*),
        COUNT(*) FILTER (WHERE "Status" = 'جديد'),
        COUNT(*) FILTER (WHERE "Status" = 'تم التأكيد')
       FROM orders WHERE business_id = $1 AND is_lost_order = false`;
    await timed('stats counters', statsSql, [businessId]);

    const byStatusSql = `SELECT btrim("Status"), COUNT(*)::int FROM orders
       WHERE business_id = $1 AND is_lost_order = false GROUP BY 1`;
    await timed('byStatus', byStatusSql, [businessId]);

    const byAgentSql = `SELECT COALESCE("AssignedTo",''), COUNT(*)::int FROM orders
       WHERE business_id = $1 AND is_lost_order = false GROUP BY 1`;
    await timed('byAgent', byAgentSql, [businessId]);

    const searchSql = `SELECT id FROM orders
       WHERE business_id = $1 AND is_lost_order = false
         AND ("FullName" ILIKE $2 OR "Phone" ILIKE $2 OR "BostaTrackingCode" ILIKE $2)
       ORDER BY "createdAt" DESC, id DESC LIMIT 50`;
    await timed('search (ILIKE)', searchSql, [businessId, '%010%']);

    console.log('\n' + '═'.repeat(70));
    console.log('4. EXECUTION PLANS');
    console.log('═'.repeat(70));
    await explain('page 1', pageSql, [businessId]);
    await explain('stats counters', statsSql, [businessId]);

    console.log('\nDone. If timings are <50 ms here but the page is slow, the DB is NOT');
    console.log('the bottleneck — look at network latency and frontend bundle instead.');
  } catch (err) {
    console.error('Profile failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
