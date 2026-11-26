'use strict';

/**
 * DeliveryRate enrichment cron — polite, cached, BUDGETED.
 * (Bosta consignee reputation → حالة الاستلام: ممتاز / متوسط / ضعيف / جديد)
 *
 * WHY THIS EXISTS
 *   Bosta hard rate-limits the consignee-ranking endpoint. Measured (2026-10-31,
 *   again 2026-11-20): ~100 lookups, then HTTP 429 (errorCode 4029 "You requested
 *   to get consignee ranking too many times") for ~24 h. The old sweep (5 phones
 *   every 15 min) burnt the 100 in ~5 h and then sat blocked for the rest of the
 *   day, and it picked phones in sorted order — so 010/011 numbers were looked up
 *   first and 012/015 almost never: on 2026-11-20 only 13 of 113 orders had a
 *   Bosta rating.
 *
 * ARCHITECTURE
 *   1. Phone-level cache (bosta_consignee_cache, tenant-scoped): once a phone is
 *      resolved it is 'done' and NEVER fetched again. Repeated soft failures flip
 *      to 'failed' after MAX_ATTEMPTS.
 *   2. Every run first APPLIES cached 'done' rates to any 'بدون' orders sharing
 *      that phone — a pure DB update, ZERO Bosta calls.
 *   3. BUDGET (services/customerRating.bostaBudget, every call logged in
 *      bosta_rank_calls): ≤ BUDGET_24H lookups in any rolling 24 h and ≤ BUDGET_4H
 *      per 4 h, ONE lookup per run (every 5 min) — the day's quota is spread over
 *      the whole day and never reaches Bosta's block. After a 429, one probe per
 *      hour until it lifts (probes during the block don't extend it).
 *   4. PRIORITY: only new / no-answer orders (جديد / لا يرد / مراجعة جديدة — a
 *      confirmed order is never looked up), at least 5 min old (EasyOrder's own
 *      rating has arrived by then), those EasyOrder did NOT rate «high» first —
 *      then newest first. If the day's budget runs out, EasyOrder's rating is
 *      what the team relies on.
 *   5. CIRCUIT BREAKER: 429/401/403 stops the run.
 *
 *   The API calls only ever run when the cron fires, which index.js gates behind
 *   NODE_ENV=production. On-demand enrichment at order creation was removed.
 *
 * Tunables (env-overridable):
 *   DELIVERY_RATE_CRON          schedule                     (default every 5 min)
 *   DELIVERY_RATE_BUDGET_24H    lookups per rolling 24 h      (default 90, hard cap 95)
 *   DELIVERY_RATE_BUDGET_4H     lookups per rolling 4 h       (default 15)
 *   DELIVERY_RATE_MAX_ATTEMPTS  soft-fails before 'failed'    (default 3)
 *   DELIVERY_RATE_MAX_AGE_DAYS  only enrich orders newer than (default 14)
 *   DELIVERY_RATE_CUTOFF        skip orders created before    (default 2026-07-05)
 */

const cron = require('node-cron');
const pool = require('../config/db');
const { fetchDeliveryRate } = require('../services/bostaEnrich');
const { bostaBudget, RATE_STATUSES } = require('../services/customerRating');

const SCHEDULE     = process.env.DELIVERY_RATE_CRON              || '*/5 * * * *';
const BUDGET_24H   = Math.min(95, Number(process.env.DELIVERY_RATE_BUDGET_24H) || 90);
const BUDGET_4H    = Math.min(BUDGET_24H, Number(process.env.DELIVERY_RATE_BUDGET_4H) || 15);
const MAX_ATTEMPTS = Number(process.env.DELIVERY_RATE_MAX_ATTEMPTS) || 3;
const MAX_AGE_DAYS = Number(process.env.DELIVERY_RATE_MAX_AGE_DAYS) || 14;
/* "Forget the past": only orders created on/after this date ever reach Bosta. */
const BACKLOG_CUTOFF = process.env.DELIVERY_RATE_CUTOFF || '2026-07-05';
/* Only new / no-answer orders are looked up — a confirmed order never is
   (owner, 2026-11-20). When Bosta has no rating, EasyOrder's stands in. */
const OPEN_STATUSES = RATE_STATUSES;

/* Normalize orders."Phone" to the SAME +2… canonical form as bostaEnrich.formatPhone()
   so the cache key matches regardless of how the order stored the number. */
