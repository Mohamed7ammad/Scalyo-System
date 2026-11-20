/* «مفاتيح API» — the owner creates / lists / stops the read-only keys another
   system uses on /api/v1 (routes/externalApi.js). Admin only, own business only.
   The full key appears ONCE in the create response and is never stored or logged. */
'use strict';

const express          = require('express');
const authenticate     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const apiKeys          = require('../services/apiKeys');

const router = express.Router();

/* The address other systems call — same base the EasyOrder webhook URL uses. */
function baseUrl(req) {
  const base = process.env.PUBLIC_API_URL || process.env.PUBLIC_WEBHOOK_BASE || `${req.protocol}://${req.get('host')}`;
  return `${String(base).replace(/\/+$/, '')}/api/v1`;
}

function fail(res, err, fallback) {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(`[api-keys] ${fallback}:`, err.message);
  return res.status(500).json({ error: fallback });
}

const actor = (user) => user.email || String(user.id);

router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const keys = await apiKeys.listKeys(req.user.business_id);
    res.set('Cache-Control', 'no-store');
    res.json({
      base_url:            baseUrl(req),
      scopes:              apiKeys.SCOPES,
      max_active:          apiKeys.MAX_ACTIVE,
      requests_per_minute: apiKeys.REQS_PER_MIN,
      keys,
    });
  } catch (err) { fail(res, err, 'تعذّر تحميل المفاتيح'); }
});

router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const created = await apiKeys.createKey({
      businessId: req.user.business_id,
      name:       req.body?.name,
      scopes:     req.body?.scopes,
      createdBy:  actor(req.user),
    });
    res.set('Cache-Control', 'no-store');
    res.status(201).json(created);
  } catch (err) { fail(res, err, 'تعذّر إنشاء المفتاح'); }
});

router.post('/:id/revoke', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await apiKeys.revokeKey({ businessId: req.user.business_id, id: req.params.id, revokedBy: actor(req.user) }));
  } catch (err) { fail(res, err, 'تعذّر إيقاف المفتاح'); }
});

module.exports = router;
