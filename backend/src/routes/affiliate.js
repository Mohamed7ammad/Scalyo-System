'use strict';

/**
 * affiliate.js — External Affiliate Network credentials (Taager / Safqa).
 * ─────────────────────────────────────────────────────────────────────────────
 * EXCLUSIVE to the "affiliate" SaaS plan.
 *
 * Each tenant configures THREE values per network from the dashboard — API URL,
 * Merchant ID, and API Token. Everything persists in the generic tenant-scoped
 * `settings` table (keys defined in services/externalAffiliate → NETWORK_KEYS),
 * strictly bound by business_id (composite PK: key + business_id). Nothing is
 * hard-coded here and there are NO global env URLs.
 *
 * SECURITY:
 *   • Every read/write/delete is scoped WHERE business_id = $tenant — no leak.
 *   • GET masks the API token (preview only) — the full token is never returned.
 *     URL + Merchant ID are NOT secrets, so they are returned in full to prefill.
 *   • An empty string on POST KEEPS the existing value (never wipes it blank).
 *   • DELETE /disconnect wipes all 3 keys for a network to reset it cleanly.
 */

const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const { NETWORK_KEYS, AFFILIATE_KEYS, loadAffiliateCreds, aggregateSafqaFromDb } = require('../services/externalAffiliate');
const { runTaagerSync } = require('../services/taagerSync');

const router = express.Router();

/* ── Plan gate ───────────────────────────────────────────────────────────────
   This whole feature set is exclusive to the affiliate plan. Tokens minted
   before plan_type existed fail closed (undefined !== 'affiliate' → 403).      */
function requireAffiliatePlan(req, res, next) {
  if (req.user.plan_type !== 'affiliate') {
    return res.status(403).json({ error: 'هذه الميزة متاحة فقط لباقة الأفليت' });
  }
  next();
}

