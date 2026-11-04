'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Post-delivery refunds — «رد فلوس مرتجع»  (P&L Phase 2, 2026-11-05)
   Admin only. All writes go through services/orderRefunds.js (finance only:
   never stock, order status or commission).

     GET    /api/refunds/order-search?q=   delivered orders by #, tracking, phone
     GET    /api/refunds?order_id=         recent refunds (optionally one order)
     POST   /api/refunds                   { order_id, amount, refunded_on, note,
                                             request_id?, treasury_tx_id? }
                                           treasury_tx_id = link an EXISTING manual
                                           expense row instead of a new one
     DELETE /api/refunds/:id               undo
     DELETE /api/refunds/by-treasury/:txId undo, addressed by its treasury row
   ════════════════════════════════════════════════════════════════════════════ */

const express          = require('express');
const authenticate     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const refunds          = require('../services/orderRefunds');

const router = express.Router();

const fail = (res, err, tag) => {
  if (err instanceof refunds.RefundError) return res.status(err.status).json({ error: err.message });
  console.error(`[refunds ${tag}]`, err.message);
  return res.status(500).json({ error: 'خطأ في الخادم' });
};

router.get('/order-search', authenticate, requireAdmin, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (q.trim().length < 2) return res.json({ orders: [] });
    res.json({ orders: await refunds.searchOrders(req.user.business_id, q) });
  } catch (err) { fail(res, err, 'search'); }
});

router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json({ refunds: await refunds.listRefunds({
      businessId: req.user.business_id, orderId: req.query.order_id, limit: req.query.limit,
    }) });
  } catch (err) { fail(res, err, 'list'); }
});

router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const out = await refunds.createRefund({
      businessId:  req.user.business_id,
      orderId:     b.order_id,
      amount:      b.amount,
      refundedOn:  b.refunded_on,
      note:        b.note,
      requestId:   b.request_id,
      convertTxId: b.treasury_tx_id,
      actor:       req.user.email || req.user.id || null,
    });
    res.status(201).json(out);
  } catch (err) { fail(res, err, 'create'); }
});

router.delete('/by-treasury/:txId', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await refunds.deleteRefund({ businessId: req.user.business_id, treasuryTxId: req.params.txId }));
  } catch (err) { fail(res, err, 'delete'); }
});

router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await refunds.deleteRefund({ businessId: req.user.business_id, refundId: req.params.id }));
  } catch (err) { fail(res, err, 'delete'); }
});

module.exports = router;
