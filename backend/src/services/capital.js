/* ══════════════════════════════════════════════════════════════════════════
   «رأس المال» — what the business owns RIGHT NOW, as money + goods at COST,
   with no expected profit in it. Owner's definition (2026-11-22):

     محفظة بوسطة (زي ما هي)                 — delivered orders' cash Bosta still holds,
                                             already net of Bosta's fees
   + الخزينة (فلوس البنك)                   — treasury: all money in − all money out
   + بضاعة في المخزن        × التكلفة       — products.stock_quantity × cost_price
   + متأكدة لسه ما اتشحنتش  × التكلفة       — confirmed: already taken out of stock
   + في الطريق مع بوسطة     × التكلفة       — shipped, not delivered
   + مرتجعات راجعة          × التكلفة       — «جاري الإعادة»
   = رأس المال الحالي

   "Taken out of stock" is exact: orders.stock_deducted is set when an order is
   confirmed and cleared when it is restocked (cancel / reject / Bosta «تم الإرجاع»),
   so an order's units are either on the shelf count or in exactly one bucket here.
   Cost of an order's unit = its own snapshot (unit_cost_price, the average cost at
   confirmation), else the product's current cost price.
   No salaries / supplier debts (owner: none on credit, salaries he tracks himself).
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const pool = require('../config/db');

const STALE_DAYS = 10;      // a shipment older than this is shown as «متأخرة»
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

/* ── pure: the shelf ──────────────────────────────────────────────────────── */
function summarizeWarehouse(products = []) {
  const items = [];
  const missingCost = [];
  const negative = [];
  for (const p of products) {
    const qty = Math.trunc(num(p.stock_quantity));
    const unit = num(p.cost_price);
    if (qty < 0) { negative.push({ product_id: String(p.id), name: p.name, units: qty }); continue; }
    if (qty === 0) continue;
    if (unit <= 0) missingCost.push({ product_id: String(p.id), name: p.name, units: qty });
    items.push({ product_id: String(p.id), name: p.name, units: qty, unit_cost: r2(unit), cost: r2(qty * unit) });
  }
  items.sort((a, b) => b.cost - a.cost || b.units - a.units);
  return {
    products: items.length,
    units:    items.reduce((s, x) => s + x.units, 0),
    cost:     r2(items.reduce((s, x) => s + x.cost, 0)),
    items,
    missing_cost: missingCost,
    negative,
  };
}

/* ── pure: units taken out of stock but not sold yet ──────────────────────── */
function emptyBucket() { return { orders: 0, units: 0, cost: 0, stale: { orders: 0, cost: 0 }, items: [], _byProduct: new Map() }; }

function summarizeGoodsOut(rows = [], now = new Date()) {
  const buckets = { confirmed: emptyBucket(), in_transit: emptyBucket(), returning: emptyBucket() };
  const other = new Map();          // any other status still holding stock
  const missingCost = [];
  const staleBefore = now.getTime() - STALE_DAYS * 86400000;

  for (const r of rows) {
    const status = String(r.status ?? '').trim();
    const key = BUCKETS[status];
    let b = key ? buckets[key] : other.get(status);
    if (!b) { b = emptyBucket(); b.status = status; other.set(status, b); }
    const units = Math.max(1, Math.trunc(num(r.quantity) || 1));
    const unit = num(r.unit_cost_price) > 0 ? num(r.unit_cost_price) : num(r.product_cost);
    const cost = units * unit;
    if (unit <= 0) missingCost.push({ order_id: Number(r.id), product: r.product_name || r.order_product || null, status });
    b.orders += 1;
    b.units += units;
    b.cost += cost;
    const since = r.since ? new Date(r.since).getTime() : null;
    if (key && key !== 'confirmed' && since !== null && since < staleBefore) {
      b.stale.orders += 1;
      b.stale.cost += cost;
    }
    const pk = r.product_id ? `p:${r.product_id}` : `n:${String(r.order_product || '').trim()}`;
    let it = b._byProduct.get(pk);
    if (!it) {
      it = { product_id: r.product_id ? String(r.product_id) : null, name: r.product_name || String(r.order_product || '').trim() || '—', orders: 0, units: 0, cost: 0 };
      b._byProduct.set(pk, it);
    }
    it.orders += 1;
    it.units += units;
    it.cost += cost;
  }

  const finish = (b) => {
    const items = [...b._byProduct.values()]
      .map((it) => ({ ...it, unit_cost: it.units ? r2(it.cost / it.units) : 0, cost: r2(it.cost) }))
      .sort((a, c) => c.cost - a.cost || c.units - a.units);
    const out = { orders: b.orders, units: b.units, cost: r2(b.cost), items };
    if (b.status !== undefined) out.status = b.status;
    out.stale = { orders: b.stale.orders, cost: r2(b.stale.cost) };
    return out;
  };
  return {
    confirmed:  finish(buckets.confirmed),
    in_transit: finish(buckets.in_transit),
    returning:  finish(buckets.returning),
    other:      [...other.values()].map(finish).filter((b) => b.orders > 0),
    missing_cost: missingCost,
  };
}

