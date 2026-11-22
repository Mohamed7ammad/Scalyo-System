/* ══════════════════════════════════════════════════════════════════════════
   «رأس المال» — what the business owns RIGHT NOW, as money + goods at COST,
   with no expected profit in it. Owner's definition (2026-11-22):

     محفظة بوسطة (زي ما هي)                 — delivered orders' cash Bosta still holds,
                                             already net of Bosta's fees
   + الخزينة (فلوس البنك)                   — treasury: all money in − all money out
   + بضاعة في المخزن        × التكلفة       — products.stock_quantity × cost_price
   + متأكدة لسه ما اتشحنتش  × التكلفة       — confirmed: off the stock count, still on the shelf
   + في الطريق مع بوسطة     × التكلفة       — shipped, not delivered
   + مرتجعات راجعة          × التكلفة       — «جاري الإعادة»
   = رأس المال الحالي

   "Off the stock count" is exact: orders.stock_deducted is set when an order is
   confirmed and cleared when it is restocked (cancel / reject / Bosta «تم الإرجاع»),
   so an order is in exactly one bucket and a returned order is restocked once.
   The product of an order = the inventory hook's own match (exact SKU → exact name
   → alias, services/orderStatus.js resolveProductForOrder).

   Owner review (2026-11-22/23):
   • confirmed orders with no goods behind them — confirming does not check the
     shelf, so a product can go below zero. The shelf line is Σ stock × cost
     exactly like the inventory page, negatives included: the negative line of
     such a product cancels its confirmed units that have no goods (the oldest
     confirmations are the covered ones), so they add nothing — and the page
     names those orders.
   • shipments / returns whose status has not moved for OLD_DAYS are NOT counted
     and shown apart — not really on the road: mostly delivered (their cash is
     already in the wallet / treasury, counting the goods too would count them
     twice) or returned unrecorded.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const pool = require('../config/db');

const STALE_DAYS = 10;      // on the road longer than this → «متأخرة» (still counted)
const OLD_DAYS   = 30;      // status unchanged longer than this → not counted, shown apart
const BUCKETS = {
  'تم التأكيد':   'confirmed',
  'تم الشحن':     'in_transit',
  'جاري الإعادة': 'returning',
};

const DDL = `
  CREATE TABLE IF NOT EXISTS capital_snapshots (
    business_id INTEGER       NOT NULL,
    day         DATE          NOT NULL,
    capital     NUMERIC(14,2) NOT NULL,
    money       NUMERIC(14,2) NOT NULL,
    goods       NUMERIC(14,2) NOT NULL,
    parts       JSONB         NOT NULL,
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (business_id, day)
  )`;
let schemaP = null;
function ensureSchema() {
  if (!schemaP) schemaP = pool.query(DDL).then(() => true).catch((err) => { schemaP = null; throw err; });
  return schemaP;
}
function _markSchemaReadyForTests() { schemaP = Promise.resolve(true); }

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2  = (v) => parseFloat(num(v).toFixed(2));
const unitsOf = (r) => Math.max(1, Math.trunc(num(r.quantity) || 1));
const timeOf = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : 0; };

/* ── pure: the shelf ──────────────────────────────────────────────────────────
   Σ stock × cost — the SAME total as the inventory page («إجمالي التكلفة»),
   negative stock included: a product below zero had more confirmed than it held,
   and its negative line cancels exactly those confirmed units (which the
   «متأكدة» line counts), so nothing is counted that isn't there. A negative
   larger than the product's confirmed units (units shipped beyond recorded
   stock — unrecorded purchases) is capped at −confirmed and flagged instead of
   pulling capital below what physically exists.
   confirmedUnits: Map(product id → confirmed units off the stock count). */
function summarizeWarehouse(products = [], confirmedUnits = new Map()) {
  const items = [];
  const missingCost = [];
  const negative = [];
  for (const p of products) {
    const qty = Math.trunc(num(p.stock_quantity));
    const unit = num(p.cost_price);
    if (qty === 0) continue;
    if (qty < 0) {
      const C = Math.trunc(num(confirmedUnits.get(String(p.id))));
      const cancels = Math.min(-qty, C);                       // confirmed units with no goods
      negative.push({ product_id: String(p.id), name: p.name, units: qty, cancels_confirmed: cancels, gap: -qty - cancels });
      if (cancels > 0) items.push({ product_id: String(p.id), name: p.name, units: -cancels, unit_cost: r2(unit), cost: r2(-cancels * unit), negative: true });
      continue;
    }
    if (unit <= 0) missingCost.push({ product_id: String(p.id), name: p.name, units: qty });
    items.push({ product_id: String(p.id), name: p.name, units: qty, unit_cost: r2(unit), cost: r2(qty * unit) });
  }
  items.sort((a, b) => b.cost - a.cost || b.units - a.units);
  return {
    products: items.filter((x) => !x.negative).length,
    units:    items.reduce((s, x) => s + x.units, 0),
    cost:     r2(items.reduce((s, x) => s + x.cost, 0)),
    items,
    missing_cost: missingCost,
    negative,
  };
}

