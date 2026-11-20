'use strict';

/**
 * EasyOrder customer rating cron (owner, 2026-11-20).
 * (EasyOrder's «نسبة التسليم للعميل» → orders.easyorder_rate: high / moderate / low / unknown)
 *
 * EasyOrder rates every order it receives, across many couriers — a better
 * signal than Bosta alone and available for (almost) every order. It is not in
 * the order webhook (it's computed a little after the order is placed), but
 * GET /external-apps/orders/:id returns it in metadata["<phone>"]
 * (services/customerRating.easyOrderRateOf).
 *
 * Every 2 minutes: up to 15 EasyOrder orders of the last 3 days with no rating
 * yet, still «جديد» / «لا يرد» / «مراجعة جديدة» (a confirmed order is never looked
 * up — owner, 2026-11-20), at least 1 minute old, newest first, ONE call each, 2 s apart —
 * ≤ 7.5 calls/min against EasyOrder's 40/min. Not ready → retried next run (max
 * 6 tries); unknown order (400/404) → given up; 429/401/403 → the run stops.
 * Runs only when index.js starts crons (NODE_ENV=production).
 */

const cron = require('node-cron');
const pool = require('../config/db');
const { easyOrderRateOf, RATE_STATUSES } = require('../services/customerRating');

const SCHEDULE     = process.env.EASYORDER_RATE_CRON || '*/2 * * * *';
const BATCH        = Math.min(20, Number(process.env.EASYORDER_RATE_BATCH) || 15);
const SLEEP_MS     = Math.max(1600, Number(process.env.EASYORDER_RATE_SLEEP_MS) || 2000);
const MAX_ATTEMPTS = 6;
const API          = 'https://api.easy-orders.net/api/v1/external-apps/orders/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const schemaReady = (async () => {
  try {
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS easyorder_rate VARCHAR(20),
                                         ADD COLUMN IF NOT EXISTS easyorder_rate_at TIMESTAMPTZ,
                                         ADD COLUMN IF NOT EXISTS easyorder_rate_attempts SMALLINT NOT NULL DEFAULT 0`);
    await pool.query(`CREATE INDEX IF NOT EXISTS orders_easyorder_rate_todo_idx ON orders ("createdAt" DESC)
                       WHERE easyorder_rate IS NULL AND order_source = 'easyorder'`);
    console.log('✅  EasyOrder rating: columns ready');
    return true;
  } catch (e) {
    console.warn('⚠️   EasyOrder rating schema:', e.message);
    return false;
  }
})();

const bump   = (id) => pool.query(`UPDATE orders SET easyorder_rate_attempts = easyorder_rate_attempts + 1 WHERE id = $1`, [id]);
const giveUp = (id) => pool.query(`UPDATE orders SET easyorder_rate_attempts = 99 WHERE id = $1`, [id]);

let running = false;
async function runSweep() {
  if (running) return;
  running = true;
  try {
    if (!(await schemaReady)) return;
    const { rows } = await pool.query(`
      SELECT o.id, o.external_order_id AS uuid, bp.easyorder_api_token AS token
        FROM orders o
        JOIN business_profile bp ON bp.id = o.business_id
       WHERE o.order_source = 'easyorder'
         AND o.easyorder_rate IS NULL
         AND o.easyorder_rate_attempts < $1
         AND btrim(o."Status") = ANY($3::text[])          -- new / no-answer only, never a confirmed order
         AND o.external_order_id ~ '^[0-9a-f-]{36}$'
         AND COALESCE(bp.easyorder_api_token, '') <> ''
         AND o."createdAt" > NOW() - INTERVAL '3 days'
         AND o."createdAt" < NOW() - INTERVAL '1 minute'
       ORDER BY o."createdAt" DESC
       LIMIT $2`, [MAX_ATTEMPTS, BATCH, RATE_STATUSES]);
    if (!rows.length) return;

    let rated = 0;
    for (const r of rows) {
      let res;
      try {
        res = await fetch(API + r.uuid, {
          headers: { 'Api-Key': r.token, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        await bump(r.id);
        await sleep(SLEEP_MS);
        continue;
      }
      if (res.status === 429 || res.status === 401 || res.status === 403) {
        console.warn(`🛑 [easyorderRate] EasyOrder HTTP ${res.status} — halting run (rated ${rated})`);
        return;
      }
      if (res.status === 400 || res.status === 404) {
        await giveUp(r.id);
      } else {
        const body = await res.json().catch(() => null);
        const rate = easyOrderRateOf(body && (body.data || body));
        if (res.ok && rate && rate.done) {
          await pool.query(
            `UPDATE orders SET easyorder_rate = $1, easyorder_rate_at = NOW() WHERE id = $2 AND easyorder_rate IS NULL`,
            [rate.result, r.id]);
          rated++;
        } else {
          await bump(r.id);
        }
      }
      await sleep(SLEEP_MS);
    }
    if (rated) console.log(`✅  [easyorderRate] rated ${rated}/${rows.length} order(s)`);
  } finally {
    running = false;
  }
}

function startEasyOrderRateCron() {
  cron.schedule(SCHEDULE, () => {
    runSweep().catch((e) => console.error('[easyorderRate] sweep error:', e.message));
  });
  console.log(`✅  EasyOrder rating cron scheduled (${SCHEDULE}, batch ${BATCH}, ${SLEEP_MS} ms apart, last 3 days, newest first).`);
}

module.exports = { startEasyOrderRateCron, runSweep, schemaReady };
