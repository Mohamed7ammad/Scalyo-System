const express      = require('express');
const axios        = require('axios');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

const BOSTA_BASE = 'https://api.bosta.co/api/v2';

/* ── Idempotent migrations — safe to run on every startup ─────────── */

/* 1. BostaTrackingCode column on orders */
pool.query(`
  ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS "BostaTrackingCode" VARCHAR(100)
`)
  .then(() => console.log('✅  Shipping: BostaTrackingCode column ready'))
  .catch((err) => console.warn('⚠️   Shipping column check:', err.message));

/* 2. shipping_settings table — SaaS credential store.
   Stores API keys / tokens for each shipping provider in the DB so
   credentials can be updated from the dashboard without touching .env.
   provider_name is the natural PK (e.g. 'bosta').
   NULLIF / COALESCE in the UPSERT route ensures partial updates never
   overwrite existing values with empty strings.                        */
pool.query(`
  CREATE TABLE IF NOT EXISTS shipping_settings (
    provider_name   VARCHAR(50)   PRIMARY KEY,
    api_key         TEXT,
    bearer_token    TEXT,
    webhook_secret  TEXT,
    is_active       BOOLEAN       NOT NULL DEFAULT true,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  )
`)
  .then(() => console.log('✅  Shipping: shipping_settings table ready'))
  .catch((err) => console.warn('⚠️   shipping_settings table check:', err.message));

/* 3. email / password columns for Bosta dashboard auto-login.
   Bosta business-dashboard bearer tokens expire often; storing the login
   credentials lets bosta.js silently refresh the token on a 401 instead of
   forcing a human to paste a new token. Idempotent ADD COLUMN IF NOT EXISTS. */
pool.query(`
  ALTER TABLE shipping_settings
    ADD COLUMN IF NOT EXISTS email    TEXT,
    ADD COLUMN IF NOT EXISTS password TEXT
`)
  .then(() => console.log('✅  Shipping: shipping_settings email/password columns ready'))
  .catch((err) => console.warn('⚠️   shipping_settings email/password check:', err.message));

/* ── Helpers ─────────────────────────────────────────────────────── */

/** Normalise Egyptian mobile numbers to +201XXXXXXXXX */
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('20') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0')  && digits.length === 11) return `+20${digits.slice(1)}`;
  if (digits.length === 10)                             return `+20${digits}`;
  return raw; // return as-is if format is unexpected
}

/** Split FullName into Bosta's firstName / lastName */
function splitName(fullName) {
  const parts = (fullName || 'عميل').trim().split(/\s+/);
  return {
    firstName: parts[0]                    || 'عميل',
    lastName:  parts.slice(1).join(' ')    || '.',
  };
}

/** Parse a price string (e.g. "150 ج.م" or "150.5") to a float COD value */
function parseCod(price) {
  return parseFloat(String(price ?? '0').replace(/[^\d.]/g, '')) || 0;
}

/**
 * Calculate the net COD amount Bosta should collect from the customer.
 *
 * If the customer already paid a deposit (عربون / ديبوزت), that amount is
 * subtracted from the full product price so the courier doesn't overcharge.
 *
 *   cod = ProductPrice − depositAmount   (minimum: 0, never negative)
 *
 * The result is floored to 2 decimal places (Bosta expects a number, not
 * a string).  Free-shipping / zero-price orders correctly produce 0.
 */
function calcCod(order) {
  const fullPrice = parseCod(order.ProductPrice);
  const deposit   = Math.max(0, parseFloat(order.depositAmount) || 0);
  const net       = Math.max(0, fullPrice - deposit);
  console.log(
    `[calcCod] order=${order.id} | price=${fullPrice} − deposit=${deposit} = COD ${net}`
  );
  return parseFloat(net.toFixed(2));
}

/* ── Bosta official city slug map (Arabic → English) ─────────────
   Bosta validates the city field against their own list.
   Keys are trimmed Arabic names as they typically appear in orders.

   IMPORTANT — NO HYPHENS: Bosta's city registry uses space-separated
   English names (e.g. "Kafr El Sheikh"), NOT hyphenated forms
   ("Kafr El-Sheikh").  Sending a hyphenated value causes Bosta to
   silently fall back to "Cairo" on the printed waybill.
   ──────────────────────────────────────────────────────────────── */
