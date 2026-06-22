'use strict';

/* ─────────────────────────────────────────────────────────────────────────
   fix-incident.js — post-downtime order triage. THREE explicit modes:

     --mode report   (DEFAULT, READ-ONLY)
         Forensic analysis. Splits the 'جديد' population into:
           • FALSE-NEW  : a processed twin (same phone+product, non-'جديد')
                          already exists → a re-imported duplicate.
           • SURVIVORS  : no processed twin. For these it reports createdAt age
                          buckets + the "mutated-old" signal (old createdAt but
                          updatedAt during the incident) + comm_no_answer
                          corroboration, to test the "status was flipped back
                          to جديد in place" hypothesis.

     --mode revert  --incident-start <ISO>  [--commit]
         For SURVIVORS that are MUTATED-OLD orders (createdAt BEFORE the incident
         AND updatedAt AT/AFTER it → the row itself was edited, not re-inserted),
         set "Status" back to 'لا يرد'. Backup-first; reversible.

     --mode purge   [--commit]
         DELETE the FALSE-NEW re-imported duplicates. Backup-first; reversible.

   SAFETY (all write modes):
     • DRY-RUN by default — you must pass --commit to write anything.
     • BACKUP-FIRST — snapshots affected rows (full, incl. current Status) into a
       timestamped table inside one transaction BEFORE the write. Fully undoable.
     • Excludes rows carrying a Bosta tracking code or a deposit (real activity /
       money — must be handled by hand).
     • Tenant-scoped: twins are matched only within the same business_id.
     • revert ABORTS unless --incident-start is supplied (age is the whole basis
       of the mutation hypothesis).

   Usage (run from backend/):
     node fix-incident.js                                            # report, all tenants
     node fix-incident.js --incident-start 2026-06-21T18:00          # report w/ mutation split
     node fix-incident.js --mode revert --incident-start 2026-06-21T18:00          # revert DRY-RUN
     node fix-incident.js --mode revert --incident-start 2026-06-21T18:00 --commit # revert APPLY
     node fix-incident.js --mode purge                               # purge DRY-RUN
     node fix-incident.js --mode purge --commit                      # purge APPLY
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('./src/config/db');

/* ── Args ─────────────────────────────────────────────────────────────────── */
const argv    = process.argv.slice(2);
const COMMIT  = argv.includes('--commit');
const flagVal = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const MODE     = flagVal('--mode') || 'report';
const argBiz   = flagVal('--biz') ? Number(flagVal('--biz')) : null;
const SINCE    = flagVal('--incident-start');     // ISO timestamp of the downtime start

const NEW = 'جديد';
const NO_ANSWER = 'لا يرد';

const log  = (...a) => console.log(...a);
const rule = () => log('─'.repeat(72));

/* Processed twin exists for candidate row `n` (phone last-10 + exact product).
   '\\D' in JS source becomes the SQL regex '\D' (any non-digit).               */
const TWIN_EXISTS = `
  EXISTS (
    SELECT 1 FROM orders t
     WHERE t.business_id = n.business_id
       AND t.id <> n.id
       AND t."Status" <> '${NEW}'
       AND COALESCE(t."ProductName",'') = COALESCE(n."ProductName",'')
       AND right(regexp_replace(COALESCE(t."Phone",''), '\\D','','g'),10)
         = right(regexp_replace(COALESCE(n."Phone",''), '\\D','','g'),10)
  )`;

/* Shared row guards: real activity/money rows are off-limits. */
const SAFE_GUARDS = `
    n."BostaTrackingCode" IS NULL
    AND COALESCE(n."hasDeposit", false) = false
    AND COALESCE(n."depositAmount", 0) = 0`;

const bizClause = (n) => (argBiz ? `AND n.business_id = $${n}::int` : '');

