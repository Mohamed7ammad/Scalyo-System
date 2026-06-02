'use strict';

/* ─────────────────────────────────────────────────────────────────────────
   bostaQueue.js — global serial rate limiter for ALL outbound Bosta API calls.

   Bosta returns HTTP 429 (Too Many Requests) under burst load — e.g. 60 orders
   arriving at once via the EasyOrder webhook, or a bulk manual dispatch from the
   dashboard. To stay within their limits, EVERY outbound Bosta request funnels
   through enqueueBosta(): jobs run ONE AT A TIME with a minimum gap between them
   and exponential back-off + retry on 429.

   • Normal/low traffic → the queue is empty, so a call runs immediately.
   • Spikes             → calls line up and drain with MIN_GAP_MS spacing.

   The queue is a module-level singleton, so it is shared across every request
   and background task in the process (webhook enrichment + bulk dispatch alike).

   Tunables (env-overridable):
     BOSTA_QUEUE_GAP_MS       gap between consecutive calls   (default 1500ms)
     BOSTA_QUEUE_MAX_RETRIES  429 retries before giving up    (default 4)
     BOSTA_QUEUE_BACKOFF_MS   base 429 cooldown, doubles each retry (default 30000ms)
   ───────────────────────────────────────────────────────────────────────── */

const MIN_GAP_MS   = Number(process.env.BOSTA_QUEUE_GAP_MS)      || 1500;
const MAX_RETRIES  = Number(process.env.BOSTA_QUEUE_MAX_RETRIES) || 4;
const BACKOFF_BASE = Number(process.env.BOSTA_QUEUE_BACKOFF_MS)  || 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const is429 = (err) => err?.response?.status === 429;

const queue = [];
let draining = false;

/**
 * Enqueue an outbound Bosta API call.
 * @param {() => Promise<any>} task  async fn performing the actual axios request.
 * @param {string} label             short label for logs.
 * @returns {Promise<any>}           resolves/rejects with the task's outcome.
 *
 * Calls are serialized with MIN_GAP_MS spacing; a 429 triggers exponential
 * back-off and a retry of the SAME task (up to MAX_RETRIES) before rejecting.
 */
function enqueueBosta(task, label = 'bosta-call') {
  return new Promise((resolve, reject) => {
    queue.push({ task, label, resolve, reject });
    if (queue.length === 1 && !draining) {
      console.log(`[bostaQueue] queued "${label}" (queue: ${queue.length})`);
    }
    drain();   // fire-and-forget; no-op if already draining
  });
}

/** Single-flight worker — processes the queue serially with throttling. */
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      let attempt = 0;

      for (;;) {
        try {
          job.resolve(await job.task());
          break;                                   // done — move to next job
        } catch (err) {
          if (is429(err) && attempt < MAX_RETRIES) {
            attempt += 1;
            const wait = BACKOFF_BASE * 2 ** (attempt - 1);   // 30s, 60s, 120s, 240s…
            console.warn(
              `[bostaQueue] 429 on "${job.label}" — backing off ${Math.round(wait / 1000)}s ` +
              `then retrying (attempt ${attempt}/${MAX_RETRIES}, queued=${queue.length})`
            );
            await sleep(wait);
            continue;                              // retry the SAME task
          }
          job.reject(err);                         // non-429, or retries exhausted
          break;
        }
      }

      if (queue.length > 0) await sleep(MIN_GAP_MS);   // space out the next call
    }
  } finally {
    draining = false;
  }
}

module.exports = { enqueueBosta, bostaQueueLength: () => queue.length };
