'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   No-answer («لا يرد») review loop — automated 2 + 2 day cycle
   ════════════════════════════════════════════════════════════════════════════
   Replaces the Team Leader's manual nightly sweep (filter «لا يرد» of the last
   4 days → one transfer into a review account). Owner's rules (2026-10-22):

     • OWNER stage  — the agent who marked it «لا يرد» keeps it that day and the
                      whole next day (agents re-dial from their bulk-copied list
                      without touching the system, so nothing may move mid-day);
     • REVIEW stage — 2 review days, each handed to a review account the Team
                      Leader picks (never the owner nor the previous reviewer:
                      a new voice / phone number);
     • then CLOSED  — status «ملغي - عدم رد نهائي», reopenable only by an admin,
                      a Team Leader, or the last agent holding it.

   Time drives everything — agents don't log every missed call, so attempt
   counts (orders.no_answer_logs, the 5-attempt commission) are NOT used here.

   Pieces:
     • no_answer_cycles — one row per «لا يرد» episode of an order. Opened and
       closed by a trigger on orders."Status" (every write path: PATCH, bulk,
       imports), so it is never out of sync. Closed rows keep the outcome and
       the stage it ended in → real "recovered by review" numbers.
     • distributeReviewQueue() — the Team Leader's «توزيع طابور المراجعة»
       button (manual by the owner's choice — no cron): hands the ready orders
       to the review account(s) she selects and closes the exhausted ones.
     • backlogMigrate() — one-time cleanup + initialisation of open cycles.   */

const pool = require('../config/db');
const { DisciplineError } = require('./agentDiscipline');
const { agentAllowsProduct } = require('../utils/productRouting');
const { hasAnyRole } = require('../utils/roles');

const NO_ANSWER   = 'لا يرد';
const TERMINAL    = 'ملغي - عدم رد نهائي';
const OWNER_DAYS  = 2;   // day it went «لا يرد» + the next day
const REVIEW_DAYS = 2;
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
     or the date of the current review day. A distribution on day T acts on
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
      closed_by     VARCHAR(20)                -- status | review_queue | backlog
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS no_answer_cycles_open_uq ON no_answer_cycles (order_id) WHERE closed_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS no_answer_cycles_due_idx ON no_answer_cycles (business_id, step_until) WHERE closed_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS no_answer_cycles_closed_idx ON no_answer_cycles (business_id, closed_at)`);

  /* One row per «توزيع طابور المراجعة» press (audit + the panel's last run). */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS no_answer_distributions (
      id          SERIAL      PRIMARY KEY,
      business_id INTEGER     NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_email TEXT,
      targets     TEXT[]      NOT NULL,
      summary     JSONB
    )`);

  /* Open / close cycles on every status change. Lost orders run their own flow.
     The actor (review_queue / backlog) is passed via SET LOCAL app.na_actor.
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

/* ── Review queue: the Team Leader's «توزيع طابور المراجعة» ───────────────────────
   No automation (owner, 2026-10-22): the Team Leader decides WHO gets the queue
   and WHEN, by daily capacity. One press takes every open cycle whose step has
   ended (step_until <= today) or whose holder can't work it (unassigned /
   absent / inactive):
     to_review — the owner's 2 days are done (or she's away) → first review day;
     redeal    — a review day is done, one more to go → next reviewer, round 2;
     rescue    — the reviewer is away mid-round → another reviewer, same round;
     close     — the last review day is done → «ملغي - عدم رد نهائي».
   Her selection is absolute: everything ready is pooled and split evenly
   between the reviewer(s) she picked, whoever owned or held it before — review
   accounts call from their own SIM cards, so it's a new caller to the customer
   anyway (owner, 2026-10-22). An order that lands with the reviewer already
   holding it just advances its round. The only exception is a reviewer
   restricted to other products (none today). A handled order's next step is
   tomorrow, so a second press the same day only picks up what is left. Moves go through a
   normal AssignedTo update (trg_orders_commission_owner keeps every earned
   عمولة عدم الرد with whoever earned it); closing grants / voids nothing.     */

