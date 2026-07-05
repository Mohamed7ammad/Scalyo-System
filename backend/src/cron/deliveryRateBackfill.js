'use strict';

/**
 * DeliveryRate enrichment cron — polite, cached, rate-limit-safe.
 * (Bosta consignee reputation → حالة الاستلام: ممتاز / متوسط / ضعيف / جديد)
 *
 * WHY THIS EXISTS
 *   Bosta hard rate-limits the consignee-ranking endpoint (HTTP 429). The old
 *   design fired an enrichment PER ORDER at creation time with no phone-level
 *   dedupe, bursting past the limit and getting the whole account blocked — so
 *   every row fell back to 'بدون'. This replaces that with a single polite queue.
 *
 * ARCHITECTURE
 *   1. Phone-level cache (bosta_consignee_cache, tenant-scoped): once a phone is
 *      resolved it is 'done' and NEVER fetched again. Repeated attempts that keep
 *      failing flip to 'failed' after MAX_ATTEMPTS so we stop retrying forever.
 *   2. Every run first APPLIES cached 'done' rates to any 'بدون' orders sharing
 *      that phone — a pure DB update, ZERO Bosta calls (labels new orders for
 *      already-known customers instantly).
 *   3. Then it picks a SMALL batch of distinct, not-yet-resolved phones and
 *      processes them SEQUENTIALLY with a deliberate sleep between each call.
 *   4. CIRCUIT BREAKER: the first 429/401/403 immediately halts the run — no more
 *      Bosta calls until the next scheduled sweep.
 *
 *   The API calls only ever run when the cron fires, which index.js gates behind
 *   NODE_ENV=production. On-demand enrichment at order creation was removed.
 *
 * RE-ENABLE SAFETY RAILS (2026-07-05, after the second Bosta block)
 *   • BACKLOG CUTOFF: while the cron was paused a huge backlog of 'بدون' orders
 *     piled up. Enriching it would blast Bosta with thousands of calls and get
 *     the account blocked on the first sweep. pickBatch() therefore ONLY looks
 *     at orders created ON/AFTER BACKLOG_CUTOFF — the backlog is never queued.
 *     (applyCachedRates() intentionally ignores the cutoff: it is DB-only and
 *     still labels old orders for free from already-cached phones.)
 *   • HARD THROTTLE FLOOR: ≥4s between EVERY Bosta call (default 5s), tiny
 *     batch (5 phones/run), sweep every 15 min → ≤20 calls/hour worst case.
 *
 * Tunables (env-overridable):
 *   DELIVERY_RATE_CRON          schedule                       (default every 15 min)
 *   DELIVERY_RATE_BATCH         phones fetched per run          (default 5)
 *   DELIVERY_RATE_SLEEP_MS      gap between Bosta calls         (default 5000ms, hard floor 4000ms)
 *   DELIVERY_RATE_MAX_ATTEMPTS  soft-fails before 'failed'      (default 3)
 *   DELIVERY_RATE_MAX_AGE_DAYS  only enrich orders newer than   (default 14)
 *   DELIVERY_RATE_CUTOFF        skip orders created before this (default 2026-07-05)
 */

const cron = require('node-cron');
const pool = require('../config/db');
const { fetchDeliveryRate } = require('../services/bostaEnrich');

const SCHEDULE     = process.env.DELIVERY_RATE_CRON              || '*/15 * * * *';
const BATCH        = Number(process.env.DELIVERY_RATE_BATCH)        || 5;
/* Hard floor: even an env override can never push calls closer than 4s apart. */
const SLEEP_MS     = Math.max(4000, Number(process.env.DELIVERY_RATE_SLEEP_MS) || 5000);
const MAX_ATTEMPTS = Number(process.env.DELIVERY_RATE_MAX_ATTEMPTS) || 3;
const MAX_AGE_DAYS = Number(process.env.DELIVERY_RATE_MAX_AGE_DAYS) || 14;
/* "Forget the past": only orders created on/after this date ever reach Bosta.
   NOT a rolling NOW() — a fixed re-enable date, so new orders are eligible the
   moment they're created while the pre-pause backlog stays skipped forever.   */
const BACKLOG_CUTOFF = process.env.DELIVERY_RATE_CUTOFF || '2026-07-05';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Normalize orders."Phone" to the SAME +2… canonical form as bostaEnrich.formatPhone()
   so the cache key matches regardless of how the order stored the number. */
const NORM_PHONE_SQL = `(CASE
  WHEN o."Phone" LIKE '+2%' THEN o."Phone"
  WHEN o."Phone" LIKE '01%' THEN '+2' || o."Phone"
  ELSE o."Phone" END)`;

