'use strict';

const express      = require('express');
const axios        = require('axios');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

const META_GRAPH = 'https://graph.facebook.com/v19.0';

/* ── API-error cooldown ────────────────────────────────────────────────────
   After any Meta API error (blocked account, expired token, rate-limit, etc.)
   we set a cooldown timestamp so the automated cron does NOT hammer the
   endpoint on every 30-minute tick while the restriction is active.
   The flag is in-process memory only — a backend restart clears it, which
   is the natural action an admin takes after fixing credentials/permissions.
   Manual syncs (POST /api/meta/sync) are NOT gated by this flag so admins
   can always test a fresh token immediately from the UI.                    */
let _cronCooldownUntil = 0;   // epoch-ms; 0 = no cooldown active

function setCronCooldown(durationMs = 2 * 60 * 60 * 1000 /* 2 h default */) {
  _cronCooldownUntil = Date.now() + durationMs;
  console.warn(
    `[meta] ⏸️  Cron sync paused for 2 h after API error. ` +
    `Cooldown expires at ${new Date(_cronCooldownUntil).toISOString()}. ` +
    `Manual sync from the UI is still available.`
  );
}

/** Called by the cron job before each tick to avoid hammering a blocked API. */
function isCronCoolingDown() {
  return Date.now() < _cronCooldownUntil;
}

/* ── Idempotent migration: settings table ────────────────────────────────────
   Generic key-value store for integration credentials.  All values are TEXT
   so they can hold tokens of any length.  The PRIMARY KEY on `key` gives us
   free upsert via ON CONFLICT (key) DO UPDATE.
   Safe to run on every restart.                                              */
pool.query(`
  CREATE TABLE IF NOT EXISTS settings (
    key        VARCHAR(50) PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`)
  .then(() => console.log('✅  Meta: settings table ready'))
  .catch((err) => console.warn('⚠️   settings table check:', err.message));

/* Idempotent column migrations — safe to run on every restart. */
pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS sku           VARCHAR(100)`)
  .then(() => pool.query(
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS meta_sync     BOOLEAN NOT NULL DEFAULT FALSE`
  ))
  .then(() => pool.query(
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS meta_purchases INT    DEFAULT 0`
  ))
  .then(() => pool.query(
    /* Dedicated column for the Meta campaign name so the UPSERT key never
       collides with the generic description column used by manual expenses. */
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS campaign_name TEXT`
  ))
  .then(() => console.log('✅  Meta: expenses columns ready'))
  .catch((err) => console.warn('⚠️   expenses column migration:', err.message));

/* NOTE: the UPSERT arbiter index for synced Meta expenses is the TENANT-AWARE
   unique index (expense_date, campaign_name, business_id), created in
   config/initTenancy.js once the business_id column exists.  Keeping the index
   tenant-scoped is what stops one tenant's sync from overwriting another
   tenant's campaign-day expense row.                                          */

/* ── Multi-account architecture migration ────────────────────────────────────
   meta_accounts holds one row per Meta ad account.  Each account can be assigned
   to a Media Buyer (assigned_user_id → users.id); NULL = admin / unassigned.
   expenses.meta_account_id attributes each synced spend row back to its account
   so the dashboard can scope a Media Buyer to only their own accounts' data.
   Safe to run on every restart.                                               */
