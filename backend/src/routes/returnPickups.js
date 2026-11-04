'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Post-delivery returns received through Bosta — pickups («Customer Return
   Pickup») and exchanges (P&L Phase 2, 2026-11-05). Admin only.
   The Bosta webhook records + auto-links + restocks them
   (services/returnPickups.js); this is the review list for the ones a person
   must link, plus undo.

     GET  /api/return-pickups?status=review|done|transit|ignored|all
     POST /api/return-pickups/:id/link     { order_id, forward_product_id? }
     POST /api/return-pickups/:id/unlink   (reverses the stock movement)
     POST /api/return-pickups/:id/ignore   { note? }
     POST /api/return-pickups/:id/refresh  (re-fetch from Bosta, retry)
   ════════════════════════════════════════════════════════════════════════════ */

const express          = require('express');
const authenticate     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const pickups          = require('../services/returnPickups');

const router = express.Router();

const fail = (res, err, tag) => {
  if (err instanceof pickups.PickupError) return res.status(err.status).json({ error: err.message });
  console.error(`[return-pickups ${tag}]`, err.message);
  return res.status(500).json({ error: 'خطأ في الخادم' });
};

router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const status = ['review', 'done', 'transit', 'ignored', 'all'].includes(String(req.query.status))
      ? String(req.query.status) : 'review';
    res.json(await pickups.listPickups({ businessId: req.user.business_id, status }));
  } catch (err) { fail(res, err, 'list'); }
});

router.post('/:id/link', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await pickups.linkPickup({
      businessId: req.user.business_id, pickupId: req.params.id,
      orderId: req.body?.order_id, forwardProductId: req.body?.forward_product_id || null,
      actor: req.user.email || req.user.id || null,
    }));
  } catch (err) { fail(res, err, 'link'); }
});

router.post('/:id/unlink', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await pickups.unlinkPickup({ businessId: req.user.business_id, pickupId: req.params.id }));
  } catch (err) { fail(res, err, 'unlink'); }
});

router.post('/:id/ignore', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await pickups.ignorePickup({ businessId: req.user.business_id, pickupId: req.params.id, note: req.body?.note }));
  } catch (err) { fail(res, err, 'ignore'); }
});

router.post('/:id/refresh', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await pickups.refreshPickup({ businessId: req.user.business_id, pickupId: req.params.id }));
  } catch (err) { fail(res, err, 'refresh'); }
});

module.exports = router;
