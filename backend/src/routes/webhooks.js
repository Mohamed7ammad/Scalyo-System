const express = require('express');
const pool    = require('../config/db');
const { enrichDeliveryRate } = require('../services/bostaEnrich');

const router = express.Router();

/* ── POST /api/webhooks/easyorder ────────────────────────────────── */
router.post('/easyorder', async (req, res) => {
  // Validate shared secret if configured
  if (process.env.WEBHOOK_SECRET) {
    const incoming = req.headers['x-webhook-secret'];
    if (incoming !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Webhook secret mismatch' });
    }
  }

  try {
    console.log('📦 Webhook payload received:', JSON.stringify(req.body, null, 2));

    const { FullName, Phone, City, Address, Note } = req.body;

    if (!FullName || !Phone) {
      console.warn('⚠️  Webhook rejected: missing FullName or Phone');
      return res.status(400).json({ error: 'FullName and Phone are required' });
    }

    // Always insert as 'بدون' — the background enrichment below will overwrite
    // it with the real Bosta rating within seconds.
    // TENANT: this public webhook has no tenant context, so new orders are
    // claimed by the ORIGINAL tenant (lowest business_profile.id). When the
    // webhook is upgraded to carry a tenant key, swap the subquery for it.
    const result = await pool.query(
      `INSERT INTO orders
         ("FullName", "Phone", "DeliveryRate", "City", "Address", "Note", "Status", business_id)
       VALUES ($1, $2, 'بدون', $3, $4, $5, 'جديد', (SELECT MIN(id) FROM business_profile))
       RETURNING *`,
      [FullName, Phone, City || null, Address || null, Note || null]
    );

    const newOrder = result.rows[0];

    // Respond immediately — don't make EasyOrders wait for Bosta.
    res.status(201).json({ success: true, order: newOrder });

    // Fire background enrichment after the response is sent.
    enrichDeliveryRate(newOrder.id, Phone);

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

module.exports = router;
