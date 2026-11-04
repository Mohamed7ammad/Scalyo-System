'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Post-delivery refunds — ONE writer (P&L Phase 2, 2026-11-05)
   ════════════════════════════════════════════════════════════════════════════
   A customer who received an order and later sends it back gets money back
   (Vodafone Cash / InstaPay). This service is the ONLY writer of that refund.
   One DB transaction writes:
     • order_refunds — which DELIVERED order, how much, when (the business fact);
     • its cash row in the treasury — source CUSTOMER_REFUND, linked to the order
       (so the generic treasury edit/delete refuses it; undo goes through here).

   FINANCE ONLY. It never touches stock, product_returns, the order's status or
   any commission:
     • the item coming back is services/returnPickups.js (the Bosta pickup /
       exchange receipt restocks it, exactly once);
     • the order stays «تم التوصيل» — flipping it would drop its revenue from
       the dashboard AND subtract the refund again;
     • the agent keeps the delivery commission (owner decision 2026-11-05).

   Profit: analytics charges −refund_amount to the refunded order's PLACEMENT
   day + product (services/pnl.js: CUSTOMER_REFUND is never daily OPEX).

   Linking a PAST refund: `convertTxId` re-tags an existing manual expense row
   (e.g. «مرتجع» typed as مصاريف تشغيل) instead of inserting a new one. Amount
   and date stay, so the cash balance is unchanged; undo restores its old
   category.
   ════════════════════════════════════════════════════════════════════════════ */

const pool = require('../config/db');
const pnl  = require('./pnl');
const { REFUNDS_SCHEMA: SCHEMA } = require('./returnsSchema');

const schemaReady = SCHEMA.reduce((p, sql) => p.then(() => pool.query(sql)), Promise.resolve())
  .then(() => console.log('✅  Refunds: order_refunds table ready'))
  .catch((e) => console.error('❌  Refunds: schema failed:', e.message));

const DELIVERED = 'تم التوصيل';
const PRICE_SQL = `COALESCE(NULLIF(REGEXP_REPLACE(COALESCE(o."ProductPrice"::text,''),'[^0-9.]','','g'),'')::numeric, 0)`;
const CAIRO_DAY_SQL = (col) => `TO_CHAR((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD')`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

class RefundError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ── Order search (refund dialog) ─────────────────────────────────────────────
   One box: order number, Bosta tracking code (current or pre-resend), or the
   customer's phone (any format; last 10 digits). Delivered orders first; others
   come back flagged so the dialog can say why they can't be refunded.          */
async function searchOrders(businessId, query) {
  const q = String(query || '').trim();
  const digits = q.replace(/[^\d]/g, '');
  if (!digits && !q) return [];
  const asId    = /^\d{1,9}$/.test(q) ? Number(q) : null;
  const phone10 = digits.length >= 10 ? digits.slice(-10) : null;
  const { rows } = await pool.query(
    `SELECT o.id, o."FullName" AS customer, o."Phone" AS phone, btrim(o."Status") AS status,
            o."ProductName" AS product, COALESCE(o.quantity, 1) AS quantity,
            ${PRICE_SQL}::float AS price, COALESCE(o."depositAmount", 0)::float AS deposit,
            o."BostaTrackingCode" AS tracking,
            ${CAIRO_DAY_SQL('o."createdAt"')} AS placed_on,
            TO_CHAR(o.delivered_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS delivered_on,
            COALESCE((SELECT SUM(r.refund_amount) FROM order_refunds r WHERE r.order_id = o.id), 0)::float AS refunded_total,
            (SELECT COUNT(*)::int FROM order_refunds r WHERE r.order_id = o.id) AS refunds_count
       FROM orders o
      WHERE o.business_id = $1::integer
        AND (
              ($2::int  IS NOT NULL AND o.id = $2::int)
           OR o."BostaTrackingCode" = $3
           OR o.resend_previous_tracking = $3
           OR ($4::text IS NOT NULL AND right(regexp_replace(COALESCE(o."Phone",''), '\\D', '', 'g'), 10) = $4)
        )
      ORDER BY (btrim(o."Status") = '${DELIVERED}') DESC, o."createdAt" DESC
      LIMIT 12`,
    [businessId, asId, q, phone10]);
  return rows.map((r) => ({ ...r, refundable: r.status === DELIVERED }));
}

/* ── Create ───────────────────────────────────────────────────────────────────
   { businessId, orderId, amount, refundedOn, note, requestId, convertTxId, actor }
   Returns the refund + the day/product it lands on. Throws RefundError(400/404/409). */