/* ── pure: units off the stock count but not sold yet ─────────────────────── */
function newBucket(extra = {}) { return { orders: 0, units: 0, cost: 0, stale: { orders: 0, cost: 0 }, byProduct: new Map(), orderIds: [], ...extra }; }

function addTo(b, r, units, unit, { stale = false } = {}) {
  const cost = units * unit;
  b.orders += 1;
  b.units += units;
  b.cost += cost;
  if (stale) { b.stale.orders += 1; b.stale.cost += cost; }
  b.orderIds.push(Number(r.id));
  const pk = r.product_id ? `p:${r.product_id}` : `n:${String(r.order_product || '').trim()}`;
  let it = b.byProduct.get(pk);
  if (!it) {
    it = { product_id: r.product_id ? String(r.product_id) : null, name: r.product_name || String(r.order_product || '').trim() || '—', orders: 0, units: 0, cost: 0 };
    b.byProduct.set(pk, it);
  }
  it.orders += 1;
  it.units += units;
  it.cost += cost;
}

function finish(b) {
  const items = [...b.byProduct.values()]
    .map((it) => ({ ...it, unit_cost: it.units ? r2(it.cost / it.units) : 0, cost: r2(it.cost) }))
    .sort((a, c) => c.cost - a.cost || c.units - a.units);
  const out = { orders: b.orders, units: b.units, cost: r2(b.cost), items, stale: { orders: b.stale.orders, cost: r2(b.stale.cost) } };
  if (b.status !== undefined) out.status = b.status;
  if (b.oldest !== undefined) out.oldest = b.oldest;
  if (b.withIds) out.order_ids = b.orderIds;
  return out;
}

function summarizeGoodsOut(rows = [], now = new Date()) {
  const staleBefore = now.getTime() - STALE_DAYS * 86400000;
  const oldBefore   = now.getTime() - OLD_DAYS * 86400000;
  const unitCost = (r) => (num(r.unit_cost_price) > 0 ? num(r.unit_cost_price) : num(r.product_cost));

  /* Which confirmed units have goods behind them: per product, units on the shelf
     = recorded stock + its confirmed units; the oldest confirmations take them. */
  const confirmedByProduct = new Map();
  for (const r of rows) {
    if (BUCKETS[String(r.status ?? '').trim()] !== 'confirmed' || !r.product_id) continue;
    const g = confirmedByProduct.get(String(r.product_id)) || { stock: Math.trunc(num(r.product_stock)), rows: [] };
    g.rows.push(r);
    confirmedByProduct.set(String(r.product_id), g);
  }
  const unbackedUnits = new Map();          // order id → units with no goods behind them
  const stockGaps = [];                     // still below zero after counting confirmed units
  for (const [, g] of confirmedByProduct) {
    const C = g.rows.reduce((s, r) => s + unitsOf(r), 0);
    const onShelf = g.stock + C;
    let covered = Math.min(C, Math.max(0, onShelf));
    g.rows.sort((a, b) => timeOf(a.since) - timeOf(b.since) || Number(a.id) - Number(b.id));
    for (const r of g.rows) {
      const u = unitsOf(r);
      const take = Math.min(u, covered);
      covered -= take;
      if (u - take > 0) unbackedUnits.set(Number(r.id), u - take);
    }
    if (onShelf < 0) stockGaps.push({ product_id: String(g.rows[0].product_id), name: g.rows[0].product_name, units_below_zero: -onShelf });
  }

  const confirmed  = newBucket();
  const unbacked   = newBucket({ withIds: true });
  const inTransit  = newBucket();
  const returning  = newBucket();
  const old        = { in_transit: newBucket({ withIds: true }), returning: newBucket({ withIds: true }) };
  const other      = new Map();
  const missingCost = [];

  for (const r of rows) {
    const status = String(r.status ?? '').trim();
    const key = BUCKETS[status];
    const units = unitsOf(r);
    const unit = unitCost(r);
    const since = timeOf(r.since);

    if (key === 'confirmed') {
      /* every confirmed unit is counted here; the ones with no goods behind them are
         cancelled by their product's negative line on the shelf (summarizeWarehouse)
         and reported apart so the owner sees which orders they are */
      addTo(confirmed, r, units, unit);
      const nb = unbackedUnits.get(Number(r.id)) || 0;
      if (nb > 0) addTo(unbacked, r, nb, unit);
      if (unit <= 0) missingCost.push({ order_id: Number(r.id), product: r.product_name || r.order_product || null, status });
      continue;
    }
    if (key === 'in_transit' || key === 'returning') {
      if (since && since < oldBefore) {
        const ob = old[key];
        addTo(ob, r, units, unit);
        const day = new Date(since).toISOString().slice(0, 10);
        if (ob.oldest === undefined || day < ob.oldest) ob.oldest = day;
        continue;                                        // not counted, shown apart
      }
      addTo(key === 'in_transit' ? inTransit : returning, r, units, unit, { stale: Boolean(since) && since < staleBefore });
      if (unit <= 0) missingCost.push({ order_id: Number(r.id), product: r.product_name || r.order_product || null, status });
      continue;
    }
    let b = other.get(status);
    if (!b) { b = newBucket({ status }); other.set(status, b); }
    addTo(b, r, units, unit);
    if (unit <= 0) missingCost.push({ order_id: Number(r.id), product: r.product_name || r.order_product || null, status });
  }

  return {
    confirmed:          finish(confirmed),
    confirmed_unbacked: finish(unbacked),
    in_transit:         finish(inTransit),
    returning:          finish(returning),
    old:                { in_transit: finish(old.in_transit), returning: finish(old.returning) },
    other:              [...other.values()].map(finish).filter((b) => b.orders > 0),
    missing_cost:       missingCost,
    stock_gaps:         stockGaps,
  };
}