/** Mask a secret for safe display: first 4 chars + bullets. Empty → null. */
function maskKey(value) {
  const v = (value || '').trim();
  if (!v) return null;
  if (v.length <= 4) return '•'.repeat(v.length);
  return v.slice(0, 4) + '•'.repeat(Math.min(20, v.length - 4));
}

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/affiliate/settings
   Per network: { configured, api_url, merchant_id, token_preview }.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/settings', authenticate, requireAdmin, requireAffiliatePlan, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings
        WHERE key = ANY($1::text[]) AND business_id = $2::integer`,
      [AFFILIATE_KEYS, req.user.business_id]
    );
    const map = Object.fromEntries(rows.map((r) => [r.key, (r.value || '').trim()]));

    const view = (net) => {
      const k = NETWORK_KEYS[net];
      const url      = map[k.url]      || '';
      const merchant = map[k.merchant] || '';
      const token    = map[k.token]    || '';
      return {
        configured:    Boolean(merchant || token),  // connected once an id/token is set
        api_url:       url,                          // not secret → full value to prefill
        merchant_id:   merchant,                     // not secret → full value to prefill
        token_preview: maskKey(token),               // secret → masked only
      };
    };

    res.json({ taager: view('taager'), safqa: view('safqa') });
  } catch (err) {
    console.error('[affiliate/settings GET] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /api/affiliate/settings
   Body: { taager_api_url?, taager_merchant_id?, taager_api_token?,
           safqa_api_url?,  safqa_merchant_id?,  safqa_api_token? }
   Upserts whichever fields are provided. An omitted or empty-string field is
   left untouched (existing value preserved).
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/settings', authenticate, requireAdmin, requireAffiliatePlan, async (req, res) => {
  const businessId = req.user.business_id;

  /* Map of request-body field → settings key (3 per network). */
  const FIELD_TO_KEY = {
    taager_api_url:     NETWORK_KEYS.taager.url,
    taager_merchant_id: NETWORK_KEYS.taager.merchant,
    taager_api_token:   NETWORK_KEYS.taager.token,
    safqa_api_url:      NETWORK_KEYS.safqa.url,
    safqa_merchant_id:  NETWORK_KEYS.safqa.merchant,
    safqa_api_token:    NETWORK_KEYS.safqa.token,
  };

  /* Build the list of (key, value) pairs to upsert — skip blanks so we never
     overwrite a saved value with an empty string. */
  const updates = [];
  for (const [field, settingsKey] of Object.entries(FIELD_TO_KEY)) {
    const raw = req.body[field];
    if (typeof raw === 'string' && raw.trim()) {
      updates.push([settingsKey, raw.trim()]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'لم يتم إرسال أي بيانات للحفظ' });
  }

  try {
    for (const [key, value] of updates) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at, business_id)
              VALUES ($1, $2, NOW(), $3::integer)
         ON CONFLICT (key, business_id) DO UPDATE
              SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value, businessId]
      );
    }
    console.log(`✅  Affiliate settings saved (${updates.map((u) => u[0]).join(', ')}) for tenant ${businessId}`);
    res.json({ message: 'تم حفظ بيانات الربط بنجاح', saved: updates.map((u) => u[0]) });
  } catch (err) {
    console.error('[affiliate/settings POST] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /api/affiliate/disconnect
   Body: { network: 'taager' | 'safqa' }
   Wipes ALL three keys (url + merchant_id + token) for that network — a clean
   reset so the tenant can start fresh. Strictly scoped to the caller's tenant.
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/disconnect', authenticate, requireAdmin, requireAffiliatePlan, async (req, res) => {
  const network = String(req.body.network || '').trim().toLowerCase();
  const keys = NETWORK_KEYS[network];
  if (!keys) {
    return res.status(400).json({ error: 'منصة غير معروفة' });
  }

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM settings
        WHERE business_id = $1::integer
          AND key = ANY($2::text[])`,
      [req.user.business_id, [keys.url, keys.merchant, keys.token]]
    );
    console.log(`🗑️  Affiliate '${network}' disconnected for tenant ${req.user.business_id} (${rowCount} keys removed)`);
    res.json({ message: 'تم فك الربط بنجاح', network, removed: rowCount });
  } catch (err) {
    console.error('[affiliate/disconnect POST] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /api/affiliate/taager/sync
   Deep sync: pull the tenant's real Taager orders and UPSERT them into our
   internal `orders` table (+ product stubs), so Products Profitability and the
   unified dashboard light up with native, accurate data. Tenant-scoped.
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/taager/sync', authenticate, requireAdmin, requireAffiliatePlan, async (req, res) => {
  try {
    const result = await runTaagerSync(req.user.business_id);
    res.json({
      message: `تمت مزامنة ${result.upserted} طلب من تاجر (${result.productsCreated} منتج جديد)`,
      ...result,
    });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED') {
      return res.status(400).json({ error: err.message });
    }
    const status = err.response?.status;
    console.error('[affiliate/taager/sync POST] Error:', status ? `HTTP ${status}` : '', err.message);
    res.status(502).json({ error: 'تعذّرت مزامنة الطلبات من تاجر — تحقق من التوكن والرابط' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/affiliate/safqa/webhook  — the orderHook URL to register in Safqa
   ─────────────────────────────────────────────────────────────────────────
   Safqa is WEBHOOK-driven (it pushes; we never GET). This returns the exact
   per-tenant URL the merchant must paste into Safqa's `orderHook` field, plus a
   snapshot of what we've ingested so far so they can confirm pushes are arriving.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/safqa/webhook', authenticate, requireAdmin, requireAffiliatePlan, async (req, res) => {
  const businessId = req.user.business_id;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host  = req.get('host');
  const path  = `/api/webhooks/safqa/${businessId}`;
  const webhookUrl = host ? `${proto}://${host}${path}` : path;

  let stat = null;
  try { stat = await aggregateSafqaFromDb(businessId, false); } catch { /* non-fatal */ }

  return res.json({
    webhookUrl,
    path,
    instructions: 'سجّل هذا الرابط في حقل orderHook داخل لوحة تحكم Safqa لاستقبال تحديثات الطلبات تلقائياً.',
    ingested: stat ? { orders: stat.orders, delivered: stat.delivered, revenue: stat.revenue } : null,
  });
});

/* POST /api/affiliate/safqa/test — report ingestion status (Safqa pushes; nothing
   to ping). Confirms whether any order has been received via the webhook yet. */
router.post('/safqa/test', authenticate, requireAdmin, requireAffiliatePlan, async (req, res) => {
  try {
    const stat = await aggregateSafqaFromDb(req.user.business_id, false);
    if (stat.orders === 0) {
      return res.status(200).json({
        ok: false,
        pending: true,
        error: 'لم تصل أي طلبات من Safqa بعد — تأكد من تسجيل رابط orderHook في لوحة Safqa.',
        ...stat,
      });
    }
    return res.json({
      ok: true,
      message: `تم استقبال ${stat.orders} طلب من Safqa عبر الـ webhook، إيراد ${stat.revenue} ج.م`,
      ...stat,
    });
  } catch (err) {
    console.error('[affiliate/safqa/test POST] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'تعذّر قراءة بيانات Safqa' });
  }
});

module.exports = router;
