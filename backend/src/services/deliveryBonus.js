'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Delivery-bonus pay plan (owner's agreement with the team, 2026-11-19)
   ════════════════════════════════════════════════════════════════════════════
   The owner switches the plan ON per agent (users.delivery_bonus_since = the
   moment it was switched on). An order that agent confirms from then on pays:
     confirmation → her confirmation rate × pieces        (comm_confirmed)
     delivered    → her bonus per piece  × pieces         (comm_delivered)
   Orders confirmed before the switch, or by anyone without the plan, keep the
   old pay (rate per order, nothing on delivery). Nothing is ever backfilled.

   The confirmation ledger row carries the deal: `pieces` + `bonus_per_piece`
   (NULL = old pay). The delivery bonus is booked by a DB trigger on orders, so
   EVERY path that marks an order delivered (Bosta webhook, reconcile, imports,
   a manual change) pays it exactly once (partial unique index) to the agent
   who confirmed it, and takes it back if the order leaves «تم التوصيل».
   Switching the plan OFF stops it for new confirmations only: an order already
   confirmed under the plan still pays its bonus when it is delivered.         */

const pool = require('../config/db');

const DELIVERED = 'تم التوصيل';
const RETURNED = ['جاري الإعادة', 'تم الإرجاع'];
const IN_PROGRESS = ['تم التأكيد', 'تم الشحن'];

/* Pieces an order counts for: its quantity, never below 1. */
const pieces = (qty) => Math.max(1, parseInt(qty, 10) || 1);

/* 5 → "5", 2.5 → "2.5" (for ledger descriptions). */
const fmt = (n) => String(Math.round((Number(n) || 0) * 100) / 100);

/* Which list a plan order belongs to on the agent's screen. */
function groupOf(status) {
  const s = String(status ?? '').trim();
  if (s === DELIVERED) return 'delivered';
  if (RETURNED.includes(s)) return 'returned';
  if (IN_PROGRESS.includes(s)) return 'pending';
  return 'cancelled';
}

