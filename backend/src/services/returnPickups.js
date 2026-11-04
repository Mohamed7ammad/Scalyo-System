'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Post-delivery returns — the PHYSICAL side (P&L Phase 2, 2026-11-05)
   ════════════════════════════════════════════════════════════════════════════
   An item a customer sends back AFTER delivery returns on its own Bosta
   delivery with a NEW tracking number. Bosta calls it a «Customer Return
   Pickup» (CRP, type 25) or an «Exchange» (type 30), and the team creates it in
   Bosta's dashboard. The webhook found no order for that tracking number and
   dropped the event, so nothing was ever restocked (Oct 2026: 32 pickups + 11
   exchanges). This service is the ONE writer for them:

     1. Every pickup / exchange webhook event is recorded in return_pickups (one
        row per tracking number).
     2. On «Returned to business» (state 46), the Bosta delivery doc is fetched
        ONCE. It uses the api_key — the same call the per-AWB shipping-fee
        capture makes, never the dashboard login. The doc gives the customer
        phone, item descriptions + counts, the fee and any COD collected.
     3. The row is linked to the customer's DELIVERED order. This happens
        automatically when the phone + item description point to exactly one
        order; otherwise the row waits in the review list
        (/dashboard/inventory/returns) for a person to pick the order.
     4. Once linked, stock moves EXACTLY once (the restocked_at claim):
          • pickup   → + the returned units of the order's product;
          • exchange → + the returned units, − the replacement sent out
                       (same product → no net change).
        Undo (unlink) reverses that same movement.

   It never changes the delivered order's status. The order stays «تم التوصيل»
   so its revenue is not reversed twice; money back to the customer is
   services/orderRefunds.js. It never writes product_returns either — that
   table means "the order's OWN parcel came back" (RTO, applyPhysicalReturn).

   Profit (analytics): on the original order's placement day + product,
     + returned units × the order's own cost snapshot (unit_cost)
     − replacement units × their cost (exchanges)
     − the Bosta fee net of any COD collected on the pickup / exchange.
   ════════════════════════════════════════════════════════════════════════════ */

const axios = require('axios');
const pool  = require('../config/db');
const { resolveProductForOrder } = require('./orderStatus');
const { readApiKey, INT_BASE } = require('./bostaShippingFee');
const { RECEIVED_STATE, kindOf, norm, parseDoc, matchProductText } = require('./returnPickupsMatch');

/* DDL lives in services/returnsSchema.js (pure — the reversible test uses it). */
const { PICKUPS_SCHEMA: SCHEMA } = require('./returnsSchema');

const schemaReady = SCHEMA.reduce((p, sql) => p.then(() => pool.query(sql)), Promise.resolve())
  .then(() => console.log('✅  Return pickups: return_pickups table ready'))
  .catch((e) => console.error('❌  Return pickups: schema failed:', e.message));

const DELIVERED = 'تم التوصيل';
const MAX_AGE_DAYS = 180;                  // a pickup belongs to an order placed within this window

class PickupError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ── Details fetcher (swappable in tests — never call Bosta from a dev box) ── */
async function fetchBostaDoc(businessId, trackingNumber) {
  const key = await readApiKey(businessId);
  if (!key) throw new Error('no Bosta api_key');
  const r = await axios.get(`${INT_BASE}/deliveries/business/${encodeURIComponent(trackingNumber)}`, {
    headers: { Authorization: key, Accept: 'application/json' }, timeout: 20000,
  });
  return r.data && (r.data.data || r.data);
}
let detailsFetcher = fetchBostaDoc;
function _setFetcherForTests(fn) { detailsFetcher = fn || fetchBostaDoc; }

/* ── Product matching (text → product: services/returnPickupsMatch.js) ────── */
async function loadProducts(db, businessId) {
  const { rows } = await db.query(
    `SELECT id, name, sku, cost_price::float AS cost_price, COALESCE(aliases, '{}'::text[]) AS aliases
       FROM products WHERE business_id = $1`, [businessId]);
  return rows;
}

