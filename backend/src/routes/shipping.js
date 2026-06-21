const express      = require('express');
const axios        = require('axios');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const { enqueueBosta } = require('../services/bostaQueue');

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

/* ── Bosta city/governorate resolver ─────────────────────────────────────────
   Bosta validates dropOffAddress.city against their own registry. When the
   incoming Arabic name doesn't EXACTLY match, Bosta silently falls back to a
   default (Cairo/Giza) on the printed waybill — a critical mis-routing bug
   (e.g. 'كفر الشيخ' / 'مرسى مطروح' shipped to Cairo).

   The resolver below is robust to the real-world mess in the DB:
     1. Normalises Arabic (unifies ا/أ/إ/آ and ي/ى, strips diacritics & tatweel),
        removes administrative prefixes (محافظة / مركز / مدينة / قسم / حي), and
        collapses whitespace.
     2. Looks the normalised value up in the GOVERNORATE map first (all 27 with
        Bosta's EXACT English names), then in the CITY map (major cities/areas).
     3. Falls back to a "contains" scan so values like
        'كفر الشيخ - دسوق' still resolve to their governorate.
     4. Passes through already-English values; warns + returns raw otherwise.
   ──────────────────────────────────────────────────────────────────────────── */

/** Normalise an Arabic string for tolerant matching. ة↔ه and ي↔ى are unified
    because Bosta's dictionary uses the ه/ي forms while the DB usually has ة/ى. */
