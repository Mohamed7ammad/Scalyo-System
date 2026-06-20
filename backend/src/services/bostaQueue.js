'use strict';

/* ─────────────────────────────────────────────────────────────────────────
   bostaQueue.js — rate limiter for ALL outbound Bosta API calls, organised
   into INDEPENDENT LANES so slow/bulk traffic on one lane never blocks another.

   Bosta returns HTTP 429 under burst load. Every outbound Bosta request funnels
   through enqueueBosta(): within a lane, jobs run ONE AT A TIME with a minimum
   gap + exponential back-off & retry on 429. Different lanes drain in parallel.

   Lanes (LANES export):
     • 'dispatch' → shipment creation (POST /deliveries), the interactive path.
     • 'enrich'   → consignee-ranking enrichment, often a huge background backlog.

   Why lanes: a 350-order enrichment backlog (with 30–240s 429 back-offs) must
   NOT stall a single manual dispatch the user is waiting on. Separate lanes also
   match Bosta's separate endpoints (api.bosta.co vs app.bosta.co).

   Concurrency is 1 PER LANE (jobs run strictly one-at-a-time). The inter-call
   gap is ADAPTIVE: every 429 widens the lane's steady-state gap (so we stop
   hammering the API), and sustained success slowly relaxes it back toward the
   base. The background `enrich` lane uses a larger base gap than the interactive
   `dispatch` lane.

   Tunables (env-overridable):
     BOSTA_QUEUE_GAP_MS       dispatch lane base gap   (default 2000ms)
     BOSTA_ENRICH_GAP_MS      enrich lane base gap     (default 5000ms)
     BOSTA_QUEUE_MAX_GAP_MS   adaptive gap ceiling     (default 30000ms)
     BOSTA_QUEUE_MAX_RETRIES  429 retries before giving up     (default 5)
     BOSTA_QUEUE_BACKOFF_MS   base 429 cooldown, doubles each retry (default 30000ms)
   ───────────────────────────────────────────────────────────────────────── */

const DISPATCH_GAP_MS = Number(process.env.BOSTA_QUEUE_GAP_MS)      || 2000;
const ENRICH_GAP_MS   = Number(process.env.BOSTA_ENRICH_GAP_MS)     || 5000;
const MAX_GAP_MS      = Number(process.env.BOSTA_QUEUE_MAX_GAP_MS)  || 30_000;
const MAX_RETRIES     = Number(process.env.BOSTA_QUEUE_MAX_RETRIES) || 5;
const BACKOFF_BASE    = Number(process.env.BOSTA_QUEUE_BACKOFF_MS)  || 30_000;

const LANES = { DISPATCH: 'dispatch', ENRICH: 'enrich' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const is429 = (err) => err?.response?.status === 429;

/* Background bulk lanes (enrich) get a larger base gap than interactive ones. */
function baseGapFor(name) {
  return name === LANES.ENRICH ? ENRICH_GAP_MS : DISPATCH_GAP_MS;
}

/* One queue + draining flag + ADAPTIVE gap per lane, created lazily. */
const lanes = new Map();   // laneName -> { queue, draining, baseGap, gapMs }

function getLane(name) {
  let lane = lanes.get(name);
  if (!lane) {
    const base = baseGapFor(name);
    lane = { queue: [], draining: false, baseGap: base, gapMs: base };
    lanes.set(name, lane);
  }
  return lane;
}

/**
 * Enqueue an outbound Bosta API call onto a lane.
 * @param {() => Promise<any>} task  async fn performing the actual axios request.
 * @param {string} label             short label for logs.
 * @param {string} laneName          lane key (defaults to 'dispatch').
 * @returns {Promise<any>}           resolves/rejects with the task's outcome.
 */
function enqueueBosta(task, label = 'bosta-call', laneName = LANES.DISPATCH) {
  const lane = getLane(laneName);
  return new Promise((resolve, reject) => {
    lane.queue.push({ task, label, resolve, reject });
    if (lane.queue.length === 1 && !lane.draining) {
      console.log(`[bostaQueue:${laneName}] queued "${label}" (queue: ${lane.queue.length})`);
    }
    drain(laneName);   // fire-and-forget; no-op if this lane is already draining
  });
}

/** Single-flight worker per lane — processes that lane serially with throttling. */
async function drain(laneName) {
  const lane = getLane(laneName);
  if (lane.draining) return;
  lane.draining = true;
  try {
    while (lane.queue.length > 0) {
      const job = lane.queue.shift();
      let attempt = 0;

      for (;;) {
        try {
          job.resolve(await job.task());
          /* Success → gently relax the adaptive gap back toward the base, so the
             lane speeds up again once Bosta stops rate-limiting us. */
          lane.gapMs = Math.max(lane.baseGap, Math.round(lane.gapMs * 0.85));
          break;                                   // done — next job
        } catch (err) {
          if (is429(err) && attempt < MAX_RETRIES) {
            attempt += 1;
            /* Adaptively WIDEN the steady-state gap so the NEXT jobs don't
               immediately re-trigger 429 once the back-off expires. */
            lane.gapMs = Math.min(MAX_GAP_MS, Math.round(lane.gapMs * 1.5) + 500);
            const wait = BACKOFF_BASE * 2 ** (attempt - 1);   // 30s, 60s, 120s, 240s…
            console.warn(
              `[bostaQueue:${laneName}] 429 on "${job.label}" — backing off ${Math.round(wait / 1000)}s ` +
              `then retrying (attempt ${attempt}/${MAX_RETRIES}, queued=${lane.queue.length}, gap now ${lane.gapMs}ms)`
            );
            await sleep(wait);
            continue;                              // retry the SAME task
          }
          job.reject(err);                         // non-429, or retries exhausted
          break;
        }
      }

      if (lane.queue.length > 0) await sleep(lane.gapMs);   // space out next call (adaptive)
    }
  } finally {
    lane.draining = false;
  }
}

/** Pending count for a lane (defaults to dispatch). */
function bostaQueueLength(laneName = LANES.DISPATCH) {
  return getLane(laneName).queue.length;
}

module.exports = { enqueueBosta, bostaQueueLength, LANES };
