'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   «إيقاف المنتج» — the owner drops a product (a test he won't stock).
   ────────────────────────────────────────────────────────────────────────────
   A TARGET is the product, from any of three handles (spec):
     { productId } an inventory product        → products.stopped_at
     { orderId }   "the product of this order" → its inventory product if it
                   has one, else the order's name / sku (stopped_products)
     { stoppedId } a stopped_products row      (a non-inventory product)
   stop    → mark stopped; every CONFIRMED order of it → «مغلق - لن يشحن»
             (commission + confirmation credit kept, reserved stock back), every
             OPEN one (جديد / لا يرد / مؤجل / …) → «مغلق - منتج متوقف» (out of
             the queues, counted nowhere). New orders of it are born closed by
             the DB trigger (services/productStopSchema.js) until it reopens.
   reopen  → unmark; optionally the orders the stop closed go back to the
             status they had.
   Every order moves through services/orderStatus.js applyUpdate — the one
   writer: compare-and-set, stock, commission rules. Live queue only (lost /
   historical CSV orders are a separate workflow and are left alone).
   ════════════════════════════════════════════════════════════════════════════ */

const pool        = require('../config/db');
const orderStatus = require('./orderStatus');
const schema      = require('./productStopSchema');
const {
  CLOSED_CONFIRMED, CLOSED_PRODUCT, CLOSED_STATUSES, STOP_CONFIRMED_FROM, STOP_OPEN_FROM,
} = require('./closedStatuses');

/* Tables + columns first, trigger last (see productStopSchema). Startup runs
   it (routes/products.js); the actions retry it but never depend on it. */
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of schema.STATEMENTS) await pool.query(sql);
      return true;
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
async function ensureSchemaSoft() {
  try { await ensureSchema(); } catch (e) { console.warn('[productStop] schema check failed (continuing):', e.message); }
}

const lc = (s) => String(s ?? '').trim().toLowerCase();
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/* ── Targets ──────────────────────────────────────────────────────────────── */
async function inventoryTarget(businessId, productId) {
  const { rows } = await pool.query(
    `SELECT id, name, sku, COALESCE(aliases, '{}'::text[]) AS aliases, stopped_at
       FROM products WHERE id = $1 AND business_id = $2`,
    [productId, businessId]);
  const p = rows[0];
  return p ? { kind: 'inventory', product: p, name: p.name, stoppedAt: p.stopped_at } : null;
}

const nameTargetFromRow = (r) => ({
  kind: 'name', stoppedId: r.id, name: r.name, keys: r.keys || [], stoppedAt: r.stopped_at,
});

async function resolveTarget(businessId, spec) {
  if (spec.productId) return inventoryTarget(businessId, spec.productId);
  if (spec.stoppedId) {
    const { rows } = await pool.query(
      `SELECT * FROM stopped_products WHERE id = $1 AND business_id = $2`, [spec.stoppedId, businessId]);
    return rows[0] ? nameTargetFromRow(rows[0]) : null;
  }
  if (spec.orderId) {
    const { rows } = await pool.query(
      `SELECT "ProductName" AS name, sku FROM orders WHERE id = $1 AND business_id = $2`,
      [spec.orderId, businessId]);
    const o = rows[0];
    if (!o) return null;
    const p = await orderStatus.resolveProductForOrder(businessId, o.sku, o.name);
    if (p) return inventoryTarget(businessId, p.id);
    const keys = uniq([lc(o.name), lc(o.sku)]);
    if (!keys.length) return null;
    const { rows: s } = await pool.query(
      `SELECT * FROM stopped_products WHERE business_id = $1 AND keys && $2::text[] ORDER BY id LIMIT 1`,
      [businessId, keys]);
    if (s[0]) return nameTargetFromRow(s[0]);
    return { kind: 'name', stoppedId: null, name: String(o.name || o.sku).trim(), keys, stoppedAt: null };
  }
  return null;
}

/* Live-queue orders in `statuses` that belong to the target. Inventory: same
   sku / name / alias rule, confirmed with resolveProductForOrder (an order that
   ranks onto ANOTHER product is not swept). Name: name / sku in its keys and
   matching NO inventory product (an inventory product is stopped through its
   own record, never by name). */
