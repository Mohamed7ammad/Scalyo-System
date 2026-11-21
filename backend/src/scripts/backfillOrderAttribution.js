/* ─────────────────────────────────────────────────────────────────────────
   Backfill order_attribution (ad platform / campaign / ad of each order) for
   EasyOrder orders that arrived before the webhook started recording it.

   Source 1 — the logged webhook bodies: every EasyOrder webhook is printed to
   the backend's pm2 out log ("📦 EasyOrder webhook (tenant N, plan …): {…}"),
   with utm_source / utm_campaign / metadata.referral_code / tracking.referrer.
   Source 2 (--api) — orders the log doesn't cover: GET orders/:id from
   EasyOrder's API, one call every 3 s (EasyOrder allows 40/min; the rating
   cron uses ≤ 7.5/min), stops at the first 429 / 401 / 403.

   Writes ONLY to order_attribution (INSERT … ON CONFLICT DO NOTHING) — no order
   row is touched. DRY-RUN by default.

   Usage (from backend/, on the server):
       node src/scripts/backfillOrderAttribution.js                    # dry run
       node src/scripts/backfillOrderAttribution.js --live             # write from the logs
       node src/scripts/backfillOrderAttribution.js --live --api       # + fetch the rest
         [--log=/root/.pm2/logs/scalyo-backend-out.log] [--max=400]
   ───────────────────────────────────────────────────────────────────────── */
'use strict';

require('dotenv').config();
const fs       = require('fs');
const readline = require('readline');
const pool     = require('../config/db');
const attribution = require('../services/attribution');

const LIVE = process.argv.includes('--live');
const API  = process.argv.includes('--api');
const arg  = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const LOGS = process.argv.filter((x) => x.startsWith('--log=')).map((x) => x.slice(6));
if (!LOGS.length) LOGS.push('/root/.pm2/logs/scalyo-backend-out.log');
const MAX_API = Math.max(0, parseInt(arg('max', '400'), 10) || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The same idempotency key ingestEasyOrder stores in orders.external_order_id. */
const externalIdOf = (b) => String(
  b.id ?? b.short_id ?? b.shortId ?? b.external_order_id ?? b.order_id ?? b.orderId ?? b.reference ?? b.ref ?? ''
).trim();

/* [\s\S] not '.': JSON.stringify leaves U+2028 / U+2029 raw (they turn up in
   pasted addresses) and '.' stops at them. */
const LINE_RE = /📦 EasyOrder webhook \(tenant (\d+), plan (\w+)\): (\{[\s\S]*)$/;

async function readLogs() {
  const byKey = new Map();            // "tenant|externalId" → attribution fields
  let lines = 0, bad = 0;
  for (const file of LOGS) {
    if (!fs.existsSync(file)) { console.log(`   (log not found: ${file})`); continue; }
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('📦 EasyOrder webhook (tenant')) continue;
      const m = LINE_RE.exec(line);
      if (!m || m[2] === 'affiliate') continue;
      lines++;
      let body;
      try { body = JSON.parse(m[3]); } catch { bad++; continue; }
      const ext = externalIdOf(body);
      if (!ext) continue;
      const key = `${m[1]}|${ext}`;
      if (!byKey.has(key)) byKey.set(key, attribution.fromEasyOrder(body));   // first sighting wins (retries are identical)
    }
  }
  return { byKey, lines, bad };
}

async function insertRows(rows, origin) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    const r = await pool.query(
      `INSERT INTO order_attribution (${attribution.COLUMNS.join(', ')})
       SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
       ON CONFLICT (order_id) DO NOTHING`,
      attribution.COLUMNS.map((_, c) => part.map((x) => attribution.rowValues(x.order_id, x.business_id, x, origin)[c]))
    );
    inserted += r.rowCount;
  }
  return inserted;
}

const tally = (rows) => rows.reduce((t, r) => { const k = `${r.channel}/${r.channel_source}`; t[k] = (t[k] || 0) + 1; return t; }, {});