/* Review accounts she can pick from, with their open review load. */
async function listReviewers(db, businessId) {
  const { rows } = await db.query(
    `SELECT u.id::text AS id, COALESCE(NULLIF(TRIM(u.name), ''), SPLIT_PART(u.email, '@', 1)) AS name, u.email,
            COALESCE(u.is_absent, FALSE) AS is_absent, COALESCE(u.allowed_products, '{}'::text[]) AS allowed,
            (SELECT COUNT(*) FROM no_answer_cycles c JOIN orders o ON o.id = c.order_id
              WHERE c.business_id = u.business_id AND c.closed_at IS NULL AND c.stage = 'review'
                AND btrim(o."Status") = '${NO_ANSWER}'
                AND LOWER(TRIM(o."AssignedTo")) = LOWER(TRIM(u.email)))::int AS review_load
       FROM users u
      WHERE u.business_id = $1
        AND 'agent' = ANY(COALESCE(u.roles, ARRAY[u.role]))
        AND COALESCE(u.is_active, TRUE)
        AND u.agent_track = ANY($2::text[])
      ORDER BY 2`, [businessId, REVIEW_ROUTING_TRACKS]);
  return rows;
}

/* Everything one press would act on right now, classified (no reviewer yet). */
async function pendingQueue(db, businessId) {
  const { rows: [{ today }] } = await db.query(`SELECT ${CAIRO_TODAY}::text AS today`);
  const { rows: cycles } = await db.query(
    `SELECT c.id AS cycle_id, c.order_id, c.owner_email, c.stage, c.review_round,
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
  const items = [];
  for (const c of cycles) {
    let kind = null;
    if (c.stage === 'owner') kind = 'to_review';
    else if (c.due) kind = c.review_round >= REVIEW_DAYS ? 'close' : 'redeal';
    else if (c.stranded) kind = 'rescue';
    if (kind) items.push({ ...c, kind });
  }
  return { today, items };
}

/* Even split between the selected reviewers. On a tie the order's current
   holder wins, so nothing moves needlessly; a.stay marks those. */
function dealTo(items, targets) {
  const count = new Map(targets.map((t) => [norm(t.email), 0]));
  for (const a of items) {
    if (a.kind === 'close') continue;
    const eligible = targets.filter((t) => agentAllowsProduct(t.allowed, a.product));
    if (!eligible.length) { a.skip = 'product'; continue; }
    const isHolder = (t) => (norm(t.email) === norm(a.holder) ? 1 : 0);
    eligible.sort((x, y) => count.get(norm(x.email)) - count.get(norm(y.email))
      || isHolder(y) - isHolder(x) || x.email.localeCompare(y.email));
    a.to = eligible[0].email;
    a.stay = norm(a.to) === norm(a.holder);
    count.set(norm(a.to), count.get(norm(a.to)) + 1);
  }
}

function summarize(items) {
  const s = { to_review: 0, redeal: 0, rescue: 0, close: 0, kept: 0, skipped: { product: 0 }, to: {} };
  for (const a of items) {
    if (a.skip) { s.skipped[a.skip] += 1; continue; }
    s[a.kind] += 1;
    if (a.stay) s.kept += 1;
    if (a.to) s.to[a.to] = (s.to[a.to] ?? 0) + 1;
  }
  return s;
}

/* Panel data: what a press would do now, the open pipeline, the review
   accounts, and the last distribution. */
async function reviewQueueSummary(businessId) {
  await schemaReady;
  const [{ today, items }, reviewers, { rows: [open] }, { rows: [last] }] = await Promise.all([
    pendingQueue(pool, businessId),
    listReviewers(pool, businessId),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE c.stage = 'owner')::int AS owner, COUNT(*) FILTER (WHERE c.stage = 'review')::int AS review
         FROM no_answer_cycles c JOIN orders o ON o.id = c.order_id
        WHERE c.business_id = $1 AND c.closed_at IS NULL AND btrim(o."Status") = '${NO_ANSWER}'`, [businessId]),
    pool.query(
      `SELECT created_at, actor_email, targets, summary FROM no_answer_distributions
        WHERE business_id = $1 ORDER BY id DESC LIMIT 1`, [businessId]),
  ]);
  const ready = { to_review: 0, redeal: 0, rescue: 0, close: 0 };
  for (const a of items) ready[a.kind] += 1;
  return {
    today, ready, open,
    reviewers: reviewers.map(({ allowed, ...r }) => r),   // eslint-disable-line no-unused-vars
    last: last ?? null,
  };
}

/* The button. agentIds = the selected review accounts (users.id). dryRun →
   the exact plan for that selection, nothing written. */
