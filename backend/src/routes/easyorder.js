'use strict';

const express  = require('express');
const crypto   = require('crypto');
const pool     = require('../config/db');
const authenticate     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

/* ── Schema: per-tenant EasyOrder credentials on business_profile ───────────
   • easyorder_api_token      — the tenant's EasyOrder API token (for future
     outbound calls to EasyOrder; stored, returned masked).
   • easyorder_webhook_secret — a secret WE generate; the tenant pastes it into
     EasyOrder's webhook config (custom header or ?secret=) and we validate it
     on the inbound webhook. Auto-generated on first GET if absent.
   Idempotent — safe on every boot.                                            */
(async () => {
  try {
    await pool.query(`ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS easyorder_api_token      TEXT`);
    await pool.query(`ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS easyorder_webhook_secret VARCHAR(80)`);
    console.log('✅  EasyOrder: business_profile credential columns ready');
  } catch (err) {
    console.warn('⚠️   EasyOrder schema migration skipped:', err.message);
  }
})();

/** Mask a secret/token for display: first `keep` chars + fixed stars. */
function mask(value, keep = 6) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= keep) return '*'.repeat(8);
  return s.slice(0, keep) + '*'.repeat(20);
}

/** Build the canonical public webhook URL for a tenant. */
function buildWebhookUrl(req, businessId) {
  const base =
    process.env.PUBLIC_WEBHOOK_BASE ||
    process.env.PUBLIC_API_URL ||
    `${req.protocol}://${req.get('host')}`;
  return `${String(base).replace(/\/+$/, '')}/api/webhooks/easyorder/${businessId}`;
}

/* ── GET /api/integrations/easyorder ────────────────────────────────────────
   Returns the tenant's EasyOrder integration settings. Generates a webhook
   secret on first access so the read-only URL/secret is always available.     */
router.get('/', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  try {
    const { rows } = await pool.query(
      `SELECT easyorder_api_token, easyorder_webhook_secret
         FROM business_profile WHERE id = $1 LIMIT 1`,
      [businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No profile found' });

    let { easyorder_api_token, easyorder_webhook_secret } = rows[0];

    // Lazily generate a webhook secret the first time the page is opened.
    if (!easyorder_webhook_secret) {
      easyorder_webhook_secret = crypto.randomBytes(24).toString('hex');
      await pool.query(
        `UPDATE business_profile SET easyorder_webhook_secret = $1, updated_at = NOW() WHERE id = $2`,
        [easyorder_webhook_secret, businessId]
      );
    }

    res.json({
      business_id:    businessId,
      connected:      Boolean(easyorder_api_token),
      api_token:      mask(easyorder_api_token),     // masked — never sent in full
      webhook_secret: easyorder_webhook_secret,      // shown in full so it can be pasted
      webhook_url:    buildWebhookUrl(req, businessId),
    });
  } catch (err) {
    console.error('[GET /integrations/easyorder]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/integrations/easyorder ───────────────────────────────────────
   Save the tenant's EasyOrder API token. Pass api_token: '' to keep existing.
   Optionally regenerate the webhook secret with regenerate_secret: true.       */
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const { api_token, regenerate_secret } = req.body;

  try {
    // Only overwrite the token when a non-empty value is supplied.
    const tokenProvided = typeof api_token === 'string' && api_token.trim() !== '';
    const newSecret = regenerate_secret ? crypto.randomBytes(24).toString('hex') : null;

    const { rows } = await pool.query(
      `UPDATE business_profile
          SET easyorder_api_token      = COALESCE($1, easyorder_api_token),
              easyorder_webhook_secret = COALESCE($2, easyorder_webhook_secret),
              updated_at               = NOW()
        WHERE id = $3
        RETURNING easyorder_api_token, easyorder_webhook_secret`,
      [tokenProvided ? api_token.trim() : null, newSecret, businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Profile not found' });

    res.json({
      message:        'تم الحفظ بنجاح',
      connected:      Boolean(rows[0].easyorder_api_token),
      api_token:      mask(rows[0].easyorder_api_token),
      webhook_secret: rows[0].easyorder_webhook_secret,
      webhook_url:    buildWebhookUrl(req, businessId),
    });
  } catch (err) {
    console.error('[POST /integrations/easyorder]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