pool.query(`
  CREATE TABLE IF NOT EXISTS meta_accounts (
    id               SERIAL PRIMARY KEY,
    account_name     VARCHAR(255) NOT NULL,
    ad_account_id    VARCHAR(100) NOT NULL,
    access_token     TEXT         NOT NULL,
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ  DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  DEFAULT NOW()
  )
`)
  /* NOTE: ad-account uniqueness is enforced PER TENANT by the composite
     unique index (ad_account_id, business_id) created in config/initTenancy.js
     once business_id exists — two different tenants may legitimately manage the
     same ad_account_id without colliding. */
  .then(() => pool.query(
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS meta_account_id INTEGER REFERENCES meta_accounts(id) ON DELETE SET NULL`
  ))
  .then(() => migrateLegacyMetaAccount())
  .then(() => console.log('✅  Meta: multi-account schema ready'))
  .catch((err) => console.warn('⚠️   Meta multi-account migration:', err.message));

/* One-time seed: if meta_accounts is empty but the legacy single-account
   settings rows exist, copy them in as an unassigned (admin-owned) account so
   the existing sync keeps working with zero manual setup.                     */
async function migrateLegacyMetaAccount() {
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM meta_accounts`);
  if (cnt[0].n > 0) return;   // already populated — nothing to migrate

  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('meta_ad_account_id', 'meta_access_token')`
  );
  const map    = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const adAcct = (map.meta_ad_account_id || '').replace(/^act_/i, '').trim();
  const token  = (map.meta_access_token  || '').trim();
  if (!adAcct || !token) return;   // no legacy creds to migrate

  /* No conflict TARGET: the old single-column unique on ad_account_id was
     replaced by the tenant-aware composite (ad_account_id, business_id) in
     initTenancy, so `ON CONFLICT (ad_account_id)` matches no constraint and
     errors. The COUNT(*) guard above already makes this seed idempotent, so a
     bare `ON CONFLICT DO NOTHING` is the correct backstop — it needs no
     specific index and silently no-ops on any unique violation. */
  await pool.query(
    `INSERT INTO meta_accounts (account_name, ad_account_id, access_token, assigned_user_id, is_active, updated_at)
     VALUES ($1, $2, $3, NULL, TRUE, NOW())
     ON CONFLICT DO NOTHING`,
    [`الحساب الرئيسي (${adAcct})`, adAcct, token]
  );
  console.log(`✅  Meta: migrated legacy account ${adAcct} → meta_accounts (admin / unassigned)`);
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Partially mask an access token (first 6 + last 4) for safe display. */
function maskToken(token) {
  const t = String(token || '');
  if (t.length > 10) return t.slice(0, 6) + '•'.repeat(Math.max(0, t.length - 10)) + t.slice(-4);
  if (t.length > 0)  return '•'.repeat(t.length);
  return '';
}

/**
 * Load Meta ad accounts from the multi-account table.
 *   activeOnly — only is_active rows (default true)
 *   userId     — restrict to accounts assigned to this user id (Media Buyer scope)
 *   accountId  — restrict to a single account id
 * Returns normalised objects with the act_ prefix stripped + token trimmed.
 */
async function loadMetaAccounts({ activeOnly = true, userId = null, accountId = null, businessId = null } = {}) {
  const where  = [];
  const params = [];
  if (activeOnly)         where.push(`is_active = TRUE`);
  if (userId     != null) { params.push(userId);     where.push(`assigned_user_id = $${params.length}`); }
  if (accountId  != null) { params.push(accountId);  where.push(`id = $${params.length}`); }
  if (businessId != null) { params.push(businessId); where.push(`business_id = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT id, account_name, ad_account_id, access_token, assigned_user_id, is_active, business_id
     FROM   meta_accounts
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER  BY id ASC`,
    params
  );
  return rows.map((r) => ({
    id:             r.id,
    accountName:    r.account_name,
    adAccountId:    (r.ad_account_id || '').replace(/^act_/i, '').trim(),
    accessToken:    (r.access_token  || '').trim(),
    assignedUserId: r.assigned_user_id,
    isActive:       r.is_active,
    businessId:     r.business_id,
  }));
}

/**
 * Translate a Meta API error object into a human-readable Arabic message.
 * Common error codes:
 *   190  — Token invalid / expired
 *   100  — Invalid parameter (bad account ID format)
 *   200  — Permission denied (can't access this account)
 *   273  — App not permitted for this account
 *   803  — Invalid ad account ID
 */
function classifyMetaError(e) {
  if (!e) return 'خطأ غير معروف من Meta API';
  switch (e.code) {
    case 190: return `التوكن منتهي الصلاحية أو غير صالح (كود ${e.code}). يرجى تحديثه من Meta Business Manager.`;
    case 100: return `معلمة غير صحيحة — تحقق من صيغة معرف حساب الإعلانات (كود ${e.code}).`;
    case 200:
    case 273: return `لا تملك صلاحية الوصول لهذا الحساب الإعلاني (كود ${e.code}). تأكد أن System User لديه دور Advertiser أو أعلى.`;
    case 803: return `معرف حساب الإعلانات غير صحيح أو غير موجود (كود ${e.code}).`;
    default:  return `خطأ من Meta (كود ${e.code}): ${e.message}`;
  }
}

/** Fetch the two Meta credential rows from settings — scoped to one tenant. */
async function loadMetaConfig(businessId) {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('meta_ad_account_id', 'meta_access_token') AND business_id = $1`,
    [businessId]
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    adAccountId:  (map.meta_ad_account_id  || '').replace(/^act_/i, '').trim(),
    accessToken:  (map.meta_access_token   || '').trim(),
    isConfigured: Boolean(map.meta_ad_account_id && map.meta_access_token),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/meta/config
   Returns the currently stored credentials.  Token is partially masked
   (first 6 + last 4 chars) so the admin can confirm what's saved without
   exposing the full secret over the wire.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/config', authenticate, requireAdmin, async (req, res) => {
  try {
    const { adAccountId, accessToken, isConfigured } = await loadMetaConfig(req.user.business_id);

    /* Partial masking — show enough to confirm which token is saved */
    let tokenPreview = '';
    if (accessToken.length > 10) {
      tokenPreview = accessToken.slice(0, 6) + '•'.repeat(Math.max(0, accessToken.length - 10)) + accessToken.slice(-4);
    } else if (accessToken.length > 0) {
      tokenPreview = '•'.repeat(accessToken.length);
    }

    res.json({
      adAccountId,
      tokenPreview,          // safe display value
      isConfigured,
      tokenLength: accessToken.length,
    });
  } catch (err) {
    console.error('[meta/config GET] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   POST /api/meta/config
   Body: { adAccountId, accessToken }
   Strips "act_" prefix from adAccountId if the user accidentally included it.
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/config', authenticate, requireAdmin, async (req, res) => {
  const rawAccountId  = String(req.body.adAccountId  || '').trim();
  const rawToken      = String(req.body.accessToken   || '').trim();

  if (!rawAccountId) return res.status(400).json({ error: 'معرف حساب الإعلانات مطلوب' });
  if (!rawToken)     return res.status(400).json({ error: 'Access Token مطلوب' });

  /* Strip accidental "act_" prefix — we add it ourselves when calling Meta */
  const cleanAccountId = rawAccountId.replace(/^act_/i, '');

  if (!/^\d+$/.test(cleanAccountId)) {
    return res.status(400).json({ error: 'معرف حساب الإعلانات يجب أن يحتوي على أرقام فقط (بدون act_)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* 1. Legacy settings keys — still read by GET /config for the masked preview. */
    await client.query(`
      INSERT INTO settings (key, value, updated_at, business_id) VALUES
        ('meta_ad_account_id', $1, NOW(), $3),
        ('meta_access_token',  $2, NOW(), $3)
      ON CONFLICT (key, business_id) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = NOW()
    `, [cleanAccountId, rawToken, req.user.business_id]);

    /* 2. CRITICAL — mirror the token into meta_accounts, the ONLY source the sync
       engine (runMetaSync → loadMetaAccounts) reads. Without this the settings
       write above is invisible to the sync and it keeps using the OLD token — the
       exact bug behind the persistent code 190. Upsert on the per-tenant unique
       key (ad_account_id, business_id): a new ad account is created; an existing
       one has ONLY its token refreshed (+ reactivated + touched), preserving its
       name and Media-Buyer assignment. Same act_-stripped id + trimmed token the
       sync expects, so both stores stay in lock-step from here on. */
    await client.query(`
      INSERT INTO meta_accounts (account_name, ad_account_id, access_token, is_active, updated_at, business_id)
      VALUES ($1, $2, $3, TRUE, NOW(), $4)
      ON CONFLICT (ad_account_id, business_id) DO UPDATE
        SET access_token = EXCLUDED.access_token,
            is_active    = TRUE,
            updated_at   = NOW()
    `, ['الحساب الرئيسي', cleanAccountId, rawToken, req.user.business_id]);

    await client.query('COMMIT');
    console.log(`✅  Meta config saved (settings + meta_accounts) — account: ${cleanAccountId}, token length: ${rawToken.length}`);

    res.json({
      message: 'تم حفظ بيانات Meta بنجاح',
      adAccountId: cleanAccountId,
      tokenLength: rawToken.length,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[meta/config POST] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   Multi-account CRUD  —  /api/meta/accounts
   All admin-only.  Tokens are never returned in full (masked preview only).
   ══════════════════════════════════════════════════════════════════════════ */

/* GET /api/meta/accounts — list every account with its assigned media buyer. */
router.get('/accounts', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.account_name, m.ad_account_id, m.access_token,
             m.assigned_user_id, m.is_active, m.created_at, m.updated_at,
             COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS assigned_user_name,
             u.email AS assigned_user_email
      FROM   meta_accounts m
      LEFT   JOIN users u ON u.id = m.assigned_user_id
      WHERE  m.business_id = $1
      ORDER  BY m.id ASC
    `, [req.user.business_id]);
    res.json(rows.map((r) => ({
      id:                  r.id,
      account_name:        r.account_name,
      ad_account_id:       (r.ad_account_id || '').replace(/^act_/i, ''),
      token_preview:       maskToken(r.access_token),
      token_length:        String(r.access_token || '').length,
      assigned_user_id:    r.assigned_user_id,
      assigned_user_name:  r.assigned_user_name,
      assigned_user_email: r.assigned_user_email,
      is_active:           r.is_active,
      created_at:          r.created_at,
      updated_at:          r.updated_at,
    })));
  } catch (err) {
    console.error('[meta/accounts GET] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* Validate that an assigned_user_id (if provided) refers to a real
   media_buyer or admin.  Returns null on success or an Arabic error string. */
async function validateAssignedUser(assigned, businessId) {
  if (assigned == null) return null;
  const { rows } = await pool.query(
    `SELECT COALESCE(roles, ARRAY[role]) AS roles FROM users WHERE id = $1 AND business_id = $2`,
    [assigned, businessId]
  );
  if (!rows.length) return 'الموظف المحدد غير موجود';
  /* Multi-role aware: any user HOLDING media_buyer or admin may be assigned an
     ad account — even if it is not their primary role. */
  const targetRoles = Array.isArray(rows[0].roles) ? rows[0].roles : [];
  if (!targetRoles.includes('media_buyer') && !targetRoles.includes('admin')) {
    return 'يمكن إسناد الحساب الإعلاني إلى ميديا باير أو مدير فقط';
  }
  return null;
}

/* POST /api/meta/accounts — add a new ad account. */
router.post('/accounts', authenticate, requireAdmin, async (req, res) => {
  const accountName = String(req.body.account_name || '').trim();
  const rawAcct     = String(req.body.adAccountId ?? req.body.ad_account_id ?? '').trim();
  const token       = String(req.body.accessToken ?? req.body.access_token ?? '').trim();
  let   assigned    = req.body.assigned_user_id;
  assigned = (assigned === '' || assigned == null) ? null : parseInt(assigned, 10);

  if (!accountName) return res.status(400).json({ error: 'اسم الحساب مطلوب' });
  if (!rawAcct)     return res.status(400).json({ error: 'معرف حساب الإعلانات مطلوب' });
  if (!token)       return res.status(400).json({ error: 'Access Token مطلوب' });

  const cleanAcct = rawAcct.replace(/^act_/i, '');
  if (!/^\d+$/.test(cleanAcct)) {
    return res.status(400).json({ error: 'معرف حساب الإعلانات يجب أن يحتوي على أرقام فقط (بدون act_)' });
  }

  try {
    const userErr = await validateAssignedUser(assigned, req.user.business_id);
    if (userErr) return res.status(400).json({ error: userErr });

    const { rows } = await pool.query(
      `INSERT INTO meta_accounts (account_name, ad_account_id, access_token, assigned_user_id, is_active, updated_at, business_id)
       VALUES ($1, $2, $3, $4, TRUE, NOW(), $5)
       RETURNING id`,
      [accountName, cleanAcct, token, assigned, req.user.business_id]
    );
    console.log(`✅  Meta account added — "${accountName}" (${cleanAcct}), assigned_user_id: ${assigned ?? 'none'}`);
    res.status(201).json({ message: 'تم إضافة الحساب الإعلاني بنجاح', id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'معرف حساب الإعلانات مُضاف بالفعل' });
    }
    console.error('[meta/accounts POST] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* PATCH /api/meta/accounts/:id — update fields; token only changes when a
   non-empty value is supplied (so editing other fields keeps the saved token). */
router.patch('/accounts/:id', authenticate, requireAdmin, async (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const sets = [];
  const vals = [];
  let   i    = 1;

  if (req.body.account_name !== undefined) {
    const n = String(req.body.account_name).trim();
    if (!n) return res.status(400).json({ error: 'اسم الحساب لا يمكن أن يكون فارغاً' });
    sets.push(`account_name = $${i++}`); vals.push(n);
  }
  if (req.body.adAccountId !== undefined || req.body.ad_account_id !== undefined) {
    const clean = String(req.body.adAccountId ?? req.body.ad_account_id ?? '').replace(/^act_/i, '').trim();
    if (!/^\d+$/.test(clean)) {
      return res.status(400).json({ error: 'معرف حساب الإعلانات يجب أن يحتوي على أرقام فقط (بدون act_)' });
    }
    sets.push(`ad_account_id = $${i++}`); vals.push(clean);
  }
  if (req.body.assigned_user_id !== undefined) {
    const a = (req.body.assigned_user_id === '' || req.body.assigned_user_id == null)
      ? null : parseInt(req.body.assigned_user_id, 10);
    const userErr = await validateAssignedUser(a, req.user.business_id);
    if (userErr) return res.status(400).json({ error: userErr });
    sets.push(`assigned_user_id = $${i++}`); vals.push(a);
  }
  if (req.body.is_active !== undefined) {
    sets.push(`is_active = $${i++}`); vals.push(Boolean(req.body.is_active));
  }
  const tok = req.body.accessToken ?? req.body.access_token;
  if (tok !== undefined && String(tok).trim() !== '') {
    sets.push(`access_token = $${i++}`); vals.push(String(tok).trim());
  }

  if (!sets.length) return res.status(400).json({ error: 'لا توجد حقول صالحة للتحديث' });

  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const idPos = i;
  vals.push(req.user.business_id);

  try {
    const { rowCount } = await pool.query(
      `UPDATE meta_accounts SET ${sets.join(', ')} WHERE id = $${idPos} AND business_id = $${idPos + 1}`,
      vals
    );
    if (!rowCount) return res.status(404).json({ error: 'الحساب الإعلاني غير موجود' });
    res.json({ message: 'تم تحديث الحساب الإعلاني بنجاح' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'معرف حساب الإعلانات مُضاف بالفعل' });
    }
    console.error('[meta/accounts PATCH] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* DELETE /api/meta/accounts/:id — remove an account.  Synced expense rows keep
   their data; their meta_account_id is set NULL by the ON DELETE SET NULL FK. */
router.delete('/accounts/:id', authenticate, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM meta_accounts WHERE id = $1 AND business_id = $2`,
      [id, req.user.business_id]
    );
    if (!rowCount) return res.status(404).json({ error: 'الحساب الإعلاني غير موجود' });
    res.json({ message: 'تم حذف الحساب الإعلاني' });
  } catch (err) {
    console.error('[meta/accounts DELETE] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── Manual SKU overrides ────────────────────────────────────────────────────
   For campaigns that cannot be renamed (deleted, archived, or locked) and
   whose names don't follow the  SKU-<code>  convention, map the exact
   campaign name → raw SKU code here.  The lookup is tried BEFORE the regex
   so it always wins.  Keys are matched case-insensitively after trimming.   */
const CAMPAIGN_OVERRIDES = {
  'جهاز البطن مصر - 11/4': 'MASSAG',
  'جهاز البطن مصر':        'MASSAG',
};

/**
 * Extract a product SKU from a Meta campaign name.
 *
 * Resolution order:
 *   1. CAMPAIGN_OVERRIDES exact match (case-insensitive trim) → bare code
 *   2. Regex  (SKU|صفقة)-<code>  anywhere in the name          → parsed bare code
 *   3. null  — campaign is not attributable to any product
 *
 * Accepts BOTH the Latin "SKU-" tag (e-commerce convention) and the Arabic
 * "صفقة-" tag (Safqa affiliate convention) before the code, case-insensitively.
 * Returns the bare code UPPERCASED with NO prefix.
 *
 * Campaign name patterns handled:
 *   "جهاز البطن مصر - 11\4"               → "MASSAG"     (override)
 *   "مساج البطن العيد - SKU-MASSAG-5\20"   → "MASSAG"     (regex + date strip)
 *   "عيدية الليزر SKU-IPL-PRO-01-20/5"    → "IPL-PRO-01" (regex + date strip)
 *   "فرشة التنظيف - صفقة-yQASPqV"          → "YQASPQV"    (Safqa tag)
 *   "حملة عشوائية"                         → null
 */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Find a KNOWN SKU as a standalone token anywhere in the campaign name. This is
   the most robust matcher — it is prefix-/language-agnostic and immune to the
   RTL marks and character-form variants that make literal "صفقة-" matching
   fragile. knownSkus must be UPPERCASED + trimmed. Longest SKU wins (so a longer
   SKU isn't shadowed by a shorter one that is its substring). A token boundary
   ([^A-Z0-9] or string edge) prevents matching a SKU inside a larger code. */
function findKnownSku(campaignName, knownSkus) {
  if (!campaignName || !Array.isArray(knownSkus) || knownSkus.length === 0) return null;
  const hay = campaignName.toUpperCase();
  const sorted = knownSkus.filter((s) => s && s.length >= 2).sort((a, b) => b.length - a.length);
  for (const sku of sorted) {
    const re = new RegExp('(^|[^A-Z0-9])' + escapeRegex(sku) + '([^A-Z0-9]|$)');
    if (re.test(hay)) return sku;
  }
  return null;
}

/**
 * Extract a product SKU from a Meta campaign name.
 *
 * Resolution order:
 *   1. CAMPAIGN_OVERRIDES exact match                         → bare code
 *   2. KNOWN-SKU match: any catalogue/Safqa SKU present as a
 *      standalone token anywhere in the name (prefix-agnostic) → that SKU
 *   3. Regex  (SKU|صفقة)-<code>  fallback (for SKUs not yet
 *      in the DB, e.g. a brand-new product)                    → parsed code
 *   4. null  — campaign is not attributable to any product
 *
 * @param {string}   campaignName
 * @param {string[]} [knownSkus]  UPPERCASED + trimmed list of valid SKUs.
 */
function extractSku(campaignName, knownSkus = []) {
  if (!campaignName || typeof campaignName !== 'string') return null;

  /* 1 — manual overrides (exact campaign name → code) */
  const key = campaignName.trim().toLowerCase();
  for (const [pattern, code] of Object.entries(CAMPAIGN_OVERRIDES)) {
    if (pattern.trim().toLowerCase() === key) return code.toUpperCase();
  }

  /* 2 — any KNOWN SKU present anywhere (prefix-agnostic, RTL-mark-proof) */
  const known = findKnownSku(campaignName, knownSkus);
  if (known) return known;

  /* 3 — fallback regex: code after "SKU-" (word-bounded) or "صفقة-", trailing
     date suffix stripped (e.g. "-20/5", "_8/12"). Case-insensitive. */
  const match = campaignName.match(/(?:\bSKU|صفقة)[-]\s*([A-Za-z0-9\-_]+)/i);
  if (!match) return null;
  let raw = match[1].replace(/[-_]?\d{1,2}[/\\]\d{1,2}.*$/, '').trim();
  if (!raw) return null;
  return raw.toUpperCase();
}

/* Load the tenant's valid SKUs (catalogue products + Safqa orders) — the
   known-SKU set the gate matches campaign names against. UPPERCASED + trimmed. */
async function loadKnownSkus(businessId) {
  if (businessId == null) return [];
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT UPPER(TRIM(sku)) AS sku
         FROM (
           SELECT sku FROM products
            WHERE business_id = $1::integer AND COALESCE(TRIM(sku), '') <> ''
           UNION
           SELECT sku FROM external_affiliate_orders
            WHERE business_id = $1::integer AND network = 'safqa' AND COALESCE(TRIM(sku), '') <> ''
         ) t
        WHERE COALESCE(TRIM(sku), '') <> ''`,
      [businessId]
    );
    return rows.map((r) => r.sku).filter(Boolean);
  } catch (e) {
    console.warn('[meta/runSync] could not load known SKUs for business', businessId, '—', e.message);
    return [];
  }
}

/* ── Date helpers ─────────────────────────────────────────────────────────── */

/** Returns today's date as a YYYY-MM-DD string in local (server) time. */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Validates that a string is a well-formed YYYY-MM-DD date. */
function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

/* ══════════════════════════════════════════════════════════════════════════
   runMetaSync(startDate, endDate) — Core sync logic (reusable)
   ─────────────────────────────────────────────────────────────────────────
   Callable from the POST /api/meta/sync route AND from the automated
   cron job.  Returns a result object on success; throws a typed Error on
   failure.  err.statusCode tells the route handler which HTTP status to
   send; the cron job just logs err.message.
   ══════════════════════════════════════════════════════════════════════════ */
async function runMetaSync(startDate, endDate, { ignoreCooldown = false, accountId = null, businessId = null } = {}) {
  /* ── Cooldown gate (cron-only — skipped for manual UI syncs) ────────────
     When the previous sync hit an API error we set a 2-hour cooldown so the
     cron doesn't hammer a blocked/rate-limited endpoint.  Manual syncs from
     the UI always pass ignoreCooldown = true so they bypass this and let the
     admin test a fresh token immediately.                                    */
  if (!ignoreCooldown && isCronCoolingDown()) {
    const e = new Error('API_COOLDOWN');
    e.statusCode  = 400;
    e.isCooldown  = true;
    throw e;
  }

  /* ── Load the active Meta accounts to sync ──────────────────────────────────
     Multi-account: we sync every active account (or a single one when accountId
     is supplied).  Each campaign-day expense row is stamped with the owning
     meta_account_id so the dashboard can scope spend per Media Buyer.
     The legacy single-account settings rows are auto-migrated into the
     meta_accounts table on boot (migrateLegacyMetaAccount), so this path also
     covers pre-existing installs.                                             */
  let accounts;
  try {
    accounts = await loadMetaAccounts({ activeOnly: true, accountId, businessId });
  } catch (e) {
    console.error('[meta/runSync] Account load error:', e.message);
    const err = new Error('خطأ في قراءة حسابات Meta من قاعدة البيانات');
    err.statusCode = 500;
    throw err;
  }
  if (!accounts.length) {
    const e = new Error('لا توجد حسابات Meta نشطة. أضف حساباً إعلانياً في صفحة الإعدادات أولاً.');
    e.statusCode = 400;
    throw e;
  }

  /* ── Sync each account, aggregating the results ─────────────────────────── */
  const agg = {
    totalSpend:           0,
    campaignRowsInserted: 0,
    insertedDates:        new Set(),
    daysReceived:         new Set(),
    accounts:             [],
  };

  /* ISOLATE per-account failures. Previously this loop had no try/catch, so a
     single failing account (bad/expired token, no access to that ad_account, or a
     429) THREW and aborted the whole run — leaving that account AND every account
     after it with zero spend, while the ones before it had already been written.
     That's exactly how a newly-added agency account (synced last) ended up with
     no data. Now each account is independent; failures are collected and surfaced
     so the admin sees WHICH account failed and WHY (e.g. the System-User token
     lacks access to that ad account). Cooldown, if the failure was API-side, was
     already set inside syncSingleAccount. */
  const acctErrors = [];
  for (const acct of accounts) {
    console.log(`[meta/runSync] ▶ Account #${acct.id} "${acct.accountName}" (act_${acct.adAccountId})`);
    try {
      const r = await syncSingleAccount(acct, startDate, endDate);
      agg.totalSpend           += r.totalSpend;
      agg.campaignRowsInserted += r.campaignRowsInserted;
      r.insertedDates.forEach((d) => agg.insertedDates.add(d));
      r.daysReceived.forEach((d) => agg.daysReceived.add(d));
      agg.accounts.push({
        id:                   acct.id,
        accountName:          acct.accountName,
        totalSpend:           parseFloat(r.totalSpend.toFixed(2)),
        campaignRowsInserted: r.campaignRowsInserted,
      });
    } catch (e) {
      console.error(`[meta/runSync] ✖ Account #${acct.id} "${acct.accountName}" (act_${acct.adAccountId}) FAILED: ${e.message}`);
      acctErrors.push({
        id:          acct.id,
        accountName: acct.accountName,
        adAccountId: acct.adAccountId,
        error:       e.message,
        metaCode:    e.metaCode ?? null,
      });
    }
  }

  /* Every account failed → surface a hard error (cooldown already set if API-side). */
  if (accounts.length > 0 && acctErrors.length === accounts.length) {
    const e = new Error(`فشلت مزامنة جميع حسابات Meta (${accounts.length}). أول خطأ: ${acctErrors[0].error}`);
    e.statusCode    = acctErrors[0].metaCode ? 502 : 400;
    if (acctErrors[0].metaCode) e.metaCode = acctErrors[0].metaCode;
    e.accountErrors = acctErrors;
    throw e;
  }

  const totalSpendRounded = parseFloat(agg.totalSpend.toFixed(2));
  console.log(
    `[meta/runSync] ✅ DONE — ${agg.accounts.length}/${accounts.length} account(s) ok` +
    (acctErrors.length ? `, ${acctErrors.length} FAILED` : '') +
    `, ${agg.campaignRowsInserted} campaign-day row(s), total spend: ${totalSpendRounded}`
  );

  return {
    message:              `تم سحب مصروفات الفترة من ${startDate} إلى ${endDate} لعدد ${agg.accounts.length} حساب`
                          + (acctErrors.length ? ` (فشل ${acctErrors.length} حساب — راجع التفاصيل)` : ' بنجاح'),
    startDate,
    endDate,
    totalSpend:           totalSpendRounded,
    daysInserted:         agg.insertedDates.size,
    daysReceived:         agg.daysReceived.size,
    campaignRowsInserted: agg.campaignRowsInserted,
    accountsSynced:       agg.accounts.length,
    accountsFailed:       acctErrors.length,
    accounts:             agg.accounts,
    accountErrors:        acctErrors,
    synced_at:            new Date().toISOString(),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   syncSingleAccount(acct, startDate, endDate) — sync ONE Meta ad account
   ─────────────────────────────────────────────────────────────────────────
   acct = { id, accountName, adAccountId (act_ stripped), accessToken, ... }
   Paginates the Graph API for this account, then UPSERTs each campaign-day
   row into expenses tagged with meta_account_id = acct.id.
   Returns { totalSpend, campaignRowsInserted, insertedDates:Set, daysReceived:Set }.
   Throws a typed Error (with .statusCode) on API / DB failure.
   ══════════════════════════════════════════════════════════════════════════ */
async function syncSingleAccount(acct, startDate, endDate) {
  const adAccountId = acct.adAccountId;
  const accessToken = acct.accessToken;
  const metaAccountId = acct.id;
  const businessId    = acct.businessId;

  if (!adAccountId || !accessToken) {
    const e = new Error(`بيانات الحساب "${acct.accountName}" غير مكتملة (معرف الحساب أو التوكن مفقود).`);
    e.statusCode = 400;
    throw e;
  }

  /* ── Paginate Meta Graph API ────────────────────────────────────────────────
     fields=spend,campaign_name,actions  — spend for the expense ledger,
       campaign_name for SKU extraction, actions for purchase conversion count.

     level=campaign  — matches the "Amount Spent" figure in Ads Manager
       (excludes account-level surcharges that level=account includes).

     time_increment=1  — one row per campaign per day.
     limit=100         — fewer round-trips (Meta default is 25).
     Safety cap (MAX_PAGES = 50) prevents infinite loops from circular cursors.
     All data accumulates BEFORE any DB write so a mid-pagination failure
     never leaves partial rows in the DB.
  ───────────────────────────────────────────────────────────────────────────── */
  const MAX_PAGES = 50;
  const allData   = [];

  /* date_start is requested explicitly so it's guaranteed in every row.
     Meta includes it automatically with time_increment=1, but requesting
     it in fields prevents any edge-case where the implicit field is absent. */
  const firstUrl = `${META_GRAPH}/act_${adAccountId}/insights`
    + `?fields=date_start,spend,campaign_name,actions`
    + `&time_range=${encodeURIComponent(JSON.stringify({ since: startDate, until: endDate }))}`
    + `&time_increment=1`
    + `&level=campaign`
    + `&limit=100`
    + `&access_token=${encodeURIComponent(accessToken)}`;

  let nextUrl      = firstUrl;
  let pagesFetched = 0;

  while (nextUrl) {
    if (pagesFetched >= MAX_PAGES) {
      console.warn(`[meta/runSync] ⚠️  Reached MAX_PAGES (${MAX_PAGES}) safety cap — stopping pagination.`);
      break;
    }

    let body;
    try {
      const response = await axios.get(nextUrl, { timeout: 20_000 });
      body = response.data;
    } catch (e) {
      console.log('[RAW META ERROR]:', JSON.stringify(e.response?.data || e.message, null, 2));
      const metaErr = e.response?.data?.error;
      if (metaErr) {
        /* Activate cooldown — DB is untouched; existing data is safe.        */
        setCronCooldown();
        const msg = classifyMetaError(metaErr);
        console.error(`[meta/runSync] Meta API HTTP error (page ${pagesFetched + 1}):`, metaErr);
        const err      = new Error(msg);
        err.statusCode = 400;
        err.metaCode   = metaErr.code;
        throw err;
      }
      const isTimeout = e.code === 'ECONNABORTED' || e.message?.includes('timeout');
      console.error(`[meta/runSync] Network/timeout error (page ${pagesFetched + 1}):`, e.message);
      const errMsg   = isTimeout
        ? `انتهت مهلة الاتصال بـ Meta API في الصفحة ${pagesFetched + 1}. حاول مجدداً.`
        : `تعذّر الاتصال بـ Meta API: ${e.message}`;
      const err      = new Error(errMsg);
      err.statusCode = 502;
      throw err;
    }

    /* Meta occasionally returns HTTP 200 with an error payload */
    if (body?.error) {
      console.log('[RAW META ERROR]:', JSON.stringify(body.error, null, 2));
      /* Activate cooldown — DB is untouched; existing data is safe.          */
      setCronCooldown();
      const msg      = classifyMetaError(body.error);
      console.error(`[meta/runSync] Meta API error-in-200 (page ${pagesFetched + 1}):`, body.error);
      const err      = new Error(msg);
      err.statusCode = 400;
      err.metaCode   = body.error.code;
      throw err;
    }

    const pageRows = Array.isArray(body?.data) ? body.data : [];
    allData.push(...pageRows);
    pagesFetched++;
    console.log(`[meta/runSync]   page ${pagesFetched}: ${pageRows.length} row(s) (total: ${allData.length})`);

    nextUrl = body?.paging?.next || null;
  }

  console.log(`[meta/runSync] ✅ Pagination done — ${pagesFetched} page(s), ${allData.length} row(s)`);

  /* ── Idempotent DB write ─────────────────────────────────────────────────
     a. DELETE existing Meta-sync rows for this date range (idempotency).
     b. INSERT one campaign-day row per allData entry with spend > 0.
        Each row includes:
          • description   = campaign name
          • sku           = parsed SKU (null when not attributable)
          • meta_sync     = TRUE
          • meta_purchases = Meta-reported purchase conversions for this
                             campaign-day row (from the actions array)
  ────────────────────────────────────────────────────────────────────────── */
  const CATEGORY    = 'إعلانات ميتا وتيك توك';
  const LEGACY_DESC = 'سحب تلقائي من Meta API';

  try {
    /* 3a — DISABLED: hard-flush removed to protect existing data.
       The UPSERT below handles idempotency: rows that already exist for the
       same (expense_date, campaign_name) are updated in-place; new rows are
       inserted.  No data is ever destroyed.
    // const del = await pool.query(`DELETE FROM expenses WHERE meta_sync = TRUE`);
    // console.log(`[meta/runSync] 🗑️  Hard-flushed ${del.rowCount} stale Meta row(s)`);
    */

    /* 3b — AGGREGATE then UPSERT.
       ───────────────────────────────────────────────────────────────────────
       AD-SPEND LEAK FIX. The UPSERT conflict key is (expense_date,
       campaign_name, business_id). Meta returns one row per campaign per day,
       but DISTINCT campaigns can share an identical name — e.g. a duplicated
       campaign keeps the original name plus "- نسخة" (copy). Upserting the raw
       rows one-by-one made the second same-named campaign OVERWRITE the first
       (DO UPDATE SET amount = EXCLUDED.amount), silently dropping the earlier
       campaign's spend for that day (observed: 1,477.58 EGP lost on 2026-06-01).

       Fix: pre-aggregate all API rows by (date_start, campaign_name), SUMMING
       spend and purchases, and write ONE combined row per key. We keep
       overwrite-on-conflict (NOT additive) so a re-run stays idempotent — each
       sync recomputes the full per-key total and overwrites, never doubling.
       Purchases ARE additive here because the merged rows are genuinely
       different campaigns (each value is already de-duped across attribution
       windows via the MAX below).                                             */
    const groups = new Map();   // `${rowDate}|${campaignName}` → { rowDate, campaignName, spend, metaPurchases }

    for (const row of allData) {
      /* rowDate is taken strictly from the row's own date_start field, so every
         campaign-day lands on its correct calendar date. */
      const rowDate = row.date_start;
      if (!rowDate || !isValidDate(rowDate)) {
        console.warn(`[meta/runSync] Skipping — invalid date_start: "${rowDate}" (campaign: "${row.campaign_name}")`);
        continue;
      }
      const campaignName = (typeof row.campaign_name === 'string' && row.campaign_name.trim())
        ? row.campaign_name.trim()
        : LEGACY_DESC;
      const spend = parseFloat(row.spend) || 0;

      /* Meta-reported purchases. The SAME conversion is reported under multiple
         action_type names ("purchase", "offsite_conversion.fb_pixel_purchase",
         "omni_purchase", custom names…) across attribution windows — these are
         NOT additive, so we take the MAXIMUM (the highest de-duped variant) for
         THIS campaign-day before aggregating distinct campaigns together.       */
      let metaPurchases = 0;
      if (Array.isArray(row.actions)) {
        const purchaseActions = row.actions.filter(
          (a) => a.action_type && a.action_type.toLowerCase().includes('purchase')
        );
        if (purchaseActions.length > 0) {
          metaPurchases = Math.max(...purchaseActions.map((a) => parseInt(a.value, 10) || 0));
        }
      }

      const key = `${rowDate}|${campaignName}`;
      const g = groups.get(key);
      if (g) {
        g.spend         += spend;
        g.metaPurchases += metaPurchases;   // distinct same-named campaigns → additive
      } else {
        groups.set(key, { rowDate, campaignName, spend, metaPurchases });
      }
    }

    if (allData.length === 0) {
      console.warn('[meta/runSync] ⚠️  Meta API returned 0 rows for this date range — nothing to insert. Existing DB data is unchanged.');
    } else if (groups.size < allData.length) {
      console.log(
        `[meta/runSync] 🧮 Aggregated ${allData.length} API row(s) → ${groups.size} unique (date,campaign) key(s) ` +
        `— merged ${allData.length - groups.size} same-name collision(s) that would otherwise overwrite each other.`
      );
    }

    const insertedDates = new Set();
    let   insertedCount = 0;
    let   totalSpend    = 0;

    /* Tenant's known SKUs (catalogue + Safqa) — the gate matches campaign names
       against these as standalone tokens, prefix-/language-agnostic, so a SKU
       present ANYWHERE in the name (e.g. "… - صفقة-yQASPqV") attributes correctly
       even when the prefix/Arabic tag varies. Loaded ONCE per account. */
    const knownSkus = await loadKnownSkus(businessId);
    /* Tenant-ownership set: ONLY SKUs this business actually owns (its catalogue
       products + its own Safqa orders). UPPERCASED+trimmed by loadKnownSkus. */
    const knownSkuSet = new Set(knownSkus);

    /* Build the rows to write (past the zero-spend + strict SKU gate). */
    const rowsToWrite = [];
    for (const g of groups.values()) {
      const spend = parseFloat(g.spend.toFixed(2));
      if (spend <= 0) {
        console.log(`[meta/runSync] ⏭️  Skipping zero-spend key: ${g.rowDate} | "${g.campaignName}"`);
        continue;
      }
      /* STRICT TENANT-SCOPED SKU GATE — keep a campaign ONLY when its parsed SKU is
         one THIS tenant actually owns (catalogue product or its own Safqa SKU).
         A bare "SKU-"/"صفقة-" tag is NOT sufficient: one Meta ad account is often
         shared across businesses (e.g. an e-commerce account that ALSO runs another
         tenant's affiliate/Safqa campaigns). extractSku's fallback regex will parse
         such a foreign tag, so we re-validate the result against the tenant's
         known-SKU set here and DROP anything it doesn't own — otherwise that foreign
         spend pollutes this tenant's "All Products" total. Brand/awareness/generic
         campaigns (no SKU at all) are likewise ignored. */
      const skuRaw = extractSku(g.campaignName, knownSkus);
      if (skuRaw === null || !knownSkuSet.has(skuRaw)) {
        console.log(`[meta/runSync] ⏭️  Ignoring campaign — SKU "${skuRaw ?? 'none'}" not owned by tenant ${businessId}: ${g.rowDate} | "${g.campaignName}" (spend ${spend} dropped)`);
        continue;
      }
      rowsToWrite.push({ date: g.rowDate, name: g.campaignName, spend, purchases: g.metaPurchases, sku: skuRaw });
    }

    /* ── REPLACE-IN-RANGE (rename-safe) ──────────────────────────────────────
       The conflict key is (expense_date, campaign_name, business_id), so when a
       campaign is RENAMED in Meta, a re-sync of the same date would INSERT a new
       row under the new name and leave the OLD-name row behind (stale name +
       double spend). To make renames take effect cleanly, we DELETE this
       account's meta_sync rows in [startDate, endDate] and re-insert the fresh
       set — atomically, and ONLY when Meta actually returned rows to write, so a
       transient empty/partial response can never wipe existing data. */
    if (allData.length > 0 && rowsToWrite.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const del = await client.query(
          `DELETE FROM expenses
            WHERE meta_sync = TRUE AND business_id = $1 AND meta_account_id = $2
              AND expense_date >= $3::date AND expense_date <= $4::date`,
          [businessId, metaAccountId, startDate, endDate]
        );
        console.log(`[meta/runSync] 🔄 Replace-in-range: cleared ${del.rowCount} existing row(s) for ${startDate}→${endDate}, account #${metaAccountId}`);

        for (const r of rowsToWrite) {
          await client.query(
            `INSERT INTO expenses
               (expense_date, campaign_name, amount, meta_purchases, meta_sync, sku, meta_account_id, business_id, category)
             VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, 'إعلانات ميتا وتيك توك')
             ON CONFLICT (expense_date, campaign_name, business_id)
             DO UPDATE SET
               amount          = EXCLUDED.amount,
               meta_purchases  = EXCLUDED.meta_purchases,
               sku             = EXCLUDED.sku,
               meta_account_id = EXCLUDED.meta_account_id,
               category        = EXCLUDED.category`,
            [r.date, r.name, r.spend, r.purchases, r.sku, metaAccountId, businessId]
          );
          totalSpend += r.spend;
          insertedCount++;
          insertedDates.add(r.date);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      console.log(`[meta/runSync] ✅ Wrote ${insertedCount} campaign-day row(s) for account #${metaAccountId}`);
    }

    const totalSpendRounded = parseFloat(totalSpend.toFixed(2));
    console.log(
      `[meta/runSync]   account #${metaAccountId} done — ${insertedCount} campaign-day row(s), ` +
      `${insertedDates.size} unique date(s), total spend: ${totalSpendRounded}`
    );

    return {
      totalSpend:           totalSpend,
      campaignRowsInserted: insertedCount,
      insertedDates,
      daysReceived:         new Set(allData.map((r) => r.date_start).filter(Boolean)),
    };

  } catch (e) {
    if (e.statusCode) throw e;
    console.error('[meta/runSync] DB write error:', e.message);
    const err = new Error('خطأ في حفظ البيانات في قاعدة البيانات');
    err.statusCode = 500;
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   POST /api/meta/sync  — thin HTTP wrapper around runMetaSync()
   Body (all optional): { startDate?: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD' }
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/sync', authenticate, requireAdmin, async (req, res) => {
  const today     = todayLocal();
  const startDate = req.body.startDate || today;
  const endDate   = req.body.endDate   || today;

  if (!isValidDate(startDate)) {
    return res.status(400).json({ error: `تاريخ البداية غير صالح: "${startDate}". استخدم صيغة YYYY-MM-DD.` });
  }
  if (!isValidDate(endDate)) {
    return res.status(400).json({ error: `تاريخ النهاية غير صالح: "${endDate}". استخدم صيغة YYYY-MM-DD.` });
  }
  if (startDate > endDate) {
    return res.status(400).json({ error: 'تاريخ البداية يجب أن يكون قبل أو مساوياً لتاريخ النهاية.' });
  }

  console.log(`[meta/sync] Date range: ${startDate} → ${endDate}`);

  try {
    /* ignoreCooldown: true — manual syncs from the UI always bypass the
       cron cooldown so the admin can immediately test a refreshed token.
       businessId scopes the sync to ONLY the caller's own ad accounts.     */
    const result = await runMetaSync(startDate, endDate, {
      ignoreCooldown: true,
      businessId: req.user.business_id,
    });
    res.json(result);
  } catch (err) {
    if (err.statusCode === 400) {
      const body = { error: err.message };
      if (err.metaCode) body.meta_code = err.metaCode;
      return res.status(400).json(body);
    }
    if (err.statusCode === 502) {
      return res.status(502).json({ error: err.message });
    }
    console.error('[meta/sync] Unexpected error:', err);
    res.status(500).json({ error: err.message || 'خطأ داخلي في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/meta/test-token?account_id=<id>
   ─────────────────────────────────────────────────────────────────────────
   Lightweight token validity probe: loads ONE meta_accounts row (the exact same
   source + token the sync uses) and makes a cheap Graph call
   (GET /act_<id>?fields=name). Lets the UI confirm a token BEFORE trusting the
   cron. Always HTTP 200 when the probe RAN — { success } tells the outcome, and
   the precise Meta code / error_subcode are surfaced for display.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/test-token', authenticate, requireAdmin, async (req, res) => {
  const accountId = Number.parseInt(req.query.account_id ?? req.query.id, 10);
  if (!Number.isInteger(accountId)) {
    return res.status(400).json({ error: 'account_id مطلوب (رقم صحيح)' });
  }

  let acct;
  try {
    /* activeOnly:false so a just-deactivated account can still be tested;
       businessId scopes strictly to the caller's tenant. */
    const accounts = await loadMetaAccounts({
      activeOnly: false, accountId, businessId: req.user.business_id,
    });
    if (!accounts.length) {
      return res.status(404).json({ error: 'الحساب الإعلاني غير موجود' });
    }
    acct = accounts[0];
  } catch (e) {
    console.error('[meta/test-token] account load error:', e.message);
    return res.status(500).json({ error: 'خطأ في قراءة الحساب من قاعدة البيانات' });
  }

  if (!acct.accessToken || !acct.adAccountId) {
    return res.json({
      success: false,
      account_id: acct.id,
      error: 'التوكن أو معرف حساب الإعلانات مفقود في هذا الحساب.',
    });
  }

  const url = `${META_GRAPH}/act_${acct.adAccountId}`
    + `?fields=name,account_status`
    + `&access_token=${encodeURIComponent(acct.accessToken)}`;

  try {
    const r = await axios.get(url, { timeout: 12_000 });
    return res.json({
      success:       true,
      account_id:    acct.id,
      ad_account_id: acct.adAccountId,
      account_name:  r.data?.name ?? null,
      token_length:  acct.accessToken.length,
      message:       `التوكن صالح ✓ — ${r.data?.name ?? 'حساب إعلاني'}`,
    });
  } catch (e) {
    const metaErr = e.response?.data?.error;
    console.warn(`[meta/test-token] account #${acct.id} failed: code=${metaErr?.code ?? '—'} subcode=${metaErr?.error_subcode ?? '—'} ${metaErr?.message ?? e.message}`);
    return res.json({
      success:       false,
      account_id:    acct.id,
      ad_account_id: acct.adAccountId,
      token_length:  acct.accessToken.length,
      meta_code:     metaErr?.code ?? null,
      meta_subcode:  metaErr?.error_subcode ?? null,
      meta_type:     metaErr?.type ?? null,
      meta_message:  metaErr?.message ?? e.message,
      error:         metaErr ? classifyMetaError(metaErr) : 'تعذّر الاتصال بخوادم Meta.',
    });
  }
});

/* ── TEMPORARY DEBUG: inspect raw expenses rows written by Meta sync ──────── */
router.get('/debug-expenses', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, expense_date, description, amount, sku, meta_sync, meta_purchases
       FROM expenses
       WHERE meta_sync = true AND business_id = $1
       ORDER BY expense_date DESC
       LIMIT 50`,
      [req.user.business_id]
    );
    console.log('[DEBUG] /debug-expenses returned', result.rowCount, 'rows');
    res.json(result.rows);
  } catch (err) {
    console.error('[DEBUG] /debug-expenses error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── TEMPORARY DEBUG: dry-run Meta API call — no DB writes ───────────────── */
/* Call: GET /api/meta/debug-api?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   Returns the first 20 raw rows the Meta API sends back so we can confirm
   that credentials, account ID, and date range are all correct.            */
router.get('/debug-api', authenticate, requireAdmin, async (req, res) => {
  try {
    const { adAccountId, accessToken, isConfigured } = await loadMetaConfig(req.user.business_id);
    if (!isConfigured) {
      return res.status(400).json({ error: 'Meta credentials not configured. Go to /integrations/meta and save them first.' });
    }

    const today      = todayLocal();
    const startDate  = req.query.startDate || today;
    const endDate    = req.query.endDate   || today;

    const url = `${META_GRAPH}/act_${adAccountId}/insights`
      + `?fields=date_start,spend,campaign_name,actions`
      + `&time_range=${encodeURIComponent(JSON.stringify({ since: startDate, until: endDate }))}`
      + `&time_increment=1`
      + `&level=campaign`
      + `&limit=20`
      + `&access_token=${encodeURIComponent(accessToken)}`;

    console.log('[DEBUG /debug-api] Calling Meta for range:', startDate, '→', endDate);
    const response = await axios.get(url, { timeout: 20_000 });
    const rows     = Array.isArray(response.data?.data) ? response.data.data : [];

    const knownSkus = await loadKnownSkus(req.user.business_id);
    const summary = rows.map((r) => ({
      date_start:    r.date_start,
      campaign_name: r.campaign_name,
      spend:         r.spend,
      sku_parsed:    extractSku(r.campaign_name, knownSkus) ?? '(UNATTRIBUTED)',
      actions:       Array.isArray(r.actions) ? r.actions : [],
    }));

    console.log('[DEBUG /debug-api] Meta returned', rows.length, 'row(s)');
    res.json({
      range:      { startDate, endDate },
      rowCount:   rows.length,
      adAccountId,
      rows:       summary,
    });
  } catch (err) {
    const metaErr = err.response?.data?.error;
    console.error('[DEBUG /debug-api] Error:', metaErr || err.message);
    res.status(500).json({
      error:    metaErr ? classifyMetaError(metaErr) : err.message,
      metaCode: metaErr?.code ?? null,
    });
  }
});

/* ── Exports ─────────────────────────────────────────────────────────────── */
module.exports = router;
module.exports.runMetaSync      = runMetaSync;
module.exports.isCronCoolingDown = isCronCoolingDown;