const NORM_PHONE_SQL = `(CASE
  WHEN o."Phone" LIKE '+2%' THEN o."Phone"
  WHEN o."Phone" LIKE '01%' THEN '+2' || o."Phone"
  ELSE o."Phone" END)`;

/* ── Idempotent tables (module load, every boot) ───────────────────────────── */
pool.query(`
  CREATE TABLE IF NOT EXISTS bosta_consignee_cache (
    id            SERIAL       PRIMARY KEY,
    business_id   INTEGER      NOT NULL,
    phone         VARCHAR(30)  NOT NULL,
    delivery_rate VARCHAR(20),
    status        VARCHAR(20)  NOT NULL DEFAULT 'pending',   -- pending | done | failed
    attempts      INTEGER      NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (business_id, phone)
  )
`)
  /* Every Bosta ranking call, for the rolling budget (429s are logged but don't count). */
  .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS bosta_rank_calls (
      id          BIGSERIAL    PRIMARY KEY,
      business_id INTEGER,
      phone       VARCHAR(30),
      http_status INTEGER,
      at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`))
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS bosta_rank_calls_at_idx ON bosta_rank_calls (at DESC)`))
  .then(() => console.log('✅  bosta_consignee_cache + bosta_rank_calls ready'))
  .catch((e) => console.warn('⚠️   bosta enrichment schema check:', e.message));

/* Per-tenant bearer token. */
async function tokenFor(businessId) {
  try {
    const { rows } = await pool.query(
      `SELECT bearer_token FROM shipping_settings
       WHERE provider_name = 'bosta' AND is_active = true AND business_id = $1`,
      [businessId]
    );
    return rows[0]?.bearer_token || process.env.BOSTA_BEARER_TOKEN || null;
  } catch {
    return process.env.BOSTA_BEARER_TOKEN || null;
  }
}

/* STEP 1 — apply already-cached 'done' rates to matching 'بدون' orders. No API. */
async function applyCachedRates() {
  const r = await pool.query(`
    UPDATE orders AS o
    SET "DeliveryRate" = c.delivery_rate, "updatedAt" = NOW()
    FROM bosta_consignee_cache c
    WHERE c.business_id   = o.business_id
      AND c.status        = 'done'
      AND c.delivery_rate IS NOT NULL
      AND o."DeliveryRate" = 'بدون'
      AND c.phone = ${NORM_PHONE_SQL}
  `);
  if (r.rowCount) console.log(`[deliveryRate] applied cached rate to ${r.rowCount} order(s) (no API call)`);
}