/* ── Safety gate: processed orders must still exist ──────────────────────────*/
async function assertProcessedExist() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders
      WHERE "Status" <> '${NEW}' ${argBiz ? 'AND business_id = $1' : ''}`,
    argBiz ? [argBiz] : []
  );
  log(`  processed (non-'${NEW}') orders present : ${rows[0].n}`);
  if (rows[0].n === 0) {
    log(`\n🛑 ABORT: zero processed orders exist — that is real data loss, not a`);
    log(`   re-import/mutation. Do NOT write anything; restore from Supabase backup/PITR.\n`);
    return false;
  }
  return true;
}

/* ── MODE: report (read-only) ────────────────────────────────────────────────*/
async function runReport() {
  if (!(await assertProcessedExist())) return;

  const p = argBiz ? [argBiz] : [];
  const falseNew = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders n
      WHERE n."Status"='${NEW}' AND ${TWIN_EXISTS} ${bizClause(1)}`, p)).rows[0].n;
  const survivors = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders n
      WHERE n."Status"='${NEW}' AND NOT ${TWIN_EXISTS} ${bizClause(1)}`, p)).rows[0].n;

  log(`\n[POPULATION]`);
  log(`  FALSE-NEW (has processed twin → re-import) : ${falseNew}`);
  log(`  SURVIVORS (no twin → inspect below)        : ${survivors}`);

  /* createdAt age buckets for survivors — the core of the user's question. */
  const age = (await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE n."createdAt" >= NOW() - INTERVAL '1 day')                       AS d_today,
        COUNT(*) FILTER (WHERE n."createdAt" <  NOW() - INTERVAL '1 day'  AND n."createdAt" >= NOW() - INTERVAL '7 days')   AS d_1_7,
        COUNT(*) FILTER (WHERE n."createdAt" <  NOW() - INTERVAL '7 days' AND n."createdAt" >= NOW() - INTERVAL '30 days')  AS d_7_30,
        COUNT(*) FILTER (WHERE n."createdAt" <  NOW() - INTERVAL '30 days')                      AS d_30plus
       FROM orders n
      WHERE n."Status"='${NEW}' AND NOT ${TWIN_EXISTS} ${bizClause(1)}`, p)).rows[0];
  log(`\n  survivor createdAt age:`);
  log(`     ≤1 day (genuinely new?) : ${age.d_today}`);
  log(`     1–7 days                : ${age.d_1_7}`);
  log(`     8–30 days               : ${age.d_7_30}`);
  log(`     >30 days (OLD!)         : ${age.d_30plus}`);
  log(`  → A high >30-days count = these are NOT new orders. Supports the`);
  log(`    "old order mutated in place to '${NEW}'" hypothesis.`);

  /* Mutation signal: old createdAt + updatedAt during the incident. */
  if (SINCE) {
    const m = (await pool.query(
      `SELECT
          COUNT(*) FILTER (WHERE n."createdAt" <  $1::timestamptz AND n."updatedAt" >= $1::timestamptz) AS mutated_old,
          COUNT(*) FILTER (WHERE n."createdAt" <  $1::timestamptz AND n."updatedAt" <  $1::timestamptz) AS old_untouched,
          COUNT(*) FILTER (WHERE n."createdAt" >= $1::timestamptz)                                       AS truly_recent
         FROM orders n
        WHERE n."Status"='${NEW}' AND NOT ${TWIN_EXISTS} ${argBiz ? 'AND n.business_id = $2::int' : ''}`,
      argBiz ? [SINCE, argBiz] : [SINCE])).rows[0];
    log(`\n  mutation split vs --incident-start ${SINCE}:`);
    log(`     MUTATED-OLD  (created before, updated during incident) : ${m.mutated_old}  ← revert candidates`);
    log(`     old & untouched (created & updated before incident)    : ${m.old_untouched}  (left alone)`);
    log(`     truly recent (created at/after incident)               : ${m.truly_recent}  (genuine new)`);
  } else {
    log(`\n  (pass --incident-start <ISO> to split survivors into mutated-old vs genuine-new)`);
  }

  /* comm_no_answer corroboration — proves a PRIOR 'لا يرد' for the subset that
     had 5+ logged attempts. High precision, low recall (absence proves nothing). */
  try {
    const cna = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM orders n
        WHERE n."Status"='${NEW}' AND NOT ${TWIN_EXISTS} ${bizClause(1)}
          AND EXISTS (SELECT 1 FROM treasury_transactions tx
                       WHERE tx.order_id = n.id AND tx.source = 'comm_no_answer')`, p)).rows[0].n;
    log(`\n  survivors with a 'comm_no_answer' treasury txn : ${cna}`);
    log(`  → these PROVABLY were '${NO_ANSWER}' before (5+ call attempts logged).`);
  } catch (e) {
    log(`\n  (comm_no_answer corroboration skipped: ${e.message})`);
  }

  /* Sample with both timestamps so the age is visible per-row. */
  const sample = (await pool.query(
    `SELECT n.id, n."createdAt", n."updatedAt", n."Phone"
       FROM orders n
      WHERE n."Status"='${NEW}' AND NOT ${TWIN_EXISTS} ${bizClause(1)}
      ORDER BY n."createdAt" ASC LIMIT 15`, p)).rows;
  log(`\n  oldest 15 survivors (id · created · updated · phone):`);
  for (const r of sample) {
    log(`     #${r.id}  created ${new Date(r.createdAt).toISOString().slice(0,16)}` +
        `  updated ${r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0,16) : '—'}  ${r.Phone||'—'}`);
  }

  rule();
  log(`  Read-only. Next steps:`);
  log(`   • Re-import duplicates → node fix-incident.js --mode purge`);
  log(`   • Mutated-old → '${NO_ANSWER}' → node fix-incident.js --mode revert --incident-start <ISO>`);
  rule();
}