const CITY_MAP = {
  // Greater Cairo & surroundings
  'القاهرة':                   'Cairo',
  'الجيزة':                    'Giza',
  'شبرا الخيمة':               'Shoubra El Kheima',
  'مدينة نصر':                 'Nasr City',
  'حلوان':                     'Helwan',
  'العبور':                    'El Obour',
  'الشروق':                    'El Shorouk',
  'بدر':                       'Badr City',
  'المقطم':                    'El Moqattam',
  'السادس من أكتوبر':          '6th Of October',
  'مدينة السادس من أكتوبر':    '6th Of October',
  '6 أكتوبر':                  '6th Of October',
  'أكتوبر':                    '6th Of October',
  '15 مايو':                   '15th May City',
  'العاشر من رمضان':           '10th Of Ramadan',
  // Delta
  'الإسكندرية':                'Alexandria',
  'اسكندرية':                  'Alexandria',   // variant without hamza
  'إسكندرية':                  'Alexandria',   // variant with different hamza
  'المنصورة':                  'Mansoura',
  'طنطا':                      'Tanta',
  'الزقازيق':                  'Zagazig',
  'دمياط':                     'Damietta',
  'كفر الشيخ':                 'Kafr El Sheikh',   // ← no hyphen (Bosta registry)
  'كفرالشيخ':                  'Kafr El Sheikh',   // variant without space
  'دمنهور':                    'Damanhour',
  'بنها':                      'Banha',
  'شبين الكوم':                'Shebin El Kom',
  'المحلة الكبرى':             'El Mahalla El Kubra',
  'المحلة':                    'El Mahalla El Kubra',
  'كفر الدوار':                'Kafr El Dawar',
  'طلخا':                      'Talha',
  'ميت غمر':                   'Meet Ghamr',
  'أبو كبير':                  'Abu Kebir',
  'بلبيس':                     'Bilbeis',
  'هرم':                       'Haram',
  'فيصل':                      'Faisal',
  'إمبابة':                    'Imbaba',
  'عين شمس':                   'Ain Shams',
  'المطرية':                   'El Mataria',
  'مصر الجديدة':               'Heliopolis',
  'التجمع':                    'New Cairo',
  'التجمع الخامس':             'New Cairo',
  'القاهرة الجديدة':           'New Cairo',
  // Canal Zone
  'بورسعيد':                   'Port Said',
  'الإسماعيلية':               'Ismailia',
  'إسماعيلية':                 'Ismailia',
  'السويس':                    'Suez',
  // Upper Egypt
  'الأقصر':                    'Luxor',
  'أسوان':                     'Aswan',
  'المنيا':                    'Minya',
  'أسيوط':                     'Asyut',
  'سوهاج':                     'Sohag',
  'قنا':                       'Qena',
  'بني سويف':                  'Beni Suef',
  'بنى سويف':                  'Beni Suef',   // alternate spelling
  'الفيوم':                    'Fayoum',
  'فيوم':                      'Fayoum',
  // Red Sea / Sinai / Frontier
  'الغردقة':                   'Hurghada',
  'شرم الشيخ':                 'Sharm El Sheikh',  // ← no hyphen (Bosta registry)
  'شرم':                       'Sharm El Sheikh',
  'مرسى مطروح':                'Mersa Matruh',
  'مطروح':                     'Mersa Matruh',
  'العريش':                    'Arish',
  'رأس السدر':                 'Ras Sedr',
  'سفاجا':                     'Safaga',
  'الأقصر':                    'Luxor',
  'طابا':                      'Taba',
};

/**
 * Resolve an Arabic (or already-English) city name to the Bosta slug.
 * Falls back to the raw value if already English, or 'Cairo' if blank.
 */
