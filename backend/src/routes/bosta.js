'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   bosta.js  —  Live Bosta Business-Dashboard integration
   ════════════════════════════════════════════════════════════════════════════

   Mounted at /api/bosta.  These endpoints talk to Bosta's BUSINESS dashboard
   API (https://app.bosta.co/api/v2), NOT the integrations API
   (https://api.bosta.co/api/v2) that shipping.js uses for creating deliveries.

   ┌──────────────────────────────────────────────────────────────────────────┐
   │ AUTH MODEL (two different credentials — do not mix them up):              │
   │   • shipping.js  → api_key       on api.bosta.co  (create / AWB)          │
   │   • bosta.js     → bearer_token  on app.bosta.co  (wallet / orders list)  │
   │ The bearer_token is the same one bostaEnrich.js uses for /consignee.      │
   │ It already includes the "Bearer " prefix when stored.                     │
   └──────────────────────────────────────────────────────────────────────────┘

   Endpoints:
     GET /api/bosta/wallet      — live wallet balance + recent transactions
     GET /api/bosta/follow-ups  — orders needing action + orders being returned

   Both are admin-only and read credentials from the shipping_settings DB table
   (fallback: BOSTA_BEARER_TOKEN env var), so nothing is ever hard-coded.
   ════════════════════════════════════════════════════════════════════════════ */

const express          = require('express');
const axios            = require('axios');
const pool             = require('../config/db');
const authenticate     = require('../middleware/auth');
const { requireAdmin, requireAdminOrPermission } = require('../middleware/roleGuard');
/* Shared physical-return processor + status helpers (defined in the Bosta
   webhook) so the backfill sync below uses the EXACT same logic. */
const { applyPhysicalReturn, canonicalizeStatus, FINAL_RETURN_STATUSES } = require('./shippingWebhook');

const router = express.Router();

/* ── Idempotent migrations for follow-up operations ─────────────────────────
   These power the interactive follow-ups hub: per-order return notes, a return
   shipping fee, and an idempotent treasury entry for that fee.

   We also (re)assert the treasury_transactions table here so the partial unique
   index can never fail on a cold start where shippingWebhook.js hasn't created
   the table yet (both run async at boot). CREATE TABLE IF NOT EXISTS is a no-op
   when the table already exists, so this is safe and order-independent.        */
pool.query(`
  ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS return_note         TEXT,
    ADD COLUMN IF NOT EXISTS return_shipping_fee NUMERIC(10,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS actual_shipping_fee NUMERIC(10,2)
`)
  .then(() =>
    pool.query(`
      CREATE TABLE IF NOT EXISTS treasury_transactions (
        id               SERIAL        PRIMARY KEY,
        order_id         INTEGER,
        amount           NUMERIC(12,2) NOT NULL,
        type             VARCHAR(50)   NOT NULL,
        source           VARCHAR(50)   NOT NULL,
        description      TEXT,
        transaction_date DATE          NOT NULL DEFAULT CURRENT_DATE,
        created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `)
  )
  .then(() =>
    /* One return-shipping-fee revenue entry per order → idempotent upsert. */
    pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS treasury_ret_fee_uidx
        ON treasury_transactions (order_id)
        WHERE source = 'return_shipping_fee'
    `)
  )
  .then(() => console.log('✅  Bosta: return_note / return_shipping_fee + treasury index ready'))
  .catch((err) => console.warn('⚠️   Bosta follow-up migration error:', err.message));

/* Business dashboard API base — same host bostaEnrich.js calls. */
const BOSTA_APP_BASE = 'https://app.bosta.co/api/v2';

/* Browser-style headers Bosta's dashboard API expects. Mirrors bostaEnrich.js;
   without the Origin/Referer pair Bosta returns 403 on these endpoints.       */
const BOSTA_APP_HEADERS = {
  Origin:                 'https://business.bosta.co',
  Referer:                'https://business.bosta.co/',
  'x-device-fingerprint': 'ko54zl',
  'x-device-id':          '01KNF2HWY0F6XTPBF0YXGS0PVQ',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 Edg/148.0.0.0',
  Accept:                 'application/json, text/plain, */*',
  'Content-Type':         'application/json',
};

/* ── Credential reader ──────────────────────────────────────────────────────
   Returns { bearerToken, apiKey, email, password } from shipping_settings,
   falling back to env. Never throws — returns nulls so the caller can emit a
   clean 400.  email/password power the auto-login token refresh below.        */
async function readBostaCreds(businessId) {
  try {
    const { rows } = await pool.query(
      `SELECT api_key, bearer_token, email, password
       FROM   shipping_settings
       WHERE  provider_name = 'bosta' AND is_active = true AND business_id = $1`,
      [businessId]
    );
    return {
      businessId,
      bearerToken: rows[0]?.bearer_token || process.env.BOSTA_BEARER_TOKEN || null,
      apiKey:      rows[0]?.api_key      || process.env.BOSTA_API_KEY      || null,
      email:       rows[0]?.email        || process.env.BOSTA_EMAIL        || null,
      password:    rows[0]?.password     || process.env.BOSTA_PASSWORD     || null,
    };
  } catch (err) {
    console.warn('[bosta] Could not read shipping_settings, falling back to .env:', err.message);
    return {
      businessId,
      bearerToken: process.env.BOSTA_BEARER_TOKEN || null,
      apiKey:      process.env.BOSTA_API_KEY      || null,
      email:       process.env.BOSTA_EMAIL        || null,
      password:    process.env.BOSTA_PASSWORD     || null,
    };
  }
}

/* ── Auto-login: refresh the Bosta bearer token ─────────────────────────────
   Bosta dashboard tokens expire frequently, so manual rotation is not viable
   for an ERP.  When a request returns 401 we call Bosta's login endpoint with
   the stored email/password, persist the fresh token (WITH the "Bearer "
   prefix, matching how bostaEnrich.js consumes it) back to shipping_settings,
   and hand it to the caller for an immediate retry.

   Returns the new "Bearer <token>" string on success, or null on failure.    */
const BOSTA_LOGIN_URL = 'https://app.bosta.co/api/v0/users/login';

async function refreshBostaToken({ email, password, businessId }) {
  if (!email || !password) {
    console.warn('[bosta/login] Cannot auto-login: email/password not configured in shipping settings.');
    return null;
  }

  try {
    console.log(`[bosta/login] Attempting auto-login at ${BOSTA_LOGIN_URL} for ${email}`);
    const r = await axios.post(
      BOSTA_LOGIN_URL,
      { email, password },
      { headers: BOSTA_APP_HEADERS, timeout: 15_000 }
    );

    /* Bosta nests the token under several possible keys across versions. */
    const rawToken =
      r.data?.data?.token        ??
      r.data?.token              ??
      r.data?.data?.accessToken  ??
      r.data?.accessToken        ??
      r.data?.data?.authToken    ??
      r.data?.authToken          ??
      null;

    if (!rawToken) {
      console.error('[bosta/login] Login succeeded (HTTP ' + r.status + ') but no token found in response body. Keys:', Object.keys(r.data || {}));
      return null;
    }

    /* Store WITH "Bearer " prefix for consistency with the rest of the app. */
    const bearer = /^bearer\s/i.test(rawToken) ? rawToken : `Bearer ${rawToken}`;

    try {
      await pool.query(
        `UPDATE shipping_settings
         SET bearer_token = $1, updated_at = NOW()
         WHERE provider_name = 'bosta' AND business_id = $2`,
        [bearer, businessId]
      );
      console.log('[bosta/login] ✅ Fresh bearer token obtained and saved to shipping_settings.');
    } catch (dbErr) {
      console.warn('[bosta/login] Token refreshed but could not persist to DB:', dbErr.message);
    }

    return bearer;
  } catch (err) {
    console.error(
      `[bosta/login] ❌ Auto-login failed: HTTP ${err.response?.status ?? 'ERR'} — ` +
      `${err.response?.data?.message ?? err.message}`
    );
    return null;
  }
}

/* ── Authenticated request with one auto-login retry on 401 ──────────────────
   `doRequest(authHeader)` must perform the axios call using the supplied
   Authorization header and return the axios response.  If it throws a 401 we
   refresh the token once and retry; any other error propagates to the caller. */
async function withAuthRetry(creds, doRequest) {
  let authHeader = creds.bearerToken;
  try {
    return await doRequest(authHeader);
  } catch (err) {
    if (err.response?.status === 401) {
      console.warn('[bosta] Request returned 401 — attempting token auto-refresh…');
      const fresh = await refreshBostaToken(creds);
      if (fresh) {
        creds.bearerToken = fresh; // so subsequent calls in this request reuse it
        return await doRequest(fresh);
      }
    }
    throw err;
  }
}

/* Coerce a Bosta value that may be a string OR a nested object
   ({_id,name,sector,nameAr} for cities/zones, {value,code} for states)
   into a plain display string.  Prevents "Objects are not valid as a React
   child" crashes downstream.                                                  */
function pickName(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    return String(v.nameAr ?? v.name ?? v.value ?? v.label ?? v.code ?? '');
  }
  return '';
}

/* ── Decode the businessId from the Bosta bearer JWT ─────────────────────────
   Bosta's wallet endpoint lives under /businesses/{businessId}/wallet, and the
   businessId is embedded in the JWT payload (no network call needed).  We
   base64-decode the payload segment WITHOUT verifying the signature — we only
   need to read a claim, not trust it — and dig out the business id from the
   handful of shapes Bosta has used across token versions.
   Returns the id string, or null if it can't be found.                        */
function decodeBusinessIdFromToken(token) {
  if (!token) return null;
  try {
    const raw = String(token).replace(/^bearer\s+/i, '').trim();
    const parts = raw.split('.');
    if (parts.length < 2) return null;

    /* base64url → base64, then decode + parse. */
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

    const businessId =
      payload?.businessAdminInfo?.businessId ??
      payload?.businessAdminInfo?.business?._id ??
      payload?.businessId                      ??
      payload?.business?._id                   ??
      payload?.business?.id                    ??
      payload?.user?.businessAdminInfo?.businessId ??
      null;

    if (businessId) {
      console.log(`[bosta] Decoded businessId from JWT: ${businessId}`);
    } else {
      console.warn('[bosta] JWT decoded but no businessId claim found. Payload keys:', Object.keys(payload || {}));
    }
    return businessId ? String(businessId) : null;
  } catch (err) {
    console.warn('[bosta] Could not decode businessId from JWT:', err.message);
    return null;
  }
}

/* Deep-search a JSON object for the first numeric value under any of `keys`.
   Bosta nests the wallet balance differently across API versions, so instead
   of guessing one path we walk the tree once and grab the first match.        */
function findNumberByKeys(obj, keys, depth = 0) {
  if (obj == null || depth > 6) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = findNumberByKeys(item, keys, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (keys.includes(k) && obj[k] != null && !isNaN(Number(obj[k]))) {
        return Number(obj[k]);
      }
    }
    for (const k of Object.keys(obj)) {
      const hit = findNumberByKeys(obj[k], keys, depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════════════════
   GET /api/bosta/wallet
   ════════════════════════════════════════════════════════════════════════════

   Fetches the merchant's CURRENT Bosta wallet balance plus a recent
   transaction list, straight from Bosta — no local calculation.

   Because Bosta's wallet endpoint path has shifted across dashboard versions,
   we try a prioritised list of candidate endpoints and use the first that
   answers with a usable balance.  Every attempt is logged so the exact working
   path is visible in the server terminal during testing.

   Response shape (always 200 on success):
   {
     balance:        number,          // live wallet balance in EGP
     currency:       'EGP',
     source_endpoint:string,          // which Bosta URL answered (for debugging)
     transactions: [
       { id, date, amount, type, description, status }
     ]
   }
   ════════════════════════════════════════════════════════════════════════════ */
router.get('/wallet', authenticate, requireAdmin, async (req, res) => {
  const creds = await readBostaCreds(req.user.business_id);

  if (!creds.bearerToken && !(creds.email && creds.password)) {
    return res.status(400).json({
      error: 'Bosta غير مهيأ. الرجاء حفظ التوكن (Bearer) أو البريد/كلمة المرور في إعدادات الشحن.',
    });
  }

  const headersFor = (auth) => ({ ...BOSTA_APP_HEADERS, Authorization: auth });

  /* Bosta's balance endpoint is scoped to the business:
       /api/v2/businesses/{businessId}/wallet
     The businessId is encoded inside the bearer JWT, so decode it and put the
     scoped URL first.  Keep the legacy guesses as fallbacks just in case.     */
  const businessId = decodeBusinessIdFromToken(creds.bearerToken);

  const balanceCandidates = [
    ...(businessId ? [
      `${BOSTA_APP_BASE}/wallets/${businessId}`,
      `${BOSTA_APP_BASE}/businesses/${businessId}/wallet`,
      `${BOSTA_APP_BASE}/businesses/${businessId}/wallet/balance`,
      `${BOSTA_APP_BASE}/businesses/${businessId}/wallets`,
      `${BOSTA_APP_BASE}/business/${businessId}/wallet`,
      `${BOSTA_APP_BASE}/wallet?businessId=${businessId}`,
    ] : []),
    `${BOSTA_APP_BASE}/wallet`,
    `${BOSTA_APP_BASE}/wallets`,
    `${BOSTA_APP_BASE}/businesses/wallet`,
    `${BOSTA_APP_BASE}/business/wallet`,
    `${BOSTA_APP_BASE}/wallet/balance`,
  ];

  let balance        = null;
  let sourceEndpoint = null;
  let rawBalanceBody = null;

  for (const url of balanceCandidates) {
    try {
      const r = await withAuthRetry(creds, (auth) =>
        axios.get(url, { headers: headersFor(auth), timeout: 12_000 })
      );
      const found = findNumberByKeys(
        r.data,
        ['balance', 'walletBalance', 'currentBalance', 'availableBalance', 'amount']
      );
      console.log(`[bosta/wallet] GET ${url} → HTTP ${r.status}, balance=${found ?? '(none)'}`);
      if (found !== null) {
        balance        = found;
        sourceEndpoint = url;
        rawBalanceBody = r.data;
        break;
      }
    } catch (err) {
      const status = err.response?.status ?? 'ERR';
      /* 404 just means "wrong path guess" — log quietly so we don't spam the
         terminal with red errors while probing. Anything else is logged loud. */
      if (status === 404) {
        console.log(`[bosta/wallet] · probe miss (404) ${url}`);
      } else {
        console.error(
          `[bosta/wallet] ❌ balance fetch failed | URL: ${url} | ` +
          `HTTP: ${status} | ` +
          `message: ${err.response?.data?.message ?? err.message} | ` +
          `body: ${JSON.stringify(err.response?.data ?? {}).slice(0, 300)}`
        );
      }
    }
  }

  /* Candidate transaction-list endpoints. */
  const txCandidates = [
    `${BOSTA_APP_BASE}/wallet/transactions?page=1&limit=25`,
    `${BOSTA_APP_BASE}/wallet/transactions?pageId=0&pageSize=25`,
    `${BOSTA_APP_BASE}/transactions?page=1&limit=25`,
    `${BOSTA_APP_BASE}/businesses/wallet/transactions?page=1&limit=25`,
  ];

  let transactions   = [];
  let rawTxBody      = null;

  for (const url of txCandidates) {
    try {
      const r = await withAuthRetry(creds, (auth) =>
        axios.get(url, { headers: headersFor(auth), timeout: 12_000 })
      );
      /* Bosta wraps the list under several possible keys. */
      const list =
        r.data?.data?.transactions ??
        r.data?.data?.list         ??
        r.data?.transactions       ??
        r.data?.data               ??
        (Array.isArray(r.data) ? r.data : null);

      if (Array.isArray(list) && list.length >= 0) {
        rawTxBody = r.data;
        transactions = list.slice(0, 25).map((t, i) => ({
          id:          t._id ?? t.id ?? `tx_${i}`,
          date:        t.createdAt ?? t.date ?? t.transactionDate ?? null,
          amount:      Number(t.amount ?? t.value ?? t.cod ?? 0) || 0,
          type:        pickName(t.type ?? t.transactionType ?? t.category) || 'transaction',
          description: pickName(t.description ?? t.note ?? t.reason ?? t.trackingNumber),
          status:      pickName(t.status ?? t.state?.value ?? t.state),
        }));
        console.log(`[bosta/wallet] transactions from ${url} → ${transactions.length} row(s)`);
        break;
      }
    } catch (err) {
      const status = err.response?.status ?? 'ERR';
      if (status === 404) {
        console.log(`[bosta/wallet] · tx probe miss (404) ${url}`);
      } else {
        console.error(
          `[bosta/wallet] ❌ tx fetch failed | URL: ${url} | ` +
          `HTTP: ${status} | ` +
          `message: ${err.response?.data?.message ?? err.message}`
        );
      }
    }
  }

  /* Balance fallback: the transactions payload often carries the running
     wallet balance in its envelope — mine it before giving up.              */
  if (balance === null && rawTxBody) {
    const fromTx = findNumberByKeys(
      rawTxBody,
      ['balance', 'walletBalance', 'currentBalance', 'availableBalance', 'closingBalance']
    );
    if (fromTx !== null) {
      balance        = fromTx;
      sourceEndpoint = 'transactions-envelope';
      console.log(`[bosta/wallet] balance recovered from transactions payload → ${fromTx}`);
    }
  }

  if (balance === null && transactions.length === 0) {
    /* Nothing answered — surface a clear error so the UI can fall back to the
       locally-computed cash-in-transit figure instead of showing a blank. */
    return res.status(502).json({
      error: 'تعذّر جلب بيانات المحفظة من Bosta. تحقّق من صلاحية التوكن (Bearer) في الإعدادات.',
      balance: null,
      transactions: [],
    });
  }

  return res.json({
    balance,
    currency:        'EGP',
    source_endpoint: sourceEndpoint,
    transactions,
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   GET /api/bosta/follow-ups
   ════════════════════════════════════════════════════════════════════════════

   Returns Bosta shipments that need merchant attention, split into two buckets:
     • action_required — "في انتظار متابعتك"  (exceptions / on-hold / failed)
     • returning       — "مرتجعاتك العائدة"    (parcels being returned to you)

   Implementation: Bosta's dashboard lists deliveries via a search endpoint.
   We POST a search query and bucket the results by the delivery's master
   status string.  We try the known search endpoint shapes and parse defensively
   because the field names vary across dashboard versions.

   Response:
   {
     action_required: [ { trackingNumber, status, customer, phone, cod, city, updatedAt } ],
     returning:       [ ... same shape ... ],
     counts: { action_required: n, returning: n }
   }
   ════════════════════════════════════════════════════════════════════════════ */

/* ── Bucketing ──────────────────────────────────────────────────────────────
   We classify a delivery into exactly one of two follow-up buckets, or skip it.
   This is intentionally STRICT — normal transit states (In Transit, Out for
   Delivery, Delivered, Pending, Ticket created, etc.) must NOT be flagged.

   • returning       → the parcel is coming back to the merchant.  Driven by the
                       boolean `isReturn` flag OR an explicit return state.
   • action_required → the parcel hit a genuine problem the merchant must act on
                       (a delivery exception).  ONLY explicit exception states.  */

/* ── Bosta's EXACT "Returning" stateCodes (reverse-engineered from the
   dashboard's network request) ───────────────────────────────────────────────
   The "مرتجعاتك العائدة" tab POSTs these to /deliveries/search. The ":R" suffix
   is Bosta's return-leg marker on a state; "23:C" is a cancelled-leg return.
   Treat this list as the single source of truth for the returning bucket.     */
const RETURNING_STATE_CODES = [
  '10:R', '11:R', '20:R', '21:R', '24:R', '30:R',
  '41:R', '47:R', '102:R', '103:R', '105:R', '23:C',
];

/* ── Bosta's EXACT "Action Required" (في انتظار متابعتك) stateCodes ──────────
   Reverse-engineered from the dashboard's network request, the same way as the
   returning bucket. The "في انتظار متابعتك" tab POSTs this single compound code
   to /deliveries/search. Everything returned by it IS action_required — no
   local heuristics / regex.                                                    */
const ACTION_REQUIRED_STATE_CODES = ['125.5,103'];

/* Extract the most DESCRIPTIVE Arabic status/reason from a delivery object.
   Bosta surfaces returns and exceptions under generic master states like
   "Processing", but the real reason (e.g. "إلغاء - العميل رفض استلام الشحنة")
   lives in nested reason fields or the latest tracking-timeline event. We probe
   richest → poorest and return the first non-empty string, preferring Arabic.  */
function pickDetailedStatus(d) {
  /* First non-empty coerced string from a list of candidates. */
  const firstOf = (...cands) => {
    for (const c of cands) {
      const s = pickName(c).trim();
      if (s) return s;
    }
    return '';
  };

  /* 1. BASE STATUS — strictly prefer Bosta's native Arabic state name
        ("قيد التنفيذ", "مؤجل", …). Drop-off leg first, then master state.
        Only fall back to the English value when no Arabic name exists.        */
  const base = firstOf(
    d.state?.nameAr,
    d.dropOff?.state?.nameAr,
    d.masterStatus?.nameAr,
    d.state?.value,
    d.dropOff?.state?.value,
    d.dropOffAddress?.state?.value,
    d.masterStatus?.value,
    d.masterStatus,
    d.status
  );

  /* 2. EXCEPTION / DELAY DETAIL — the specific reason, if one exists.
        Prefer the latest tracking-timeline event reason, then explicit reason
        fields on the delivery itself.                                         */
  const events =
    d.timeline ?? d.trackingEvents ?? d.tracker ?? d.history ??
    d.events   ?? d.transitEvents  ?? d.state?.history ?? [];
  const last = (Array.isArray(events) && events.length) ? (events[events.length - 1] || {}) : {};

  const detail = firstOf(
    d.exceptionReason, d.exception?.reasonAr, d.exception?.nameAr, d.exception?.reason,
    d.delayReason, d.holdReason, d.attemptReason,
    d.state?.delayReason, d.state?.exceptionReason, d.state?.reason, d.state?.delay?.reason,
    last.exceptionReason, last.reason, last.descriptionAr, last.nameAr, last.note, last.notes
  );

  /* 3. Compose: append the reason to the base when it adds new information.   */
  if (detail && detail !== base) {
    return base ? `${base} - ${detail}` : detail;
  }
  return base;
}

function mapDelivery(d) {
  const receiver = d.receiver ?? d.consignee ?? {};
  const name =
    receiver.fullName ??
    [receiver.firstName, receiver.lastName].filter(Boolean).join(' ').trim() ??
    '';
  const addr = d.dropOffAddress ?? d.dropoffAddress ?? d.address ?? {};
  /* city / zone / state may be nested objects ({_id,name,sector,nameAr} or
     {value,code}) — coerce to plain strings so React can render them. */
  const cityStr = pickName(addr.city ?? addr.cityName ?? d.city);
  const zoneStr = pickName(addr.zone ?? d.zone);
  return {
    trackingNumber: pickName(d.trackingNumber ?? d.tracking_number ?? d._id),
    /* Most descriptive Arabic reason available (real Bosta exception/return
       reason, not a generic master state). */
    status:         pickDetailedStatus(d) || pickName(d.state?.value ?? d.masterStatus?.value ?? d.masterStatus ?? d.status),
    customer:       pickName(name) || '—',
    phone:          pickName(receiver.phone),
    cod:            Number(d.cod ?? d.specs?.cod ?? 0) || 0,
    city:           [cityStr, zoneStr].filter(Boolean).join(' - ') || '',
    updatedAt:      d.updatedAt ?? d.lastUpdateDate ?? d.createdAt ?? null,
  };
}

router.get('/follow-ups', authenticate, requireAdminOrPermission('shipping_followups'), async (req, res) => {
  const creds = await readBostaCreds(req.user.business_id);

  if (!creds.bearerToken && !(creds.email && creds.password)) {
    return res.status(400).json({
      error: 'Bosta غير مهيأ. الرجاء حفظ التوكن (Bearer) أو البريد/كلمة المرور في إعدادات الشحن.',
    });
  }

  const headersFor = (auth) => ({ ...BOSTA_APP_HEADERS, Authorization: auth });

  const PAGE_SIZE = 50;   // matches the dashboard's own page size
  const MAX_PAGES = 20;   // safety cap → up to 1000 deliveries per bucket

  /* Pull the delivery list out of whichever envelope Bosta used. */
  const extractList = (data) =>
    data?.data?.deliveries ??
    data?.deliveries       ??
    data?.data?.list       ??
    data?.data             ??
    (Array.isArray(data) ? data : null);

  /* One POST /deliveries/search call → parsed delivery list (or null). */
  const runSearch = async (body) => {
    const r = await withAuthRetry(creds, (auth) =>
      axios.post(`${BOSTA_APP_BASE}/deliveries/search`, body, {
        headers: headersFor(auth),
        timeout: 15_000,
      })
    );
    return extractList(r.data);
  };

  /* ── AUTHORITATIVE bucket fetch ────────────────────────────────────────────
     Both follow-up buckets are reverse-engineered from the Bosta dashboard's
     own network requests: each tab POSTs an exact `stateCodes` payload to
     /deliveries/search. Everything the payload returns belongs to that bucket —
     no local scanning, regex, or status-string heuristics. Deduped by tracking
     number, paginated until a short page (or the safety cap) is reached.        */
  const fetchBucketByStateCodes = async (stateCodes, label) => {
    const out  = [];
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      let list;
      try {
        list = await runSearch({ limit: PAGE_SIZE, page, sortBy: '-updatedAt', stateCodes });
      } catch (err) {
        console.warn(
          `[bosta/follow-ups] ${label} fetch stopped at page ${page}: ` +
          `HTTP ${err.response?.status ?? 'ERR'} ${err.response?.data?.message ?? err.message}`
        );
        if (page === 1) throw err;   // total failure on first page → bubble up
        break;
      }
      if (!Array.isArray(list) || list.length === 0) break;
      for (const d of list) {
        const m   = mapDelivery(d);
        const key = m.trackingNumber || `${m.customer}|${m.phone}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(m);
      }
      console.log(`[bosta/follow-ups] ${label} page ${page} → +${list.length} (total ${out.length})`);
      if (list.length < PAGE_SIZE) break;   // last page reached
    }
    return out;
  };

  let returning;
  let action_required;
  try {
    /* مرتجعاتك العائدة — authoritative returning stateCodes. */
    returning = await fetchBucketByStateCodes(RETURNING_STATE_CODES, 'returning');
    /* في انتظار متابعتك — authoritative action-required stateCodes. */
    action_required = await fetchBucketByStateCodes(ACTION_REQUIRED_STATE_CODES, 'action_required');
  } catch (err) {
    console.error(`[bosta/follow-ups] fatal: ${err.response?.status ?? 'ERR'} ${err.message}`);
    return res.status(502).json({
      error: 'تعذّر جلب قائمة الشحنات من Bosta. تحقّق من صلاحية التوكن (Bearer) في الإعدادات.',
      action_required: [],
      returning: [],
      counts: { action_required: 0, returning: 0 },
    });
  }

  /* De-overlap: a parcel surfacing in both payloads is treated as returning
     (the more specific bucket) and dropped from action_required.               */
  const returningKeys = new Set(returning.map((r) => r.trackingNumber).filter(Boolean));
  action_required = action_required.filter(
    (r) => !(r.trackingNumber && returningKeys.has(r.trackingNumber))
  );

  console.log(
    `[bosta/follow-ups] bucketed: ${action_required.length} action_required, ` +
    `${returning.length} returning (both via authoritative stateCodes)`
  );

  /* ── Step E: merge local DB data (notes, return shipping fee, order id) ──
     Match Bosta deliveries to our orders by tracking number so the frontend
     can show + edit the merchant's own follow-up data inline.                */
  await enrichWithLocalOrder([...returning, ...action_required], req.user.business_id);

  return res.json({
    action_required,
    returning,
    counts: {
      action_required: action_required.length,
      returning:       returning.length,
    },
  });
});