/* ── Schema ───────────────────────────────────────────────────────────────── */
const DDL = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS delivery_bonus_since TIMESTAMPTZ`,
  `ALTER TABLE treasury_transactions ADD COLUMN IF NOT EXISTS pieces INTEGER`,
  `ALTER TABLE treasury_transactions ADD COLUMN IF NOT EXISTS bonus_per_piece NUMERIC(10,2)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS treasury_comm_del_uidx
     ON treasury_transactions (order_id) WHERE source = 'comm_delivered'`,
  /* The agent's list: only plan confirmations, so it stays tiny. */
  `CREATE INDEX IF NOT EXISTS treasury_plan_conf_idx
     ON treasury_transactions (LOWER(TRIM(agent_email)), created_at DESC)
     WHERE source = 'comm_confirmed' AND bonus_per_piece IS NOT NULL`,
  /* Runs only on transitions INTO or OUT OF «تم التوصيل» (trigger WHEN), every
     lookup hits a partial index, and it never raises: a bonus problem must not
     block an order update. */
  `CREATE OR REPLACE FUNCTION scalyo_delivery_bonus() RETURNS trigger AS $fn$
   DECLARE
     c   RECORD;
     pcs INTEGER;
     changed BOOLEAN := false;
   BEGIN
     IF btrim(COALESCE(NEW."Status", '')) = '${DELIVERED}' THEN
       SELECT agent_email, bonus_per_piece, pieces INTO c
         FROM treasury_transactions
        WHERE order_id = NEW.id AND source = 'comm_confirmed'
          AND bonus_per_piece > 0 AND agent_email IS NOT NULL
        LIMIT 1;
       IF FOUND THEN
         pcs := GREATEST(1, COALESCE(NEW.quantity, c.pieces, 1));
         INSERT INTO treasury_transactions
           (order_id, amount, type, source, description, transaction_date,
            business_id, agent_email, pieces, bonus_per_piece)
         VALUES
           (NEW.id, c.bonus_per_piece * pcs, 'expense', 'comm_delivered',
            'بونص تسليم — ' || split_part(c.agent_email, '@', 1) || ' — طلب #' || NEW.id
              || ' (' || pcs || ' قطعة × ' || trim_scale(c.bonus_per_piece) || ')',
            CURRENT_DATE, NEW.business_id, c.agent_email, pcs, c.bonus_per_piece)
         ON CONFLICT (order_id) WHERE source = 'comm_delivered' DO NOTHING;
         changed := FOUND;
       END IF;
     ELSE
       DELETE FROM treasury_transactions
        WHERE order_id = NEW.id AND source = 'comm_delivered' AND bonus_per_piece IS NOT NULL;
       changed := FOUND;
     END IF;
     IF changed THEN
       UPDATE orders SET earned_commission = COALESCE((
           SELECT SUM(amount) FROM treasury_transactions
            WHERE order_id = NEW.id
              AND source IN ('comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer')), 0)
        WHERE id = NEW.id;
     END IF;
     RETURN NULL;
   EXCEPTION WHEN OTHERS THEN
     RAISE WARNING 'scalyo_delivery_bonus: order % skipped: %', NEW.id, SQLERRM;
     RETURN NULL;
   END
   $fn$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE TRIGGER trg_orders_delivery_bonus
     AFTER UPDATE OF "Status" ON orders
     FOR EACH ROW
     WHEN (btrim(COALESCE(OLD."Status", '')) IS DISTINCT FROM btrim(COALESCE(NEW."Status", ''))
           AND (btrim(COALESCE(NEW."Status", '')) = '${DELIVERED}'
                OR btrim(COALESCE(OLD."Status", '')) = '${DELIVERED}'))
     EXECUTE FUNCTION scalyo_delivery_bonus()`,
];

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = DDL.reduce((p, sql) => p.then(() => pool.query(sql)), Promise.resolve())
      .then(() => console.log('✅  Delivery bonus: columns + trigger ready'))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/* ── Plan switch (admin) ──────────────────────────────────────────────────────
   ON keeps the original start time if it is already on, and gives a 0 bonus
   rate the agreed 5 EGP per piece. OFF clears the start time. */
async function setPlan({ userId, businessId, enabled }) {
  await ensureSchema();
  const { rows: [u] } = await pool.query(
    enabled
      ? `UPDATE users
            SET delivery_bonus_since = COALESCE(delivery_bonus_since, NOW()),
                comm_delivered = CASE WHEN COALESCE(comm_delivered, 0) > 0 THEN comm_delivered ELSE 5 END
          WHERE id = $1 AND business_id = $2
          RETURNING id, email, delivery_bonus_since, COALESCE(comm_delivered, 0) AS comm_delivered`
      : `UPDATE users SET delivery_bonus_since = NULL
          WHERE id = $1 AND business_id = $2
          RETURNING id, email, delivery_bonus_since, COALESCE(comm_delivered, 0) AS comm_delivered`,
    [userId, businessId]);
  return u || null;
}

/* ── The agent's list ─────────────────────────────────────────────────────────
   Every order she confirmed under the plan (in the date range, by confirmation
   date): customer + phone + tracking so she can check it herself, what she got
   on confirmation, and the bonus once delivered. */
async function listFor({ email, businessId, start = null, end = null }) {
  await ensureSchema();
  const { rows: [user] } = await pool.query(
    `SELECT id, COALESCE(NULLIF(TRIM(name), ''), SPLIT_PART(email, '@', 1)) AS name, email,
            delivery_bonus_since, COALESCE(comm_confirmed, 0) AS comm_confirmed,
            COALESCE(comm_delivered, 0) AS comm_delivered
       FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) AND business_id = $2`,
    [email, businessId]);
  if (!user) return null;

  /* By the Cairo calendar day she confirmed it (transaction_date is the DB's UTC
     day, so a confirmation after midnight Cairo would land on "yesterday"). */
  const params = [user.email, businessId];
  const cairoDay = `(c.created_at AT TIME ZONE 'Africa/Cairo')::date`;
  let range = '';
  if (start) { params.push(start); range += ` AND ${cairoDay} >= $${params.length}::date`; }
  if (end) { params.push(end); range += ` AND ${cairoDay} <= $${params.length}::date`; }

  const { rows } = await pool.query(
    `SELECT o.id, o."FullName" AS customer, o."Phone" AS phone, o."ProductName" AS product,
            btrim(o."Status") AS status, o."BostaTrackingCode" AS tracking,
            o.delivered_at, c.created_at AS confirmed_at,
            c.pieces, c.bonus_per_piece, c.amount AS confirm_amount,
            GREATEST(1, COALESCE(o.quantity, c.pieces, 1)) AS qty,
            d.amount AS bonus_amount, d.created_at AS bonus_at
       FROM treasury_transactions c
       JOIN orders o ON o.id = c.order_id AND o.business_id = $2
       LEFT JOIN treasury_transactions d ON d.order_id = c.order_id AND d.source = 'comm_delivered'
      WHERE c.source = 'comm_confirmed' AND c.bonus_per_piece IS NOT NULL
        AND c.business_id = $2
        AND LOWER(TRIM(c.agent_email)) = LOWER(TRIM($1))
        ${range}
      ORDER BY c.created_at DESC
      LIMIT 3000`,
    params);

  const summary = {
    orders: rows.length, delivered: 0, returned: 0, pending: 0, cancelled: 0,
    confirmEarned: 0, bonusEarned: 0, bonusPossible: 0,
  };
  const list = rows.map((r) => {
    const group = groupOf(r.status);
    const confirmAmount = Number(r.confirm_amount) || 0;
    const bonusAmount = r.bonus_amount == null ? null : Number(r.bonus_amount);
    summary[group] += 1;
    summary.confirmEarned += confirmAmount;
    if (bonusAmount != null) summary.bonusEarned += bonusAmount;
    if (group === 'pending') summary.bonusPossible += (Number(r.bonus_per_piece) || 0) * (Number(r.qty) || 1);
    return {
      id: r.id, customer: r.customer, phone: r.phone, product: r.product, status: r.status,
      group, tracking: r.tracking, pieces: Number(r.qty) || 1,
      confirmPieces: r.pieces == null ? null : Number(r.pieces),
      bonusPerPiece: Number(r.bonus_per_piece) || 0,
      confirmAmount, bonusAmount, confirmedAt: r.confirmed_at, deliveredAt: r.delivered_at,
    };
  });
  for (const k of ['confirmEarned', 'bonusEarned', 'bonusPossible']) summary[k] = Math.round(summary[k] * 100) / 100;

  return {
    agent: { id: user.id, name: user.name, email: user.email },
    enabled: user.delivery_bonus_since != null,
    since: user.delivery_bonus_since,
    confirmRate: Number(user.comm_confirmed) || 0,
    perPiece: Number(user.comm_delivered) || 0,
    summary,
    rows: list,
  };
}

/* Test seam: a harness that built the schema on temp tables itself. */
function _markSchemaReadyForTests() { ready = Promise.resolve(); }

module.exports = { ensureSchema, setPlan, listFor, pieces, groupOf, fmt, DELIVERED, DDL, _markSchemaReadyForTests };
