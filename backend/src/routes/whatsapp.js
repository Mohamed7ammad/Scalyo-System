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
const templates        = require('../services/whatsapp/templates');
const flows            = require('../services/whatsapp/flowStore');
const flowRules        = require('../services/whatsapp/flow');
const { whatsappNumbers } = require('../utils/phone');
const pool             = require('../config/db');

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
    /* failures Meta reported later arrive in English — show the Arabic meaning (the raw text stays in the DB) */
    messages:      (await store.recentMessages(req.user.business_id, 30))
      .map((m) => (m.status === 'failed' ? { ...m, error_text: cloud.friendlyForCode(m.error_code, m.error_text) } : m)),
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
  if (!settings?.waba_id) return { linked: null, app: null, apps: [], error: 'اكتب الـ Messaging account ID في الخطوة 1 واحفظ' };
  try {
    if (subscribe) await cloud.subscribeApp(settings);
    const [apps, own] = await Promise.all([cloud.listSubscribedApps(settings), cloud.ownApp(settings)]);
    /* linked = OUR app is in the list. Meta's own «WA DevX Webhook Events» test app
       is there on every new account and proves nothing. */
    const mine = own.id ? apps.find((a) => a.id === own.id) : null;
    return {
      linked: own.id ? Boolean(mine) : null,
      app:    own.name || null,
      apps:   apps.filter((a) => a !== mine).map((a) => a.name || a.id).filter(Boolean),
      error:  null,
    };
  } catch (e) {
    if (!(e instanceof cloud.GraphError)) throw e;
    return { linked: null, app: null, apps: [], error: e.message, meta: `#${e.code}: ${String(e.metaMessage || '').slice(0, 160)}` };
  }
}

/* ── message templates (step 5): the approved texts + what Meta says about each ── */
async function templateList(businessId, settings) {
  const { rows: [bp] } = await pool.query('SELECT brand_name FROM business_profile WHERE id = $1', [businessId]);
  const mine = templates.build(bp?.brand_name);
  let onMeta = [];
  let error = null;
  if (!settings?.waba_id || !settings?.access_token) {
    error = 'احفظ مفاتيح ميتا والـ Messaging account ID الأول';
  } else {
    try { onMeta = await cloud.listTemplates(settings); } catch (e) {
      if (!(e instanceof cloud.GraphError)) throw e;
      error = e.message;
    }
  }
  return {
    error,
    templates: mine.map((t) => {
      const m = onMeta.find((x) => x.name === t.name && x.language === t.language) || null;
      return { ...t, preview: templates.preview(t),
        meta: m ? { status: m.status, category: m.category, rejected_reason: m.rejected_reason } : null };
    }),
  };
}

router.get('/templates', authenticate, requireAdmin, async (req, res) => {
  try {
    const settings = await store.getSettings(req.user.business_id);
    res.set('Cache-Control', 'no-store');
    res.json(await templateList(req.user.business_id, settings));
  } catch (err) { fail(res, err, 'تعذّر تحميل قوالب الرسايل'); }
});

/* Send ONE of our templates to Meta for review. Creates nothing on our side and
   messages no one; a template already on Meta is never submitted twice. */
router.post('/templates/:key/submit', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  try {
    const settings = await store.getSettings(businessId);
    const before = await templateList(businessId, settings);
    if (before.error) return res.status(400).json({ error: before.error });
    const t = before.templates.find((x) => x.key === req.params.key);
    if (!t) return res.status(404).json({ error: 'القالب ده مش موجود' });
    if (t.meta) return res.status(409).json({ error: 'القالب ده متبعت لميتا قبل كده', ...before });
    try {
      const r = await cloud.createTemplate(settings, templates.toMetaPayload(t));
      console.log(`[whatsapp] template ${t.name} submitted by ${actor(req.user)} → ${r.status} (${r.category})`);
    } catch (e) {
      if (!(e instanceof cloud.GraphError)) throw e;
      console.warn(`[whatsapp] template ${t.name} refused: #${e.code} ${String(e.metaMessage || '').slice(0, 200)}`);
      return res.status(400).json({ error: e.message });
    }
    res.set('Cache-Control', 'no-store');
    res.json(await templateList(businessId, settings));
  } catch (err) { fail(res, err, 'تعذّر إرسال القالب لميتا'); }
});

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
    console.log(`[whatsapp] account-link by ${actor(req.user)} → linked=${r.linked}${r.error ? ` (meta ${r.meta || 'error'})` : ''}`);
    res.set('Cache-Control', 'no-store');
    if (r.error) return res.status(400).json({ error: r.error, ...r });
    res.json(r);
  } catch (err) { fail(res, err, 'تعذّر ربط حساب الواتساب بالتطبيق'); }
});