function normalizeCity(raw) {
  if (!raw) return 'Cairo';
  const trimmed = raw.trim();
  if (CITY_MAP[trimmed]) return CITY_MAP[trimmed];
  // If the string contains no Arabic characters, assume it's already an
  // English slug and pass it through unchanged.
  if (!/[؀-ۿ]/.test(trimmed)) return trimmed;
  // Unknown Arabic name — pass raw and let Bosta's validation surface it
  // (the error log will capture any rejection).
  console.warn(`⚠️  Bosta: unknown city name "${trimmed}", sending as-is`);
  return trimmed;
}

/** Map one DB order row to a Bosta delivery payload */
function toBosta(order, allowOpen = false) {
  const { firstName, lastName } = splitName(order.FullName);
  const city    = normalizeCity(order.City || order.Governorate);
  const isAllowed = allowOpen === true;

  // Diagnostic: confirm resolved values before sending to Bosta
  console.log(
    `[toBosta] order=${order.id} | city_raw="${order.City || order.Governorate}"` +
    ` → city_resolved="${city}" | allowOpen=${allowOpen} → isAllowed=${isAllowed}`
  );

  const addressBlock = {
    city,
    zone:      order.Zone     || '',
    district:  order.District || '',
    firstLine: order.Address  || '',
  };

  return {
    type: 10, // Bosta standard integer ID for regular forward delivery

    // ── Package-opening flag — all known Bosta V2 field variants ──
    allowToOpenPackage:     isAllowed, // ✅ PRIMARY V2 field (drives waybill print)
    allowExploration:       isAllowed, // root-level v2 alternate A
    isAllowedToOpenPackage: isAllowed, // root-level v2 alternate B
    openPackage:            isAllowed, // v2 alternate C
    allowInspection:        isAllowed, // v2 alternate D

    specs: {
      allowToOpenPackage:     isAllowed, // ✅ specs-level primary
      allowExploration:       isAllowed, // specs-level alternate A
      isAllowedToOpenPackage: isAllowed, // specs-level alternate B
      packageDetails: {
        description:          order.ProductName || 'منتج',
        itemsCount:           order.Quantity    || 1,
        allowToOpenPackage:   isAllowed, // nested primary
        allowExploration:     isAllowed, // nested alternate
      },
    },

    // Both casing variants — Bosta V2 inconsistently uses both across endpoints
    dropOffAddress: addressBlock,
    dropoffAddress: addressBlock,

    receiver: {
      firstName,
      lastName,
      phone: normalizePhone(order.Phone),
      email: order.Email || 'customer@example.com',
    },
    // Net COD = full price − deposit already paid (never negative)
    cod: calcCod(order),
  };
}

/* ── GET /api/shipping/pending ────────────────────────────────────
   Returns the count of confirmed orders not yet forwarded.
   Used by the frontend to show a badge on the shipping button.     */
