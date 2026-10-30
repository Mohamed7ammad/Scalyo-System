'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   «مؤجل» callbacks — impossible to lose (owner, 2026-10-30)
   ════════════════════════════════════════════════════════════════════════════
   Measured on 30 Oct: 239 of 262 «مؤجل» were overdue (193 by 30+ days). The
   «مؤجلات تستحق التأكيد» tab only showed TODAY..+3, so a missed callback left
   view the day after its date; 158 sat with absent / inactive / no agents
   (marking someone absent only moved «جديد»); nothing escalated, nothing
   expired. Rules, from that data:

     • DUE  = callback date ≤ today (Cairo). Due callbacks are real work: the
              reminder tab, the agent's strip, her idle radar and the Team
              Leader's board all count them.
     • REBALANCE (11:30, and the moment an agent is marked absent): a due
              callback held by an absent / inactive / missing agent moves to a
              present agent on the same side (review accounts ↔ review
              accounts, everyone else ↔ everyone else), product-aware.
     • EXPIRY (23:00 the day after the date): still «مؤجل» → «لا يرد», i.e.
              into the no-answer cycle (2 days with her, then review rounds).
              81% of the callbacks that ever succeed happen by then.
     • LIMITS: at most 7 days ahead (≤7 d: 22–24% confirmed; 8–14 d: 10%;
              15+ d: 3%, nothing delivered) and at most 2 postponements per
              order. Admins / Team Leaders may override both.

   Every automated change is written to order_auto_actions (there is no status
   history), and moves also to order_assignment_log.                         */

const pool = require('../config/db');
const { assignProductAware } = require('../utils/productRouting');
const { hasAnyRole } = require('../utils/roles');

const POSTPONED      = 'مؤجل';
const NO_ANSWER      = 'لا يرد';
const TERMINAL       = 'ملغي - عدم رد نهائي';
const MAX_AHEAD_DAYS = 7;
const MAX_POSTPONES  = 2;
const BACKLOG_CLOSE_AFTER_DAYS = 30;   // one-time cleanup: overdue this long → closed
const ACTOR = 'system:postponed';
const CAIRO_TODAY = `(NOW() AT TIME ZONE 'Africa/Cairo')::date`;

/* "PostponedDate" is VARCHAR on the live schema — parse YYYY-MM-DD values only. */
const pdSql = (alias = '') =>
  `(CASE WHEN ${alias}"PostponedDate"::text ~ '^\\d{4}-\\d{2}-\\d{2}' THEN left(${alias}"PostponedDate"::text, 10)::date END)`;

const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
const cairoToday = () => CAIRO_DAY.format(new Date());                       // 'YYYY-MM-DD'
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ymdOf = (v) => (v == null ? null : (String(v).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null));

