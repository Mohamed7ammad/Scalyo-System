'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Confirmation-team discipline — Stage 1
   (checkpoints · check-in · breaks · daily seeding · 15-minute auto-withdrawal)
   ════════════════════════════════════════════════════════════════════════════
   • Agents in the program carry users.agent_track ('confirmation' | 'review').
     NULL = not monitored. Roles are untouched on purpose: routing, commission
     and analytics all select role 'agent', so new roles would silently drop
     people out of them.
   • Every time below is Cairo local time (the server and DB run in UTC).
   • One agent_daily_logs row per agent per Cairo day; one agent_checkpoint_logs
     row per checkpoint for that day, seeded with the absolute due time.
   • Deadline = due + grace + 1 minute: with a 15-minute grace, an 11:30
     checkpoint accepts a check-in until 11:45:59 and is withdrawn at 11:46.
   • users.last_action_at = last REAL work action (check-in now; status changes,
     notes and call attempts in Stage 2). It is deliberately NOT last_active_at,
     which the 90-second presence ping keeps writing for Online/Offline.        */

const pool = require('../config/db');
const { assignProductAware } = require('../utils/productRouting');

const CAIRO_TODAY = `(NOW() AT TIME ZONE 'Africa/Cairo')::date`;

/* GO-LIVE: nothing before this Cairo-local moment is ever seeded or enforced
   (launch: 2026-10-22 11:00, the first checkpoint). Converted by Postgres as
   Africa/Cairo so the DST offset can't be wrong. Override with env
   DISCIPLINE_ENFORCE_FROM='YYYY-MM-DD HH:MM' (validated; bad values fall back). */
const ENFORCE_FROM_LOCAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(process.env.DISCIPLINE_ENFORCE_FROM || '')
  ? process.env.DISCIPLINE_ENFORCE_FROM
  : '2026-10-22 11:00';
const ENFORCE_FROM_SQL = `('${ENFORCE_FROM_LOCAL}'::timestamp AT TIME ZONE 'Africa/Cairo')`;
const IDLE_WARNING_MINUTES = 13;   // client "هل ما زلتِ هنا؟" prompt
const IDLE_MINUTES         = 15;   // shown as idle on the Team Leader grid
const IDLE_WATCH_END_LOCAL = '21:00';

const TRACKS                = ['confirmation', 'review'];
const EARLY_CHECKIN_MINUTES = 30;            // check-in opens 30 min before due
const BREAK_MAX_SESSIONS    = 2;             // at most 2 break sessions a day
const BREAK_ALLOWANCE_SEC   = 30 * 60;       // 30 minutes a day in total
const BREAK_CHECKPOINT_BUFFER_MIN = 15;      // no break if a checkpoint is due within 15 min
/* Orders taken back on withdrawal: every 'جديد', plus 'لا يرد' from the active
   window only (the follow-up queue's 4 days). Measured 2026-10-22: 1,520 of the
   1,599 'لا يرد' orders assigned to agents were older than 4 days (1,258 older
   than a month) — moving those would flood compliant agents with dead orders.
   'مؤجل' stays: those are callbacks the agent promised the customer. */
const NO_ANSWER_WITHDRAW_WINDOW_DAYS = 4;

const DEFAULT_CHECKPOINTS = [
  { code: 'yesterday_review', label_ar: 'بدء مراجعة أوردرات أمس', due_time: '11:00', sort_order: 1 },
  { code: 'new_orders',       label_ar: 'بدء الأوردرات الجديدة',   due_time: '11:30', sort_order: 2 },
  { code: 'review_1',         label_ar: 'المراجعة الأولى',          due_time: '13:00', sort_order: 3 },
  { code: 'review_2',         label_ar: 'المراجعة الثانية',         due_time: '15:00', sort_order: 4 },
  { code: 'final_review',     label_ar: 'المراجعة النهائية',        due_time: '19:00', sort_order: 5 },
];

