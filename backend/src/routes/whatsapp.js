/* «الربط مع واتساب» — the owner connects the business WhatsApp number (Meta
   WhatsApp Cloud API): pastes the ids + token + app secret, checks the
   connection, sends a test message to a number HE types, and watches the
   message log. Admin only, own business only.

   Step 2 of the roadmap: nothing here messages a customer on its own. */
'use strict';

const express          = require('express');
const authenticate     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const store            = require('../services/whatsapp/db');
const cloud            = require('../services/whatsapp/cloudApi');
const { whatsappNumber } = require('../utils/phone');

const router = express.Router();

const TEST_PER_HOUR = 10;
const TEST_TEMPLATE = { name: 'hello_world', language: 'en_US' };   // Meta puts it in every new account

/* The address Meta calls — same base the EasyOrder webhook and the API keys page use. */
function webhookUrl(req) {
  const base = process.env.PUBLIC_API_URL || process.env.PUBLIC_WEBHOOK_BASE || `${req.protocol}://${req.get('host')}`;
  return `${String(base).replace(/\/+$/, '')}/api/whatsapp/webhook`;
}

function fail(res, err, fallback) {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(`[whatsapp] ${fallback}:`, err.message);
  return res.status(500).json({ error: fallback });
}

const actor = (user) => user.email || String(user.id);

async function view(req, row) {
  return {
    settings:      store.publicSettings(row),
    webhook_url:   webhookUrl(req),
    graph_version: cloud.VERSION,
    test_per_hour: TEST_PER_HOUR,
    test_template: TEST_TEMPLATE.name,
    messages:      await store.recentMessages(req.user.business_id, 30),
  };
}

router.get('/settings', authenticate, requireAdmin, async (req, res) => {
  try {
    const row = await store.getSettings(req.user.business_id);
    res.set('Cache-Control', 'no-store');
    res.json(await view(req, row));
  } catch (err) { fail(res, err, 'تعذّر تحميل إعدادات الواتساب'); }
});

router.put('/settings', authenticate, requireAdmin, async (req, res) => {
  try {
    const row = await store.saveSettings(req.user.business_id, req.body || {}, actor(req.user));
    res.set('Cache-Control', 'no-store');
    res.json(await view(req, row));
  } catch (err) { fail(res, err, 'تعذّر حفظ إعدادات الواتساب'); }
});

/* Ask Meta which number the saved id + token open — proves both work. */
router.post('/check', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  try {
    const settings = await store.getSettings(businessId);
    if (!settings?.phone_number_id || !settings?.access_token) {
      return res.status(400).json({ error: 'احفظ مفاتيح ميتا الأول' });
    }
    let info = null;
    let error = null;
    try { info = await cloud.checkPhoneNumber(settings); } catch (e) {
      if (!(e instanceof cloud.GraphError)) throw e;
      error = e;
    }
    const row = await store.saveCheckResult(businessId, { info, error: error?.message });
    res.set('Cache-Control', 'no-store');
    if (error) return res.status(400).json({ error: error.message, settings: store.publicSettings(row) });
    res.json({ ok: true, settings: store.publicSettings(row) });
  } catch (err) { fail(res, err, 'تعذّر فحص الاتصال بميتا'); }
});

/* Meta's own «Hello World» template to ONE number the owner types. */
router.post('/test', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  try {
    const settings = await store.getSettings(businessId);
    if (!settings?.phone_number_id || !settings?.access_token) {
      return res.status(400).json({ error: 'احفظ مفاتيح ميتا الأول' });
    }
    const to = whatsappNumber(req.body?.phone);
    if (!to) return res.status(400).json({ error: 'اكتب رقم موبايل مصري صحيح (010 أو 011 أو 012 أو 015)' });
    if (await store.countRecentTests(businessId) >= TEST_PER_HOUR) {
      return res.status(429).json({ error: `اتبعت ${TEST_PER_HOUR} رسايل تجربة في آخر ساعة — استنى شوية وجرّب تاني` });
    }

    let sent = null;
    let error = null;
    try { sent = await cloud.sendTemplate(settings, { to, ...TEST_TEMPLATE }); } catch (e) {
      if (!(e instanceof cloud.GraphError)) throw e;
      error = e;
    }
    const message = await store.logOutbound({
      businessId, kind: 'test', phone: to, template: TEST_TEMPLATE.name,
      waMessageId: sent?.message_id || null,
      status:      sent ? 'sent' : 'failed',
      errorCode:   Number.isInteger(error?.code) ? error.code : null,
      errorText:   error?.message || null,
      createdBy:   actor(req.user),
    });
    res.set('Cache-Control', 'no-store');
    if (error) return res.status(400).json({ error: error.message, message });
    res.json({ ok: true, message });
  } catch (err) { fail(res, err, 'تعذّر إرسال رسالة التجربة'); }
});

/* Is the WhatsApp account linked to our Meta app (so Meta sends us its real
   events)? `subscribe: true` creates the link first. Never throws a Meta error
   upward: the answer says what Meta said. */
async function accountLink(settings, { subscribe = false } = {}) {
  if (!settings?.waba_id) return { linked: null, apps: [], error: 'اكتب الـ Messaging account ID في الخطوة 1 واحفظ' };
  try {
    if (subscribe) await cloud.subscribeApp(settings);
    const apps = await cloud.listSubscribedApps(settings);
    return { linked: apps.length > 0, apps: apps.map((a) => a.name || a.id).filter(Boolean), error: null };
  } catch (e) {
    if (!(e instanceof cloud.GraphError)) throw e;
    return { linked: null, apps: [], error: e.message };
  }
}

router.get('/account-link', authenticate, requireAdmin, async (req, res) => {
  try {
    const settings = await store.getSettings(req.user.business_id);
    if (!settings?.access_token) return res.status(400).json({ error: 'احفظ مفاتيح ميتا الأول' });
    res.set('Cache-Control', 'no-store');
    res.json(await accountLink(settings));
  } catch (err) { fail(res, err, 'تعذّر فحص ربط حساب الواتساب'); }
});

router.post('/account-link', authenticate, requireAdmin, async (req, res) => {
  try {
    const settings = await store.getSettings(req.user.business_id);
    if (!settings?.access_token) return res.status(400).json({ error: 'احفظ مفاتيح ميتا الأول' });
    const r = await accountLink(settings, { subscribe: true });
    console.log(`[whatsapp] account-link by ${actor(req.user)} → linked=${r.linked}${r.error ? ' (error)' : ''}`);
    res.set('Cache-Control', 'no-store');
    if (r.error) return res.status(400).json({ error: r.error, ...r });
    res.json(r);
  } catch (err) { fail(res, err, 'تعذّر ربط حساب الواتساب بالتطبيق'); }
});

module.exports = router;