/* ── Attach local order fields to a list of mapped Bosta deliveries ──────────
   Mutates each row in place, adding: order_id, return_note, return_shipping_fee.
   Rows with no matching local order get order_id:null and empty defaults.     */
async function enrichWithLocalOrder(rows, businessId) {
  const tracking = [...new Set(
    rows.map((r) => r.trackingNumber).filter(Boolean)
  )];

  /* Default every row first so the shape is consistent even with no matches. */
  for (const r of rows) {
    r.order_id            = null;
    r.return_note         = '';
    r.return_shipping_fee = 0;
  }

  if (tracking.length === 0) return;

  try {
    const { rows: locals } = await pool.query(
      `SELECT id, "BostaTrackingCode", return_note, return_shipping_fee
       FROM   orders
       WHERE  "BostaTrackingCode" = ANY($1::text[])
         AND  business_id = $2`,
      [tracking, businessId]
    );

    const byTracking = new Map(
      locals.map((o) => [String(o.BostaTrackingCode), o])
    );

    for (const r of rows) {
      const o = byTracking.get(String(r.trackingNumber));
      if (o) {
        r.order_id            = o.id;
        r.return_note         = o.return_note ?? '';
        r.return_shipping_fee = Number(o.return_shipping_fee ?? 0) || 0;
      }
    }
    console.log(`[bosta/follow-ups] merged ${byTracking.size}/${tracking.length} tracking numbers with local orders`);
  } catch (err) {
    console.warn('[bosta/follow-ups] local enrichment skipped:', err.message);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   PATCH /api/bosta/follow-ups/:trackingNumber
   ════════════════════════════════════════════════════════════════════════════

   Saves a merchant follow-up action against the local order matching the given
   Bosta tracking number:
     • return_note         — free-text note
     • return_shipping_fee — the fee charged back for the return leg

   Treasury hook (kept idempotent via treasury_ret_fee_uidx):
     • fee  > 0  → UPSERT a 'return_shipping_fee' revenue row for the order
     • fee == 0  → DELETE any existing 'return_shipping_fee' row for the order

   Body: { return_note?: string, return_shipping_fee?: number }
   ════════════════════════════════════════════════════════════════════════════ */
router.patch('/follow-ups/:trackingNumber', authenticate, requireAdminOrPermission('shipping_followups'), async (req, res) => {
  const trackingNumber = String(req.params.trackingNumber || '').trim();
  if (!trackingNumber) {
    return res.status(400).json({ error: 'رقم التتبع مطلوب' });
  }

  /* Normalise inputs. Either field may be omitted → keep existing value. */
  const hasNote = Object.prototype.hasOwnProperty.call(req.body, 'return_note');
  const hasFee  = Object.prototype.hasOwnProperty.call(req.body, 'return_shipping_fee');

  const note = hasNote ? (req.body.return_note == null ? '' : String(req.body.return_note)) : null;

  let fee = null;
  if (hasFee) {
    fee = Math.max(0, parseFloat(req.body.return_shipping_fee) || 0);
    if (!isFinite(fee)) fee = 0;
  }

  try {
    /* 1. Resolve the local order (tenant-scoped). */
    const businessId = req.user.business_id;
    const { rows } = await pool.query(
      `SELECT id, "ProductName", return_note, return_shipping_fee
       FROM   orders
       WHERE  "BostaTrackingCode" = $1 AND business_id = $2`,
      [trackingNumber, businessId]
    );

    if (!rows.length) {
      return res.status(404).json({
        error: `لا يوجد طلب محلي مرتبط برقم التتبع "${trackingNumber}".`,
      });
    }

    const order = rows[0];

    /* 2. Update only the provided fields (COALESCE keeps the rest intact). */
    const { rows: updated } = await pool.query(
      `UPDATE orders
       SET return_note         = COALESCE($2, return_note),
           return_shipping_fee = COALESCE($3, return_shipping_fee),
           "updatedAt"         = NOW()
       WHERE id = $1 AND business_id = $4
       RETURNING id, return_note, return_shipping_fee`,
      [order.id, note, fee, businessId]
    );

    const finalFee = Number(updated[0].return_shipping_fee ?? 0) || 0;

    /* 3. Treasury hook — only when the fee was part of this request. */
    if (hasFee) {
      if (finalFee > 0) {
        const description =
          `مصاريف شحن مرتجع — طلب #${order.id}` +
          (order.ProductName ? ` | ${order.ProductName}` : '');

        await pool.query(
          `INSERT INTO treasury_transactions
             (order_id, amount, type, source, description, transaction_date, business_id)
           VALUES ($1, $2, 'revenue', 'return_shipping_fee', $3, CURRENT_DATE, $4)
           ON CONFLICT (order_id) WHERE source = 'return_shipping_fee'
           DO UPDATE SET amount      = EXCLUDED.amount,
                         description  = EXCLUDED.description`,
          [order.id, finalFee.toFixed(2), description, businessId]
        );
        console.log(`✅  Treasury: return_shipping_fee ${finalFee.toFixed(2)} EGP set for order #${order.id}`);
      } else {
        /* fee dropped to 0 → remove any prior treasury entry. */
        const { rowCount } = await pool.query(
          `DELETE FROM treasury_transactions
           WHERE order_id = $1 AND source = 'return_shipping_fee'`,
          [order.id]
        );
        if (rowCount > 0) {
          console.log(`🗑️   Treasury: removed return_shipping_fee entry for order #${order.id}`);
        }
      }
    }

    return res.json({
      message:             'تم حفظ المتابعة بنجاح',
      trackingNumber,
      order_id:            order.id,
      return_note:         updated[0].return_note ?? '',
      return_shipping_fee: finalFee,
    });
  } catch (err) {
    console.error('[bosta/follow-ups PATCH]', err.message);
    return res.status(500).json({ error: 'خطأ في الخادم أثناء حفظ المتابعة' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/bosta/sync-returns  — backfill missed physical returns
   ════════════════════════════════════════════════════════════════════════════
   Recovers returns that Bosta marks as received-back ("تم الاسترجاع") but that
   never landed locally (e.g. the 13 missed yesterday due to the old DB-index
   bug). Each match is processed through applyPhysicalReturn — the SAME path as
   the live webhook: Status → تم الإرجاع, stock +qty, logged once. Idempotent.

   Two modes (admin only, tenant-scoped):
     • body.trackingNumbers: ["EG-123", …]  → process EXACTLY these (the reliable
       path when the user already knows the missed tracking numbers).
     • no body  → auto-fetch Bosta's "returning" bucket, keep only deliveries
       whose state means RECEIVED-BACK (canonical FINAL return), and process.
   ──────────────────────────────────────────────────────────────────────────── */
router.post('/sync-returns', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const explicit = Array.isArray(req.body?.trackingNumbers)
    ? [...new Set(req.body.trackingNumbers.map((t) => String(t).trim()).filter(Boolean))]
    : null;

  // Optional date filter (YYYY-MM-DD) — only returns from THAT Egypt-local day.
  const dateFilter = typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date.trim())
    ? req.body.date.trim()
    : null;

  const summary = {
    mode: explicit ? 'explicit' : (dateFilter ? 'date' : 'auto'),
    date: dateFilter,
    scanned: 0, matchedLocal: 0, processed: 0, restocked: 0,
    notFound: [], details: [],
  };

  /* Egypt-local YYYY-MM-DD for a timestamp (Bosta returns UTC ISO strings). */
  const egyptDate = (ts) => {
    if (!ts) return null;
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(d); // YYYY-MM-DD
  };

  try {
    let trackingNumbers = explicit;

    /* ── AUTO / DATE mode: pull returns from Bosta ───────────────────────── */
    if (!explicit) {
      const creds = await readBostaCreds(businessId);
      if (!creds.bearerToken && !(creds.email && creds.password)) {
        return res.status(400).json({
          error: 'Bosta غير مهيأ (التوكن/البريد). أو مرّر trackingNumbers يدوياً في الـ body.',
        });
      }

      const headersFor  = (auth) => ({ ...BOSTA_APP_HEADERS, Authorization: auth });
      const extractList = (data) =>
        data?.data?.deliveries ?? data?.deliveries ?? data?.data?.list ??
        data?.data ?? (Array.isArray(data) ? data : null);
      const runSearch = async (body) => {
        const r = await withAuthRetry(creds, (auth) =>
          axios.post(`${BOSTA_APP_BASE}/deliveries/search`, body, { headers: headersFor(auth), timeout: 15_000 })
        );
        return extractList(r.data);
      };

      /* EXACT stateCodes Bosta's dashboard POSTs for the "غير ناجح / Returned"
         tab (reverse-engineered from the browser Network tab). This is the
         AUTHORITATIVE source for fully-returned (تم الاسترجاع) parcels — every
         delivery it returns IS a received-back return.                          */
      const RETURNED_TAB_CODES = ['46:R', '104', '100&16', '101', '50', '48', '60'];

      const PAGE = 50;
      const seen     = new Set();
      const received = [];

      /* Paginate one stateCodes bucket WITHOUT early-exit on dates.
         We do NOT assume the API is strictly -updatedAt sorted, so we scan every
         page up to the cap and filter each row in memory by its updatedAt day.

         `trusted` = the stateCodes payload itself defines a returns tab, so every
         row is a return → skip the status-string re-validation (those weird codes
         may not surface a recognisable status string). For the untrusted catch-all
         sweep we still gate on canonicalizeStatus ∈ FINAL_RETURN_STATUSES.        */
      const collectBucket = async (stateCodes, label, { maxPages = 40, trusted = false } = {}) => {
        for (let page = 1; page <= maxPages; page++) {
          let list;
          const body = stateCodes
            ? { limit: PAGE, page, sortBy: '-updatedAt', stateCodes }
            : { limit: PAGE, page, sortBy: '-updatedAt' };
          try {
            list = await runSearch(body);
          } catch (err) {
            console.warn(`[bosta/sync-returns] ${label} page ${page} failed: ` +
              `HTTP ${err.response?.status ?? 'ERR'} ${err.response?.data?.message ?? err.message}`);
            return;   // skip this bucket on error; other buckets still run
          }
          if (!Array.isArray(list) || list.length === 0) break;

          let kept = 0;
          for (const d of list) {
            summary.scanned++;
            const tn = pickName(d.trackingNumber ?? d.tracking_number ?? d._id);
            if (!tn || seen.has(tn)) continue;

            if (!trusted) {
              const stateStr = pickName(
                d.state?.nameAr ?? d.state?.value ?? d.masterStatus?.nameAr ??
                d.masterStatus?.value ?? d.masterStatus ?? d.status
              );
              if (!FINAL_RETURN_STATUSES.has(canonicalizeStatus(stateStr))) continue; // received-back only
            }

            // Filter by the day the parcel was last updated (when it was returned).
            // NEVER filter on createdAt — these orders can be weeks old.
            if (dateFilter) {
              const dDate = egyptDate(d.updatedAt ?? d.lastUpdateDate ?? d.updateDate ?? d.state?.updatedAt ?? d.returnedAt);
              if (dDate !== dateFilter) continue;   // no early-exit — keep scanning
            }
            seen.add(tn);
            received.push(tn);
            kept++;
          }
          console.log(`[bosta/sync-returns] ${label} page ${page}: ${list.length} rows, +${kept} kept (total ${received.length})`);
          if (list.length < PAGE) break;   // genuine last page
        }
      };

      // 1) AUTHORITATIVE returned-tab codes (the user's exact dashboard payload).
      //    Every row IS a received-back return → trusted.
      await collectBucket(RETURNED_TAB_CODES, 'returned-tab', { maxPages: 40, trusted: true });
      // 2) Active returning-leg codes — status-gated so only rows that already
      //    canonicalise to a RECEIVED return pass (in-transit ones are skipped,
      //    avoiding premature restock).
      await collectBucket(RETURNING_STATE_CODES, 'returning', { maxPages: 40, trusted: false });
      // 3) Catch-all: most-recently-updated deliveries (any bucket), status-gated.
      //    Today's returns sort to the top, so 12 pages (600 rows) covers the day.
      await collectBucket(null, 'all-recent', { maxPages: 12, trusted: false });

      trackingNumbers = received;
    }

    /* ── Process each tracking number against the local DB ───────────────── */
    for (const tn of trackingNumbers) {
      const { rows } = await pool.query(
        `SELECT id, "ProductName", "sku", COALESCE("quantity", 1) AS quantity, "Status", business_id
           FROM orders WHERE "BostaTrackingCode" = $1 AND business_id = $2 LIMIT 1`,
        [tn, businessId]
      );
      if (!rows.length) { summary.notFound.push(tn); continue; }

      summary.matchedLocal++;
      const order = rows[0];
      /* applyPhysicalReturn is idempotent: it (re)sets status, and only
         restocks + logs if this order wasn't already logged as returned —
         so a missed return whose status WAS set but never logged/restocked is
         fully recovered here. */
      const r = await applyPhysicalReturn(order);
      if (!r.alreadyLogged) {
        summary.processed++;
        if (r.restocked) summary.restocked++;
        summary.details.push({ tn, orderId: order.id, restocked: r.restocked, qty: r.qty });
      } else {
        summary.details.push({ tn, orderId: order.id, action: 'already-logged' });
      }
    }

    console.log(
      `[bosta/sync-returns] tenant ${businessId} (${summary.mode}): ` +
      `scanned=${summary.scanned} matched=${summary.matchedLocal} ` +
      `processed=${summary.processed} restocked=${summary.restocked} notFound=${summary.notFound.length}`
    );
    return res.json({ message: 'تمت مزامنة المرتجعات', ...summary });
  } catch (err) {
    console.error('[bosta/sync-returns]', err.response?.status ?? 'ERR', err.message);
    return res.status(502).json({ error: 'تعذّر مزامنة المرتجعات من Bosta', detail: err.message });
  }
});

module.exports = router;