/* Typed error the routes turn into an HTTP status + Arabic message. */
class DisciplineError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/* ── Schema (idempotent; runs once at module load) ──────────────────────────── */
const schemaReady = (async () => {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_track VARCHAR(20)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_agent_track_chk') THEN
        ALTER TABLE users ADD CONSTRAINT users_agent_track_chk
          CHECK (agent_track IS NULL OR agent_track IN ('confirmation', 'review'));
      END IF;
    END $$`);

  /* Checkpoint definitions — data, not code, so the Team Leader can retime them. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discipline_checkpoints (
      id            SERIAL       PRIMARY KEY,
      business_id   INTEGER      NOT NULL,
      code          VARCHAR(30)  NOT NULL,
      label_ar      TEXT         NOT NULL,
      due_time      TIME         NOT NULL,                       -- Cairo local
      grace_minutes INTEGER      NOT NULL DEFAULT 15 CHECK (grace_minutes BETWEEN 0 AND 60),
      tracks        TEXT[]       NOT NULL DEFAULT ARRAY['confirmation', 'review'],
      sort_order    INTEGER      NOT NULL DEFAULT 0,
      is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
      updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (business_id, code)
    )`);

  /* One row per agent per Cairo work day. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_daily_logs (
      id                   SERIAL       PRIMARY KEY,
      business_id          INTEGER      NOT NULL,
      user_id              VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_date            DATE         NOT NULL,
      status               VARCHAR(20)  NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'active', 'break', 'withdrawn', 'off')),
      started_at           TIMESTAMPTZ,                          -- first check-in of the day
      withdrawn_at         TIMESTAMPTZ,
      withdrawn_checkpoint VARCHAR(30),
      orders_withdrawn     INTEGER      NOT NULL DEFAULT 0,
      reinstated_by        VARCHAR(255),
      reinstated_at        TIMESTAMPTZ,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (business_id, user_id, work_date)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS agent_daily_logs_day_idx ON agent_daily_logs (business_id, work_date)`);

  /* One row per checkpoint per agent per day (absolute due time + grace frozen
     at seeding, so editing settings mid-day never moves today's goalposts). */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_checkpoint_logs (
      id              SERIAL       PRIMARY KEY,
      daily_log_id    INTEGER      NOT NULL REFERENCES agent_daily_logs(id) ON DELETE CASCADE,
      checkpoint_code VARCHAR(30)  NOT NULL,
      label_ar        TEXT         NOT NULL,
      due_at          TIMESTAMPTZ  NOT NULL,
      grace_minutes   INTEGER      NOT NULL,
      checked_in_at   TIMESTAMPTZ,                               -- server NOW() on click
      outcome         VARCHAR(10)  NOT NULL DEFAULT 'open'
                        CHECK (outcome IN ('open', 'on_time', 'late', 'missed')),
      UNIQUE (daily_log_id, checkpoint_code)
    )`);

  /* Break sessions. The DB itself caps a day at 2 sessions (session_no 1..2 +
     unique) and at one open session at a time — a double tap can't beat it. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_break_sessions (
      id           SERIAL       PRIMARY KEY,
      daily_log_id INTEGER      NOT NULL REFERENCES agent_daily_logs(id) ON DELETE CASCADE,
      session_no   SMALLINT     NOT NULL CHECK (session_no BETWEEN 1 AND 2),
      started_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      max_end_at   TIMESTAMPTZ  NOT NULL,      -- allowance left, capped at the next checkpoint
      ended_at     TIMESTAMPTZ,
      ended_by     VARCHAR(10)  CHECK (ended_by IN ('agent', 'auto', 'checkin')),
      UNIQUE (daily_log_id, session_no)
    )`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_break_one_open_uidx
      ON agent_break_sessions (daily_log_id) WHERE ended_at IS NULL`);

  /* Audit trail (check-ins, breaks, withdrawals, reinstatements; idle in Stage 2). */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_activity_logs (
      id          BIGSERIAL    PRIMARY KEY,
      business_id INTEGER      NOT NULL,
      user_id     VARCHAR(255) NOT NULL,
      event       VARCHAR(20)  NOT NULL,
      detail      JSONB,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS agent_activity_recent_idx ON agent_activity_logs (business_id, created_at DESC)`);
  console.log('✅  Discipline: schema ready');
})().catch((err) => console.warn('⚠️   Discipline schema check:', err.message));

/* ── Helpers ─────────────────────────────────────────────────────────────────── */
const logEvent = (db, businessId, userId, event, detail = null) =>
  db.query(
    `INSERT INTO agent_activity_logs (business_id, user_id, event, detail) VALUES ($1, $2, $3, $4)`,
    [businessId, String(userId), event, detail ? JSON.stringify(detail) : null]
  );

/* Break seconds used today: closed sessions count until ended_at, the open one
   until now — both capped at max_end_at, so cron lag never overcharges. */
const BREAK_USED_SQL = `
  COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(b.ended_at, NOW()), b.max_end_at) - b.started_at))), 0)`;

/* ── Checkpoint settings ─────────────────────────────────────────────────────── */
async function ensureDefaultCheckpoints(businessId, db = pool) {
  for (const c of DEFAULT_CHECKPOINTS) {
    await db.query(
      `INSERT INTO discipline_checkpoints (business_id, code, label_ar, due_time, sort_order)
       VALUES ($1, $2, $3, $4::time, $5)
       ON CONFLICT (business_id, code) DO NOTHING`,
      [businessId, c.code, c.label_ar, c.due_time, c.sort_order]
    );
  }
}

async function listCheckpoints(businessId) {
  await ensureDefaultCheckpoints(businessId);
  const { rows } = await pool.query(
    `SELECT code, label_ar, to_char(due_time, 'HH24:MI') AS due_time, grace_minutes, tracks, sort_order, is_active, updated_at
       FROM discipline_checkpoints WHERE business_id = $1 ORDER BY sort_order, due_time`,
    [businessId]
  );
  return rows;
}

/* Validated partial update. Takes effect from the NEXT day's seeding: today's
   checkpoint rows were frozen when the day was seeded. */