/* ── Auto-link: the customer's delivered order this pickup belongs to ─────────
   Candidates: DELIVERED orders on the Bosta receiver's phone, placed before the
   pickup was created (within MAX_AGE_DAYS), not already fully returned.
     • description names a product → the newest candidate of THAT product;
     • no usable description → only when there is exactly one candidate.
   Anything else waits for a person.                                          */
async function findCandidates(db, businessId, row) {
  if (!row.customer_phone) return [];
  const before = row.bosta_created_at || row.received_at || new Date();
  const { rows } = await db.query(
    `SELECT o.id, o.sku, o."ProductName" AS product, COALESCE(o.quantity, 1) AS quantity,
            TO_CHAR((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS placed_on,
            o."FullName" AS customer,
            COALESCE((SELECT SUM(rp.return_qty) FROM return_pickups rp
                       WHERE rp.order_id = o.id AND rp.restocked_at IS NOT NULL AND rp.kind = 'pickup'), 0)::int AS already_back
       FROM orders o
      WHERE o.business_id = $1::integer
        AND btrim(o."Status") = '${DELIVERED}'
        AND right(regexp_replace(COALESCE(o."Phone", ''), '\\D', '', 'g'), 10) = $2
        AND (o."createdAt" AT TIME ZONE 'UTC') <= $3::timestamptz
        AND (o."createdAt" AT TIME ZONE 'UTC') >= $3::timestamptz - INTERVAL '${MAX_AGE_DAYS} days'
      ORDER BY o."createdAt" DESC
      LIMIT 10`,
    [businessId, row.customer_phone, before]);
  return rows.filter((o) => o.already_back < o.quantity);
}

async function chooseOrder(db, businessId, row) {
  const candidates = await findCandidates(db, businessId, row);
  if (!candidates.length) return { order: null, reason: 'مفيش طلب متسلّم على رقم العميل ده' };
  const products = await loadProducts(db, businessId);
  const wanted = matchProductText(products, row.return_desc);
  if (wanted) {
    for (const c of candidates) {
      const p = await resolveProductForOrder(businessId, c.sku, c.product);
      if (p && p.id === wanted.id) return { order: c, reason: null };
    }
    return { order: null, reason: `مفيش طلب متسلّم لـ «${wanted.name}» على رقم العميل ده` };
  }
  if (candidates.length === 1) return { order: candidates[0], reason: null };
  return { order: null, reason: `${candidates.length} طلبات متسلّمة على نفس الرقم — اختار الطلب` };
}