async function ordersOfTarget(businessId, target, statuses) {
  let rows;
  const cols = `o.id, btrim(o."Status") AS status, o.sku, o."ProductName" AS product_name,
                COALESCE(o."depositAmount", 0)::float AS deposit, o.closed_from_status, o.closed_reason`;
  if (target.kind === 'inventory') {
    const p = target.product;
    ({ rows } = await pool.query(
      `SELECT ${cols} FROM orders o
        WHERE o.business_id = $1 AND COALESCE(o.is_lost_order, FALSE) = FALSE
          AND btrim(o."Status") = ANY($2::text[])
          AND ( LOWER(TRIM(o.sku)) = LOWER(NULLIF(TRIM($3), ''))
             OR LOWER(TRIM(o."ProductName")) = LOWER(NULLIF(TRIM($4), ''))
             OR EXISTS (SELECT 1 FROM unnest($5::text[]) a
                         WHERE LOWER(TRIM(a)) = LOWER(TRIM(o.sku))
                            OR LOWER(TRIM(a)) = LOWER(TRIM(o."ProductName"))) )
        ORDER BY o.id`,
      [businessId, statuses, p.sku || '', p.name || '', p.aliases || []]));
  } else {
    ({ rows } = await pool.query(
      `SELECT ${cols} FROM orders o
        WHERE o.business_id = $1 AND COALESCE(o.is_lost_order, FALSE) = FALSE
          AND btrim(o."Status") = ANY($2::text[])
          AND ( LOWER(TRIM(o."ProductName")) = ANY($3::text[]) OR LOWER(TRIM(o.sku)) = ANY($3::text[]) )
        ORDER BY o.id`,
      [businessId, statuses, target.keys]));
  }

  const resolved = new Map();               // "sku|name" → inventory product id (or null)
  const mine = [];
  for (const r of rows) {
    const key = `${lc(r.sku)}|${lc(r.product_name)}`;
    if (!resolved.has(key)) {
      const p = await orderStatus.resolveProductForOrder(businessId, r.sku, r.product_name);
      resolved.set(key, p ? String(p.id) : null);
    }
    const pid = resolved.get(key);
    if (target.kind === 'inventory' ? pid === String(target.product.id) : pid === null) mine.push(r);
  }
  return mine;
}

const describe = (t) => ({
  kind: t.kind, name: t.name,
  productId: t.kind === 'inventory' ? t.product.id : null,
  stoppedId: t.kind === 'name' ? t.stoppedId : null,
});

/* ── Preview — what a stop (or reopen) would do, shown before confirming ── */
const COMMISSION_SOURCES = ['comm_confirmed', 'comm_no_answer', 'comm_rejected'];