/* confirmed units off the stock count, per product (feeds the shelf's negative lines) */
function confirmedUnitsByProduct(rows = []) {
  const m = new Map();
  for (const r of rows) {
    if (BUCKETS[String(r.status ?? '').trim()] !== 'confirmed' || !r.product_id) continue;
    m.set(String(r.product_id), (m.get(String(r.product_id)) || 0) + unitsOf(r));
  }
  return m;
}

/* ── pure: the total (only what is counted) ───────────────────────────────── */
function total({ wallet, treasury, warehouse, out }) {
  const walletAmount = wallet && wallet.ok ? num(wallet.balance) : 0;
  const money = r2(walletAmount + num(treasury.balance));
  const goods = r2(num(warehouse.cost) + num(out.confirmed.cost) + num(out.in_transit.cost) + num(out.returning.cost)
    + out.other.reduce((s, b) => s + num(b.cost), 0));
  return { money, goods, capital: r2(money + goods), complete: Boolean(wallet && wallet.ok) };
}

/* ── queries ──────────────────────────────────────────────────────────────── */
async function loadTreasury(businessId) {
  const { rows: [t] } = await pool.query(`
    SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'revenue'), 0)
         - COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS balance,
           MAX(created_at) AS last_entry_at,
           COUNT(*)::int   AS entries
      FROM treasury_transactions WHERE business_id = $1`, [businessId]);
  return { balance: r2(t.balance), last_entry_at: t.last_entry_at, entries: t.entries };
}

async function loadProducts(businessId) {
  const { rows } = await pool.query(`
    SELECT id, name, stock_quantity, cost_price FROM products
     WHERE business_id = $1 AND COALESCE(stock_quantity, 0) <> 0`, [businessId]);
  return rows;
}

/* Every order whose units are off the stock count but not sold (not delivered),
   matched to its product exactly like the inventory hook does. */
async function loadGoodsRows(businessId) {
  const { rows } = await pool.query(`
    SELECT o.id, btrim(o."Status") AS status, o.quantity, o.unit_cost_price,
           o."ProductName" AS order_product,
           COALESCE(o.shipped_at, o.status_changed_at, o."updatedAt") AS since,
           p.id AS product_id, p.name AS product_name, p.cost_price AS product_cost, p.stock_quantity AS product_stock
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT px.id, px.name, px.cost_price, px.stock_quantity FROM products px
         WHERE px.business_id = o.business_id
           AND ( LOWER(TRIM(px.sku))  = LOWER(NULLIF(TRIM(COALESCE(o.sku, '')), ''))
              OR LOWER(TRIM(px.name)) = LOWER(NULLIF(TRIM(COALESCE(o."ProductName", '')), ''))
              OR EXISTS (SELECT 1 FROM unnest(COALESCE(px.aliases, '{}'::text[])) a
                          WHERE LOWER(TRIM(a)) = LOWER(NULLIF(TRIM(COALESCE(o.sku, '')), ''))
                             OR LOWER(TRIM(a)) = LOWER(NULLIF(TRIM(COALESCE(o."ProductName", '')), ''))) )
         ORDER BY CASE WHEN LOWER(TRIM(px.sku))  = LOWER(NULLIF(TRIM(COALESCE(o.sku, '')), '')) THEN 1
                       WHEN LOWER(TRIM(px.name)) = LOWER(NULLIF(TRIM(COALESCE(o."ProductName", '')), '')) THEN 2
                       ELSE 3 END
         LIMIT 1) p ON TRUE
     WHERE o.business_id = $1
       AND o.stock_deducted = true
       AND btrim(o."Status") <> 'تم التوصيل'`, [businessId]);
  return rows;
}

