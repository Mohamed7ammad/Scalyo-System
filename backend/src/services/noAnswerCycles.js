'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   No-answer («لا يرد») review loop — automated 2 + 2 day cycle
   ════════════════════════════════════════════════════════════════════════════
   Replaces the Team Leader's manual nightly sweep (filter «لا يرد» of the last
   4 days → one transfer into a review account). Owner's rules (2026-10-22):

     • OWNER stage  — the agent who marked it «لا يرد» keeps it that day and the
                      whole next day (agents re-dial from their bulk-copied list
                      without touching the system, so nothing may move mid-day);
     • REVIEW stage — 2 review days, each night re-dealt to a DIFFERENT
                      review-account agent (REVIEW_ROUTING_TRACKS; never the owner, never last
                      night's reviewer: a new voice / phone number);
     • then CLOSED  — status «ملغي - عدم رد نهائي», reopenable only by an admin,
                      a Team Leader, or the last agent holding it.

   Time drives everything — agents don't log every missed call, so attempt
   counts (orders.no_answer_logs, the 5-attempt commission) are NOT used here.

   Pieces:
     • no_answer_cycles — one row per «لا يرد» episode of an order. Opened and
       closed by a trigger on orders."Status" (every write path: PATCH, bulk,
       imports), so it is never out of sync. Closed rows keep the outcome and
       the stage it ended in → real "recovered by review" numbers.
     • runRollover()    — the ONE nightly hand-off (cron 23:30 Cairo). Moves go
       through a normal AssignedTo update, so trg_orders_commission_owner keeps
       every earned عمولة عدم الرد with whoever earned it; closing writes the
       status directly (no commission granted or voided). A run row per
       (business, date) makes it run-once even across restarts.
     • backlogMigrate() — one-time cleanup + initialisation of open cycles.   */

const pool = require('../config/db');
const { agentAllowsProduct } = require('../utils/productRouting');
const { hasAnyRole } = require('../utils/roles');

const NO_ANSWER   = 'لا يرد';
const TERMINAL    = 'ملغي - عدم رد نهائي';
const OWNER_DAYS  = 2;   // day it went «لا يرد» + the next day
const REVIEW_DAYS = 2;
const SYSTEM_ACTOR = 'system:no-answer';
const CAIRO_TODAY = `(NOW() AT TIME ZONE 'Africa/Cairo')::date`;
/* Backlog rule (owner, 2026-10-22): close only «لا يرد» created AND last
   updated before this Cairo moment; everything since stays in the cycle. */
const BACKLOG_CUTOFF_LOCAL = '2026-10-15 00:00';

/* Who may receive review-stage orders. Two-account mode (owner, 2026-10-22):
   review work stays on the dedicated review accounts (track 'review') until the
   agents' «محاولاتي» / «مراجعة» split view ships — then add 'both'. */
const REVIEW_ROUTING_TRACKS = ['review'];

const norm = (e) => String(e ?? '').trim().toLowerCase();

/* ── Schema ─────────────────────────────────────────────────────────────────── */
const schemaReady = (async () => {
  /* step_until = the last Cairo day of the CURRENT step: the owner's 2nd day,
     or the date of the current review day. The rollover of day T acts on
     every open cycle with step_until <= T. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS no_answer_cycles (
      id            SERIAL       PRIMARY KEY,
      business_id   INTEGER      NOT NULL,
      order_id      INTEGER      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      owner_email   TEXT,                      -- holder when it went «لا يرد»
      entered_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      stage         VARCHAR(10)  NOT NULL DEFAULT 'owner' CHECK (stage IN ('owner', 'review')),
      review_round  SMALLINT     NOT NULL DEFAULT 0,       -- 1..REVIEW_DAYS in review
      step_until    DATE         NOT NULL,
      last_reviewer TEXT,
      moves         SMALLINT     NOT NULL DEFAULT 0,
      closed_at     TIMESTAMPTZ,
      outcome       TEXT,                      -- the status it left «لا يرد» for
      closed_stage  VARCHAR(10),
      closed_by     VARCHAR(20)                -- status | rollover | backlog | heal
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS no_answer_cycles_open_uq ON no_answer_cycles (order_id) WHERE closed_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS no_answer_cycles_due_idx ON no_answer_cycles (business_id, step_until) WHERE closed_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS no_answer_cycles_closed_idx ON no_answer_cycles (business_id, closed_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS no_answer_rollover_runs (
      business_id INTEGER     NOT NULL,
      run_date    DATE        NOT NULL,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      summary     JSONB,
      PRIMARY KEY (business_id, run_date)
    )`);

  /* Open / close cycles on every status change. Lost orders run their own flow.
     The actor (rollover / backlog) is passed via SET LOCAL app.na_actor.
     Schema-qualified so it is created in public whatever the search_path. */
  await pool.query(`
    CREATE OR REPLACE FUNCTION public.no_answer_cycle_track() RETURNS trigger AS $fn$
    DECLARE
      was_na BOOLEAN := TG_OP = 'UPDATE' AND btrim(COALESCE(OLD."Status", '')) = '${NO_ANSWER}';
      is_na  BOOLEAN := btrim(COALESCE(NEW."Status", '')) = '${NO_ANSWER}';
    BEGIN
      IF is_na AND NOT was_na AND NOT COALESCE(NEW.is_lost_order, FALSE) THEN
        INSERT INTO no_answer_cycles (business_id, order_id, owner_email, entered_at, stage, review_round, step_until)
        VALUES (NEW.business_id, NEW.id, NULLIF(btrim(COALESCE(NEW."AssignedTo", '')), ''), NOW(), 'owner', 0,
                (NOW() AT TIME ZONE 'Africa/Cairo')::date + ${OWNER_DAYS - 1})
        ON CONFLICT (order_id) WHERE closed_at IS NULL DO NOTHING;
      ELSIF was_na AND NOT is_na THEN
        UPDATE no_answer_cycles
           SET closed_at = NOW(), outcome = btrim(COALESCE(NEW."Status", '')), closed_stage = stage,
               closed_by = COALESCE(NULLIF(current_setting('app.na_actor', TRUE), ''), 'status')
         WHERE order_id = NEW.id AND closed_at IS NULL;
      END IF;
      RETURN NULL;
    END
    $fn$ LANGUAGE plpgsql`);
  await pool.query(`
    CREATE OR REPLACE TRIGGER trg_orders_no_answer_cycle
      AFTER INSERT OR UPDATE OF "Status" ON orders
      FOR EACH ROW EXECUTE FUNCTION public.no_answer_cycle_track()`);
  console.log('✅  No-answer cycles: schema + trigger ready');
})().catch((e) => { console.error('❌  No-answer cycles schema failed:', e.message); throw e; });
schemaReady.catch(() => {});   // surfaced by callers that await it

/* ── Rollover ───────────────────────────────────────────────────────────────── */

/* Review-capable agents present now, with their open review load. */
async function reviewerPool(db, businessId) {
  const { rows } = await db.query(
    `SELECT u.email, COALESCE(u.allowed_products, '{}'::text[]) AS allowed,
            (SELECT COUNT(*) FROM no_answer_cycles c JOIN orders o ON o.id = c.order_id
              WHERE c.business_id = u.business_id AND c.closed_at IS NULL AND c.stage = 'review'
                AND LOWER(TRIM(o."AssignedTo")) = LOWER(TRIM(u.email)))::int AS load
       FROM users u
      WHERE u.business_id = $1
        AND 'agent' = ANY(COALESCE(u.roles, ARRAY[u.role]))
        AND COALESCE(u.is_active, TRUE) AND NOT COALESCE(u.is_absent, FALSE)
        AND u.agent_track = ANY($2::text[])
      ORDER BY u.email`, [businessId, REVIEW_ROUTING_TRACKS]);
  return rows;
}

/* Builds tonight's plan for one business — pure reads, no writes.
   Each open cycle whose step ended (step_until <= today), or whose holder can't
   work it (unassigned / absent / inactive), gets one action:
     to_review — owner stage done (or owner away) → first review day;
     redeal    — a review day done, more to go → next reviewer, next round;
     rescue    — reviewer away mid-round → another reviewer, same round;
     close     — last review day done → «ملغي - عدم رد نهائي».
   Dealing: a review/both agent allowed for the product, never the owner nor the
   current holder, lowest open review load first. If nobody else qualifies, a
   holder who is herself an eligible reviewer keeps it ("stay"); otherwise the
   cycle is left untouched for tomorrow ("stuck") and reported.             */
async function planRollover(db, businessId) {
  const { rows: [{ today }] } = await db.query(`SELECT ${CAIRO_TODAY}::text AS today`);
  const { rows: cycles } = await db.query(
    `SELECT c.id AS cycle_id, c.order_id, c.owner_email, c.stage, c.review_round, c.step_until::text,
            o."AssignedTo" AS holder, o."ProductName" AS product,
            (c.step_until <= $2::date) AS due,
            (h.email IS NULL OR NOT COALESCE(h.is_active, TRUE) OR COALESCE(h.is_absent, FALSE)) AS stranded
       FROM no_answer_cycles c
       JOIN orders o ON o.id = c.order_id AND o.business_id = c.business_id
       LEFT JOIN users h ON h.business_id = c.business_id AND LOWER(TRIM(h.email)) = LOWER(TRIM(o."AssignedTo"))
      WHERE c.business_id = $1 AND c.closed_at IS NULL
        AND btrim(o."Status") = '${NO_ANSWER}' AND NOT COALESCE(o.is_lost_order, FALSE)
        AND (c.step_until <= $2::date OR h.email IS NULL OR NOT COALESCE(h.is_active, TRUE) OR COALESCE(h.is_absent, FALSE))
      ORDER BY c.order_id`,
    [businessId, today]);

  const reviewers = await reviewerPool(db, businessId);
  const load = new Map(reviewers.map((r) => [norm(r.email), r.load]));
  const actions = [];

  for (const c of cycles) {
    let kind = null;
    if (c.stage === 'owner') kind = 'to_review';
    else if (c.due) kind = c.review_round >= REVIEW_DAYS ? 'close' : 'redeal';
    else if (c.stranded) kind = 'rescue';
    if (!kind) continue;
    /* Whatever happens next, this order leaves the holder's review load. */
    if (c.stage === 'review' && load.has(norm(c.holder))) load.set(norm(c.holder), load.get(norm(c.holder)) - 1);
    actions.push({ ...c, kind });
  }

  for (const a of actions) {
    if (a.kind === 'close') continue;
    const exclude = new Set([norm(a.owner_email), norm(a.holder)]);
    const eligible = reviewers.filter((r) => !exclude.has(norm(r.email)) && agentAllowsProduct(r.allowed, a.product));
    eligible.sort((x, y) => load.get(norm(x.email)) - load.get(norm(y.email)) || x.email.localeCompare(y.email));
    let target = eligible[0]?.email ?? null;
    if (!target) {
      const self = reviewers.find((r) => norm(r.email) === norm(a.holder) && norm(r.email) !== norm(a.owner_email)
                                         && agentAllowsProduct(r.allowed, a.product));
      if (self) { a.stay = true; target = self.email; }
    }
    a.to = target;
    if (target) load.set(norm(target), (load.get(norm(target)) ?? 0) + 1);
  }

  const summary = { date: today, to_review: 0, redeal: 0, rescue: 0, close: 0, stay: 0, stuck: 0, to: {} };
  for (const a of actions) {
    if (a.kind !== 'close' && !a.to) { summary.stuck += 1; continue; }
    summary[a.kind] += 1;
    if (a.stay) summary.stay += 1;
    else if (a.to) summary.to[a.to] = (summary.to[a.to] ?? 0) + 1;
  }
  return { today, actions, summary };
}

/* Applies the plan for one business inside ONE transaction, guarded by the
   (business, date) run row — a restart or a second tick the same night is a
   no-op. dryRun → returns the plan and changes nothing. */
async function rolloverBusiness(businessId, { dryRun = false } = {}) {
  await schemaReady;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.na_actor = 'rollover'`);
    if (!dryRun) {
      const { rowCount } = await client.query(
        `INSERT INTO no_answer_rollover_runs (business_id, run_date) VALUES ($1, ${CAIRO_TODAY})
         ON CONFLICT DO NOTHING`, [businessId]);
      if (!rowCount) { await client.query('ROLLBACK'); return { skipped: 'already_ran' }; }
    }
    const plan = await planRollover(client, businessId);
    if (dryRun) { await client.query('ROLLBACK'); return { dryRun: true, ...plan }; }

    const done = { to_review: 0, redeal: 0, rescue: 0, close: 0, stay: 0, stuck: 0, raced: 0, to: {} };
    const closeIds = [];
    for (const a of plan.actions) {
      if (a.kind === 'close') { closeIds.push(a.order_id); continue; }
      if (!a.to) { done.stuck += 1; continue; }
      if (!a.stay) {
        const { rowCount } = await client.query(
          `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW()
            WHERE id = $2 AND business_id = $3 AND btrim("Status") = '${NO_ANSWER}'
              AND "AssignedTo" IS NOT DISTINCT FROM $4`,
          [a.to, a.order_id, businessId, a.holder]);
        if (!rowCount) { done.raced += 1; continue; }   // changed since the plan was read
        await client.query(
          `INSERT INTO order_assignment_log
             (order_id, business_id, from_agent, to_agent, changed_by, changed_by_id, source, order_status)
           VALUES ($1, $2, $3, $4, '${SYSTEM_ACTOR}', NULL, 'no_answer_rollover', '${NO_ANSWER}')`,
          [a.order_id, businessId, a.holder, a.to]);
        done.to[a.to] = (done.to[a.to] ?? 0) + 1;
      } else {
        done.stay += 1;
      }
      /* to_review / redeal start a new review day tomorrow; rescue keeps the round. */
      await client.query(
        `UPDATE no_answer_cycles
            SET stage = 'review',
                review_round = CASE WHEN $2 = 'to_review' THEN 1 WHEN $2 = 'redeal' THEN review_round + 1 ELSE review_round END,
                step_until   = CASE WHEN $2 = 'rescue' THEN step_until ELSE ${CAIRO_TODAY} + 1 END,
                last_reviewer = $3,
                moves = moves + CASE WHEN $4 THEN 0 ELSE 1 END
          WHERE id = $1 AND closed_at IS NULL`,
        [a.cycle_id, a.kind, a.to, a.stay === true]);
      done[a.kind] += 1;
    }
    if (closeIds.length) {
      /* The status trigger closes the cycles (closed_by = 'rollover'). No
         commission is granted or voided: earned عمولة عدم الرد stays. */
      const { rowCount } = await client.query(
        `UPDATE orders SET "Status" = '${TERMINAL}', "updatedAt" = NOW()
          WHERE id = ANY($1::int[]) AND business_id = $2 AND btrim("Status") = '${NO_ANSWER}'`,
        [closeIds, businessId]);
      done.close = rowCount;
      done.raced += closeIds.length - rowCount;
    }
    await client.query(
      `UPDATE no_answer_rollover_runs SET summary = $3 WHERE business_id = $1 AND run_date = $2::date`,
      [businessId, plan.today, JSON.stringify(done)]);
    await client.query('COMMIT');
    return { date: plan.today, ...done };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* Every business with open cycles. */
async function runRollover({ dryRun = false } = {}) {
  await schemaReady;
  const { rows } = await pool.query(`SELECT DISTINCT business_id FROM no_answer_cycles WHERE closed_at IS NULL`);
  const out = [];
  for (const { business_id } of rows) {
    try {
      out.push({ business_id, ...(await rolloverBusiness(business_id, { dryRun })) });
    } catch (e) {
      console.error(`[no-answer] rollover for business ${business_id} failed:`, e.message);
      out.push({ business_id, error: e.message });
    }
  }
  return out;
}

/* ── Backlog (one-time) ─────────────────────────────────────────────────────────
   1. CLOSE every non-lost «لا يرد» created AND last updated before the cutoff
      → «ملغي - عدم رد نهائي», each recorded as a closed cycle (closed_by
      'backlog', previous holder kept in owner_email) so it can be audited or
      reverted.
   2. OPEN a cycle for every other non-lost «لا يرد» without one, staged from
      what really happened (order_assignment_log):
        • never swept by the Team Leader → owner stage, owner = holder, from
          the earliest sign it went «لا يرد» (first logged attempt / last update);
        • swept on N nights → review stage. Owner = the agent it was first swept
          from. Round capped at REVIEW_DAYS − 1 so NOTHING initialised here is
          closed on the first automated night — every one gets at least one more
          review day under the new system. step_until = last sweep night + 1.
   dryRun → counts only.                                                        */
async function backlogMigrate(businessId, { apply = false } = {}) {
  await schemaReady;
  const cutoff = `('${BACKLOG_CUTOFF_LOCAL}'::timestamp AT TIME ZONE 'Africa/Cairo')`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.na_actor = 'backlog'`);

    const { rows: closeRows } = await client.query(
      `SELECT id, "AssignedTo" AS holder, "createdAt", "updatedAt" FROM orders
        WHERE business_id = $1 AND btrim("Status") = '${NO_ANSWER}' AND NOT COALESCE(is_lost_order, FALSE)
          AND "createdAt" < ${cutoff} AND "updatedAt" < ${cutoff}
        FOR UPDATE`, [businessId]);
    const closeIds = closeRows.map((r) => r.id);

    let closed = 0;
    if (closeIds.length) {
      await client.query(
        `INSERT INTO no_answer_cycles
           (business_id, order_id, owner_email, entered_at, stage, review_round, step_until,
            closed_at, outcome, closed_stage, closed_by)
         SELECT o.business_id, o.id, NULLIF(btrim(COALESCE(o."AssignedTo", '')), ''),
                LEAST(o."updatedAt", NOW()), 'review', ${REVIEW_DAYS}, ${CAIRO_TODAY},
                NOW(), '${TERMINAL}', 'review', 'backlog'
           FROM orders o
          WHERE o.id = ANY($1::int[])
            AND NOT EXISTS (SELECT 1 FROM no_answer_cycles c WHERE c.order_id = o.id AND c.closed_at IS NULL)`,
        [closeIds]);
      const r = await client.query(
        `UPDATE orders SET "Status" = '${TERMINAL}', "updatedAt" = NOW()
          WHERE id = ANY($1::int[]) AND business_id = $2 AND btrim("Status") = '${NO_ANSWER}'`,
        [closeIds, businessId]);
      closed = r.rowCount;
    }

    /* Open cycles for the rest, staged from the sweep history. */
    const { rows: init } = await client.query(
      `WITH open_na AS (
         SELECT o.id, o.business_id, o."AssignedTo" AS holder, o."createdAt", o."updatedAt",
                (SELECT MIN(t::timestamptz) FROM jsonb_array_elements_text(COALESCE(o.no_answer_logs, '[]'::jsonb)) t) AS first_log
           FROM orders o
          WHERE o.business_id = $1 AND btrim(o."Status") = '${NO_ANSWER}' AND NOT COALESCE(o.is_lost_order, FALSE)
            AND NOT EXISTS (SELECT 1 FROM no_answer_cycles c WHERE c.order_id = o.id AND c.closed_at IS NULL)),
       sweeps AS (
         SELECT l.order_id,
                COUNT(DISTINCT (l.created_at AT TIME ZONE 'Africa/Cairo')::date)::int AS nights,
                MAX((l.created_at AT TIME ZONE 'Africa/Cairo')::date)                 AS last_night,
                MIN(l.created_at)                                                    AS first_at,
                (ARRAY_AGG(l.from_agent ORDER BY l.created_at))[1]                   AS first_from
           FROM order_assignment_log l
          WHERE l.business_id = $1 AND l.source IN ('transfer', 'no_answer_rollover')
            AND btrim(COALESCE(l.order_status, '')) = '${NO_ANSWER}'
            AND l.order_id IN (SELECT id FROM open_na)
          GROUP BY l.order_id)
       INSERT INTO no_answer_cycles
         (business_id, order_id, owner_email, entered_at, stage, review_round, step_until, last_reviewer)
       SELECT n.business_id, n.id,
              NULLIF(btrim(COALESCE(CASE WHEN s.order_id IS NULL THEN n.holder ELSE COALESCE(s.first_from, n.holder) END, '')), ''),
              GREATEST(n."createdAt"::timestamptz,
                       LEAST(COALESCE(n.first_log, 'infinity'), COALESCE(s.first_at, 'infinity'), n."updatedAt")),
              CASE WHEN s.order_id IS NULL THEN 'owner' ELSE 'review' END,
              CASE WHEN s.order_id IS NULL THEN 0 ELSE LEAST(s.nights, ${REVIEW_DAYS - 1}) END,
              CASE WHEN s.order_id IS NULL
                   THEN (GREATEST(n."createdAt"::timestamptz,
                                  LEAST(COALESCE(n.first_log, 'infinity'), n."updatedAt")) AT TIME ZONE 'Africa/Cairo')::date + ${OWNER_DAYS - 1}
                   ELSE s.last_night + 1 END,
              CASE WHEN s.order_id IS NULL THEN NULL ELSE n.holder END
         FROM open_na n LEFT JOIN sweeps s ON s.order_id = n.id
       ON CONFLICT (order_id) WHERE closed_at IS NULL DO NOTHING
       RETURNING stage, review_round, step_until::text`,
      [businessId]);

    const byStage = {};
    for (const r of init) {
      const k = r.stage === 'owner' ? `owner (until ${r.step_until})` : `review r${r.review_round} (day ${r.step_until})`;
      byStage[k] = (byStage[k] ?? 0) + 1;
    }
    const result = { cutoff: BACKLOG_CUTOFF_LOCAL, to_close: closeIds.length, closed, initialised: init.length, by_stage: byStage };
    if (apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return { applied: apply, ...result };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ── Status guard (used by PATCH /api/orders/:id and the attempt logger) ─────────
   «ملغي - عدم رد نهائي» is set by the nightly rollover (or by an admin / Team
   Leader). From it, only an admin, a Team Leader or the order's last holder may
   change anything. Returns an Arabic error string, or null when allowed.      */
function terminalGuard(user, { currentStatus, currentAssignedTo, nextStatus }) {
  if (hasAnyRole(user, 'admin', 'supervisor')) return null;
  if (String(currentStatus ?? '').trim() === TERMINAL && norm(currentAssignedTo) !== norm(user?.email)) {
    return 'هذا الطلب مغلق نهائياً (عدم رد) — يعدّله فقط المدير أو التيم ليدر أو آخر موظفة كان معها';
  }
  if (nextStatus !== undefined && String(nextStatus ?? '').trim() === TERMINAL
      && String(currentStatus ?? '').trim() !== TERMINAL) {
    return 'الإغلاق النهائي لعدم الرد يتم تلقائياً بعد انتهاء دورة المتابعة (يومان للموظفة + يومان مراجعة)';
  }
  return null;
}

module.exports = {
  schemaReady, NO_ANSWER, TERMINAL, OWNER_DAYS, REVIEW_DAYS, BACKLOG_CUTOFF_LOCAL,
  planRollover, rolloverBusiness, runRollover, backlogMigrate, terminalGuard,
};