async function distributeReviewQueue(businessId, { agentIds, actor, dryRun = false }) {
  await schemaReady;
  const ids = Array.isArray(agentIds) ? [...new Set(agentIds.map(String))] : [];
  if (!ids.length || ids.length > 10) throw new DisciplineError(400, 'اختاري موظفة مراجعة واحدة على الأقل');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.na_actor = 'review_queue'`);
    /* One distribution at a time per business (two Team Leaders pressing). */
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('no_answer_review_queue'), $1)`, [businessId]);

    const reviewers = await listReviewers(client, businessId);
    const targets = reviewers.filter((r) => ids.includes(r.id));
    if (targets.length !== ids.length) throw new DisciplineError(400, 'إحدى الموظفات المختارات ليست حساب مراجعة نشطاً');
    const absent = targets.filter((t) => t.is_absent);
    if (absent.length) throw new DisciplineError(400, `مسجّلة غائبة اليوم: ${absent.map((t) => t.name).join('، ')}`);

    const { today, items } = await pendingQueue(client, businessId);
    dealTo(items, targets);
    const plan = summarize(items);
    if (dryRun) { await client.query('ROLLBACK'); return { dryRun: true, today, ...plan }; }

    const done = { to_review: 0, redeal: 0, rescue: 0, close: 0, kept: 0, skipped: plan.skipped, raced: 0, to: {} };
    const closeIds = [];
    for (const a of items) {
      if (a.skip) continue;
      if (a.kind === 'close') { closeIds.push(a.order_id); continue; }
      if (a.stay) {
        /* Already with this reviewer: nothing to move, the round still advances. */
        const { rowCount } = await client.query(
          `SELECT 1 FROM orders
            WHERE id = $1 AND business_id = $2 AND btrim("Status") = '${NO_ANSWER}'
              AND "AssignedTo" IS NOT DISTINCT FROM $3
            FOR UPDATE`,
          [a.order_id, businessId, a.holder]);
        if (!rowCount) { done.raced += 1; continue; }   // changed since it was read
        done.kept += 1;
      } else {
        const { rowCount } = await client.query(
          `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW()
            WHERE id = $2 AND business_id = $3 AND btrim("Status") = '${NO_ANSWER}'
              AND "AssignedTo" IS NOT DISTINCT FROM $4`,
          [a.to, a.order_id, businessId, a.holder]);
        if (!rowCount) { done.raced += 1; continue; }   // changed since it was read
        await client.query(
          `INSERT INTO order_assignment_log
             (order_id, business_id, from_agent, to_agent, changed_by, changed_by_id, source, order_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'review_queue', '${NO_ANSWER}')`,
          [a.order_id, businessId, a.holder, a.to, actor?.email ?? null, actor?.id != null ? String(actor.id) : null]);
      }
      /* to_review / redeal start a new review day tomorrow; rescue keeps its day. */
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
      done.to[a.to] = (done.to[a.to] ?? 0) + 1;
    }
    if (closeIds.length) {
      /* The status trigger closes the cycles (closed_by = 'review_queue'). */
      const { rowCount } = await client.query(
        `UPDATE orders SET "Status" = '${TERMINAL}', "updatedAt" = NOW()
          WHERE id = ANY($1::int[]) AND business_id = $2 AND btrim("Status") = '${NO_ANSWER}'`,
        [closeIds, businessId]);
      done.close = rowCount;
      done.raced += closeIds.length - rowCount;
    }
    await client.query(
      `INSERT INTO no_answer_distributions (business_id, actor_email, targets, summary) VALUES ($1, $2, $3, $4)`,
      [businessId, actor?.email ?? null, targets.map((t) => t.email), JSON.stringify(done)]);
    await client.query('COMMIT');
    console.log(`[no-answer] 📞 review queue by ${actor?.email}: → ${JSON.stringify(done.to)} (kept ${done.kept}) · closed ${done.close}` +
      (plan.skipped.product ? ` · skipped ${plan.skipped.product} (product)` : ''));
    return { today, ...done };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
          WHERE l.business_id = $1 AND l.source IN ('transfer', 'no_answer_rollover', 'review_queue')
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
   «ملغي - عدم رد نهائي» is set by the review-queue distribution (or by an admin / Team
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
  REVIEW_ROUTING_TRACKS, reviewQueueSummary, distributeReviewQueue, backlogMigrate, terminalGuard,
};