/* ── MODE: revert mutated-old survivors → 'لا يرد' ───────────────────────────*/
async function runRevert() {
  if (!SINCE) {
    log(`🛑 --mode revert requires --incident-start <ISO> (e.g. 2026-06-21T18:00).`);
    log(`   That timestamp is how we tell a mutated-old order from a genuine new one.`);
    return;
  }
  if (!(await assertProcessedExist())) return;

  /* Candidate = SURVIVOR that is mutated-old: created before the incident, but
     touched (updatedAt) at/after it; not shipped; no deposit; no processed twin. */
  const WHERE = `
    FROM orders n
    WHERE n."Status" = '${NEW}'
      AND n."createdAt" <  $1::timestamptz
      AND n."updatedAt" >= $1::timestamptz
      AND ${SAFE_GUARDS}
      AND NOT ${TWIN_EXISTS}
      ${argBiz ? 'AND n.business_id = $2::int' : ''}`;
  const params = argBiz ? [SINCE, argBiz] : [SINCE];

  const cand = (await pool.query(`SELECT n.id ${WHERE}`, params)).rows;
  let proven = 0;
  try {
    proven = (await pool.query(
      `SELECT COUNT(*)::int AS n ${WHERE}
         AND EXISTS (SELECT 1 FROM treasury_transactions tx
                      WHERE tx.order_id = n.id AND tx.source = 'comm_no_answer')`, params)).rows[0].n;
  } catch { /* treasury table absent — skip */ }

  log(`\n[REVERT → '${NO_ANSWER}']`);
  log(`  mutated-old survivors matched : ${cand.length}`);
  log(`  └─ with 'comm_no_answer' proof : ${proven}  (high confidence)`);
  log(`  └─ without explicit proof      : ${cand.length - proven}  (trusting your domain knowledge)`);

  if (cand.length === 0) { log(`\n✅ Nothing matches. Nothing to do.\n`); return; }

  const sample = (await pool.query(
    `SELECT n.id, n."createdAt", n."updatedAt" ${WHERE} ORDER BY n."createdAt" ASC LIMIT 15`, params)).rows;
  log(`\n  sample (oldest 15):`);
  for (const r of sample)
    log(`     #${r.id}  created ${new Date(r.createdAt).toISOString().slice(0,16)}` +
        `  updated ${new Date(r.updatedAt).toISOString().slice(0,16)}`);

  if (!COMMIT) {
    rule();
    log(`  DRY-RUN — nothing changed. If the count ≈ your missing '${NO_ANSWER}' orders,`);
    log(`  re-run with --commit:`);
    log(`     node fix-incident.js --mode revert --incident-start ${SINCE}` +
        `${argBiz ? ` --biz ${argBiz}` : ''} --commit`);
    rule();
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bk = `orders_statusrevert_backup_${stamp}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE ${bk} AS SELECT n.* ${WHERE}`, params);
    const cnt = (await client.query(`SELECT COUNT(*)::int AS n FROM ${bk}`)).rows[0].n;
    const upd = await client.query(
      `UPDATE orders SET "Status" = '${NO_ANSWER}'
        WHERE id IN (SELECT id FROM ${bk}) AND "Status" = '${NEW}' RETURNING id`);
    await client.query('COMMIT');
    rule();
    log(`  💾 Backed up ${cnt} row(s) (with original Status) → "${bk}"`);
    log(`  ↩️  Reverted ${upd.rowCount} order(s): '${NEW}' → '${NO_ANSWER}'`);
    log(`\n  UNDO:  UPDATE orders o SET "Status"=b."Status" FROM ${bk} b WHERE o.id=b.id;`);
    log(`  CLEAN: DROP TABLE ${bk};`);
    rule();
  } catch (err) {
    await client.query('ROLLBACK');
    log(`\n❌ Rolled back — nothing changed: ${err.message}`);
    process.exitCode = 1;
  } finally { client.release(); }
}