async function updateCheckpoint(businessId, code, body) {
  await ensureDefaultCheckpoints(businessId);
  const sets = [];
  const params = [];
  const add = (sql, v) => { params.push(v); sets.push(`${sql} = $${params.length}`); };
  if (body.label_ar !== undefined) {
    const v = String(body.label_ar ?? '').trim();
    if (!v || v.length > 100) throw new DisciplineError(400, 'اسم نقطة المتابعة مطلوب (حتى 100 حرف)');
    add('label_ar', v);
  }
  if (body.due_time !== undefined) {
    const v = String(body.due_time ?? '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new DisciplineError(400, 'الوقت يجب أن يكون بصيغة HH:MM (24 ساعة)');
    add('due_time', v);
  }
  if (body.grace_minutes !== undefined) {
    const v = Number(body.grace_minutes);
    if (!Number.isInteger(v) || v < 0 || v > 60) throw new DisciplineError(400, 'مهلة السماح بين 0 و 60 دقيقة');
    add('grace_minutes', v);
  }
  if (body.tracks !== undefined) {
    const v = Array.isArray(body.tracks) ? [...new Set(body.tracks.map(String))] : null;
    if (!v || !v.length || v.some((t) => !TRACKS.includes(t))) throw new DisciplineError(400, 'المسارات المسموحة: confirmation و/أو review');
    add('tracks', v);
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') throw new DisciplineError(400, 'is_active يجب أن تكون true أو false');
    add('is_active', body.is_active);
  }
  if (!sets.length) throw new DisciplineError(400, 'لا توجد حقول للتحديث');
  sets.push('updated_at = NOW()');
  params.push(businessId, code);
  const { rows } = await pool.query(
    `UPDATE discipline_checkpoints SET ${sets.join(', ')}
      WHERE business_id = $${params.length - 1} AND code = $${params.length}
      RETURNING code, label_ar, to_char(due_time, 'HH24:MI') AS due_time, grace_minutes, tracks, sort_order, is_active`,
    params
  );
  if (!rows.length) throw new DisciplineError(404, 'نقطة المتابعة غير موجودة');
  return rows[0];
}

async function setAgentTrack(businessId, userId, track) {
  if (track !== null && !TRACKS.includes(track)) throw new DisciplineError(400, 'المسار يجب أن يكون confirmation أو review أو null');
  const { rows } = await pool.query(
    `UPDATE users SET agent_track = $1
      WHERE id = $2 AND business_id = $3 AND 'agent' = ANY(COALESCE(roles, ARRAY[role]))
      RETURNING id, email, COALESCE(NULLIF(TRIM(name), ''), SPLIT_PART(email, '@', 1)) AS name, agent_track`,
    [track, String(userId), businessId]
  );
  if (!rows.length) throw new DisciplineError(404, 'الموظفة غير موجودة أو ليست موظفة تأكيد');
  return rows[0];
}

/* ── Daily seeding (idempotent) ──────────────────────────────────────────────────
   Creates today's rows for every enrolled, active, present agent (optionally one
   agent). A checkpoint whose deadline has ALREADY passed when the agent is seeded
   (track assigned mid-day, or marked present mid-day) is not created — nobody is
   withdrawn for a checkpoint that didn't apply to them yet. */
async function seedToday({ userId = null, db = pool } = {}) {
  const params = [];
  let userFilter = '';
  if (userId != null) { params.push(String(userId)); userFilter = `AND u.id = $${params.length}`; }

  const { rows: bizRows } = await db.query(
    `SELECT DISTINCT u.business_id FROM users u
      WHERE u.agent_track IS NOT NULL AND u.business_id IS NOT NULL ${userFilter}`, params);
  for (const b of bizRows) await ensureDefaultCheckpoints(b.business_id, db);

  await db.query(
    `INSERT INTO agent_daily_logs (business_id, user_id, work_date)
     SELECT u.business_id, u.id, ${CAIRO_TODAY}
       FROM users u
      WHERE u.agent_track IS NOT NULL AND u.business_id IS NOT NULL
        AND COALESCE(u.is_active, TRUE) AND NOT COALESCE(u.is_absent, FALSE)
        ${userFilter}
     ON CONFLICT (business_id, user_id, work_date) DO NOTHING`, params);

  await db.query(
    `INSERT INTO agent_checkpoint_logs (daily_log_id, checkpoint_code, label_ar, due_at, grace_minutes)
     SELECT d.id, k.code, k.label_ar,
            (d.work_date + k.due_time) AT TIME ZONE 'Africa/Cairo', k.grace_minutes
       FROM agent_daily_logs d
       JOIN users u                  ON u.id = d.user_id
       JOIN discipline_checkpoints k ON k.business_id = d.business_id AND k.is_active
                                    AND u.agent_track = ANY(k.tracks)
      WHERE d.work_date = ${CAIRO_TODAY}
        AND ((d.work_date + k.due_time) AT TIME ZONE 'Africa/Cairo')
              + make_interval(mins => k.grace_minutes + 1) > NOW()
        AND ((d.work_date + k.due_time) AT TIME ZONE 'Africa/Cairo') >= ${ENFORCE_FROM_SQL}
        ${userFilter}
     ON CONFLICT (daily_log_id, checkpoint_code) DO NOTHING`, params);
}

/* ── Agent state (powers the check-in panel; returned by every agent action) ── */
async function getAgentState(userId, businessId, db = pool) {
  const { rows: [u] } = await db.query(
    `SELECT id, agent_track, COALESCE(is_absent, FALSE) AS is_absent,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - last_action_at)))::int AS seconds_since_action,
            (NOW() AT TIME ZONE 'Africa/Cairo')::time < TIME '${IDLE_WATCH_END_LOCAL}' AS within_hours
       FROM users WHERE id = $1 AND business_id = $2`,
    [String(userId), businessId]
  );
  if (!u || !u.agent_track) return { enrolled: false };

  const { rows: [d] } = await db.query(
    `SELECT id, work_date::text, status, started_at, withdrawn_at, withdrawn_checkpoint, orders_withdrawn, reinstated_at
       FROM agent_daily_logs WHERE user_id = $1 AND business_id = $2 AND work_date = ${CAIRO_TODAY}`,
    [String(userId), businessId]
  );
  if (!d) return { enrolled: true, track: u.agent_track, is_absent: u.is_absent, scheduled_today: false, server_time: new Date().toISOString() };

  const { rows: checkpoints } = await db.query(
    `SELECT checkpoint_code AS code, label_ar, due_at, grace_minutes,
            due_at - make_interval(mins => ${EARLY_CHECKIN_MINUTES})  AS opens_at,
            due_at + make_interval(mins => grace_minutes + 1)          AS deadline_at,
            checked_in_at, outcome,
            CASE WHEN checked_in_at > due_at
                 THEN CEIL(EXTRACT(EPOCH FROM (checked_in_at - due_at)) / 60)::int ELSE 0 END AS late_minutes
       FROM agent_checkpoint_logs WHERE daily_log_id = $1 ORDER BY due_at`,
    [d.id]
  );

  const { rows: [br] } = await db.query(
    `SELECT COUNT(*)::int AS sessions_used, ${BREAK_USED_SQL}::float AS used_seconds,
            MAX(b.started_at) FILTER (WHERE b.ended_at IS NULL) AS open_started_at,
            MAX(b.max_end_at) FILTER (WHERE b.ended_at IS NULL) AS open_ends_at
       FROM agent_break_sessions b WHERE b.daily_log_id = $1`,
    [d.id]
  );
  const usedSeconds      = Math.min(BREAK_ALLOWANCE_SEC, Math.round(br.used_seconds));
  const remainingSeconds = Math.max(0, BREAK_ALLOWANCE_SEC - usedSeconds);
  const breakBlock       = await breakBlockReason(d, br.sessions_used, remainingSeconds, db);

  const now = Date.now();
  const nextCheckpoint = checkpoints.find((c) => c.outcome === 'open' && new Date(c.deadline_at).getTime() > now) || null;

  return {
    enrolled: true,
    track: u.agent_track,
    scheduled_today: true,
    work_date: d.work_date,
    status: d.status,
    started_at: d.started_at,
    withdrawn_at: d.withdrawn_at,
    withdrawn_checkpoint: d.withdrawn_checkpoint,
    orders_withdrawn: d.orders_withdrawn,
    reinstated_at: d.reinstated_at,
    checkpoints,
    next_checkpoint: nextCheckpoint,
    enforce_from: ENFORCE_FROM_LOCAL,
    /* Inactivity prompt: only while working (checked in, not on a break, before
       the end of the working day). The clock is the SERVER's — a wrong phone
       clock can't skew it. */
    seconds_since_action: u.seconds_since_action,
    idle_watch: d.status === 'active' && u.within_hours,
    idle_warning_minutes: IDLE_WARNING_MINUTES,
    break: {
      max_sessions:      BREAK_MAX_SESSIONS,
      sessions_used:     br.sessions_used,
      sessions_left:     Math.max(0, BREAK_MAX_SESSIONS - br.sessions_used),
      allowance_minutes: BREAK_ALLOWANCE_SEC / 60,
      used_seconds:      usedSeconds,
      remaining_seconds: remainingSeconds,
      remaining_minutes: Math.round(remainingSeconds / 60),   // a 3-second break must not read as "29 min left"
      active:            br.open_started_at ? { started_at: br.open_started_at, ends_at: br.open_ends_at } : null,
      can_start:         !breakBlock,
      blocked_reason:    breakBlock,
    },
    server_time: new Date().toISOString(),
  };
}

/* Why a break can't start right now (null = it can). Rules: active day only, max
   2 sessions, minutes left, no checkpoint due within 15 min, none in its grace. */
async function breakBlockReason(daily, sessionsUsed, remainingSeconds, db = pool) {
  if (daily.status === 'withdrawn') return 'تم سحب الأوردرات اليوم';
  if (daily.status === 'break')     return 'أنتِ في استراحة بالفعل';
  if (daily.status !== 'active')    return 'سجّلي حضور أول نقطة متابعة قبل الاستراحة';
  if (sessionsUsed >= BREAK_MAX_SESSIONS) return `استُخدمت فترتا الاستراحة لليوم (${BREAK_MAX_SESSIONS} من ${BREAK_MAX_SESSIONS})`;
  if (remainingSeconds < 60)        return 'انتهى رصيد الاستراحة اليومي (30 دقيقة)';
  const { rows: [due] } = await db.query(
    `SELECT label_ar, due_at, (due_at <= NOW()) AS in_grace
       FROM agent_checkpoint_logs
      WHERE daily_log_id = $1 AND outcome = 'open'
        AND due_at <= NOW() + make_interval(mins => ${BREAK_CHECKPOINT_BUFFER_MIN})
        AND due_at + make_interval(mins => grace_minutes + 1) > NOW()
      ORDER BY due_at LIMIT 1`,
    [daily.id]
  );
  if (due?.in_grace) return `سجّلي حضور «${due.label_ar}» أولاً`;
  if (due)           return `لا يمكن بدء استراحة — «${due.label_ar}» خلال أقل من ${BREAK_CHECKPOINT_BUFFER_MIN} دقيقة`;
  return null;
}

/* Lock (and if needed seed) the agent's row for today inside a transaction. */
async function lockToday(client, userId, businessId) {
  const { rows: [u] } = await client.query(
    `SELECT agent_track, COALESCE(is_absent, FALSE) AS is_absent, COALESCE(is_active, TRUE) AS is_active
       FROM users WHERE id = $1 AND business_id = $2`, [String(userId), businessId]);
  if (!u || !u.agent_track) throw new DisciplineError(403, 'حسابك غير مسجّل في نظام المتابعة');
  if (u.is_absent || !u.is_active) throw new DisciplineError(403, 'حسابك مسجّل كغائب اليوم — تواصلي مع التيم ليدر');
  await seedToday({ userId, db: client });
  const { rows: [d] } = await client.query(
    `SELECT * FROM agent_daily_logs WHERE user_id = $1 AND business_id = $2 AND work_date = ${CAIRO_TODAY} FOR UPDATE`,
    [String(userId), businessId]);
  if (!d) throw new DisciplineError(409, 'لا يوجد جدول متابعة لك اليوم');
  return d;
}

/* ── Check-in ────────────────────────────────────────────────────────────────────
   Records the SERVER time. `code` optional: defaults to the open checkpoint whose
   window (opens 30 min early → deadline) contains now. On time = within the due
   minute; after that, late (the yellow 1–15 min delay). Checking in ends a break. */
async function checkIn(userId, businessId, code = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await lockToday(client, userId, businessId);
    if (d.status === 'withdrawn') {
      throw new DisciplineError(403, 'تم سحب الأوردرات اليوم — تواصلي مع التيم ليدر لإعادة التفعيل');
    }

    const params = [d.id];
    let codeFilter = '';
    if (code) { params.push(String(code)); codeFilter = `AND checkpoint_code = $2`; }
    const { rows: [cp] } = await client.query(
      `SELECT id, checkpoint_code, label_ar, due_at, grace_minutes, checked_in_at, outcome,
              NOW() < due_at - make_interval(mins => ${EARLY_CHECKIN_MINUTES})  AS too_early,
              NOW() >= due_at + make_interval(mins => grace_minutes + 1)       AS too_late
         FROM agent_checkpoint_logs
        WHERE daily_log_id = $1 ${codeFilter}
          ${code ? '' : `AND outcome = 'open'
          AND NOW() >= due_at - make_interval(mins => ${EARLY_CHECKIN_MINUTES})
          AND NOW() <  due_at + make_interval(mins => grace_minutes + 1)`}
        ORDER BY due_at LIMIT 1
        FOR UPDATE`,
      params
    );
    if (!cp) throw new DisciplineError(404, code ? 'نقطة المتابعة غير موجودة اليوم' : 'لا توجد نقطة متابعة مفتوحة للتسجيل الآن');
    if (cp.outcome !== 'open') throw new DisciplineError(409, `تم تسجيل «${cp.label_ar}» بالفعل`);
    if (cp.too_early) throw new DisciplineError(400, `التسجيل في «${cp.label_ar}» يفتح قبل موعدها بـ ${EARLY_CHECKIN_MINUTES} دقيقة`);
    if (cp.too_late)  throw new DisciplineError(400, `انتهت مهلة «${cp.label_ar}»`);

    const { rows: [done] } = await client.query(
      `UPDATE agent_checkpoint_logs
          SET checked_in_at = NOW(),
              outcome = CASE WHEN NOW() < due_at + INTERVAL '1 minute' THEN 'on_time' ELSE 'late' END
        WHERE id = $1 RETURNING outcome`,
      [cp.id]
    );
    const brk = await client.query(
      `UPDATE agent_break_sessions SET ended_at = LEAST(NOW(), max_end_at), ended_by = 'checkin'
        WHERE daily_log_id = $1 AND ended_at IS NULL RETURNING id`, [d.id]);
    await client.query(
      `UPDATE agent_daily_logs SET status = 'active', started_at = COALESCE(started_at, NOW()) WHERE id = $1`, [d.id]);
    await client.query(`UPDATE users SET last_action_at = NOW() WHERE id = $1`, [String(userId)]);
    await logEvent(client, businessId, userId, 'checkin',
      { checkpoint: cp.checkpoint_code, outcome: done.outcome, ended_break: brk.rowCount > 0 });
    await client.query('COMMIT');
    return { checkpoint: cp.checkpoint_code, outcome: done.outcome, state: await getAgentState(userId, businessId) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ── Breaks ──────────────────────────────────────────────────────────────────────
   start: all rules in breakBlockReason. The session auto-ends at the earlier of
          (break minutes left) and (the next checkpoint's due time) — so a break
          can never cover a checkpoint, and is never a way around one.
   end:   closes the open session early; unused minutes stay available, but the
          session still counts toward the 2-a-day limit.                          */
async function startBreak(userId, businessId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await lockToday(client, userId, businessId);
    const { rows: [br] } = await client.query(
      `SELECT COUNT(*)::int AS sessions_used, ${BREAK_USED_SQL}::float AS used_seconds
         FROM agent_break_sessions b WHERE b.daily_log_id = $1`, [d.id]);
    const remaining = Math.max(0, BREAK_ALLOWANCE_SEC - Math.round(br.used_seconds));
    const blocked = await breakBlockReason(d, br.sessions_used, remaining, client);
    if (blocked) throw new DisciplineError(400, blocked);

    const { rows: [s] } = await client.query(
      `INSERT INTO agent_break_sessions (daily_log_id, session_no, max_end_at)
       SELECT $1, $2, LEAST(NOW() + make_interval(secs => $3),
                            COALESCE((SELECT MIN(due_at) FROM agent_checkpoint_logs
                                       WHERE daily_log_id = $1 AND outcome = 'open' AND due_at > NOW()), 'infinity'))
       RETURNING session_no, started_at, max_end_at`,
      [d.id, br.sessions_used + 1, remaining]
    );
    await client.query(`UPDATE agent_daily_logs SET status = 'break' WHERE id = $1`, [d.id]);
    await logEvent(client, businessId, userId, 'break_start',
      { session_no: s.session_no, ends_at: s.max_end_at, remaining_seconds: remaining });
    await client.query('COMMIT');
    return { session_no: s.session_no, ends_at: s.max_end_at, state: await getAgentState(userId, businessId) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505' || e.code === '23514') throw new DisciplineError(409, 'لا يمكن بدء استراحة أخرى');
    throw e;
  } finally {
    client.release();
  }
}

async function endBreak(userId, businessId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await lockToday(client, userId, businessId);
    const { rows } = await client.query(
      `UPDATE agent_break_sessions SET ended_at = LEAST(NOW(), max_end_at), ended_by = 'agent'
        WHERE daily_log_id = $1 AND ended_at IS NULL RETURNING session_no`, [d.id]);
    if (!rows.length) throw new DisciplineError(409, 'لا توجد استراحة جارية');
    await client.query(`UPDATE agent_daily_logs SET status = 'active' WHERE id = $1 AND status = 'break'`, [d.id]);
    await client.query(`UPDATE users SET last_action_at = NOW() WHERE id = $1`, [String(userId)]);
    await logEvent(client, businessId, userId, 'break_end', { session_no: rows[0].session_no, by: 'agent' });
    await client.query('COMMIT');
    return { state: await getAgentState(userId, businessId) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* Cron: close breaks that reached their cap (charged up to max_end_at only). */
async function closeExpiredBreaks() {
  const { rows } = await pool.query(
    `WITH closed AS (
       UPDATE agent_break_sessions SET ended_at = max_end_at, ended_by = 'auto'
        WHERE ended_at IS NULL AND max_end_at <= NOW()
       RETURNING daily_log_id, session_no)
     UPDATE agent_daily_logs d SET status = 'active'
       FROM closed c WHERE d.id = c.daily_log_id AND d.status = 'break'
     RETURNING d.business_id, d.user_id, c.session_no`);
  for (const r of rows) await logEvent(pool, r.business_id, r.user_id, 'break_end', { session_no: r.session_no, by: 'auto' });
  return rows.length;
}

/* ── Auto-withdrawal ─────────────────────────────────────────────────────────────
   1. open → missed once the deadline passes (the UPDATE is the lock: a re-run
      or overlapping tick can never process the same checkpoint twice);
   2. EVERY affected agent is marked withdrawn BEFORE any orders move, so one
      withdrawn agent's orders can't be handed to another withdrawn in the same tick;
   3. each agent's 'جديد' + recent 'لا يرد' live orders go to compliant agents —
      product-aware, balanced — or back to the unassigned pool when nobody may
      take that product. The commission-ownership trigger keeps any commission
      she already earned on them; order_assignment_log records every move.     */
async function enforceCheckpoints() {
  const { rows: missed } = await pool.query(
    `UPDATE agent_checkpoint_logs c SET outcome = 'missed'
       FROM agent_daily_logs d, users u
      WHERE c.daily_log_id = d.id AND u.id = d.user_id
        AND c.outcome = 'open'
        AND NOW() >= c.due_at + make_interval(mins => c.grace_minutes + 1)
        AND c.due_at >= ${ENFORCE_FROM_SQL}
        AND d.work_date = ${CAIRO_TODAY}
        AND d.status <> 'withdrawn'
        AND u.agent_track IS NOT NULL      -- un-enrolled mid-day → today's rows no longer enforced
        AND COALESCE(u.is_active, TRUE) AND NOT COALESCE(u.is_absent, FALSE)
      RETURNING d.id AS daily_log_id, d.business_id, d.user_id, c.checkpoint_code, c.label_ar`);
  if (!missed.length) return [];

  const first = new Map();                 // one withdrawal per agent per tick
  for (const m of missed) if (!first.has(m.daily_log_id)) first.set(m.daily_log_id, m);
  const { rows: newlyWithdrawn } = await pool.query(
    `UPDATE agent_daily_logs d
        SET status = 'withdrawn', withdrawn_at = NOW(), withdrawn_checkpoint = x.code
       FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::text[]) AS code) x
      WHERE d.id = x.id AND d.status <> 'withdrawn'
     RETURNING d.id, d.business_id, d.user_id, d.withdrawn_checkpoint`,
    [[...first.keys()], [...first.values()].map((m) => m.checkpoint_code)]
  );
  /* An open break can't outlive a withdrawal. */
  if (newlyWithdrawn.length) {
    await pool.query(
      `UPDATE agent_break_sessions SET ended_at = LEAST(NOW(), max_end_at), ended_by = 'auto'
        WHERE ended_at IS NULL AND daily_log_id = ANY($1::int[])`, [newlyWithdrawn.map((r) => r.id)]);
  }

  const results = [];
  for (const w of newlyWithdrawn) {
    try {
      results.push(await withdrawOrders(w));
    } catch (e) {
      console.error(`[discipline] withdrawing orders of user ${w.user_id} failed:`, e.message);
    }
  }
  return results;
}

async function withdrawOrders({ id: dailyLogId, business_id: businessId, user_id: userId, withdrawn_checkpoint: checkpoint }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [u] } = await client.query(`SELECT email FROM users WHERE id = $1`, [String(userId)]);
    const fromEmail = u?.email;
    const { rows: orders } = fromEmail ? await client.query(
      `SELECT id, "ProductName" AS product, btrim("Status") AS status
         FROM orders
        WHERE business_id = $1 AND "AssignedTo" = $2 AND is_lost_order = FALSE
          AND (btrim("Status") = 'جديد'
               OR (btrim("Status") = 'لا يرد'
                   AND "createdAt" >= NOW() - make_interval(days => ${NO_ANSWER_WITHDRAW_WINDOW_DAYS})))
        ORDER BY id
        FOR UPDATE`,
      [businessId, fromEmail]) : { rows: [] };

    /* Compliant receivers: active, present agents — not her, and not withdrawn
       today. (Stage 2 adds: not idle, not on break.) */
    const { rows: agents } = await client.query(
      `SELECT u.email, COALESCE(u.allowed_products, '{}'::text[]) AS allowed
         FROM users u
        WHERE u.business_id = $1
          AND 'agent' = ANY(COALESCE(u.roles, ARRAY[u.role]))
          AND COALESCE(u.is_active, TRUE) AND NOT COALESCE(u.is_absent, FALSE)
          AND LOWER(TRIM(u.email)) <> LOWER(TRIM($2))
          AND NOT EXISTS (SELECT 1 FROM agent_daily_logs d
                           WHERE d.user_id = u.id AND d.work_date = ${CAIRO_TODAY} AND d.status = 'withdrawn')`,
      [businessId, fromEmail ?? '']);

    const { byAgent, unassigned } = assignProductAware(
      orders.map((o) => ({ id: o.id, product: o.product })),
      agents.map((a) => ({ email: a.email, weight: 1, allowed: a.allowed })));
    const statusById = new Map(orders.map((o) => [o.id, o.status]));

    let moved = 0;
    const logRows = [];
    for (const [toEmail, ids] of byAgent) {
      if (!ids.length) continue;
      const r = await client.query(
        `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW()
          WHERE id = ANY($2::int[]) AND business_id = $3 AND "AssignedTo" = $4 RETURNING id`,
        [toEmail, ids, businessId, fromEmail]);
      moved += r.rowCount;
      r.rows.forEach((x) => logRows.push([x.id, toEmail]));
    }
    if (unassigned.length) {
      const r = await client.query(
        `UPDATE orders SET "AssignedTo" = NULL, "updatedAt" = NOW()
          WHERE id = ANY($1::int[]) AND business_id = $2 AND "AssignedTo" = $3 RETURNING id`,
        [unassigned, businessId, fromEmail]);
      moved += r.rowCount;
      r.rows.forEach((x) => logRows.push([x.id, null]));
    }
    for (const [orderId, toEmail] of logRows) {
      await client.query(
        `INSERT INTO order_assignment_log
           (order_id, business_id, from_agent, to_agent, changed_by, changed_by_id, source, order_status)
         VALUES ($1, $2, $3, $4, 'system:discipline', NULL, 'withdrawal', $5)`,
        [orderId, businessId, fromEmail, toEmail, statusById.get(orderId) ?? null]);
    }

    await client.query(`UPDATE agent_daily_logs SET orders_withdrawn = $2 WHERE id = $1`, [dailyLogId, moved]);
    await logEvent(client, businessId, userId, 'withdrawn',
      { checkpoint, orders_moved: moved, to_pool: logRows.filter((r) => r[1] === null).length });
    await client.query('COMMIT');
    console.log(`[discipline] ⛔ ${fromEmail} withdrawn at "${checkpoint}" — ${moved} order(s) moved`);
    return { user_id: userId, email: fromEmail, checkpoint, orders_moved: moved };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* Team Leader / admin: lift a withdrawal for the rest of the day. Orders already
   handed to others stay with them; the missed checkpoint stays on the record
   (it still counts in the monthly evaluation); later checkpoints apply again. */
async function reinstate(businessId, userId, actorEmail) {
  const { rows } = await pool.query(
    `UPDATE agent_daily_logs SET status = 'active', reinstated_by = $3, reinstated_at = NOW()
      WHERE business_id = $1 AND user_id = $2 AND work_date = ${CAIRO_TODAY} AND status = 'withdrawn'
      RETURNING id`,
    [businessId, String(userId), actorEmail]);
  if (!rows.length) throw new DisciplineError(409, 'الموظفة غير مسحوبة اليوم');
  await logEvent(pool, businessId, userId, 'reinstated', { by: actorEmail });
  return getAgentState(userId, businessId);
}

/* "نعم، ما زلت هنا" — resets the inactivity clock (decision 6) and is LOGGED so
   the Team Leader sees how often an agent pinged instead of working. */
async function stillHere(userId, businessId) {
  const { rows } = await pool.query(
    `UPDATE users SET last_action_at = NOW()
      WHERE id = $1 AND business_id = $2 AND agent_track IS NOT NULL RETURNING id`,
    [String(userId), businessId]);
  if (!rows.length) throw new DisciplineError(403, 'حسابك غير مسجّل في نظام المتابعة');
  await logEvent(pool, businessId, userId, 'still_here');
  return getAgentState(userId, businessId);
}

/* Team Leader live board: every active agent (enrolled or not, for enrolment)
   with today's checkpoints, break use, last REAL action and "still here" pings.
   Colours are derived client-side from these facts. */
async function liveBoard(businessId) {
  await ensureDefaultCheckpoints(businessId);
  const [{ rows: defs }, { rows: agents }, { rows: cps }, { rows: brk }, { rows: pings }] = await Promise.all([
    pool.query(
      `SELECT code, label_ar, to_char(due_time, 'HH24:MI') AS due_time, grace_minutes, tracks
         FROM discipline_checkpoints WHERE business_id = $1 AND is_active ORDER BY sort_order, due_time`, [businessId]),
    pool.query(
      `SELECT u.id, COALESCE(NULLIF(TRIM(u.name), ''), SPLIT_PART(u.email, '@', 1)) AS name, u.email,
              u.agent_track, COALESCE(u.is_absent, FALSE) AS is_absent,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - u.last_action_at)))::int AS seconds_since_action,
              d.id AS daily_log_id, d.status, d.started_at, d.withdrawn_at, d.withdrawn_checkpoint,
              d.orders_withdrawn, d.reinstated_at, d.reinstated_by
         FROM users u
         LEFT JOIN agent_daily_logs d ON d.user_id = u.id AND d.work_date = ${CAIRO_TODAY}
        WHERE u.business_id = $1 AND 'agent' = ANY(COALESCE(u.roles, ARRAY[u.role]))
          AND COALESCE(u.is_active, TRUE)
        ORDER BY (u.agent_track IS NULL), u.agent_track, name`, [businessId]),
    pool.query(
      `SELECT c.daily_log_id, c.checkpoint_code AS code, c.due_at, c.grace_minutes, c.checked_in_at, c.outcome,
              CASE WHEN c.checked_in_at > c.due_at
                   THEN CEIL(EXTRACT(EPOCH FROM (c.checked_in_at - c.due_at)) / 60)::int ELSE 0 END AS late_minutes
         FROM agent_checkpoint_logs c JOIN agent_daily_logs d ON d.id = c.daily_log_id
        WHERE d.business_id = $1 AND d.work_date = ${CAIRO_TODAY}`, [businessId]),
    pool.query(
      `SELECT b.daily_log_id, COUNT(*)::int AS sessions_used, ${BREAK_USED_SQL}::float AS used_seconds,
              MAX(b.max_end_at) FILTER (WHERE b.ended_at IS NULL) AS open_ends_at
         FROM agent_break_sessions b JOIN agent_daily_logs d ON d.id = b.daily_log_id
        WHERE d.business_id = $1 AND d.work_date = ${CAIRO_TODAY} GROUP BY b.daily_log_id`, [businessId]),
    pool.query(
      `SELECT user_id, COUNT(*)::int AS n FROM agent_activity_logs
        WHERE business_id = $1 AND event = 'still_here'
          AND (created_at AT TIME ZONE 'Africa/Cairo')::date = ${CAIRO_TODAY}
        GROUP BY user_id`, [businessId]),
  ]);
  const cpByLog = new Map();
  for (const c of cps) {
    if (!cpByLog.has(c.daily_log_id)) cpByLog.set(c.daily_log_id, []);
    cpByLog.get(c.daily_log_id).push(c);
  }
  const brkByLog = new Map(brk.map((b) => [b.daily_log_id, b]));
  const pingBy   = new Map(pings.map((p) => [String(p.user_id), p.n]));
  return {
    server_time:  new Date().toISOString(),
    enforce_from: ENFORCE_FROM_LOCAL,
    idle_minutes: IDLE_MINUTES,
    checkpoints:  defs,
    agents: agents.map((a) => {
      const b = a.daily_log_id ? brkByLog.get(a.daily_log_id) : null;
      return {
        id: a.id, name: a.name, email: a.email, track: a.agent_track, is_absent: a.is_absent,
        scheduled_today: !!a.daily_log_id,
        status: a.status ?? null,
        started_at: a.started_at, withdrawn_at: a.withdrawn_at, withdrawn_checkpoint: a.withdrawn_checkpoint,
        orders_withdrawn: a.orders_withdrawn ?? 0, reinstated_at: a.reinstated_at, reinstated_by: a.reinstated_by,
        seconds_since_action: a.seconds_since_action,
        still_here_today: pingBy.get(String(a.id)) ?? 0,
        checkpoints: a.daily_log_id
          ? (cpByLog.get(a.daily_log_id) ?? []).sort((x, y) => new Date(x.due_at) - new Date(y.due_at))
          : [],
        break: {
          sessions_used: b?.sessions_used ?? 0,
          used_minutes:  Math.round(Math.min(BREAK_ALLOWANCE_SEC, b?.used_seconds ?? 0) / 60),
          active_until:  b?.open_ends_at ?? null,
        },
      };
    }),
  };
}

/* Team view of enrolled + enrollable agents with today's status. */
async function listAgents(businessId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, COALESCE(NULLIF(TRIM(u.name), ''), SPLIT_PART(u.email, '@', 1)) AS name,
            u.agent_track, COALESCE(u.is_absent, FALSE) AS is_absent, COALESCE(u.is_active, TRUE) AS is_active,
            d.status AS today_status, d.withdrawn_checkpoint, d.orders_withdrawn
       FROM users u
       LEFT JOIN agent_daily_logs d ON d.user_id = u.id AND d.work_date = ${CAIRO_TODAY}
      WHERE u.business_id = $1 AND 'agent' = ANY(COALESCE(u.roles, ARRAY[u.role]))
      ORDER BY (u.agent_track IS NULL), u.agent_track, name`,
    [businessId]);
  return rows;
}

module.exports = {
  schemaReady, DisciplineError, TRACKS, DEFAULT_CHECKPOINTS,
  listCheckpoints, updateCheckpoint, setAgentTrack, listAgents,
  seedToday, getAgentState, checkIn, startBreak, endBreak, reinstate, stillHere, liveBoard,
  closeExpiredBreaks, enforceCheckpoints,
};