/* Average Bosta fee charged on recent returns — only for the note under «مرتجعات»
   (Bosta deducts it from the wallet when the parcel arrives back). */
async function loadReturnFee(businessId) {
  const { rows: [f] } = await pool.query(`
    SELECT AVG(actual_shipping_fee)::float AS avg_fee, COUNT(*)::int AS n FROM orders
     WHERE business_id = $1 AND btrim("Status") = 'تم الإرجاع' AND actual_shipping_fee > 0
       AND "updatedAt" > NOW() - INTERVAL '30 days'`, [businessId]);
  return f.n >= 5 ? r2(f.avg_fee) : null;
}

const cairoDay = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/* One row per day (the last view of the day wins) — only when the wallet answered,
   so a day is never recorded with a missing piece. */
async function saveSnapshot(businessId, t, parts) {
  if (!t.complete) return;
  await ensureSchema();
  await pool.query(`
    INSERT INTO capital_snapshots (business_id, day, capital, money, goods, parts, updated_at)
    VALUES ($1, $2::date, $3, $4, $5, $6::jsonb, NOW())
    ON CONFLICT (business_id, day) DO UPDATE
      SET capital = EXCLUDED.capital, money = EXCLUDED.money, goods = EXCLUDED.goods,
          parts = EXCLUDED.parts, updated_at = NOW()`,
  [businessId, cairoDay(), t.capital, t.money, t.goods, JSON.stringify(parts)]);
}

async function loadHistory(businessId, days = 60) {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, capital::float, money::float, goods::float
      FROM capital_snapshots WHERE business_id = $1 ORDER BY day DESC LIMIT $2`, [businessId, days]);
  return rows.reverse();
}

/* fetchWallet() → { ok, balance, error } — injected by the route (the same Bosta
   wallet read the treasury page uses), so tests and previews never touch Bosta. */
async function computeCapital({ businessId, fetchWallet }) {
  const [wallet, treasury, productRows, goodsRows, returnFee] = await Promise.all([
    Promise.resolve().then(fetchWallet).catch((err) => ({ ok: false, balance: null, error: err.message })),
    loadTreasury(businessId),
    loadProducts(businessId),
    loadGoodsRows(businessId),
    loadReturnFee(businessId).catch(() => null),
  ]);
  const out = summarizeGoodsOut(goodsRows);
  const warehouse = summarizeWarehouse(productRows, confirmedUnitsByProduct(goodsRows));
  const t = total({ wallet, treasury, warehouse, out });
  const parts = {
    wallet:     wallet.ok ? r2(wallet.balance) : null,
    treasury:   treasury.balance,
    warehouse:  warehouse.cost,
    confirmed:  out.confirmed.cost,
    in_transit: out.in_transit.cost,
    returning:  out.returning.cost,
    other:      r2(out.other.reduce((s, b) => s + b.cost, 0)),
    not_counted: {
      old_shipments: r2(out.old.in_transit.cost + out.old.returning.cost),
    },
  };
  await saveSnapshot(businessId, t, parts).catch((err) => console.warn('[capital] snapshot not saved:', err.message));
  const history = await loadHistory(businessId).catch(() => []);
  return {
    generated_at:       new Date().toISOString(),
    stale_days:         STALE_DAYS,
    old_days:           OLD_DAYS,
    total:              t,
    parts,
    wallet:             { ok: Boolean(wallet.ok), balance: wallet.ok ? r2(wallet.balance) : null, error: wallet.ok ? null : (wallet.error || 'تعذّر جلب رصيد المحفظة') },
    treasury,
    warehouse,
    confirmed:          out.confirmed,
    confirmed_unbacked: out.confirmed_unbacked,
    in_transit:         out.in_transit,
    returning:          { ...out.returning, avg_return_fee: returnFee, expected_return_fees: returnFee ? r2(returnFee * out.returning.orders) : null },
    old_shipments:      out.old,
    other:              out.other,
    stock_gaps:         out.stock_gaps,
    missing_cost:       { orders: out.missing_cost, products: warehouse.missing_cost },
    history,
  };
}

module.exports = {
  STALE_DAYS, OLD_DAYS, DDL, ensureSchema, _markSchemaReadyForTests,
  summarizeWarehouse, summarizeGoodsOut, confirmedUnitsByProduct, total, cairoDay, computeCapital,
};