/* ── the automation switch (step 6): off | test | on ─────────────────────────
   test = only orders whose customer number is in the owner's test list enter
   the flow; every other order is untouched. */
const LIVE_MODE_OPEN = false;   // part C of the roadmap opens it

async function autoView(businessId) {
  const auto = await flows.getAuto(businessId);
  return {
    auto_mode:   auto.auto_mode,
    test_phones: auto.test_phones,
    split_test:  auto.split_test,
    configured:  auto.configured,
    live_mode_open: LIVE_MODE_OPEN,
    rules: {
      hold_status:      flowRules.HOLD_STATUS,
      send_delay_min:   flowRules.DEFAULTS.send_delay_min,
      send_delay_b_min: flowRules.DEFAULTS.send_delay_b_min,
      hold_min:         flowRules.DEFAULTS.hold_min,
      reminder1_min:    flowRules.DEFAULTS.reminder1_min,
      reminder2_min:    flowRules.DEFAULTS.reminder2_min,
      quiet_until_hour: flowRules.DEFAULTS.quiet_until_hour,
    },
    tags:  flowRules.TAGS,
    flows: await flows.recentFlows(businessId, 30),
  };
}

router.get('/auto', authenticate, requireAdmin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await autoView(req.user.business_id));
  } catch (err) { fail(res, err, 'تعذّر تحميل إعدادات التشغيل'); }
});

router.put('/auto', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  try {
    const mode = String(req.body?.auto_mode || '');
    if (mode === 'on' && !LIVE_MODE_OPEN) {
      return res.status(400).json({ error: 'التشغيل على كل العملاء بيتفتح بعد أسبوع التجربة' });
    }
    /* phones as the owner types them (010…), stored as WhatsApp numbers (2010…) */
    const raw = Array.isArray(req.body?.test_phones) ? req.body.test_phones : [];
    const phones = [];
    for (const p of raw) {
      const found = whatsappNumbers(p);
      if (!found.length && String(p).trim()) return res.status(400).json({ error: `«${String(p).slice(0, 20)}» مش رقم موبايل مصري صحيح` });
      phones.push(...found);
    }
    if (mode !== 'off') {
      /* never switch on before Meta approved both messages */
      const settings = await store.getSettings(businessId);
      const list = await templateList(businessId, settings);
      if (list.error) return res.status(400).json({ error: list.error });
      const pending = list.templates.filter((t) => t.meta?.status !== 'APPROVED');
      if (pending.length) {
        return res.status(400).json({ error: `ميتا لسه موافقتش على: ${pending.map((t) => t.title).join('، ')} — استنى الموافقة الأول` });
      }
    }
    const saved = await flows.saveAuto(businessId, { auto_mode: mode, test_phones: phones, split_test: req.body?.split_test === true }, actor(req.user));
    console.log(`[whatsapp] automation set to "${saved.auto_mode}" by ${actor(req.user)} (${saved.test_phones.length} test number(s), split=${saved.split_test})`);
    res.set('Cache-Control', 'no-store');
    res.json(await autoView(businessId));
  } catch (err) { fail(res, err, 'تعذّر حفظ إعدادات التشغيل'); }
});

module.exports = router;