/* ── pure: the total ──────────────────────────────────────────────────────── */
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

async function loadWarehouse(businessId) {
  const { rows } = await pool.query(`
    SELECT id, name, stock_quantity, cost_price FROM products
     WHERE business_id = $1 AND COALESCE(stock_quantity, 0) <> 0`, [businessId]);
  return summarizeWarehouse(rows);
}

/* Every order whose units are off the shelf count but not sold (not delivered),
   with its cost snapshot and its product (SKU first, name only when the SKU
   matches no product — the same match the profitability report uses). */
async function loadGoodsOut(businessId) {
  const { rows } = await pool.query(`
    SELECT o.id, btrim(o."Status") AS status, o.quantity, o.unit_cost_price,
           o."ProductName" AS order_product,
           COALESCE(o.shipped_at, o.status_changed_at, o."updatedAt") AS since,
           p.id AS product_id, p.name AS product_name, p.cost_price AS product_cost
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT px.id, px.name, px.cost_price FROM products px
         WHERE px.business_id = o.business_id
           AND ( ( COALESCE(o.sku, '') <> '' AND UPPER(o.sku) = UPPER(px.sku) )
              OR ( UPPER(TRIM(COALESCE(o."ProductName", ''))) = UPPER(TRIM(px.name))
                   AND NOT EXISTS (SELECT 1 FROM products py
                                    WHERE py.business_id = o.business_id AND COALESCE(o.sku, '') <> ''
                                      AND UPPER(py.sku) = UPPER(o.sku)) ) )
         ORDER BY ( COALESCE(o.sku, '') <> '' AND UPPER(o.sku) = UPPER(px.sku) ) DESC
         LIMIT 1) p ON TRUE
     WHERE o.business_id = $1
       AND o.stock_deducted = true
       AND btrim(o."Status") <> 'تم التوصيل'`, [businessId]);
  return summarizeGoodsOut(rows);
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
  const [wallet, treasury, warehouse, out, returnFee] = await Promise.all([
    Promise.resolve().then(fetchWallet).catch((err) => ({ ok: false, balance: null, error: err.message })),
    loadTreasury(businessId),
    loadWarehouse(businessId),
    loadGoodsOut(businessId),
    loadReturnFee(businessId).catch(() => null),
  ]);
  const t = total({ wallet, treasury, warehouse, out });
  const parts = {
    wallet:     wallet.ok ? r2(wallet.balance) : null,
    treasury:   treasury.balance,
    warehouse:  warehouse.cost,
    confirmed:  out.confirmed.cost,
    in_transit: out.in_transit.cost,
    returning:  out.returning.cost,
    other:      r2(out.other.reduce((s, b) => s + b.cost, 0)),
  };
  await saveSnapshot(businessId, t, parts).catch((err) => console.warn('[capital] snapshot not saved:', err.message));
  const history = await loadHistory(businessId).catch(() => []);
  return {
    generated_at: new Date().toISOString(),
    stale_days:   STALE_DAYS,
    total:        t,
    parts,
    wallet:       { ok: Boolean(wallet.ok), balance: wallet.ok ? r2(wallet.balance) : null, error: wallet.ok ? null : (wallet.error || 'تعذّر جلب رصيد المحفظة') },
    treasury,
    warehouse,
    confirmed:    out.confirmed,
    in_transit:   out.in_transit,
    returning:    { ...out.returning, avg_return_fee: returnFee, expected_return_fees: returnFee ? r2(returnFee * out.returning.orders) : null },
    other:        out.other,
    missing_cost: { orders: out.missing_cost, products: warehouse.missing_cost },
    history,
  };
}

module.exports = {
  STALE_DAYS, DDL, ensureSchema, _markSchemaReadyForTests,
  summarizeWarehouse, summarizeGoodsOut, total, cairoDay, computeCapital,
};