/* ── Apply the stock movement — exactly once ──────────────────────────────── */
async function applyReceipt(businessId, pickupId) {
  const { rows: [row] } = await pool.query(
    `SELECT * FROM return_pickups WHERE id = $1 AND business_id = $2::integer`, [pickupId, businessId]);
  if (!row) throw new PickupError(404, 'المرتجع غير موجود');
  if (row.restocked_at) return { applied: false, already: true };
  if (row.ignored_at || !row.order_id || !row.received_at) return { applied: false };

  const { rows: [order] } = await pool.query(
    `SELECT id, sku, "ProductName" AS product, COALESCE(quantity, 1) AS quantity,
            unit_cost_price::float AS unit_cost_price, COALESCE(stock_deducted, false) AS stock_deducted
       FROM orders WHERE id = $1 AND business_id = $2::integer`, [row.order_id, businessId]);
  if (!order) return { applied: false, reason: 'الطلب المربوط غير موجود' };
  const back = await resolveProductForOrder(businessId, order.sku, order.product);
  if (!back) {
    await pool.query(`UPDATE return_pickups SET note = $1, updated_at = NOW() WHERE id = $2`,
      ['منتج الطلب مش متعرّف في المخزون — ضيف alias للمنتج', row.id]);
    return { applied: false, reason: 'منتج الطلب مش متعرّف في المخزون' };
  }

  let fwd = null;
  if (row.kind === 'exchange') {
    if (!row.forward_product_id && !row.details_fetched_at) {
      await pool.query(`UPDATE return_pickups SET note = $1, updated_at = NOW() WHERE id = $2`,
        ['محتاج بيانات الاستبدال من بوسطة — اضغط «تحديث» أو اختار منتج الاستبدال', row.id]);
      return { applied: false, reason: 'بيانات الاستبدال ناقصة' };
    }
    if (row.forward_product_id) {
      const { rows: [p] } = await pool.query(
        `SELECT id, name, cost_price::float AS cost_price FROM products WHERE id = $1 AND business_id = $2`,
        [row.forward_product_id, businessId]);
      fwd = p || null;
    } else if (!row.forward_desc || norm(row.forward_desc) === norm(row.return_desc)) {
      fwd = back;                                    // same item swapped
    } else {
      fwd = matchProductText(await loadProducts(pool, businessId), row.forward_desc);
    }
    if (!fwd) {
      await pool.query(`UPDATE return_pickups SET note = $1, updated_at = NOW() WHERE id = $2`,
        [`منتج الاستبدال «${row.forward_desc}» مش متعرّف — اختاره`, row.id]);
      return { applied: false, reason: 'منتج الاستبدال مش متعرّف' };
    }
  }

  const qtyBack = Math.min(Math.max(1, row.return_qty || 1), order.quantity || 1);
  const qtyOut  = row.kind === 'exchange' ? Math.max(1, row.forward_qty || 1) : 0;
  const unitCost = (order.unit_cost_price && order.unit_cost_price > 0) ? order.unit_cost_price : (Number(back.cost_price) || 0);
  const clearFlag = row.kind === 'pickup' && qtyBack >= order.quantity && order.stock_deducted;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `UPDATE return_pickups
          SET restocked_at = NOW(), return_product_id = $2, forward_product_id = $3,
              unit_cost = $4, forward_unit_cost = $5, return_qty = $6, forward_qty = $7,
              cleared_order_flag = $8, note = NULL, updated_at = NOW()
        WHERE id = $1 AND restocked_at IS NULL AND ignored_at IS NULL AND order_id IS NOT NULL
        RETURNING id`,
      [row.id, back.id, fwd ? fwd.id : null, unitCost, fwd ? (Number(fwd.cost_price) || 0) : null, qtyBack, qtyOut, clearFlag]);
    if (!claim.rowCount) { await client.query('ROLLBACK'); return { applied: false, already: true }; }

    const moves = new Map();                          // product id → net units
    moves.set(back.id, (moves.get(back.id) || 0) + qtyBack);
    if (fwd) moves.set(fwd.id, (moves.get(fwd.id) || 0) - qtyOut);
    for (const [pid, delta] of moves) {
      if (delta !== 0) {
        await client.query(
          `UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2 AND business_id = $3`,
          [delta, pid, businessId]);
      }
    }
    /* Like applyPhysicalReturn: the order no longer holds committed stock, so a
       later manual status change can't restock the same units a second time. */
    if (clearFlag) {
      await client.query(`UPDATE orders SET stock_deducted = false WHERE id = $1 AND business_id = $2::integer`,
        [order.id, businessId]);
    }
    await client.query('COMMIT');
    console.log(`📦  Return pickup ${row.tracking_number} (${row.kind}) → order #${order.id}: `
      + [...moves].map(([pid, d]) => `${d >= 0 ? '+' : ''}${d} ${pid === back.id ? back.name : fwd.name}`).join(', '));
    return { applied: true, moves: [...moves].map(([product_id, delta]) => ({ product_id, delta })) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[returnPickups] applyReceipt failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/* Fetch details (once), auto-link when unambiguous, then apply. Never throws. */
async function processReceived(businessId, pickupId) {
  try {
    let { rows: [row] } = await pool.query(
      `SELECT * FROM return_pickups WHERE id = $1 AND business_id = $2::integer`, [pickupId, businessId]);
    if (!row || row.restocked_at || row.ignored_at || !row.received_at) return;
    if (!row.details_fetched_at) {
      let doc = null;
      try { doc = await detailsFetcher(businessId, row.tracking_number); }
      catch (e) { console.warn(`[returnPickups] Bosta doc for ${row.tracking_number} failed: ${e.response ? `HTTP ${e.response.status}` : e.message}`); }
      if (doc) {
        const d = parseDoc(doc, row.kind);
        ({ rows: [row] } = await pool.query(
          `UPDATE return_pickups
              SET details_fetched_at = NOW(), customer_phone = $2, customer_name = $3, return_desc = $4,
                  return_qty = $5, forward_desc = $6, forward_qty = $7, pickup_fee = $8, collected_cod = $9,
                  bosta_created_at = COALESCE($10, bosta_created_at),
                  received_at = COALESCE($11, received_at), updated_at = NOW()
            WHERE id = $1 RETURNING *`,
          [row.id, d.customer_phone, d.customer_name, d.return_desc, d.return_qty, d.forward_desc, d.forward_qty,
            d.pickup_fee, d.collected_cod, d.bosta_created_at, d.received_at]));
      }
    }
    if (!row.order_id && row.details_fetched_at) {
      const { order, reason } = await chooseOrder(pool, businessId, row);
      if (order) {
        ({ rows: [row] } = await pool.query(
          `UPDATE return_pickups SET order_id = $2, link_method = 'auto', linked_at = NOW(), note = NULL, updated_at = NOW()
            WHERE id = $1 AND order_id IS NULL RETURNING *`, [row.id, order.id]));
      } else {
        await pool.query(`UPDATE return_pickups SET note = $2, updated_at = NOW() WHERE id = $1`, [row.id, reason]);
      }
    }
    if (row && row.order_id) await applyReceipt(businessId, row.id);
  } catch (err) {
    console.error('[returnPickups] processReceived failed:', err.message);
  }
}

/* ── Webhook entry ────────────────────────────────────────────────────────────
   Called for a Bosta event whose tracking number matches no order. Returns
   true when it was a pickup / exchange (recorded), false otherwise.           */
async function resolveBusiness(incomingSecret) {
  const { rows } = await pool.query(
    `SELECT business_id, webhook_secret FROM shipping_settings WHERE provider_name = 'bosta' AND is_active = true`);
  const bySecret = incomingSecret ? rows.filter((r) => r.webhook_secret && r.webhook_secret === incomingSecret) : [];
  if (bySecret.length === 1) return bySecret[0].business_id;
  return rows.length === 1 ? rows[0].business_id : null;
}

async function handleUnmatchedWebhook({ trackingNumber, type, stateCode, received, payload, incomingSecret }) {
  const kind = kindOf(type);
  if (!kind || !trackingNumber) return false;
  await schemaReady;
  const businessId = await resolveBusiness(incomingSecret);
  if (!businessId) { console.warn(`[returnPickups] ${trackingNumber}: tenant unresolved — skipped`); return true; }
  const isReceived = received || Number(stateCode) === RECEIVED_STATE;
  const { rows: [row] } = await pool.query(
    `INSERT INTO return_pickups (business_id, tracking_number, kind, state_code, received_at, last_payload)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN NOW() END, $6::jsonb)
     ON CONFLICT (business_id, tracking_number) DO UPDATE
       SET state_code   = COALESCE(EXCLUDED.state_code, return_pickups.state_code),
           received_at  = COALESCE(return_pickups.received_at, EXCLUDED.received_at),
           last_payload = EXCLUDED.last_payload,
           updated_at   = NOW()
     RETURNING id, received_at, restocked_at, ignored_at`,
    [businessId, String(trackingNumber), kind, Number.isFinite(Number(stateCode)) ? Number(stateCode) : null,
      isReceived, payload ? JSON.stringify(payload) : null]);
  console.log(`📥  Return pickup ${trackingNumber} (${kind}) state ${stateCode ?? '?'}${row.received_at ? ' — received' : ''}`);
  if (row.received_at && !row.restocked_at && !row.ignored_at) await processReceived(businessId, row.id);
  return true;
}

/* ── Review list + manual actions (routes/returnPickups.js) ───────────────── */
async function listPickups({ businessId, status = 'review' }) {
  await schemaReady;
  const where = {
    review:   `rp.received_at IS NOT NULL AND rp.restocked_at IS NULL AND rp.ignored_at IS NULL`,
    done:     `rp.restocked_at IS NOT NULL`,
    transit:  `rp.received_at IS NULL AND rp.ignored_at IS NULL`,
    ignored:  `rp.ignored_at IS NOT NULL`,
    all:      `TRUE`,
  }[status] || `TRUE`;
  const { rows } = await pool.query(
    `SELECT rp.id, rp.tracking_number, rp.kind, rp.state_code, rp.received_at, rp.customer_phone, rp.customer_name,
            rp.return_desc, rp.return_qty, rp.forward_desc, rp.forward_qty,
            rp.pickup_fee::float AS pickup_fee, rp.collected_cod::float AS collected_cod,
            rp.order_id, rp.link_method, rp.linked_by, rp.restocked_at, rp.ignored_at, rp.note,
            rp.unit_cost::float AS unit_cost, rp.details_fetched_at,
            o."ProductName" AS order_product, o."FullName" AS order_customer,
            TO_CHAR((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS order_placed_on,
            pr.name AS return_product, pf.name AS forward_product
       FROM return_pickups rp
       LEFT JOIN orders o    ON o.id = rp.order_id
       LEFT JOIN products pr ON pr.id = rp.return_product_id
       LEFT JOIN products pf ON pf.id = rp.forward_product_id
      WHERE rp.business_id = $1::integer AND ${where}
      ORDER BY COALESCE(rp.received_at, rp.created_at) DESC
      LIMIT 200`, [businessId]);
  const counts = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE received_at IS NOT NULL AND restocked_at IS NULL AND ignored_at IS NULL)::int AS review,
            COUNT(*) FILTER (WHERE restocked_at IS NOT NULL)::int AS done,
            COUNT(*) FILTER (WHERE received_at IS NULL AND ignored_at IS NULL)::int AS transit,
            COUNT(*) FILTER (WHERE ignored_at IS NOT NULL)::int AS ignored
       FROM return_pickups WHERE business_id = $1::integer`, [businessId])).rows[0];
  /* Suggested orders for the ones waiting on a person (same phone). */
  for (const r of rows) {
    if (!r.order_id && r.received_at && !r.ignored_at) r.candidates = await findCandidates(pool, businessId, r);
  }
  return { pickups: rows, counts };
}

async function linkPickup({ businessId, pickupId, orderId, forwardProductId, actor }) {
  await schemaReady;
  const id = parseInt(pickupId, 10);
  const oid = parseInt(orderId, 10);
  if (!Number.isInteger(id) || !Number.isInteger(oid)) throw new PickupError(400, 'بيانات غير صالحة');
  const { rows: [row] } = await pool.query(
    `SELECT * FROM return_pickups WHERE id = $1 AND business_id = $2::integer`, [id, businessId]);
  if (!row) throw new PickupError(404, 'المرتجع غير موجود');
  if (row.restocked_at) throw new PickupError(409, 'المرتجع ده اتسجّل في المخزون بالفعل — فك الربط الأول');
  const { rows: [order] } = await pool.query(
    `SELECT id, btrim("Status") AS status FROM orders WHERE id = $1 AND business_id = $2::integer`, [oid, businessId]);
  if (!order) throw new PickupError(404, 'الطلب غير موجود');
  if (order.status !== DELIVERED) throw new PickupError(409, `الطلب #${oid} حالته «${order.status}» — اربط بطلب متسلّم`);
  let fwd = null;
  if (forwardProductId) {
    const { rows: [p] } = await pool.query(`SELECT id FROM products WHERE id = $1 AND business_id = $2`, [forwardProductId, businessId]);
    if (!p) throw new PickupError(404, 'منتج الاستبدال غير موجود');
    fwd = p.id;
  }
  await pool.query(
    `UPDATE return_pickups SET order_id = $2, link_method = 'manual', linked_by = $3, linked_at = NOW(),
            forward_product_id = COALESCE($4, forward_product_id), ignored_at = NULL, note = NULL, updated_at = NOW()
      WHERE id = $1`, [id, oid, actor || null, fwd]);
  const result = row.received_at ? await applyReceipt(businessId, id) : { applied: false, waiting: true };
  return { id, order_id: oid, ...result };
}