router.get('/pending', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS count
      FROM   orders
      WHERE  "Status" = 'تم التأكيد'
        AND  "BostaTrackingCode" IS NULL
        AND  business_id = $1
    `, [req.user.business_id]);
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) {
    console.error('Shipping /pending error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/shipping/forward ───────────────────────────────────
   Forwards every confirmed-but-not-yet-shipped order to Bosta.
   On success: stores the tracking code + marks order as "تم الشحن".
   Each order is processed independently — one failure won't abort
   the rest of the batch.                                            */
router.post('/forward', authenticate, requireAdmin, async (req, res) => {
  const { allowOpen = false, limit } = req.body;

  /* ── Optional batch quota ─────────────────────────────────────────
     The client may cap how many confirmed orders are shipped in this
     run (shipping-package limits).  Accept only a positive integer;
     anything else (undefined, 0, negative, non-numeric) means "no cap"
     → ship the whole pending queue, preserving the previous behaviour. */
  const parsedLimit = Number.parseInt(limit, 10);
  const batchLimit  = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;

  /* ── Read api_key from DB (Phase 1: SaaS credential store) ────────
     Falls back to process.env.BOSTA_API_KEY so existing deployments
     that haven't migrated yet continue to work during the transition. */
  const businessId = req.user.business_id;
  let apiKey;
  let keySource = 'none';   // 'db' | 'env' | 'none' — surfaced in logs for diagnosis
  try {
    const { rows: credRows } = await pool.query(
      `SELECT api_key FROM shipping_settings WHERE provider_name = 'bosta' AND is_active = true AND business_id = $1`,
      [businessId]
    );
    const dbKey  = credRows[0]?.api_key && String(credRows[0].api_key).trim();
    const envKey = process.env.BOSTA_API_KEY && String(process.env.BOSTA_API_KEY).trim();
    if (dbKey)       { apiKey = dbKey;  keySource = 'db';  }
    else if (envKey) { apiKey = envKey; keySource = 'env'; }
    else             { apiKey = null; }
  } catch (credErr) {
    console.warn('[shipping/forward] Could not read shipping_settings, falling back to .env:', credErr.message);
    const envKey = process.env.BOSTA_API_KEY && String(process.env.BOSTA_API_KEY).trim();
    apiKey    = envKey || null;
    keySource = envKey ? 'env' : 'none';
  }

  if (!apiKey) {
    return res.status(400).json({
      error: 'Shipping credentials not configured. Please update settings in the dashboard.',
    });
  }

  /* Diagnostic breadcrumb — logs WHICH source supplied the key and its length,
     never the secret itself. Lets us tell from prod logs whether a stale DB
     row is shadowing a correct BOSTA_API_KEY env var (DB takes precedence).   */
  console.log(`[shipping/forward] Using Bosta api_key from "${keySource}" (length ${apiKey.length}) for business ${businessId}`);

  try {
    /* Fetch only THIS tenant's unshipped confirmed orders, oldest first.
       When a batch quota is supplied we LIMIT the queue so only the oldest
       N orders are dispatched this run (FIFO fulfilment).                 */
    const params = [businessId];
    let limitClause = '';
    if (batchLimit !== null) {
      params.push(batchLimit);
      limitClause = `LIMIT $${params.length}`;
    }

    const { rows: orders } = await pool.query(`
      SELECT *
      FROM   orders
      WHERE  "Status"           = 'تم التأكيد'
        AND  "BostaTrackingCode" IS NULL
        AND  business_id = $1
      ORDER  BY "createdAt" ASC
      ${limitClause}
    `, params);

    if (orders.length === 0) {
      return res.json({
        message: 'لا توجد طلبات مؤكدة جديدة بانتظار الشحن',
        success: [],
        failed:  [],
      });
    }

    const success = [];
    const failed  = [];

    for (const order of orders) {
      try {
        const payload  = toBosta(order, allowOpen);
        const bostaRes = await axios.post(`${BOSTA_BASE}/deliveries`, payload, {
          headers: {
            'Authorization': apiKey,
            'Content-Type':  'application/json',
          },
          timeout: 15_000,
        });

        /* Log full Bosta response so we can inspect every returned field */
        console.log('✅ Bosta Success Response Data:', JSON.stringify(bostaRes.data, null, 2));

        /* Bosta returns the tracking number in different shapes across versions */
        const trackingCode =
          bostaRes.data?.trackingNumber       ??
          bostaRes.data?.data?.trackingNumber ??
          bostaRes.data?._id                  ??
          bostaRes.data?.data?._id            ??
          'N/A';

        /* Persist the tracking code and advance the status */
        await pool.query(
          `UPDATE orders
           SET "BostaTrackingCode" = $1,
               "Status"            = 'تم الشحن'
           WHERE id = $2 AND business_id = $3`,
          [String(trackingCode), order.id, businessId]
        );

        success.push({
          orderId:      order.id,
          name:         order.FullName,
          phone:        order.Phone,
          trackingCode: String(trackingCode),
        });

        console.log(`✅  Bosta: order ${order.id} → tracking ${trackingCode}`);

      } catch (err) {
        const bostaError =
          err.response?.data?.message ??
          err.response?.data?.error   ??
          err.message                 ??
          'خطأ غير معروف';

        failed.push({
          orderId: order.id,
          name:    order.FullName,
          phone:   order.Phone,
          error:   String(bostaError),
        });

        const httpStatus = err.response?.status ?? 'no-response';
        console.error(`❌  Bosta: order ${order.id} failed [HTTP ${httpStatus}, key src="${keySource}"]:`, bostaError);
        console.error('❌ Bosta Error Details:', err.response?.data || err.message);
        /* A 401/403/404 here with a present key almost always means the key
           VALUE is invalid for api.bosta.co (wrong key, or the app.bosta.co
           bearer token pasted by mistake) — not a code/header problem. */
      }
    }

    res.json({
      message: `تم إرسال ${success.length} طلب بنجاح، فشل ${failed.length} طلب`,
      success,
      failed,
    });

  } catch (err) {
    console.error('Shipping /forward fatal error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── GET /api/shipping/settings/:provider ─────────────────────────
   Returns the stored settings for a provider.  Credentials are
   partially masked so the UI can confirm they are set without
   ever exposing the full secret over the wire.                     */
router.get('/settings/:provider', authenticate, requireAdmin, async (req, res) => {
  const { provider } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT
         provider_name,
         is_active,
         updated_at,
         /* Mask: first 6 chars + fixed stars so length doesn't leak secret size */
         CASE WHEN api_key IS NOT NULL AND api_key <> ''
              THEN LEFT(api_key, 6) || REPEAT('*', 20)
              ELSE NULL END                              AS api_key,
         CASE WHEN bearer_token IS NOT NULL AND bearer_token <> ''
              THEN LEFT(bearer_token, 10) || REPEAT('*', 20)
              ELSE NULL END                              AS bearer_token,
         CASE WHEN webhook_secret IS NOT NULL AND webhook_secret <> ''
              THEN LEFT(webhook_secret, 4) || REPEAT('*', 12)
              ELSE NULL END                              AS webhook_secret,
         /* Email is not secret — return it in full so the UI can show it.   */
         email                                           AS email,
         /* Never return the password; just signal whether one is stored.    */
         (password IS NOT NULL AND password <> '')       AS password_set
       FROM shipping_settings
       WHERE provider_name = $1 AND business_id = $2`,
      [provider, req.user.business_id]
    );

    if (!rows.length) {
      return res.json({ provider_name: provider, configured: false, is_active: false });
    }
    res.json({ ...rows[0], configured: true });

  } catch (err) {
    console.error('[shipping/settings GET]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/shipping/settings ──────────────────────────────────
   Upserts credentials for a provider.  Sending an empty string for
   a credential field leaves the existing DB value untouched
   (NULLIF coerces '' → NULL, then COALESCE keeps the stored value).
   This lets a partial update (e.g. only rotating the api_key)
   without accidentally clearing the bearer_token.

   Body: {
     provider_name   : 'bosta'             (required)
     api_key         : string | ''         (omit or '' to keep existing)
     bearer_token    : string | ''         (omit or '' to keep existing)
     webhook_secret  : string | ''         (omit or '' to keep existing)
     is_active       : boolean             (optional, default true)
   }                                                                  */
router.post('/settings', authenticate, requireAdmin, async (req, res) => {
  const {
    provider_name,
    api_key,
    bearer_token,
    webhook_secret,
    email,
    password,
    is_active = true,
  } = req.body;

  if (!provider_name || typeof provider_name !== 'string' || !provider_name.trim()) {
    return res.status(400).json({ error: 'provider_name مطلوب' });
  }

  /* Normalise: convert empty strings to null so COALESCE can protect existing values */
  const norm = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  try {
    const { rows } = await pool.query(
      `INSERT INTO shipping_settings
         (provider_name, api_key, bearer_token, webhook_secret, email, password, is_active, updated_at, business_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
       ON CONFLICT (provider_name, business_id) DO UPDATE SET
         api_key        = COALESCE(NULLIF($2, ''), shipping_settings.api_key),
         bearer_token   = COALESCE(NULLIF($3, ''), shipping_settings.bearer_token),
         webhook_secret = COALESCE(NULLIF($4, ''), shipping_settings.webhook_secret),
         email          = COALESCE(NULLIF($5, ''), shipping_settings.email),
         password       = COALESCE(NULLIF($6, ''), shipping_settings.password),
         is_active      = $7,
         updated_at     = NOW()
       RETURNING provider_name, is_active, updated_at`,
      [
        provider_name.trim(),
        norm(api_key),
        norm(bearer_token),
        norm(webhook_secret),
        norm(email),
        norm(password),
        Boolean(is_active),
        req.user.business_id,
      ]
    );

    console.log(`✅  Shipping settings saved for provider "${provider_name.trim()}"`);
    res.json({ message: 'تم حفظ إعدادات الشحن بنجاح', ...rows[0] });

  } catch (err) {
    console.error('[shipping/settings POST]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── GET /api/shipping/bulk-awb?ids=1,2,3 ────────────────────────────────
   Fetches the printable AWB (Air Waybill / shipping label) PDF for one or
   more orders directly from Bosta and pipes it back to the caller.

   Query param:
     ids  — comma-separated order IDs from our database (not tracking numbers)

   Flow:
     1. Validate and parse the order IDs
     2. Look up each order's BostaTrackingCode in the DB
     3. Report any orders that have no tracking code (not yet shipped)
     4. Call the Bosta AWB endpoint with all resolved tracking numbers
     5. Pipe the PDF response back, or surface a URL if Bosta returns JSON

   Bosta AWB endpoint:
     GET https://api.bosta.co/api/v2/deliveries/awb
         ?trackingNumbers[]=TN1&trackingNumbers[]=TN2&...
   ────────────────────────────────────────────────────────────────────────── */
router.get('/bulk-awb', authenticate, requireAdmin, async (req, res) => {

  /* ── 1. Parse and validate order IDs ─────────────────────────────────── */
  const rawIds = (req.query.ids || '').trim();
  if (!rawIds) {
    return res.status(400).json({ error: 'معامل "ids" مطلوب. مثال: ?ids=1,2,3' });
  }

  const ids = rawIds
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);

  if (!ids.length) {
    return res.status(400).json({ error: 'لا توجد معرفات طلبات صالحة' });
  }

  /* Sanity cap — Bosta may time out or reject very large batches */
  if (ids.length > 50) {
    return res.status(400).json({ error: 'الحد الأقصى 50 طلباً لكل طباعة. قسّم الطلبات على دفعات.' });
  }

  /* ── 2. Read api_key from DB (Phase 1 SaaS credential store) ─────────── */
  const businessId = req.user.business_id;
  let apiKey;
  try {
    const { rows: credRows } = await pool.query(
      `SELECT api_key FROM shipping_settings WHERE provider_name = 'bosta' AND is_active = true AND business_id = $1`,
      [businessId]
    );
    apiKey = credRows[0]?.api_key || process.env.BOSTA_API_KEY || null;
  } catch (credErr) {
    console.warn('[shipping/bulk-awb] Could not read shipping_settings, falling back to .env:', credErr.message);
    apiKey = process.env.BOSTA_API_KEY || null;
  }

  if (!apiKey) {
    return res.status(400).json({
      error: 'Shipping credentials not configured. Please update settings in the dashboard.',
    });
  }

  /* ── 3. Resolve tracking codes from the DB ───────────────────────────── */
  let orders;
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `SELECT id, "BostaTrackingCode"
       FROM   orders
       WHERE  id IN (${placeholders})
         AND  business_id = $${ids.length + 1}
       ORDER  BY id ASC`,
      [...ids, businessId]
    );
    orders = rows;
  } catch (dbErr) {
    console.error('[shipping/bulk-awb] DB error:', dbErr.message);
    return res.status(500).json({ error: 'خطأ في الخادم عند جلب بيانات الطلبات' });
  }

  /* Categorise: which orders have tracking codes and which don't */
  const withTracking    = orders.filter((o) => o.BostaTrackingCode);
  const withoutTracking = orders.filter((o) => !o.BostaTrackingCode);

  /* Orders requested but not found in the DB at all */
  const foundIds  = new Set(orders.map((o) => o.id));
  const notFound  = ids.filter((id) => !foundIds.has(id));

  if (!withTracking.length) {
    return res.status(404).json({
      error:          'لا توجد أرقام تتبع للطلبات المحددة',
      without_tracking: withoutTracking.map((o) => o.id),
      not_found:        notFound,
    });
  }

  /* Log any orders we can't print for */
  if (withoutTracking.length) {
    console.warn(
      `[shipping/bulk-awb] ${withoutTracking.length} order(s) have no tracking code:`,
      withoutTracking.map((o) => o.id)
    );
  }
  if (notFound.length) {
    console.warn('[shipping/bulk-awb] Order IDs not found in DB:', notFound);
  }

  const trackingNumbers = withTracking.map((o) => o.BostaTrackingCode);

  /* ── 4. Call Bosta AWB API ─────────────────────────────────────────────
     Build the query string manually: Bosta expects repeated array params
     in the form  trackingNumbers[]=TN1&trackingNumbers[]=TN2             */
  const awbQs = trackingNumbers
    .map((tn) => `trackingNumbers[]=${encodeURIComponent(tn)}`)
    .join('&');

  console.log(
    `[shipping/bulk-awb] Requesting AWB for ${trackingNumbers.length} shipment(s):`,
    trackingNumbers
  );

  try {
    const bostaRes = await axios.get(
      `${BOSTA_BASE}/deliveries/awb?${awbQs}`,
      {
        headers: {
          Authorization: apiKey,
          Accept:        'application/pdf, application/json, */*',
        },
        responseType: 'arraybuffer',   // works for both PDF blobs and JSON bodies
        timeout:      30_000,
      }
    );

    const contentType = (bostaRes.headers['content-type'] || '').toLowerCase();
    console.log(`[shipping/bulk-awb] Bosta response content-type: ${contentType}`);

    /* ── 5a. PDF response — pipe directly to the client ───────────────── */
    if (contentType.includes('application/pdf') || contentType.includes('octet-stream')) {
      const filename = `bosta-awb-${Date.now()}.pdf`;
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.set('X-AWB-Count',         String(trackingNumbers.length));
      /* Surface any skipped orders as headers so the frontend can warn */
      if (withoutTracking.length) {
        res.set('X-Orders-Without-Tracking', withoutTracking.map((o) => o.id).join(','));
      }
      return res.send(Buffer.from(bostaRes.data));
    }

    /* ── 5b. JSON response — Bosta returned a download URL or an error ── */
    const json = (() => {
      try { return JSON.parse(Buffer.from(bostaRes.data).toString('utf8')); }
      catch { return null; }
    })();

    if (json) {
      const pdfUrl =
        json?.data?.url     ??
        json?.url           ??
        json?.pdfUrl        ??
        json?.download_url  ??
        null;

      if (pdfUrl) {
        console.log(`[shipping/bulk-awb] Bosta returned PDF URL: ${pdfUrl}`);
        return res.json({
          pdf_url:                pdfUrl,
          count:                  trackingNumbers.length,
          without_tracking:       withoutTracking.map((o) => o.id),
          not_found:              notFound,
        });
      }

      /* Bosta returned JSON with no URL — might be an error body */
      console.error('[shipping/bulk-awb] Unexpected Bosta JSON body:', json);
      return res.status(502).json({
        error:       'Bosta لم يرجع PDF أو رابط تحميل',
        bosta_body:  json,
        without_tracking: withoutTracking.map((o) => o.id),
      });
    }

    /* Unknown response format */
    console.error('[shipping/bulk-awb] Unrecognised Bosta response format, content-type:', contentType);
    return res.status(502).json({ error: 'استجابة غير متوقعة من Bosta' });

  } catch (err) {
    const bostaStatus = err.response?.status;
    const bostaBody   = err.response?.data
      ? (() => {
          try { return JSON.parse(Buffer.from(err.response.data).toString('utf8')); }
          catch { return String(err.response.data); }
        })()
      : err.message;

    console.error(`[shipping/bulk-awb] Bosta AWB request failed (HTTP ${bostaStatus ?? 'ERR'}):`, bostaBody);

    return res.status(bostaStatus || 500).json({
      error:           `فشل جلب AWB من Bosta (${bostaStatus ?? 'connection error'})`,
      bosta_error:     bostaBody,
      tracking_sent:   trackingNumbers,
      without_tracking: withoutTracking.map((o) => o.id),
    });
  }
});

module.exports = router;