async function createRefund({ businessId, orderId, amount, refundedOn, note, requestId, convertTxId, actor }) {
  await schemaReady;
  const oid = parseInt(orderId, 10);
  if (!Number.isInteger(oid) || oid <= 0) throw new RefundError(400, 'اختر الطلب اللي اترد فلوسه');
  const convertId = convertTxId == null || convertTxId === '' ? null : parseInt(convertTxId, 10);
  if (convertTxId != null && convertTxId !== '' && (!Number.isInteger(convertId) || convertId <= 0)) {
    throw new RefundError(400, 'معرّف القيد غير صالح');
  }
  let amt = parseFloat(amount);
  let day = isYmd(refundedOn) ? String(refundedOn) : pnl.cairoToday();
  if (!convertId) {
    if (!Number.isFinite(amt) || amt <= 0) throw new RefundError(400, 'المبلغ المردود مطلوب ويجب أن يكون رقماً موجباً');
    if (day > pnl.cairoToday()) throw new RefundError(400, 'تاريخ رد الفلوس لا يمكن أن يكون في المستقبل');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    /* Lock the order: two refunds of the same order can't both pass the cap. */
    const { rows: [order] } = await client.query(
      `SELECT o.id, btrim(o."Status") AS status, o."ProductName" AS product, ${PRICE_SQL}::float AS price,
              ${CAIRO_DAY_SQL('o."createdAt"')} AS placed_on
         FROM orders o WHERE o.id = $1 AND o.business_id = $2::integer
        FOR UPDATE`, [oid, businessId]);
    if (!order) throw new RefundError(404, 'الطلب غير موجود');
    if (order.status !== DELIVERED) {
      throw new RefundError(409, `الطلب #${oid} حالته «${order.status}» — رد الفلوس للطلبات اللي اتسلّمت بس`);
    }

    let txId;
    let convertedFrom = null;
    if (convertId) {
      const { rows: [tx] } = await client.query(
        `SELECT id, source, type, order_id, purchase_order_id, amount::float AS amount,
                TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date
           FROM treasury_transactions WHERE id = $1 AND business_id = $2::integer FOR UPDATE`,
        [convertId, businessId]);
      if (!tx) throw new RefundError(404, 'قيد الخزينة غير موجود');
      if (tx.type !== 'expense' || tx.order_id !== null || tx.purchase_order_id !== null
          || pnl.AUTO_SOURCES[tx.source]) {
        throw new RefundError(409, 'القيد ده مش مصروف يدوي — مينفعش يتربط بطلب');
      }
      amt = tx.amount;
      day = tx.transaction_date;
      convertedFrom = tx.source;
    }

    const { rows: [{ so_far }] } = await client.query(
      `SELECT COALESCE(SUM(refund_amount), 0)::float AS so_far FROM order_refunds WHERE order_id = $1`, [oid]);
    if (order.price > 0 && r2(so_far + amt) > r2(order.price) + 0.009) {
      throw new RefundError(400,
        `المبلغ أكبر من سعر الطلب (${r2(order.price)} ج${so_far > 0 ? `، واترد منه قبل كده ${r2(so_far)} ج` : ''})`
        + (convertId ? ' — لو القيد ده فيه أكتر من مرتجع، قسّمه الأول' : ''));
    }
    if (day < order.placed_on) throw new RefundError(400, 'تاريخ رد الفلوس قبل تاريخ الطلب');

    if (convertId) {
      await client.query(
        `UPDATE treasury_transactions SET source = 'CUSTOMER_REFUND', order_id = $1, period_month = NULL
          WHERE id = $2 AND business_id = $3::integer`, [oid, convertId, businessId]);
      txId = convertId;
    } else {
      const desc = `رد فلوس مرتجع — طلب #${oid}${order.product ? ` | ${String(order.product).trim()}` : ''}`
        + (note && String(note).trim() ? ` — ${String(note).trim()}` : '');
      const { rows: [tx] } = await client.query(
        `INSERT INTO treasury_transactions (order_id, amount, type, source, description, transaction_date, business_id)
         VALUES ($1, $2, 'expense', 'CUSTOMER_REFUND', $3, $4::date, $5) RETURNING id`,
        [oid, amt.toFixed(2), desc, day, businessId]);
      txId = tx.id;
    }

    const reqId = parseInt(requestId, 10);
    const { rows: [refund] } = await client.query(
      `INSERT INTO order_refunds
         (business_id, order_id, refund_amount, refunded_on, treasury_tx_id, converted_from_source,
          after_sales_request_id, note, created_by)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9)
       RETURNING id, order_id, refund_amount::float AS refund_amount,
                 TO_CHAR(refunded_on, 'YYYY-MM-DD') AS refunded_on, treasury_tx_id, converted_from_source`,
      [businessId, oid, amt.toFixed(2), day, txId, convertedFrom,
        Number.isInteger(reqId) && reqId > 0 ? reqId : null,
        note && String(note).trim() ? String(note).trim() : null,
        actor || null]);
    await client.query('COMMIT');
    console.log(`💸  Refund #${refund.id}: ${amt.toFixed(2)} EGP on order #${oid} (placed ${order.placed_on})`
      + (convertedFrom ? ` — linked existing treasury row #${txId} (was ${convertedFrom})` : ` — treasury row #${txId}`));
    return { refund, order: { id: oid, product: order.product, placed_on: order.placed_on } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof RefundError) throw err;
    console.error('[refunds] create failed:', err.message);
    throw new RefundError(500, 'خطأ في الخادم');
  } finally {
    client.release();
  }
}