/* Undo a link: reverses the stock movement (if it was applied) and puts the
   pickup back on the review list. */
async function unlinkPickup({ businessId, pickupId }) {
  await schemaReady;
  const id = parseInt(pickupId, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `SELECT * FROM return_pickups WHERE id = $1 AND business_id = $2::integer FOR UPDATE`, [id, businessId]);
    if (!row) throw new PickupError(404, 'المرتجع غير موجود');
    if (row.restocked_at) {
      const moves = new Map();
      if (row.return_product_id) moves.set(row.return_product_id, (moves.get(row.return_product_id) || 0) - row.return_qty);
      if (row.kind === 'exchange' && row.forward_product_id) {
        moves.set(row.forward_product_id, (moves.get(row.forward_product_id) || 0) + row.forward_qty);
      }
      for (const [pid, delta] of moves) {
        if (delta !== 0) {
          await client.query(`UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2 AND business_id = $3`,
            [delta, pid, businessId]);
        }
      }
      if (row.cleared_order_flag && row.order_id) {
        await client.query(`UPDATE orders SET stock_deducted = true WHERE id = $1 AND business_id = $2::integer`,
          [row.order_id, businessId]);
      }
    }
    await client.query(
      `UPDATE return_pickups
          SET order_id = NULL, link_method = NULL, linked_by = NULL, linked_at = NULL, restocked_at = NULL,
              return_product_id = NULL, unit_cost = NULL, forward_unit_cost = NULL, cleared_order_flag = false,
              updated_at = NOW()
        WHERE id = $1`, [id]);
    await client.query('COMMIT');
    return { id, reversed: Boolean(row.restocked_at) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PickupError) throw err;
    console.error('[returnPickups] unlink failed:', err.message);
    throw new PickupError(500, 'خطأ في الخادم');
  } finally {
    client.release();
  }
}