/* STEP 2 — the budget: calls in the last 24 h / 4 h and the last 429. */
async function budgetNow() {
  const { rows: [b] } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE http_status IS DISTINCT FROM 429)::int                                     AS calls24h,
           COUNT(*) FILTER (WHERE http_status IS DISTINCT FROM 429 AND at > NOW() - INTERVAL '4 hours')::int AS calls4h,
           MAX(at) FILTER (WHERE http_status = 429)                                                          AS last429
      FROM bosta_rank_calls WHERE at > NOW() - INTERVAL '24 hours'`);
  return bostaBudget({ calls24h: b.calls24h, calls4h: b.calls4h, last429At: b.last429, per24h: BUDGET_24H, per4h: BUDGET_4H });
}

/* STEP 3 — the ONE phone that most needs a lookup now. */
async function pickOne() {
  const { rows } = await pool.query(`
    SELECT ${NORM_PHONE_SQL} AS phone, o.business_id
    FROM   orders o
    JOIN   shipping_settings s
           ON s.business_id = o.business_id AND s.provider_name = 'bosta' AND s.is_active = true
    LEFT   JOIN bosta_consignee_cache c
           ON c.business_id = o.business_id AND c.phone = ${NORM_PHONE_SQL}
    WHERE  o."DeliveryRate" = 'بدون'
      AND  o."Phone" IS NOT NULL AND o."Phone" <> ''
      /* …plus an order the customer confirmed on WhatsApp within minutes: its
         rating was never seen, and «ضعيف» must reach an agent before it ships.
         Same queue, no priority — the agents' orders keep their share of the budget. */
      AND  (btrim(o."Status") = ANY($4::text[])
            OR (btrim(o."Status") = 'تم التأكيد' AND to_jsonb(o) ->> 'confirmed_via' = 'whatsapp'))
      AND  o."createdAt" > NOW() - ($1 || ' days')::interval
      AND  o."createdAt" < NOW() - INTERVAL '5 minutes'
      AND  o."createdAt" >= $3::timestamptz          -- backlog cutoff: pre-pause orders never hit Bosta
      AND  (c.id IS NULL OR (c.status = 'pending' AND c.attempts < $2))
    ORDER BY (COALESCE(to_jsonb(o) ->> 'easyorder_rate', '') = 'high') ASC,
             o."createdAt" DESC
    LIMIT  1
  `, [String(MAX_AGE_DAYS), MAX_ATTEMPTS, BACKLOG_CUTOFF, OPEN_STATUSES]);
  return rows[0] || null;
}

const logCall = (businessId, phone, status) => pool.query(
  `INSERT INTO bosta_rank_calls (business_id, phone, http_status) VALUES ($1, $2, $3)`,
  [businessId, phone, status]
).catch((e) => console.warn('[deliveryRate] call log failed:', e.message));

/* Resolved — cache 'done' + label every 'بدون' order sharing this phone. */
async function markDone(businessId, phone, rate) {
  await pool.query(`
    INSERT INTO bosta_consignee_cache (business_id, phone, delivery_rate, status, attempts, updated_at)
    VALUES ($1, $2, $3, 'done', 0, NOW())
    ON CONFLICT (business_id, phone)
    DO UPDATE SET delivery_rate = $3, status = 'done', last_error = NULL, updated_at = NOW()
  `, [businessId, phone, rate]);

  const upd = await pool.query(
    `UPDATE orders AS o SET "DeliveryRate" = $1, "updatedAt" = NOW()
     WHERE o.business_id = $2 AND o."DeliveryRate" = 'بدون' AND ${NORM_PHONE_SQL} = $3`,
    [rate, businessId, phone]
  );
  return upd.rowCount;
}

/* Soft failure — bump attempts; flip to 'failed' once MAX_ATTEMPTS reached. */
async function bumpAttempt(businessId, phone, errMsg) {
  await pool.query(`
    INSERT INTO bosta_consignee_cache (business_id, phone, status, attempts, last_error, updated_at)
    VALUES ($1, $2, 'pending', 1, $3, NOW())
    ON CONFLICT (business_id, phone)
    DO UPDATE SET
      attempts   = bosta_consignee_cache.attempts + 1,
      last_error = $3,
      status     = CASE WHEN bosta_consignee_cache.attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END,
      updated_at = NOW()
  `, [businessId, phone, String(errMsg).slice(0, 300), MAX_ATTEMPTS]);
}

let running = false;
async function runSweep() {
  if (running) return;
  running = true;
  try {
    /* Cheap DB-only pass first — labels new orders of already-known customers. */
    await applyCachedRates();

    const budget = await budgetNow();
    if (!budget.allowed) return;            // blocked / budget spent — quietly wait

    const next = await pickOne();
    if (!next) return;
    const { business_id, phone } = next;

    const token = await tokenFor(business_id);
    if (!token) { await bumpAttempt(business_id, phone, 'no active Bosta token'); return; }

    try {
      const rate = await fetchDeliveryRate(phone, token);
      await logCall(business_id, phone, 200);
      const n = await markDone(business_id, phone, rate);
      console.log(`✅  [deliveryRate] ${phone} → ${rate} (${n} order(s) labeled)`);
    } catch (err) {
      const st = err.response?.status ?? 0;
      await logCall(business_id, phone, st);
      if (st === 429 || st === 401 || st === 403) {
        console.warn(`🛑 [deliveryRate] Bosta HTTP ${st} — next probe in an hour`);
        return;
      }
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      await bumpAttempt(business_id, phone, detail);
      console.warn(`⚠️  [deliveryRate] ${phone} soft-failed (HTTP ${st || 'ERR'}) — attempt bumped`);
    }
  } finally {
    running = false;
  }
}

function startDeliveryRateBackfillCron() {
  cron.schedule(SCHEDULE, () => {
    runSweep().catch((e) => console.error('[deliveryRate] sweep error:', e.message));
  });
  console.log(`✅  DeliveryRate enrichment cron scheduled (${SCHEDULE}, 1 lookup/run, ≤${BUDGET_24H}/24h, ≤${BUDGET_4H}/4h, open orders newest first, orders ≥ ${BACKLOG_CUTOFF} only).`);
}

module.exports = { startDeliveryRateBackfillCron, runSweep, pickOne, budgetNow };