async function main() {
  console.log(`📣 [backfillOrderAttribution] ${LIVE ? 'LIVE — will write' : 'DRY RUN — nothing is written'}${API ? ' · + EasyOrder API for the rest' : ''}`);
  /* Dry run: every session read-only, and the table is not even created. */
  if (!LIVE) pool.on('connect', (c) => { c.query('SET default_transaction_read_only = on').catch(() => {}); });
  const exists = (await pool.query(`SELECT to_regclass('public.order_attribution') AS t`)).rows[0].t !== null;
  if (LIVE) await attribution.ensureSchema();

  const { byKey, lines, bad } = await readLogs();
  console.log(`   logs: ${lines} EasyOrder webhook lines, ${byKey.size} distinct orders${bad ? `, ${bad} unreadable` : ''}`);

  const { rows: todo } = await pool.query(`
    SELECT o.id, o.business_id, o.external_order_id
      FROM orders o
      JOIN business_profile bp ON bp.id = o.business_id AND bp.plan_type <> 'affiliate'
     WHERE o.order_source = 'easyorder' AND o.external_order_id IS NOT NULL
       ${exists || LIVE ? 'AND NOT EXISTS (SELECT 1 FROM order_attribution a WHERE a.order_id = o.id)' : ''}`);
  console.log(`   EasyOrder orders without attribution: ${todo.length}`);

  const fromLog = [];
  const missing = [];
  for (const o of todo) {
    const a = byKey.get(`${o.business_id}|${o.external_order_id}`);
    if (a) fromLog.push({ order_id: o.id, business_id: o.business_id, ...a });
    else missing.push(o);
  }
  console.log(`   found in the logs: ${fromLog.length} → ${JSON.stringify(tally(fromLog))}`);
  console.log(`   not in the logs:   ${missing.length}`);
  if (LIVE && fromLog.length) console.log(`   ✔ inserted from logs: ${await insertRows(fromLog, 'log_backfill')}`);

  if (API && missing.length) {
    const uuids = missing.filter((o) => /^[0-9a-f-]{36}$/i.test(o.external_order_id)).slice(0, MAX_API);
    console.log(`   EasyOrder API: ${uuids.length} to fetch (1 every 3 s ≈ ${Math.ceil((uuids.length * 3) / 60)} min)${LIVE ? '' : ' — dry run, not fetching'}`);
    if (LIVE && uuids.length) {
      const tokens = new Map((await pool.query(
        `SELECT id, easyorder_api_token t FROM business_profile WHERE easyorder_api_token IS NOT NULL`)).rows.map((r) => [r.id, r.t]));
      const got = [];
      let gone = 0;
      for (const o of uuids) {
        const token = tokens.get(o.business_id);
        if (!token) continue;
        let res;
        try {
          res = await fetch(`https://api.easy-orders.net/api/v1/external-apps/orders/${o.external_order_id}`,
            { headers: { 'Api-Key': token, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        } catch (err) { console.log(`   ! #${o.id}: ${err.message}`); await sleep(3000); continue; }
        if ([401, 403, 429].includes(res.status)) { console.log(`   ⛔ EasyOrder answered ${res.status} — stopping the API part`); break; }
        if (res.ok) {
          const j = await res.json().catch(() => ({}));
          got.push({ order_id: o.id, business_id: o.business_id, ...attribution.fromEasyOrder(j.data || j) });
        } else gone++;
        if (got.length && got.length % 50 === 0) console.log(`     … ${got.length} fetched`);
        await sleep(3000);
      }
      console.log(`   API: ${got.length} fetched (${gone} not found) → ${JSON.stringify(tally(got))}`);
      if (got.length) console.log(`   ✔ inserted from API: ${await insertRows(got, 'api_backfill')}`);
    }
  }

  if (exists || LIVE) {
    const { rows: sum } = await pool.query(`
      SELECT channel, COUNT(*)::int n FROM order_attribution GROUP BY 1 ORDER BY 2 DESC`);
    console.log(`   order_attribution now: ${sum.map((r) => `${r.channel}=${r.n}`).join(' · ') || '(empty)'}`);
  }
}

main()
  .catch((err) => { console.error('❌', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