async function preview(businessId, spec) {
  await ensureSchemaSoft();
  const t = await resolveTarget(businessId, spec);
  if (!t) return null;

  const live = await ordersOfTarget(businessId, t, [...STOP_CONFIRMED_FROM, ...STOP_OPEN_FROM]);
  const confirmed = live.filter((o) => STOP_CONFIRMED_FROM.includes(o.status));
  const open      = live.filter((o) => STOP_OPEN_FROM.includes(o.status));
  const openByStatus = {};
  for (const o of open) openByStatus[o.status] = (openByStatus[o.status] || 0) + 1;

  let commissionKept = 0;
  if (live.length) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS s FROM treasury_transactions
        WHERE business_id = $1 AND order_id = ANY($2::int[]) AND source = ANY($3::text[])`,
      [businessId, live.map((o) => o.id), COMMISSION_SOURCES]);
    commissionKept = rows[0].s;
  }
  const withDeposit = live.filter((o) => o.deposit > 0);
  const closedByStop = (await ordersOfTarget(businessId, t, CLOSED_STATUSES))
    .filter((o) => o.closed_reason === 'product').length;

  return {
    target: describe(t),
    stopped: !!t.stoppedAt,
    stopped_at: t.stoppedAt || null,
    confirmed: confirmed.length,
    open: open.length,
    openByStatus,
    commissionKept: Math.round(commissionKept * 100) / 100,
    deposits: {
      count: withDeposit.length,
      total: Math.round(withDeposit.reduce((s, o) => s + o.deposit, 0) * 100) / 100,
    },
    closedByStop,
  };
}

/* Move one order under compare-and-set; true when it moved. */
async function moveOrder(businessId, orderId, fromStatus, updates, actor) {
  const current = await orderStatus.loadOrder(businessId, orderId);
  if (!current) return false;
  const r = await orderStatus.applyUpdate({
    businessId, orderId, current, updates, expectedStatus: fromStatus,
    actor: { email: actor.email, id: actor.id, source: 'product_stop' },
  });
  if (!r.ok) return false;
  await r.settled;                          // commission rules finish before the next one
  return true;
}

/* ── Stop ─────────────────────────────────────────────────────────────────── */
async function stop({ businessId, spec, actor }) {
  await ensureSchemaSoft();
  const t = await resolveTarget(businessId, spec);
  if (!t) return { ok: false, status: 404, error: 'المنتج غير موجود' };

  /* Mark FIRST, so an order arriving during the sweep is closed by the trigger. */
  if (t.kind === 'inventory') {
    await pool.query(
      `UPDATE products SET stopped_at = COALESCE(stopped_at, NOW()), stopped_by = COALESCE(stopped_by, $3)
        WHERE id = $1 AND business_id = $2`,
      [t.product.id, businessId, actor.email || null]);
  } else {
    const { rows } = await pool.query(
      `INSERT INTO stopped_products (business_id, name, keys, stopped_by)
       VALUES ($1, $2, $3::text[], $4)
       ON CONFLICT (business_id, (LOWER(TRIM(name))))
       DO UPDATE SET keys = ARRAY(SELECT DISTINCT unnest(stopped_products.keys || EXCLUDED.keys))
       RETURNING *`,
      [businessId, t.name, t.keys, actor.email || null]);
    Object.assign(t, nameTargetFromRow(rows[0]));
  }

  const orders = await ordersOfTarget(businessId, t, [...STOP_CONFIRMED_FROM, ...STOP_OPEN_FROM]);
  const out = { ok: true, target: describe(t), closedConfirmed: 0, closedOpen: 0, skipped: 0 };
  for (const o of orders) {
    const to = STOP_CONFIRMED_FROM.includes(o.status) ? CLOSED_CONFIRMED : CLOSED_PRODUCT;
    const moved = await moveOrder(businessId, o.id, o.status, {
      Status: to, closed_from_status: o.status, closed_at: new Date(),
      closed_by: actor.email || null, closed_reason: 'product',
    }, actor);
    if (!moved) out.skipped++;
    else if (to === CLOSED_CONFIRMED) out.closedConfirmed++;
    else out.closedOpen++;
  }
  console.log(`⏸️  [productStop] "${t.name}" (${t.kind}) stopped by ${actor.email || '?'} — ` +
    `${out.closedConfirmed} confirmed → «${CLOSED_CONFIRMED}», ${out.closedOpen} open → «${CLOSED_PRODUCT}», ${out.skipped} skipped`);
  return out;
}

/* ── Reopen ───────────────────────────────────────────────────────────────── */
async function reopen({ businessId, spec, actor, restoreOrders = false }) {
  await ensureSchemaSoft();
  const t = await resolveTarget(businessId, spec);
  if (!t) return { ok: false, status: 404, error: 'المنتج غير موجود' };

  /* Unmark first (new orders flow again), then restore with the keys in hand. */
  if (t.kind === 'inventory') {
    await pool.query(
      `UPDATE products SET stopped_at = NULL, stopped_by = NULL WHERE id = $1 AND business_id = $2`,
      [t.product.id, businessId]);
  } else if (t.stoppedId) {
    await pool.query(`DELETE FROM stopped_products WHERE id = $1 AND business_id = $2`, [t.stoppedId, businessId]);
  }

  const out = { ok: true, target: describe(t), restored: 0, skipped: 0 };
  if (restoreOrders) {
    const orders = (await ordersOfTarget(businessId, t, CLOSED_STATUSES))
      .filter((o) => o.closed_reason === 'product');
    for (const o of orders) {
      const back = (o.closed_from_status || '').trim()
        || (o.status === CLOSED_CONFIRMED ? 'تم التأكيد' : 'جديد');
      const moved = await moveOrder(businessId, o.id, o.status, {
        Status: back, closed_from_status: null, closed_at: null, closed_by: null, closed_reason: null,
      }, actor);
      if (moved) out.restored++; else out.skipped++;
    }
  }
  console.log(`▶️  [productStop] "${t.name}" (${t.kind}) reopened by ${actor.email || '?'} — ${out.restored} order(s) restored`);
  return out;
}

/* ── Stopped list (the «مغلق» tab) ────────────────────────────────────────── */
async function listStopped(businessId) {
  await ensureSchemaSoft();
  const { rows } = await pool.query(
    `SELECT 'inventory' AS kind, id::text AS id, name, stopped_at FROM products
      WHERE business_id = $1 AND stopped_at IS NOT NULL
     UNION ALL
     SELECT 'name', id::text, name, stopped_at FROM stopped_products WHERE business_id = $1
     ORDER BY stopped_at DESC`,
    [businessId]);
  return rows;
}

module.exports = { ensureSchema, preview, stop, reopen, listStopped, resolveTarget, ordersOfTarget };