/* ── MODE: purge false-new re-imports (DELETE) ───────────────────────────────*/
async function runPurge() {
  if (!(await assertProcessedExist())) return;

  const WHERE = `
    FROM orders n
    WHERE n."Status" = '${NEW}'
      AND ${SAFE_GUARDS}
      AND ${TWIN_EXISTS}
      ${argBiz ? 'AND n.business_id = $1::int' : ''}`;
  const params = argBiz ? [argBiz] : [];

  const matched = (await pool.query(
    `SELECT n.id, n."Phone", n."ProductName", n."createdAt" ${WHERE} ORDER BY n."createdAt" DESC`, params)).rows;
  log(`\n[PURGE — delete false-new]`);
  log(`  matched re-imports : ${matched.length}`);
  if (matched.length === 0) { log(`\n✅ Nothing to purge.\n`); return; }
  for (const r of matched.slice(0, 15))
    log(`     #${r.id}  ${r.Phone||'—'}  ${(r.ProductName||'—').slice(0,28)}  ${new Date(r.createdAt).toISOString().slice(0,16)}`);

  if (!COMMIT) {
    rule();
    log(`  DRY-RUN — nothing deleted. Re-run with --commit to back up + delete.`);
    rule();
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bk = `orders_falsenew_backup_${stamp}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE ${bk} AS SELECT n.* ${WHERE}`, params);
    const cnt = (await client.query(`SELECT COUNT(*)::int AS n FROM ${bk}`)).rows[0].n;
    const del = await client.query(
      `DELETE FROM orders WHERE id IN (SELECT id FROM ${bk}) AND "Status"='${NEW}' RETURNING id`);
    await client.query('COMMIT');
    rule();
    log(`  💾 Backed up ${cnt} row(s) → "${bk}"`);
    log(`  🗑️  Deleted ${del.rowCount} false-new order(s)`);
    log(`\n  UNDO:  INSERT INTO orders SELECT * FROM ${bk};`);
    log(`  CLEAN: DROP TABLE ${bk};`);
    rule();
  } catch (err) {
    await client.query('ROLLBACK');
    log(`\n❌ Rolled back — nothing deleted: ${err.message}`);
    process.exitCode = 1;
  } finally { client.release(); }
}

async function main() {
  rule();
  log(`  fix-incident.js — mode: ${MODE}` +
      `${MODE !== 'report' ? (COMMIT ? '  ⚠️ COMMIT' : '  🔍 DRY-RUN') : '  (read-only)'}`);
  log(`  scope: ${argBiz ? `business_id=${argBiz}` : 'ALL tenants'}` +
      `${SINCE ? ` · incident-start ${SINCE}` : ''}`);
  rule();

  if (MODE === 'report')      await runReport();
  else if (MODE === 'revert') await runRevert();
  else if (MODE === 'purge')  await runPurge();
  else log(`🛑 Unknown --mode "${MODE}". Use report | revert | purge.`);
}

main()
  .catch((err) => { console.error('\n❌ fix-incident.js failed:', err); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