function normalizeArabic(s) {
  return String(s ?? '')
    .replace(/[ً-ْٰـ]/g, '') // harakat + tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/^(محافظة|محافظه|مركز|مدينة|مدينه|قسم|حي)\s+/u, '') // admin prefix
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Bosta governorate dictionary — SOURCE OF TRUTH ──────────────────────────
   Pulled verbatim from this account's GET /api/v2/cities. `name` is the EXACT
   string Bosta expects; `id` (_id) and `code` are sent alongside so routing is
   immune to any spelling drift. All 27 governorates.                          */
const BOSTA_CITIES = [
  { name: 'Alexandria',   id: 'Jrb6X6ucjiYgMP4T7', code: 'EG-02', nameAr: 'الاسكندريه' },
  { name: 'Assuit',       id: '7mDPAohM3ArSZmWTm', code: 'EG-17', nameAr: 'اسيوط' },
  { name: 'Aswan',        id: 'kLvZ5JY6LJPL5chzN', code: 'EG-21', nameAr: 'اسوان' },
  { name: 'Bani Suif',    id: 'LzbbvTzZ7D2CgE2PL', code: 'EG-16', nameAr: 'بني سويف' },
  { name: 'Behira',       id: 'g3GchTSmCgR2JynsJ', code: 'EG-04', nameAr: 'البحيره' },
  { name: 'Cairo',        id: 'FceDyHXwpSYYF9zGW', code: 'EG-01', nameAr: 'القاهره' },
  { name: 'Dakahlia',     id: 'RrDhS8YYsXAwZ9Zfo', code: 'EG-05', nameAr: 'الدقهليه' },
  { name: 'Damietta',     id: 'qoZvYcZ8Cqji4pGp5', code: 'EG-14', nameAr: 'دمياط' },
  { name: 'El Kalioubia', id: 'yp3atroeTwnyiBNKE', code: 'EG-06', nameAr: 'القليوبيه' },
  { name: 'Fayoum',       id: 'BW5MiNxEirB7tuz2y', code: 'EG-15', nameAr: 'الفيوم' },
  { name: 'Gharbia',      id: 'K3RwC677J8kJytdZD', code: 'EG-07', nameAr: 'الغربيه' },
  { name: 'Giza',         id: '0064Qb0OgcA',       code: 'EG-25', nameAr: 'الجيزه' },
  { name: 'Ismailia',     id: 'PJqNriLtFtx2cfkKP', code: 'EG-11', nameAr: 'الاسماعيليه' },
  { name: 'Kafr Alsheikh',id: 'ByP7rFCjL6XzF6j4S', code: 'EG-08', nameAr: 'كفر الشيخ' },
  { name: 'Luxor',        id: 'wgYEdH2WMzxGE2Ztp', code: 'EG-22', nameAr: 'الاقصر' },
  { name: 'Matrouh',      id: 'KBpGiRZJMIx',       code: 'EG-28', nameAr: 'مرسي مطروح' },
  { name: 'Menya',        id: 'si6eLnKjXqTFTMBj9', code: 'EG-19', nameAr: 'المنيا' },
  { name: 'Monufia',      id: 'ruBSjGBDX9wpRa3cc', code: 'EG-09', nameAr: 'المنوفيه' },
  { name: 'New Valley',   id: 'w4yDVHVJWqa4HpbzA', code: 'EG-24', nameAr: 'الوادي الجديد' },
  { name: 'North Sinai',  id: 'ZuCaDAVQlPT',       code: 'EG-27', nameAr: 'شمال سيناء' },
  { name: 'Port Said',    id: 'skFtf6ZmKo8kBEBDK', code: 'EG-13', nameAr: 'بور سعيد' },
  { name: 'Qena',         id: 'vfTHTes3uGjAszgtg', code: 'EG-20', nameAr: 'قنا' },
  { name: 'Red Sea',      id: 'r5TscLCNSjR2GimxQ', code: 'EG-23', nameAr: 'البحر الاحمر' },
  { name: 'Sharqia',      id: '6ExcoGbpYHnggP8JD', code: 'EG-10', nameAr: 'الشرقيه' },
  { name: 'Sohag',        id: 'n3EENg2adhuR9xBZK', code: 'EG-18', nameAr: 'سوهاج' },
  { name: 'South Sinai',  id: 'nG_c44vHQht',       code: 'EG-26', nameAr: 'جنوب سيناء' },
  { name: 'Suez',         id: 'PickurJ5uJZ9rDTHW', code: 'EG-12', nameAr: 'السويس' },
];

const CAIRO = BOSTA_CITIES.find((c) => c.name === 'Cairo');

/* Lookups (built once):
     byKey      — normalised Arabic nameAr → governorate object
     byEnglish  — lowercased English name  → governorate object               */
const byKey     = {};
const byEnglish = {};
for (const c of BOSTA_CITIES) {
  byKey[normalizeArabic(c.nameAr)] = c;
  byEnglish[c.name.toLowerCase()]  = c;
}

/* Extra Arabic aliases the DB / EasyOrder / the manual-order dropdown may use,
   that don't exactly equal Bosta's nameAr. Value = canonical Bosta `name`.    */
const ALIAS_RAW = {
  // Governorate spelling variants
  'مطروح': 'Matrouh', 'مرسى مطروح': 'Matrouh', 'مرسي مطروح': 'Matrouh',
  'بورسعيد': 'Port Said', 'بور سعيد': 'Port Said',
  'القليوبية': 'El Kalioubia', 'القليوبيه': 'El Kalioubia',
  'المنوفية': 'Monufia', 'الشرقية': 'Sharkia', 'البحيرة': 'Behira',
  'الدقهلية': 'Dakahlia', 'الغربية': 'Gharbia', 'الإسماعيلية': 'Ismailia',
  'الاسكندرية': 'Alexandria', 'اسكندرية': 'Alexandria',
  'أسيوط': 'Assuit', 'اسيوط': 'Assuit', 'المنيا': 'Menya',
  'بنى سويف': 'Bani Suif', 'كفرالشيخ': 'Kafr Alsheikh',
  // Major cities / districts → their governorate
  'شبرا الخيمة': 'El Kalioubia', 'بنها': 'El Kalioubia', 'العبور': 'El Kalioubia',
  'مدينة نصر': 'Cairo', 'حلوان': 'Cairo', 'المقطم': 'Cairo', 'مصر الجديدة': 'Cairo',
  'عين شمس': 'Cairo', 'المعادي': 'Cairo', 'التجمع': 'Cairo', 'التجمع الخامس': 'Cairo',
  'القاهرة الجديدة': 'Cairo', 'الشروق': 'Cairo', 'بدر': 'Cairo',
  'الهرم': 'Giza', 'فيصل': 'Giza', 'إمبابة': 'Giza', 'الدقي': 'Giza',
  'السادس من أكتوبر': 'Giza', '6 أكتوبر': 'Giza', 'أكتوبر': 'Giza', 'الشيخ زايد': 'Giza',
  'المنصورة': 'Dakahlia', 'طلخا': 'Dakahlia', 'ميت غمر': 'Dakahlia',
  'طنطا': 'Gharbia', 'المحلة الكبرى': 'Gharbia', 'المحلة': 'Gharbia',
  'الزقازيق': 'Sharkia', 'بلبيس': 'Sharkia', 'العاشر من رمضان': 'Sharkia',
  'دمنهور': 'Behira', 'كفر الدوار': 'Behira',
  'شبين الكوم': 'Monufia', 'السادات': 'Monufia',
  'دسوق': 'Kafr Alsheikh',
  'الغردقة': 'Red Sea', 'سفاجا': 'Red Sea', 'مرسى علم': 'Red Sea',
  'شرم الشيخ': 'South Sinai', 'دهب': 'South Sinai', 'الطور': 'South Sinai',
  'رأس السدر': 'South Sinai', 'طابا': 'South Sinai',
  'العريش': 'North Sinai', 'الخارجة': 'New Valley', 'الداخلة': 'New Valley',
};
for (const [k, engName] of Object.entries(ALIAS_RAW)) {
  const gov = byEnglish[engName.toLowerCase()];
  if (gov) byKey[normalizeArabic(k)] = gov;   // alias → same governorate object
}

/**
 * Resolve a DB city/governorate name to the Bosta governorate object
 * { name, id, code }. Guarantees a 1-to-1 match with Bosta's dictionary so an
 * order can never silently fall back to Cairo on the AWB.
 *   • blank            → Cairo
 *   • exact / alias    → matched governorate
 *   • already-English  → matched by English name, else passthrough
 *   • partial          → "contains" scan
 *   • unmatched Arabic → logged; sent raw (Bosta errors loudly, not silent)
 */
function resolveBostaCity(raw) {
  if (!raw || !String(raw).trim()) return CAIRO;
  const norm = normalizeArabic(raw);

  if (byKey[norm]) return byKey[norm];

  // Already English → match Bosta's English name exactly, else passthrough.
  if (!/[؀-ۿ]/.test(norm)) {
    const eng = byEnglish[String(raw).trim().toLowerCase()];
    return eng || { name: String(raw).trim(), id: null, code: null };
  }

  // "Contains" fallback (e.g. 'كفر الشيخ - دسوق' → Kafr Alsheikh).
  for (const key of Object.keys(byKey)) {
    if (norm.includes(key)) return byKey[key];
  }

  console.warn(`⚠️  Bosta: unmapped city/governorate "${raw}" (normalised "${norm}") — sending raw name only`);
  return { name: String(raw).trim(), id: null, code: null };
}

/** Backward-compatible string resolver (returns just the Bosta name). */
function mapToBostaCity(raw) { return resolveBostaCity(raw).name; }
const normalizeCity = mapToBostaCity;

/** Map one DB order row to a Bosta delivery payload */
function toBosta(order, allowOpen = false, payWithPoints = false) {
  const { firstName, lastName } = splitName(order.FullName);
  const gov     = resolveBostaCity(order.City || order.Governorate);
  const isAllowed = allowOpen === true;
  const useWallet = payWithPoints === true;

  // Diagnostic: confirm resolved values before sending to Bosta
  console.log(
    `[toBosta] order=${order.id} | city_raw="${order.City || order.Governorate}"` +
    ` → city="${gov.name}" cityId="${gov.id ?? '(none)'}" code="${gov.code ?? '(none)'}"` +
    ` | allowOpen=${allowOpen} → isAllowed=${isAllowed} | payWithPoints=${useWallet}`
  );

  /* Send the EXACT Bosta name AND the cityId/cityCode from Bosta's own
     dictionary, so routing is immune to any name-string drift. */
  const addressBlock = {
    city:     gov.name,
    ...(gov.id   ? { cityId: gov.id }     : {}),
    ...(gov.code ? { cityCode: gov.code } : {}),
    zone:      order.Zone     || '',
    district:  order.District || '',
    firstLine: order.Address  || '',
  };

  // Shipping notes printed on the AWB for the courier (Bosta `notes`).
  const shippingNotes = (order.ShippingNotes || '').toString().trim();

  return {
    type: 10, // Bosta standard integer ID for regular forward delivery

    // Printed on the airway bill so the courier sees special handling notes.
    notes: shippingNotes,

    // ── Package-opening flag — all known Bosta V2 field variants ──
    allowToOpenPackage:     isAllowed, // ✅ PRIMARY V2 field (drives waybill print)
    allowExploration:       isAllowed, // root-level v2 alternate A
    isAllowedToOpenPackage: isAllowed, // root-level v2 alternate B
    openPackage:            isAllowed, // v2 alternate C
    allowInspection:        isAllowed, // v2 alternate D

    // ── Pay shipping fee from Bosta points/credits (exact dashboard key) ──
    payWithBostaCredits: useWallet,

    specs: {
      allowToOpenPackage:     isAllowed, // ✅ specs-level primary
      allowExploration:       isAllowed, // specs-level alternate A
      isAllowedToOpenPackage: isAllowed, // specs-level alternate B
      packageDetails: {
        description:          order.ProductName || 'منتج',
        itemsCount:           order.quantity    || 1,
        allowToOpenPackage:   isAllowed, // nested primary
        allowExploration:     isAllowed, // nested alternate
      },
      notes: shippingNotes,   // specs-level mirror (Bosta version variance)
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
  const { allowOpen = false, payWithPoints = false, limit, orderIds } = req.body;

  /* ── "Send What You See" — explicit order selection ────────────────
     The client may send the exact ids of the confirmed orders it wants
     dispatched (the rows currently visible/filtered in the UI). When the
     `orderIds` key is present we honour it verbatim, sanitised to a list
     of positive integers. An explicitly-empty list ships nothing (we do
     NOT silently fall back to the global queue — that would surprise the
     user who filtered down to zero matches).                            */
  const useExplicitIds = Array.isArray(orderIds);
  const idList = useExplicitIds
    ? [...new Set(
        orderIds
          .map((v) => Number.parseInt(v, 10))
          .filter((n) => Number.isInteger(n) && n > 0)
      )]
    : [];

  /* ── Optional batch quota (legacy / no explicit ids) ──────────────
     When no `orderIds` are given, the client may instead cap how many
     confirmed orders are shipped in this run (shipping-package limits).
     Accept only a positive integer; anything else means "no cap"
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
    let orders;

    if (useExplicitIds) {
      /* ── "Send What You See": ship exactly the selected ids ──────────
         Only the status guard ('تم التأكيد') and tenant scope are applied.
         We deliberately do NOT filter on "BostaTrackingCode" IS NULL, so a
         manually-reverted order that still carries a stale tracking code can
         be re-sent to Bosta to generate a fresh waybill (its code is then
         overwritten on success below).                                    */
      if (idList.length === 0) {
        return res.json({
          message: 'لم يتم تحديد أي طلبات صالحة للشحن',
          success: [],
          failed:  [],
        });
      }

      const { rows } = await pool.query(`
        SELECT *
        FROM   orders
        WHERE  id = ANY($1::int[])
          AND  "Status"      = 'تم التأكيد'
          AND  business_id   = $2
        ORDER  BY "createdAt" ASC
      `, [idList, businessId]);
      orders = rows;

    } else {
      /* ── Legacy global queue: oldest unshipped confirmed orders first.
         When a batch quota is supplied we LIMIT how many ship this run.   */
      const params = [businessId];
      let limitClause = '';
      if (batchLimit !== null) {
        params.push(batchLimit);
        limitClause = `LIMIT $${params.length}`;
      }

      const { rows } = await pool.query(`
        SELECT *
        FROM   orders
        WHERE  "Status"           = 'تم التأكيد'
          AND  "BostaTrackingCode" IS NULL
          AND  business_id = $1
        ORDER  BY "createdAt" ASC
        ${limitClause}
      `, params);
      orders = rows;
    }

    if (orders.length === 0) {
      return res.json({
        message: 'لا توجد طلبات مؤكدة جديدة بانتظار الشحن',
        success: [],
        failed:  [],
      });
    }

    /* ── Defensive batch cap (rate-limit + runtime backstop) ────────────────
       The Bosta queue already serialises + paces every call, and the UI ships a
       user-set quota — but we ALSO cap here so NO single request (a direct API
       hit, an automated retry, or a future bug) can ever queue an unbounded burst
       at Bosta. Oldest-first; the overflow is reported as `remaining` so the
       caller ships it on the next run. Tunable via BOSTA_DISPATCH_MAX_BATCH. */
    const MAX_BATCH    = Number(process.env.BOSTA_DISPATCH_MAX_BATCH) || 200;
    const totalPending = orders.length;
    if (orders.length > MAX_BATCH) {
      orders = orders.slice(0, MAX_BATCH);
      console.warn(`[shipping/forward] batch capped: ${totalPending} pending → shipping ${MAX_BATCH} this run (set BOSTA_DISPATCH_MAX_BATCH to change)`);
    }

    const success = [];
    const failed  = [];

    console.log(`[shipping/forward] dispatching ${orders.length} order(s) via the throttled Bosta queue…`);
    for (const order of orders) {
      try {
        const payload  = toBosta(order, allowOpen, payWithPoints);
        /* Funnel every shipment-creation call through the shared global Bosta
           queue: serialized with a safe gap + 429 back-off, so a bulk dispatch
           of dozens of orders (or a webhook spike) never trips the rate limit. */
        const bostaRes = await enqueueBosta(
          () => axios.post(`${BOSTA_BASE}/deliveries`, payload, {
            headers: {
              'Authorization': apiKey,
              'Content-Type':  'application/json',
            },
            timeout: 15_000,
          }),
          `dispatch order ${order.id}`
        );

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

        /* Progress breadcrumb for big batches (every 25 processed). */
        const done = success.length + failed.length;
        if (done % 25 === 0) console.log(`[shipping/forward] progress ${done}/${orders.length}`);

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

    const processed = success.length + failed.length;
    const remaining = Math.max(0, totalPending - processed);
    res.json({
      message: remaining > 0
        ? `تم إرسال ${success.length} طلب بنجاح، فشل ${failed.length}. متبقٍ ${remaining} طلب — اضغط "إرسال للشحن" مرة أخرى لإكمالها.`
        : `تم إرسال ${success.length} طلب بنجاح، فشل ${failed.length} طلب`,
      success,
      failed,
      total_pending: totalPending,
      processed,
      remaining,
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