/* ── Undo ─────────────────────────────────────────────────────────────────────
   Removes the refund. A cash row the dialog created is deleted; a row that was
   LINKED from an existing manual expense goes back to its old category. */
async function deleteRefund({ businessId, refundId, treasuryTxId }) {
  await schemaReady;
  const id = parseInt(refundId, 10);
  const txId = parseInt(treasuryTxId, 10);
  const byTx = !Number.isInteger(id) && Number.isInteger(txId) && txId > 0;
  if (!byTx && (!Number.isInteger(id) || id <= 0)) throw new RefundError(400, 'معرّف غير صالح');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [rf] } = await client.query(
      `SELECT id, treasury_tx_id, converted_from_source FROM order_refunds
        WHERE ${byTx ? 'treasury_tx_id' : 'id'} = $1 AND business_id = $2::integer FOR UPDATE`,
      [byTx ? txId : id, businessId]);
    if (!rf) throw new RefundError(404, 'رد الفلوس ده غير موجود');
    await client.query(`DELETE FROM order_refunds WHERE id = $1`, [rf.id]);
    if (rf.converted_from_source) {
      await client.query(
        `UPDATE treasury_transactions SET source = $1, order_id = NULL
          WHERE id = $2 AND business_id = $3::integer AND source = 'CUSTOMER_REFUND'`,
        [rf.converted_from_source, rf.treasury_tx_id, businessId]);
    } else {
      await client.query(
        `DELETE FROM treasury_transactions
          WHERE id = $1 AND business_id = $2::integer AND source = 'CUSTOMER_REFUND'`,
        [rf.treasury_tx_id, businessId]);
    }
    await client.query('COMMIT');
    console.log(`↩️   Refund #${rf.id} undone (${rf.converted_from_source ? `row #${rf.treasury_tx_id} back to ${rf.converted_from_source}` : `row #${rf.treasury_tx_id} deleted`})`);
    return { id: rf.id, treasury_tx_id: rf.treasury_tx_id, restored_source: rf.converted_from_source || null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof RefundError) throw err;
    console.error('[refunds] delete failed:', err.message);
    throw new RefundError(500, 'خطأ في الخادم');
  } finally {
    client.release();
  }
}

/* Recent refunds (newest first), optionally for one order. */
async function listRefunds({ businessId, orderId, limit = 50 }) {
  await schemaReady;
  const oid = parseInt(orderId, 10);
  const { rows } = await pool.query(
    `SELECT r.id, r.order_id, r.refund_amount::float AS refund_amount,
            TO_CHAR(r.refunded_on, 'YYYY-MM-DD') AS refunded_on, r.treasury_tx_id,
            r.converted_from_source, r.note, r.created_by,
            o."ProductName" AS product, o."FullName" AS customer,
            ${CAIRO_DAY_SQL('o."createdAt"')} AS placed_on
       FROM order_refunds r JOIN orders o ON o.id = r.order_id
      WHERE r.business_id = $1::integer AND ($2::int IS NULL OR r.order_id = $2::int)
      ORDER BY r.refunded_on DESC, r.id DESC
      LIMIT $3`,
    [businessId, Number.isInteger(oid) && oid > 0 ? oid : null, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]);
  return rows;
}

module.exports = { SCHEMA, schemaReady, searchOrders, createRefund, deleteRefund, listRefunds, RefundError };