/* ── Schema ─────────────────────────────────────────────────────────────────── */
const schemaReady = (async () => {
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS postpone_count SMALLINT NOT NULL DEFAULT 0`);
  /* Orders postponed before the counter existed count as postponed once. */
  await pool.query(`UPDATE orders SET postpone_count = 1 WHERE postpone_count = 0 AND "PostponedDate" IS NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_auto_actions (
      id          SERIAL      PRIMARY KEY,
      business_id INTEGER     NOT NULL,
      order_id    INTEGER     NOT NULL,
      action      VARCHAR(40) NOT NULL,   -- postponed_rebalance | postponed_expired | postponed_backlog_close | postponed_backlog_redate
      from_status TEXT,
      to_status   TEXT,
      from_agent  TEXT,
      to_agent    TEXT,
      detail      JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS order_auto_actions_order_idx ON order_auto_actions (order_id)`);
  console.log('✅  Postponed callbacks: schema ready');
})().catch((e) => { console.error('❌  Postponed callbacks schema failed:', e.message); throw e; });
schemaReady.catch(() => {});

async function logActions(db, rows) {
  if (!rows.length) return;
  await db.query(
    `INSERT INTO order_auto_actions (business_id, order_id, action, from_status, to_status, from_agent, to_agent, detail)
     SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::jsonb[])`,
    [rows.map((r) => r.business_id), rows.map((r) => r.order_id), rows.map((r) => r.action),
     rows.map((r) => r.from_status ?? null), rows.map((r) => r.to_status ?? null),
     rows.map((r) => r.from_agent ?? null), rows.map((r) => r.to_agent ?? null),
     rows.map((r) => JSON.stringify(r.detail ?? {}))]);
}

/* ── PATCH rules (agents setting / moving «مؤجل») ─────────────────────────────
   Returns {} when nothing applies, { status, error } to refuse, or
   { postpone_count } to store with the update. A postponement = entering
   «مؤجل», or re-dating it once its callback day has come (re-dating a future
   date is just an adjustment). */
function checkPatch(user, { currentStatus, currentPostponedDate, currentPostponeCount }, updates) {
  const has = (k) => Object.prototype.hasOwnProperty.call(updates, k);
  const cur  = String(currentStatus ?? '').trim();
  const next = has('Status') ? String(updates.Status ?? '').trim() : cur;
  if (next !== POSTPONED) return {};
  const privileged = hasAnyRole(user, 'admin', 'supervisor');
  const entering = cur !== POSTPONED;
  const oldDate = ymdOf(currentPostponedDate);
  const newDate = has('PostponedDate') ? ymdOf(updates.PostponedDate) : oldDate;
  if (!entering && newDate === oldDate) return {};
  const today = cairoToday();
  if (!newDate) return { status: 400, error: 'حدّدي تاريخ المتابعة للتأجيل' };
  if (!privileged) {
    if (newDate < today) return { status: 400, error: 'تاريخ المتابعة لا يمكن أن يكون في الماضي' };
    const max = addDays(today, MAX_AHEAD_DAYS);
    if (newDate > max) return { status: 400, error: `أقصى تأجيل ${MAX_AHEAD_DAYS} أيام (حتى ${max}) — التأجيل الأطول من التيم ليدر` };
  }
  if (!entering && !(oldDate != null && oldDate <= today)) return {};   // adjusting a future date
  const count = (Number(currentPostponeCount) || 0) + 1;
  if (count > MAX_POSTPONES && !privileged) {
    return { status: 403, error: 'تم تأجيل هذا الأوردر مرتين — لازم قرار نهائي (تأكيد / رفض / لا يرد) أو تأجيل من التيم ليدر' };
  }
  return { postpone_count: count };
}

/* ── Rebalance ─────────────────────────────────────────────────────────────────
   DUE callbacks (date ≤ today, or no date) whose holder can't work them move to
   present agents on the same side. A missing date becomes today. */
async function rebalanceDue(businessId = null) {
  await schemaReady;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('postponed_rebalance'))`);
    const { rows: due } = await client.query(
      `SELECT o.id, o.business_id, o."AssignedTo" AS holder, o."ProductName" AS product,
              COALESCE(h.agent_track = 'review', FALSE) AS review_side
         FROM orders o
         LEFT JOIN users h ON h.business_id = o.business_id AND LOWER(TRIM(h.email)) = LOWER(TRIM(o."AssignedTo"))
        WHERE btrim(o."Status") = '${POSTPONED}'
          ${businessId != null ? 'AND o.business_id = $1' : ''}
          AND (${pdSql('o.')} IS NULL OR ${pdSql('o.')} <= ${CAIRO_TODAY})
          AND (h.email IS NULL OR NOT COALESCE(h.is_active, TRUE) OR COALESCE(h.is_absent, FALSE)
               OR NOT ('agent' = ANY(COALESCE(h.roles, ARRAY[h.role]))))
        ORDER BY o.id
        FOR UPDATE OF o SKIP LOCKED`,
      businessId != null ? [businessId] : []);

    const groups = new Map();   // "business|side" → orders
    for (const o of due) {
      const k = `${o.business_id}|${o.review_side}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    const out = { moved: 0, stuck: 0, to: {} };
    const assignLog = [];
    const audit = [];
    const today = cairoToday();
    for (const [k, orders] of groups) {
      const [biz, side] = k.split('|');
      const reviewSide = side === 'true';
      const { rows: agents } = await client.query(
        `SELECT email, COALESCE(allowed_products, '{}'::text[]) AS allowed FROM users
          WHERE business_id = $1 AND 'agent' = ANY(COALESCE(roles, ARRAY[role]))
            AND COALESCE(is_active, TRUE) AND NOT COALESCE(is_absent, FALSE)
            AND ${reviewSide ? `agent_track = 'review'` : `agent_track IS DISTINCT FROM 'review'`}
          ORDER BY email`, [Number(biz)]);
      const { byAgent, unassigned } = assignProductAware(
        orders.map((o) => ({ id: o.id, product: o.product })),
        agents.map((a) => ({ email: a.email, weight: 1, allowed: a.allowed })));
      out.stuck += unassigned.length;
      const holderOf = new Map(orders.map((o) => [o.id, o.holder]));
      for (const [to, ids] of byAgent) {
        if (!ids.length) continue;
        const { rows: moved } = await client.query(
          `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW(),
                  "PostponedDate" = CASE WHEN ${pdSql()} IS NULL THEN $4 ELSE "PostponedDate" END
            WHERE id = ANY($2::int[]) AND business_id = $3 AND btrim("Status") = '${POSTPONED}'
            RETURNING id`, [to, ids, Number(biz), today]);
        for (const { id } of moved) {
          assignLog.push([id, Number(biz), holderOf.get(id) ?? null, to]);
          audit.push({ business_id: Number(biz), order_id: id, action: 'postponed_rebalance', from_status: POSTPONED,
            to_status: POSTPONED, from_agent: holderOf.get(id) ?? null, to_agent: to });
        }
        out.moved += moved.length;
        out.to[to] = (out.to[to] ?? 0) + moved.length;
      }
    }
    if (assignLog.length) {
      await client.query(
        `INSERT INTO order_assignment_log (order_id, business_id, from_agent, to_agent, changed_by, changed_by_id, source, order_status)
         SELECT o, b, f, t, '${ACTOR}', NULL, 'postponed_rebalance', '${POSTPONED}'
           FROM unnest($1::int[], $2::int[], $3::text[], $4::text[]) AS x(o, b, f, t)`,
        [assignLog.map((r) => r[0]), assignLog.map((r) => r[1]), assignLog.map((r) => r[2]), assignLog.map((r) => r[3])]);
    }
    await logActions(client, audit);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ── Expiry ────────────────────────────────────────────────────────────────────
   Run after 23:00: every callback dated yesterday or earlier that is still
   «مؤجل» becomes «لا يرد» — the no-answer trigger opens its cycle (2 days with
   her, then review). Taking every date ≤ yesterday makes a missed night
   self-healing. */
async function expireOverdue() {
  await schemaReady;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE orders o SET "Status" = '${NO_ANSWER}', "updatedAt" = NOW()
        WHERE btrim(o."Status") = '${POSTPONED}' AND ${pdSql('o.')} <= ${CAIRO_TODAY} - 1
        RETURNING o.id, o.business_id, o."AssignedTo" AS holder, left(o."PostponedDate"::text, 10) AS callback`);
    await logActions(client, rows.map((r) => ({
      business_id: r.business_id, order_id: r.id, action: 'postponed_expired', from_status: POSTPONED, to_status: NO_ANSWER,
      from_agent: r.holder, to_agent: r.holder, detail: { callback_date: r.callback } })));
    await client.query('COMMIT');
    return { expired: rows.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ── One-time backlog (owner-approved 2026-10-30) ──────────────────────────────
   • overdue ≥ 30 days → «ملغي - عدم رد نهائي» (reopenable by admin / TL);
   • overdue 1–29 days, or no date → due TODAY again (then the normal rules:
     rebalance away from absent agents, expiry tomorrow night if untouched).
   apply=false → counts only. */
async function backlogCleanup({ businessId = 1, apply = false } = {}) {
  await schemaReady;
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    const today = cairoToday();
    const { rows: closed } = await client.query(
      `UPDATE orders o SET "Status" = '${TERMINAL}', "updatedAt" = NOW()
        WHERE o.business_id = $1 AND btrim(o."Status") = '${POSTPONED}'
          AND ${pdSql('o.')} <= ${CAIRO_TODAY} - ${BACKLOG_CLOSE_AFTER_DAYS}
        RETURNING o.id, o."AssignedTo" AS holder, left(o."PostponedDate"::text, 10) AS callback`, [businessId]);
    const { rows: redated } = await client.query(
      `WITH t AS (SELECT o.id, o."PostponedDate" AS old FROM orders o
                   WHERE o.business_id = $1 AND btrim(o."Status") = '${POSTPONED}'
                     AND (${pdSql('o.')} IS NULL OR ${pdSql('o.')} BETWEEN ${CAIRO_TODAY} - ${BACKLOG_CLOSE_AFTER_DAYS - 1} AND ${CAIRO_TODAY} - 1)
                   FOR UPDATE)
       UPDATE orders o SET "PostponedDate" = $2, "updatedAt" = NOW()
         FROM t WHERE o.id = t.id
       RETURNING o.id, o."AssignedTo" AS holder, left(t.old::text, 10) AS callback`, [businessId, today]);
    await logActions(client, [
      ...closed.map((r) => ({ business_id: businessId, order_id: r.id, action: 'postponed_backlog_close', from_status: POSTPONED,
        to_status: TERMINAL, from_agent: r.holder, to_agent: r.holder, detail: { callback_date: r.callback } })),
      ...redated.map((r) => ({ business_id: businessId, order_id: r.id, action: 'postponed_backlog_redate', from_status: POSTPONED,
        to_status: POSTPONED, from_agent: r.holder, to_agent: r.holder, detail: { callback_date: r.callback, new_date: today } })),
    ]);
    result = { closed: closed.length, redated: redated.length };
    if (apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (apply) result.rebalanced = await rebalanceDue(businessId);
  return { applied: apply, ...result };
}

module.exports = {
  schemaReady, POSTPONED, MAX_AHEAD_DAYS, MAX_POSTPONES, pdSql, cairoToday,
  checkPatch, rebalanceDue, expireOverdue, backlogCleanup,
};