async function ignorePickup({ businessId, pickupId, note }) {
  await schemaReady;
  const { rows: [row] } = await pool.query(
    `UPDATE return_pickups SET ignored_at = NOW(), note = $3, updated_at = NOW()
      WHERE id = $1 AND business_id = $2::integer AND restocked_at IS NULL RETURNING id`,
    [parseInt(pickupId, 10), businessId, note ? String(note).slice(0, 300) : 'تم التجاهل']);
  if (!row) throw new PickupError(409, 'مينفعش تتجاهل مرتجع اتسجّل في المخزون — فك الربط الأول');
  return { id: row.id };
}

/* Re-fetch from Bosta and retry (review-list button). */
async function refreshPickup({ businessId, pickupId }) {
  await schemaReady;
  const id = parseInt(pickupId, 10);
  await pool.query(`UPDATE return_pickups SET details_fetched_at = NULL WHERE id = $1 AND business_id = $2::integer AND restocked_at IS NULL`,
    [id, businessId]);
  await processReceived(businessId, id);
  const { rows: [row] } = await pool.query(`SELECT id, order_id, restocked_at, note FROM return_pickups WHERE id = $1`, [id]);
  return row;
}

module.exports = {
  SCHEMA, schemaReady, kindOf, parseDoc, matchProductText, norm,
  handleUnmatchedWebhook, processReceived, applyReceipt,
  listPickups, linkPickup, unlinkPickup, ignorePickup, refreshPickup,
  PickupError, _setFetcherForTests,
};