/* ── Idempotent cache table (runs at module load, every boot) ──────────────── */
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
  .then(() => console.log('✅  bosta_consignee_cache table ready'))
  .catch((e) => console.warn('⚠️   bosta_consignee_cache schema check:', e.message));

/* Per-tenant bearer token, cached for the duration of one sweep. */
async function tokenFor(businessId, cacheMap) {
  if (cacheMap.has(businessId)) return cacheMap.get(businessId);
  let token = null;
  try {
    const { rows } = await pool.query(
      `SELECT bearer_token FROM shipping_settings
       WHERE provider_name = 'bosta' AND is_active = true AND business_id = $1`,
      [businessId]
    );
    token = rows[0]?.bearer_token || process.env.BOSTA_BEARER_TOKEN || null;
  } catch {
    token = process.env.BOSTA_BEARER_TOKEN || null;
  }
  cacheMap.set(businessId, token);
  return token;
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

/* STEP 2 — pick a batch of DISTINCT phones that still need a live lookup. */
async function pickBatch() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ${NORM_PHONE_SQL} AS phone, o.business_id
    FROM   orders o
    JOIN   shipping_settings s
           ON s.business_id = o.business_id AND s.provider_name = 'bosta' AND s.is_active = true
    LEFT   JOIN bosta_consignee_cache c
           ON c.business_id = o.business_id AND c.phone = ${NORM_PHONE_SQL}
    WHERE  o."DeliveryRate" = 'بدون'
      AND  o."Phone" IS NOT NULL AND o."Phone" <> ''
      AND  o."createdAt" > NOW() - ($1 || ' days')::interval
      AND  o."createdAt" >= $4::timestamptz          -- backlog cutoff: pre-pause orders never hit Bosta
      AND  (c.id IS NULL OR (c.status = 'pending' AND c.attempts < $2))
    LIMIT  $3
  `, [String(MAX_AGE_DAYS), MAX_ATTEMPTS, BATCH, BACKLOG_CUTOFF]);
  return rows;
}

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

/* Soft failure — bump attempts; flip to 'failed' once MAX_ATTEMPTS reached so we
   never retry this number again. */
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

async function runSweep() {
  /* Cheap DB-only pass first — labels new orders of already-known customers. */
  await applyCachedRates();

  const batch = await pickBatch();
  if (!batch.length) return;
  console.log(`[deliveryRate] sweep: ${batch.length} phone(s) to enrich (batch ${BATCH}, sleep ${SLEEP_MS}ms)`);

  const tokenCache = new Map();
  let ok = 0, softFailed = 0;

  for (const { business_id, phone } of batch) {
    const token = await tokenFor(business_id, tokenCache);
    if (!token) { await bumpAttempt(business_id, phone, 'no active Bosta token'); continue; }

    try {
      const rate = await fetchDeliveryRate(phone, token);
      const n = await markDone(business_id, phone, rate);
      ok++;
      console.log(`✅  [deliveryRate] ${phone} → ${rate} (${n} order(s) labeled)`);
    } catch (err) {
      const st = err.response?.status;
      /* CIRCUIT BREAKER: rate-limited or auth-blocked → stop the ENTIRE run now.
         No more Bosta calls until the next scheduled sweep. */
      if (st === 429 || st === 401 || st === 403) {
        console.warn(`🛑 [deliveryRate] circuit breaker: Bosta HTTP ${st} — halting run; resume next schedule (done ${ok}, soft-failed ${softFailed})`);
        return;
      }
      /* Any other error (400/network/unreadable) → soft-fail this one number. */
      softFailed++;
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      await bumpAttempt(business_id, phone, detail);
      console.warn(`⚠️  [deliveryRate] ${phone} soft-failed (HTTP ${st ?? 'ERR'}) — attempt bumped`);
    }

    await sleep(SLEEP_MS);   // deliberate polite gap between EVERY Bosta call
  }

  console.log(`[deliveryRate] sweep done: ${ok} enriched, ${softFailed} soft-failed`);
}

function startDeliveryRateBackfillCron() {
  cron.schedule(SCHEDULE, () => {
    runSweep().catch((e) => console.error('[deliveryRate] sweep error:', e.message));
  });
  console.log(`✅  DeliveryRate enrichment cron scheduled (${SCHEDULE}, batch ${BATCH}, sleep ${SLEEP_MS}ms, max ${MAX_ATTEMPTS} attempts, <${MAX_AGE_DAYS}d, orders ≥ ${BACKLOG_CUTOFF} only).`);
}

module.exports = { startDeliveryRateBackfillCron };
