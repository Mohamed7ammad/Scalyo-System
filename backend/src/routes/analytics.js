const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin, requireAdminOrPermission, requireAdminOrAnyPermission } = require('../middleware/roleGuard');
const { getExternalAffiliateStats, aggregateSafqaBreakdowns } = require('../services/externalAffiliate');
const { EARNED_COMMISSION_SQL } = require('../utils/commission');

const router = express.Router();

/* ── Egypt UTC-offset helper ─────────────────────────────────────────
   Egypt observes DST: UTC+2 (winter) and UTC+3 (summer, roughly
   April–October).  This function detects the correct offset for any
   given date by asking the Intl API what hour it is in Cairo at noon
   UTC on that day, then deriving the offset from the difference.

   Example:
     2026-01-15 → Cairo noon = 14:xx → offset +02:00 (EET)
     2026-05-25 → Cairo noon = 15:xx → offset +03:00 (EEST)

   Falls back to '+02:00' if Intl throws (shouldn't happen on Node 12+).
   ─────────────────────────────────────────────────────────────────── */
function getEgyptOffset(dateStr) {
  try {
    const noonUtc = new Date(dateStr + 'T12:00:00.000Z');
    const cairoHour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Cairo',
        hour:     '2-digit',
        hour12:   false,
      }).format(noonUtc),
      10
    );
    const offsetHours = cairoHour - 12; // 2 (winter) or 3 (summer)
    const sign = offsetHours >= 0 ? '+' : '-';
    return `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  } catch (_) {
    return '+02:00'; // safe fallback (winter / standard Egypt time)
  }
}

/* ════════════════════════════════════════════════════════════════════
   resolveCampaignTokens(businessId, campaignSel)
   ─────────────────────────────────────────────────────────────────────
   E-COMMERCE campaign → order-match token set.

   Orders carry no campaign reference; the ONLY link is the Meta naming
   convention used everywhere else (ad-spend attribution, ADS isolation):
   a campaign advertises a product when its NAME contains that product's SKU.

   So a selected campaign resolves to every CATALOGUE product whose SKU appears
   inside the campaign name, and we return that product set's match tokens
   (sku + name + aliases, uppercased) — the SAME token shape the product-filter
   uses — so the caller can scope orders by `sku`/`ProductName` exactly like the
   product dropdown does.  STRICT tenant scope.  Returns [] when nothing matches.
   ════════════════════════════════════════════════════════════════════ */
async function resolveCampaignTokens(businessId, campaignSel) {
  if (!campaignSel || campaignSel === 'كل الحملات') return [];
  const { rows } = await pool.query(
    `SELECT sku, name, COALESCE(aliases, '{}'::text[]) AS aliases
       FROM products
      WHERE business_id = $1::integer
        AND COALESCE(TRIM(sku), '') <> ''
        AND UPPER($2::text) LIKE '%' || UPPER(TRIM(sku)) || '%'`,
    [businessId, campaignSel]
  );
  const tokens = [];
  for (const r of rows) {
    for (const t of [r.sku, r.name, ...(r.aliases || [])]) {
      const v = String(t ?? '').trim().toUpperCase();
      if (v) tokens.push(v);
    }
  }
  return [...new Set(tokens)];
}

/* ════════════════════════════════════════════════════════════════════
   resolveAnalyticsScope(req) — AGENCY MODEL data scope
   ─────────────────────────────────────────────────────────────────────
   Returns { all, referralCodes, adAccountIds, mediaBuyerId }:
     • admin, no ?mediaBuyer   → { all:true }  (sees EVERYTHING)
     • admin + ?mediaBuyer=ID  → that buyer's scope (impersonation/filter)
     • media_buyer             → their OWN scope, ALWAYS — the ?mediaBuyer query
                                 param is IGNORED, so a buyer can never widen
                                 scope or peek at a colleague.

   Attribution model:
     • ORDERS  → users.referral_code (the buyer's unique UTM/Sub-ID). For Safqa
                 affiliate orders the equivalent column is `marketer`.
     • AD SPEND→ meta_accounts.assigned_user_id (1 buyer → many ad accounts),
                 plus the optional users.ad_account_id convenience pointer
                 resolved to its meta_accounts.id.

   CALLER CONTRACT: pass `scope.all ? null : (codes || [])` to each filter.
     null  → unscoped (admin sees all);  []  → scoped-but-unconfigured (0 rows);
     [..]  → scoped to those values. This is what guarantees a scoped buyer can
     never accidentally read unscoped data.
   ════════════════════════════════════════════════════════════════════ */
async function loadMediaBuyerScope(businessId, userId) {
  const uid = String(userId);
  const { rows: uRows } = await pool.query(
    `SELECT referral_code, ad_account_id FROM users
      WHERE id::text = $1 AND business_id = $2::integer`,
    [uid, businessId]
  );
  const u = uRows[0] || {};
  const referralCodes = u.referral_code ? [String(u.referral_code)] : [];

  /* Ad accounts assigned to this buyer — the scalable 1→many source of truth. */
  const { rows: aRows } = await pool.query(
    `SELECT id FROM meta_accounts WHERE assigned_user_id = $1 AND business_id = $2::integer`,
    [uid, businessId]
  );
  const adAccountIds = aRows.map((r) => r.id);

  /* Optional convenience pointer users.ad_account_id (the META ad_account_id
     string) → resolve to its meta_accounts.id and merge in. */
  if (u.ad_account_id) {
    const { rows: mRows } = await pool.query(
      `SELECT id FROM meta_accounts WHERE ad_account_id = $1 AND business_id = $2::integer`,
      [String(u.ad_account_id), businessId]
    );
    for (const m of mRows) if (!adAccountIds.includes(m.id)) adAccountIds.push(m.id);
  }

  return {
    all: false,
    referralCodes: referralCodes.length ? referralCodes : null,
    adAccountIds:  adAccountIds.length  ? adAccountIds  : null,
    mediaBuyerId:  uid,
  };
}

/* Sentinel marketer for the Main Account (organic / unassigned) bucket — written
   by the EasyOrder ingestion and selectable in the dashboard as "الحساب الأساسي". */
const MAIN_ACCOUNT = 'main_account';

async function resolveAnalyticsScope(req) {
  const role       = req.user?.role;
  const businessId = req.user?.business_id;
  /* MASTER DASHBOARD: admin with no buyer selected → all:true → NO marketer/account
     filter → the grand total of EVERY order (all buyers + organic 'main_account' +
     legacy null/'-'). This IS the single source of truth; the dropdown only narrows
     it down to an individual buyer. */
  const ADMIN_ALL  = { all: true, referralCodes: null, adAccountIds: null, mediaBuyerId: null };

  if (role === 'media_buyer') {
    /* Strict isolation — never trust a client param for a media buyer. */
    return loadMediaBuyerScope(businessId, req.user.id);
  }
  if (role === 'admin') {
    const mb = typeof req.query.mediaBuyer === 'string' ? req.query.mediaBuyer.trim() : '';
    if (!mb) return ADMIN_ALL;                    // Master view (business-name option)
    /* "الحساب الأساسي" — isolate the Main Account: orders tagged marketer='main_account'
       AND ad spend from the UNASSIGNED ad accounts (assigned_user_id IS NULL = the
       main agency campaigns owned by no individual buyer). Coexists with the Master
       view, which still shows the grand total of everything. */
    if (mb === MAIN_ACCOUNT) {
      const { rows } = await pool.query(
        `SELECT id FROM meta_accounts
          WHERE business_id = $1::integer AND assigned_user_id IS NULL`,
        [businessId]
      );
      return {
        all: false,
        referralCodes: [MAIN_ACCOUNT],
        adAccountIds:  rows.map((r) => r.id),   // [] → 0 spend until an account is left unassigned
        mediaBuyerId:  MAIN_ACCOUNT,
      };
    }
    return loadMediaBuyerScope(businessId, mb);   // drill-down to one buyer
  }
  return ADMIN_ALL;   // other roles are blocked by the per-route guards anyway
}

/* Convert a resolved scope into the per-filter param value (see CALLER CONTRACT). */
const scopeOrders   = (s) => (s.all ? null : (s.referralCodes || []));
const scopeAdAcc    = (s) => (s.all ? null : (s.adAccountIds  || []));

/* ════════════════════════════════════════════════════════════════════
   FORWARD PIPELINE — the SINGLE source of truth for "actively on the road"
   ─────────────────────────────────────────────────────────────────────
   Used by the dashboard 'طلبات في الطريق' count + 'مستحقات لدى شركة الشحن'
   cash sum (GET /dashboard) AND by the drill-down list (GET /in-transit-orders),
   so the number on the card and the rows behind it can NEVER disagree. A parcel
   is genuinely forward-moving toward the customer ONLY when ALL of these hold:
     • Status = 'تم الشحن'  — our SINGLE forward status. Returns
       ('جاري الإعادة','تم الإرجاع'), rejects ('تم الرفض') and pre-ship states
       ('جديد','لا يرد','مؤجل','تم التأكيد') are ALL excluded by this equality.
     • Bosta hasn't zeroed its COD (expected_cod > 0) — a return leg reads
       بدون تحصيل = 0; NULL = not yet synced ⇒ still treated as forward.
     • NOT in Bosta's "في انتظار متابعتك" action-required bucket (exceptions).
     • Shipped within the last FORWARD_MAX_DAYS days — older parcels still at
       'تم الشحن' are GHOSTS (a delivered/returned webhook was missed), not money
       on the road. Clock = true ship time (shipped_at), falling back to createdAt.
   Callers AND their own date-range predicate (CR on "createdAt") + tenant/
   product/campaign scope; this constant carries only the status/COD/freshness
   half so those pieces are guaranteed identical across the count and the list. */
const FORWARD_MAX_DAYS = 10;
const FORWARD_STATIC = `
  "Status" = 'تم الشحن'
  AND COALESCE("expected_cod"::numeric, 1) > 0
  AND NOT COALESCE("bosta_action_required", FALSE)
  AND COALESCE("shipped_at", "createdAt") >= NOW() - INTERVAL '${FORWARD_MAX_DAYS} days'
`;

/* ════════════════════════════════════════════════════════════════════
   buildJoinOn(params, startDate, endDate)
   ─────────────────────────────────────────────────────────────────────
   Builds the LEFT JOIN … ON (…) string.  All date logic lives here —
   NOTHING related to dates goes into the WHERE clause.

   Why ON and not WHERE?
   ─────────────────────
   A WHERE predicate on an outer-joined column silently converts the
   LEFT JOIN into an INNER JOIN.  If an agent has zero matching orders
   for the period, o.* is all NULL, the WHERE fails, and the agent row
   disappears entirely — producing an empty table instead of a row of
   zeros.  The ON clause only decides which orders are joined; it never
   removes agent rows.

   Date comparison strategy — timestamp boundaries in Node.js:
   ───────────────────────────────────────────────────────────
   All previous attempts using DATE() / AT TIME ZONE in SQL were
   fragile because they depend on whether "updatedAt" is TIMESTAMPTZ or
   TIMESTAMP WITHOUT TIME ZONE, and on the PostgreSQL server's
   TimeZone GUC (almost always UTC on hosted services).

   The foolproof fix: compute exact UTC boundaries in JavaScript and
   pass them as ISO-8601 strings with an explicit offset.  PostgreSQL
   then normalises them to UTC automatically, regardless of column type
   or server timezone.

     '2026-05-25T00:00:00+03:00'  →  '2026-05-24T21:00:00Z' in UTC
     '2026-05-25T23:59:59+03:00'  →  '2026-05-25T20:59:59Z' in UTC

   The offset is determined dynamically per date via getEgyptOffset()
   so DST transitions (April / October) are handled automatically.

   Date basis — orders are counted by their CREATION date:
   ───────────────────────────────────────────────────────
   The range is applied to o."createdAt" (NOT "updatedAt"). "Today" therefore
   means "orders CREATED today" — a stable cohort. Using "updatedAt" was the bug:
   any old order edited today (status change, note, etc.) leaked into today's
   numbers. Every metric in buildAgentSql() FILTERs over this same joined cohort,
   so the denominator (total_assigned) and all percentages stay consistent.

   STRICT range — no backlog override:
   ───────────────────────────────────
   The previous "(range) OR Status='جديد'" clause forced ALL unactioned orders
   (any date) into EVERY filtered period, so "Today" showed last week's backlog.
   The date range is now applied strictly; when no dates are passed we still join
   ALL of the tenant's orders (the all-time view).                            */
function buildJoinOn(params, startDate, endDate, bizIdx) {
  /* TENANT ISOLATION: only orders belonging to the caller's tenant may ever be
     joined onto a user row.  bizIdx is the $-position of req.user.business_id. */
  const bizClause = `o.business_id = $${bizIdx}::integer`;

  if (!startDate && !endDate) {
    // No date filter — join ALL of the tenant's orders for the agent.
    // Email match is normalised (LOWER+TRIM): orders.AssignedTo can drift in
    // case/whitespace from users.email, and an exact match silently DROPS those
    // orders from the per-agent totals (the dashboard, which doesn't join users,
    // still counts them — that mismatch was the missing-delivered-orders bug).
    return `LOWER(TRIM(o."AssignedTo")) = LOWER(TRIM(u.email)) AND ${bizClause}`;
  }

  const rangeParts = [];

  if (startDate) {
    const offset = getEgyptOffset(startDate);
    // Midnight Cairo on startDate, expressed as a UTC-anchored ISO string.
    params.push(`${startDate}T00:00:00${offset}`);
    rangeParts.push(`o."createdAt" >= $${params.length}::timestamptz`);
  }

  if (endDate) {
    const offset = getEgyptOffset(endDate);
    // Last second of endDate in Cairo time.
    params.push(`${endDate}T23:59:59${offset}`);
    rangeParts.push(`o."createdAt" <= $${params.length}::timestamptz`);
  }

  return [
    `LOWER(TRIM(o."AssignedTo")) = LOWER(TRIM(u.email))`,
    `AND ${bizClause}`,
    `AND (${rangeParts.join(' AND ')})`,
  ].join('\n          ');
}

/* ── Shared SELECT / GROUP BY fragment ──────────────────────────────
   Receives the pre-built ON-clause string and a WHERE clause string
   (role filter or email filter — never date conditions).             */
function buildAgentSql(joinOnClause, whereClause) {
  return `
    SELECT
      u.id                                                              AS agent_id,
      COALESCE(NULLIF(TRIM(u.name), ''), SPLIT_PART(u.email, '@', 1)) AS agent_name,
      u.email                                                           AS agent_email,
      COALESCE(u.is_active, true)                                       AS is_active,

      /* ── Granular commission matrix ── */
      COALESCE(u.comm_confirmed,  0)                                    AS comm_confirmed,
      COALESCE(u.comm_delivered,  0)                                    AS comm_delivered,
      COALESCE(u.comm_rejected,   0)                                    AS comm_rejected,
      COALESCE(u.comm_no_answer,  0)                                    AS comm_no_answer,

      COUNT(o.id)                                                       AS total_assigned,

      COUNT(o.id) FILTER (WHERE o."Status" = 'جديد')                   AS status_new,
      COUNT(o.id) FILTER (WHERE o."Status" = 'لا يرد')                AS status_no_answer,
      COUNT(o.id) FILTER (WHERE o."Status" = 'مؤجل')                  AS status_postponed,
      COUNT(o.id) FILTER (WHERE o."Status" = 'تم الرفض')              AS status_cancelled,
      COUNT(o.id) FILTER (WHERE o."Status" IN (
        'تم التأكيد', 'تم الشحن', 'تم التوصيل',
        'جاري الإعادة', 'تم الإرجاع'
      ))                                                                AS status_confirmed,
      COUNT(o.id) FILTER (WHERE o."Status" = 'تم التوصيل')            AS status_delivered,
      COUNT(o.id) FILTER (WHERE o."Status" IN ('جاري الإعادة', 'تم الإرجاع'))
                                                                        AS status_returned,

      /* Ghost detector: forward-pipeline orders older than 10 days. A COD parcel
         can't genuinely be in transit that long — these are stuck (missed webhook
         or never dispatched) and need review, not counting as "قيد التوصيل". */
      COUNT(o.id) FILTER (WHERE o."Status" IN ('تم الشحن', 'تم التأكيد')
        AND o."createdAt" < NOW() - INTERVAL '10 days')                 AS stale_in_transit,

      /* NDR: returned / (delivered + returned) × 100 */
      ROUND(
        COUNT(o.id) FILTER (WHERE o."Status" IN ('جاري الإعادة', 'تم الإرجاع'))::numeric
        / NULLIF(
            COUNT(o.id) FILTER (WHERE o."Status" IN (
              'تم التوصيل', 'جاري الإعادة', 'تم الإرجاع'
            )), 0
          ) * 100,
        1
      )                                                                 AS ndr_pct,

      /* Earned commission — shared formula (utils/commission.js) so the period
         column here and the all-time global balance can never diverge. */
      ${EARNED_COMMISSION_SQL}                                          AS earned_commission

    FROM  users u
    LEFT  JOIN orders o ON (
          ${joinOnClause}
    )
    ${whereClause}
    GROUP BY u.id, u.name, u.email, u.is_active,
             u.comm_confirmed, u.comm_delivered, u.comm_rejected, u.comm_no_answer
  `;
}

/* ══════════════════════════════════════════════════════════════════
   GET /api/analytics/overview  — Admin only
   ─────────────────────────────────────────────────────────────────
   Returns date-filtered financial KPIs for the main dashboard.
   Two independent queries run in parallel:

     1. expenses table  — DATE column, so a plain ::date cast is enough;
        no timezone conversion needed (the date the expense was logged).

     2. orders table    — uses the same Egypt-local UTC boundaries as
        buildJoinOn() so the result matches what the analytics endpoints
        show for the same period.  We sum ProductPrice only for orders
        that are in status 'تم التوصيل' (Delivered).

   When no dates are provided both queries return the all-time totals.
   ══════════════════════════════════════════════════════════════════ */
const PRICE_EXPR = `
  COALESCE(
    NULLIF(
      REGEXP_REPLACE(COALESCE("ProductPrice"::text, ''), '[^0-9.]', '', 'g'),
      ''
    )::numeric,
    0
  )`;

/* Ensure the SKU-attribution columns exist before any route handles a request.
   These are the same migrations as in meta.js — duplicated here so the
   profitability endpoint never fails with "column does not exist" even if the
   meta sync has never been run on this instance.                             */
pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS sku            VARCHAR(100)`)
  .catch(() => {});
pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS meta_sync     BOOLEAN NOT NULL DEFAULT FALSE`)
  .catch(() => {});
pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS meta_purchases INT     DEFAULT 0`)
  .catch(() => {});

/* Ensure "rejectionReason" exists on the orders table.
   The column is defined in schema.sql but that file is run manually.
   This guard means the dashboard rejection-reasons query never fails with
   "column does not exist" on a DB provisioned from an older dump.           */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "rejectionReason" VARCHAR(255)`)
  .catch(() => {});

router.get('/overview', authenticate, requireAdminOrPermission('analytics'), async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    /* ── Query A: filtered expense sum (tenant-scoped) ────────────── */
    const expParams = [req.user.business_id];   // $1 = tenant
    let expWhere = ` AND business_id = $1::integer`;
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      expParams.push(startDate);
      expWhere += ` AND expense_date >= $${expParams.length}::date`;
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      expParams.push(endDate);
      expWhere += ` AND expense_date <= $${expParams.length}::date`;
    }
    const expSql = `
      SELECT COALESCE(SUM(amount), 0) AS total_expenses
      FROM   expenses
      WHERE  1=1${expWhere}
    `;

    /* ── Query B: delivered orders revenue (tenant-scoped) ────────── */
    const ordParams = [req.user.business_id];   // $1 = tenant
    let ordWhere = `"Status" = 'تم التوصيل' AND business_id = $1::integer`;

    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      const offset = getEgyptOffset(startDate);
      ordParams.push(`${startDate}T00:00:00${offset}`);
      ordWhere += ` AND "updatedAt" >= $${ordParams.length}::timestamptz`;
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      const offset = getEgyptOffset(endDate);
      ordParams.push(`${endDate}T23:59:59${offset}`);
      ordWhere += ` AND "updatedAt" <= $${ordParams.length}::timestamptz`;
    }
    const ordSql = `
      SELECT COALESCE(SUM(${PRICE_EXPR}), 0) AS total_sales_delivered
      FROM   orders
      WHERE  ${ordWhere}
    `;

    /* ── Run both in parallel ─────────────────────────────────────── */
    const [expRes, ordRes] = await Promise.all([
      pool.query(expSql, expParams),
      pool.query(ordSql, ordParams),
    ]);

    const total_expenses        = parseFloat(expRes.rows[0].total_expenses)        || 0;
    const total_sales_delivered = parseFloat(ordRes.rows[0].total_sales_delivered) || 0;
    const net_profit            = total_sales_delivered - total_expenses;

    res.json({ total_expenses, total_sales_delivered, net_profit });

  } catch (err) {
    console.error('[analytics/overview] Error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── GET /api/analytics/agents — Admin only ──────────────────────── */
/* Agent PERFORMANCE leaderboard. Reachable two ways with DIFFERENT visibility:
     • financial access (admin OR 'analytics') → full rows incl. commissions.
     • team-management access ('manage_staff', i.e. team-leaders) → PERFORMANCE
       ONLY; every commission / payout / balance field is stripped below. */
router.get('/agents', authenticate, requireAdminOrAnyPermission('analytics', 'manage_staff'), async (req, res) => {
  const { startDate, endDate } = req.query;
  const params = [req.user.business_id];        // $1 = tenant
  const bizIdx = params.length;
  const joinOn = buildJoinOn(params, startDate, endDate, bizIdx);

  /* Include 'supervisor' so a PROMOTED agent keeps their historical performance +
     commission attributed to THEM. Their orders (orders."AssignedTo" = their email)
     are never touched by a role change, so without this they'd silently fall into
     the "غير محدد" bucket below and look "lost". Admins/media-buyers stay excluded. */
  const sql = buildAgentSql(joinOn, `WHERE u.role IN ('agent', 'supervisor') AND u.business_id = $${bizIdx}::integer`) + `
    ORDER BY
      COUNT(o.id) FILTER (WHERE o."Status" IN (
        'تم التأكيد', 'تم الشحن', 'تم التوصيل',
        'جاري الإعادة', 'تم الإرجاع'
      )) DESC,
      COUNT(o.id) DESC,
      u.email ASC
  `;

  /* ── All-time GLOBAL balance (Employee Ledger) ──────────────────────────────
     The period `earned_commission` above respects the date filter, but a payout
     settles the employee's ALL-TIME balance. So we compute, per agent:
       lifetime_commission = the SAME earned-commission formula over ALL orders
       total_paid          = Σ logged payouts (employee_payouts, all-time)
       outstanding_balance = lifetime_commission − total_paid   (what is owed now)
     Computed independently of the date filter and merged onto each row.        */
  const lifetimeSql = `
    SELECT
      u.id                                      AS agent_id,
      ${EARNED_COMMISSION_SQL}                  AS lifetime_commission,
      COALESCE(pay.total_paid, 0)               AS total_paid
    FROM users u
    LEFT JOIN orders o
      ON LOWER(TRIM(o."AssignedTo")) = LOWER(TRIM(u.email)) AND o.business_id = $1::integer
    LEFT JOIN (
      SELECT user_id, SUM(amount) AS total_paid
      FROM employee_payouts
      WHERE business_id = $1::integer
      GROUP BY user_id
    ) pay ON pay.user_id = u.id
    WHERE u.role IN ('agent', 'supervisor') AND u.business_id = $1::integer
    GROUP BY u.id, u.comm_confirmed, u.comm_delivered,
             u.comm_rejected, u.comm_no_answer, pay.total_paid
  `;

  try {
    const result = await pool.query(sql, params);

    /* Lifetime query uses ONLY $1 (tenant); guarded so a missing employee_payouts
       table (pre-migration) degrades to period-only data instead of a 500. */
    const life = await pool.query(lifetimeSql, [req.user.business_id]).catch((e) => {
      console.warn('[analytics/agents] lifetime balance unavailable:', e.message);
      return { rows: [] };
    });
    const lifeMap = new Map(life.rows.map((r) => [String(r.agent_id), r]));

    const merged = result.rows.map((row) => {
      const L = lifeMap.get(String(row.agent_id));
      const lifetime = L ? (parseFloat(L.lifetime_commission) || 0) : 0;
      const paid     = L ? (parseFloat(L.total_paid)          || 0) : 0;
      return {
        ...row,
        lifetime_commission: parseFloat(lifetime.toFixed(2)),
        total_paid:          parseFloat(paid.toFixed(2)),
        outstanding_balance: parseFloat((lifetime - paid).toFixed(2)),
      };
    });

    /* ── Synthetic "غير محدد" (unassigned) bucket ───────────────────────────────
       Captures every order in the period that does NOT belong to any agent OR
       supervisor user — AssignedTo NULL / empty, or assigned to an admin /
       media_buyer / deleted user. The per-agent rows only cover agent-owned orders,
       so without
       this bucket their sum is LESS than the dashboard (which counts ALL tenant
       orders). Same metric definitions as a real agent; commission/ledger fields
       are 0 (orphaned orders earn no agent commission). The NOT EXISTS check uses
       the SAME normalised email match (LOWER+TRIM) and COALESCE so NULL/empty
       AssignedTo is treated as unassigned. Date scope = same createdAt range. */
    const unParams = [req.user.business_id];
    let unRange = '';
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      unParams.push(`${startDate}T00:00:00${getEgyptOffset(startDate)}`);
      unRange += ` AND o."createdAt" >= $${unParams.length}::timestamptz`;
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      unParams.push(`${endDate}T23:59:59${getEgyptOffset(endDate)}`);
      unRange += ` AND o."createdAt" <= $${unParams.length}::timestamptz`;
    }
    const unassignedSql = `
      SELECT
        COUNT(o.id)                                                       AS total_assigned,
        COUNT(o.id) FILTER (WHERE o."Status" = 'جديد')                   AS status_new,
        COUNT(o.id) FILTER (WHERE o."Status" = 'لا يرد')                AS status_no_answer,
        COUNT(o.id) FILTER (WHERE o."Status" = 'مؤجل')                  AS status_postponed,
        COUNT(o.id) FILTER (WHERE o."Status" = 'تم الرفض')              AS status_cancelled,
        COUNT(o.id) FILTER (WHERE o."Status" IN (
          'تم التأكيد', 'تم الشحن', 'تم التوصيل', 'جاري الإعادة', 'تم الإرجاع'
        ))                                                                AS status_confirmed,
        COUNT(o.id) FILTER (WHERE o."Status" = 'تم التوصيل')            AS status_delivered,
        COUNT(o.id) FILTER (WHERE o."Status" IN ('جاري الإعادة', 'تم الإرجاع')) AS status_returned,
        COUNT(o.id) FILTER (WHERE o."Status" IN ('تم الشحن', 'تم التأكيد')
          AND o."createdAt" < NOW() - INTERVAL '10 days')                 AS stale_in_transit,
        ROUND(
          COUNT(o.id) FILTER (WHERE o."Status" IN ('جاري الإعادة', 'تم الإرجاع'))::numeric
          / NULLIF(COUNT(o.id) FILTER (WHERE o."Status" IN (
              'تم التوصيل', 'جاري الإعادة', 'تم الإرجاع')), 0) * 100, 1
        )                                                                 AS ndr_pct
      FROM orders o
      WHERE o.business_id = $1::integer
        AND NOT EXISTS (
          SELECT 1 FROM users u
           WHERE u.role IN ('agent', 'supervisor')
             AND u.business_id = $1::integer
             AND LOWER(TRIM(u.email)) = LOWER(TRIM(COALESCE(o."AssignedTo", '')))
        )
        ${unRange}
    `;
    const un = await pool.query(unassignedSql, unParams).catch((e) => {
      console.warn('[analytics/agents] unassigned bucket unavailable:', e.message);
      return { rows: [] };
    });
    const ur = un.rows[0];
    if (ur && parseInt(ur.total_assigned, 10) > 0) {
      merged.push({
        agent_id:            'unassigned',
        agent_name:          'غير محدد',
        agent_email:         'unassigned@system',
        is_active:           true,
        comm_confirmed: 0, comm_delivered: 0, comm_rejected: 0, comm_no_answer: 0,
        total_assigned:      ur.total_assigned,
        status_new:          ur.status_new,
        status_no_answer:    ur.status_no_answer,
        status_postponed:    ur.status_postponed,
        status_cancelled:    ur.status_cancelled,
        status_confirmed:    ur.status_confirmed,
        status_delivered:    ur.status_delivered,
        status_returned:     ur.status_returned,
        stale_in_transit:    ur.stale_in_transit,
        ndr_pct:             ur.ndr_pct,
        earned_commission:   0,
        lifetime_commission: 0,
        total_paid:          0,
        outstanding_balance: 0,
      });
    }

    /* ── Financial redaction — deny-by-default for team-leaders ────────────────
       A supervisor reaches this endpoint via 'manage_staff' (team management),
       NOT financial access. Strip every money field by ROLE (never trust a stale
       'analytics' permission on a supervisor token) so agent commissions, payouts
       and balances are fully isolated from them. Admins + real analytics users
       keep the full payload. */
    const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    const canSeeFinancials =
      req.user.role !== 'supervisor' && (req.user.role === 'admin' || perms.includes('analytics'));
    if (!canSeeFinancials) {
      const FINANCIAL_KEYS = [
        'comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer',
        'earned_commission', 'lifetime_commission', 'total_paid', 'outstanding_balance',
      ];
      const redacted = merged.map((row) => {
        const clean = { ...row };
        for (const k of FINANCIAL_KEYS) delete clean[k];
        return clean;
      });
      return res.json(redacted);
    }

    res.json(merged);
  } catch (err) {
    console.error('[analytics/agents] SQL error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── GET /api/analytics/order-sources?startDate&endDate ──────────────────────
   Per chat-source funnel for chat-moderator commissions: for orders whose
   chat_source is set (manual orders where the moderator picked Messenger /
   WhatsApp / …), grouped by source: total received, confirmed (reached confirmed
   or beyond), and delivered (تم التوصيل — the commission driver). Date range is
   Egypt-local on the RECEIVED date (createdAt), so month-end filtering is exact.
   Admin / analytics-permission only.                                            */
router.get('/order-sources', authenticate, requireAdminOrPermission('analytics'), async (req, res) => {
  const businessId = req.user.business_id;
  const { startDate, endDate } = req.query;
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  const params = [businessId];
  let dateClause = '';
  if (isDate(startDate)) { params.push(startDate); dateClause += ` AND ("createdAt" AT TIME ZONE 'Africa/Cairo')::date >= $${params.length}::date`; }
  if (isDate(endDate))   { params.push(endDate);   dateClause += ` AND ("createdAt" AT TIME ZONE 'Africa/Cairo')::date <= $${params.length}::date`; }

  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(chat_source), ''), 'unset') AS source,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE "Status" IN
                ('تم التأكيد','تم الشحن','تم التوصيل','جاري الإعادة','تم الإرجاع'))::int AS confirmed,
              COUNT(*) FILTER (WHERE "Status" = 'تم التوصيل')::int AS delivered
         FROM orders
        WHERE business_id = $1
          AND COALESCE(is_lost_order, FALSE) = FALSE
          AND chat_source IS NOT NULL
          ${dateClause}
        GROUP BY 1
        ORDER BY delivered DESC, total DESC`,
      params
    );
    const totals = rows.reduce(
      (a, r) => ({ total: a.total + r.total, confirmed: a.confirmed + r.confirmed, delivered: a.delivered + r.delivered }),
      { total: 0, confirmed: 0, delivered: 0 }
    );
    res.json({ startDate: isDate(startDate) ? startDate : null, endDate: isDate(endDate) ? endDate : null, totals, sources: rows });
  } catch (err) {
    console.error('[analytics/order-sources]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* Per-order COD used by every drill-down list (Bosta live COD, else price−deposit).
   Kept identical to the overview so the modal totals match the cards to the piaster. */
const DRILLDOWN_COD_EXPR = (() => {
  const P   = `COALESCE(NULLIF(REGEXP_REPLACE(COALESCE("ProductPrice"::text,''),'[^0-9.]','','g'),'')::numeric, 0)`;
  const DEP = `COALESCE(NULLIF(REGEXP_REPLACE(COALESCE("depositAmount"::text,''),'[^0-9.]','','g'),'')::numeric, 0)`;
  return `COALESCE("expected_cod"::numeric, GREATEST(${P} - ${DEP}, 0))`;
})();

/* The order statuses a drill-down may request. Whitelisting keeps an arbitrary
   status string from ever reaching the query (the values are also parameterised). */
const DRILLDOWN_STATUSES = new Set([
  'جديد', 'تم التأكيد', 'تم الشحن', 'تم التوصيل', 'تم الرفض',
  'لا يرد', 'مؤجل', 'جاري الإعادة', 'تم الإرجاع', 'معلق حتي الدفع',
]);

/* Build the SAME tenant / date-range (CR) / product / campaign / agency scope
   every dashboard card uses, so any drill-down list matches its card's count by
   construction. Returns { params, ordFilter, CR } — the caller AND's its own
   predicate (FORWARD_STATIC, a status set, …) and appends its SELECT.            */
async function buildAnalyticsOrderScope(req) {
  const { startDate, endDate } = req.query;
  const params = [req.user.business_id];                    // $1 = tenant
  let startIdx = null, endIdx = null;
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    params.push(`${startDate}T00:00:00${getEgyptOffset(startDate)}`); startIdx = params.length;
  }
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    params.push(`${endDate}T23:59:59${getEgyptOffset(endDate)}`); endIdx = params.length;
  }
  const rangePred = (col) => {
    const parts = [];
    if (startIdx) parts.push(`${col} >= $${startIdx}::timestamptz`);
    if (endIdx)   parts.push(`${col} <= $${endIdx}::timestamptz`);
    return parts.length ? `(${parts.join(' AND ')})` : 'TRUE';
  };
  const CR = rangePred('"createdAt"');

  let ordFilter = ` AND business_id = $1::integer`;

  /* Agency scope (media_buyer / admin-impersonation) → referral_code fence. */
  const scope = await resolveAnalyticsScope(req);
  if (!scope.all) {
    const hasOrderScope = scope.referralCodes && scope.referralCodes.length > 0;
    if (hasOrderScope) {
      params.push(scope.referralCodes);
      ordFilter += ` AND referral_code = ANY($${params.length}::text[])`;
    } else {
      ordFilter += ` AND 1=0`;
    }
  }

  /* Product filter (alias-aware) — same resolution as the overview. */
  const productSel = typeof req.query.product === 'string' ? req.query.product.trim() : '';
  if (productSel && productSel !== 'كل المنتجات') {
    const pr = await pool.query(
      `SELECT sku, name, COALESCE(aliases, '{}'::text[]) AS aliases
         FROM products
        WHERE UPPER(TRIM(name)) = UPPER(TRIM($1)) AND business_id = $2::integer LIMIT 1`,
      [productSel, req.user.business_id]);
    const prow = pr.rows[0];
    const prodTokens = [prow?.sku, prow?.name, ...(prow?.aliases || []), productSel]
      .map((t) => String(t ?? '').trim().toUpperCase()).filter((t) => t !== '');
    if (prodTokens.length > 0) {
      params.push(prodTokens);
      ordFilter += ` AND ( UPPER(TRIM(COALESCE(sku,'')))          = ANY($${params.length}::text[])
                        OR UPPER(TRIM(COALESCE("ProductName",''))) = ANY($${params.length}::text[]) )`;
    }
  }

  /* Campaign filter — same token resolution as the overview. */
  const campaignSel = typeof req.query.campaign === 'string' ? req.query.campaign.trim() : '';
  if (campaignSel && campaignSel !== 'كل الحملات') {
    const campTokens = await resolveCampaignTokens(req.user.business_id, campaignSel);
    if (campTokens.length === 0) {
      ordFilter += ` AND 1=0`;
    } else {
      params.push(campTokens);
      ordFilter += ` AND ( UPPER(TRIM(COALESCE(sku,'')))          = ANY($${params.length}::text[])
                        OR UPPER(TRIM(COALESCE("ProductName",''))) = ANY($${params.length}::text[]) )`;
    }
  }

  return { params, ordFilter, CR };
}

/* ── GET /api/analytics/in-transit-orders ────────────────────────────────────
   Drill-down for the 'طلبات في الطريق' / 'مستحقات لدى شركة الشحن' cards. Returns
   the EXACT order rows that make up the card's count, so the user can copy each
   Bosta AWB and track it in their portal. Consistency is guaranteed BY CONSTRUCTION:
   it applies the SAME module-level FORWARD_STATIC predicate and rebuilds the SAME
   scope (buildAnalyticsOrderScope) as GET /dashboard's in_transit_count. Gated by
   the 'analytics' permission (admins bypass).                                    */
router.get('/in-transit-orders', authenticate, requireAdminOrPermission('analytics'), async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const { params, ordFilter, CR } = await buildAnalyticsOrderScope(req);

    const { rows } = await pool.query(
      `SELECT id,
              "Phone"             AS phone,
              "FullName"          AS customer_name,
              "BostaTrackingCode" AS tracking_number,
              ROUND(${DRILLDOWN_COD_EXPR}, 2) AS cod,
              "createdAt"         AS created_at,
              "shipped_at"        AS shipped_at
         FROM orders
        WHERE 1=1${ordFilter}
          AND ${FORWARD_STATIC}
          AND ${CR}
        ORDER BY "shipped_at" DESC NULLS LAST, "createdAt" DESC
        LIMIT 1000`,
      params
    );

    const totalCod = rows.reduce((s, r) => s + Number(r.cod || 0), 0);
    res.json({
      startDate: (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) ? startDate : null,
      endDate:   (endDate   && /^\d{4}-\d{2}-\d{2}$/.test(endDate))   ? endDate   : null,
      count:     rows.length,
      totalCod:  Math.round(totalCod * 100) / 100,
      orders:    rows,
    });
  } catch (err) {
    console.error('[analytics/in-transit-orders]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم أثناء جلب طلبات الطريق' });
  }
});

/* ── GET /api/analytics/orders-by-status?statuses=… ──────────────────────────
   Generic drill-down for the status-based dashboard cards (Confirmed / Delivered
   / Returned-Failed). `statuses` is a comma-separated list of order statuses; the
   list is whitelisted (DRILLDOWN_STATUSES) and parameterised. Same date/product/
   campaign/agency scope as the overview counts, so COUNT(rows) matches the card.  */
router.get('/orders-by-status', authenticate, requireAdminOrPermission('analytics'), async (req, res) => {
  const { startDate, endDate } = req.query;
  const requested = String(req.query.statuses || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const statuses = requested.filter((s) => DRILLDOWN_STATUSES.has(s));
  if (statuses.length === 0) {
    return res.status(400).json({ error: 'حالة غير صالحة' });
  }
  try {
    const { params, ordFilter, CR } = await buildAnalyticsOrderScope(req);
    params.push(statuses);
    const statusIdx = params.length;

    const { rows } = await pool.query(
      `SELECT id,
              "Phone"             AS phone,
              "FullName"          AS customer_name,
              "BostaTrackingCode" AS tracking_number,
              "Status"            AS status,
              ROUND(${DRILLDOWN_COD_EXPR}, 2) AS cod,
              "createdAt"         AS created_at
         FROM orders
        WHERE 1=1${ordFilter}
          AND "Status" = ANY($${statusIdx}::text[])
          AND ${CR}
        ORDER BY "createdAt" DESC
        LIMIT 1000`,
      params
    );

    const totalCod = rows.reduce((s, r) => s + Number(r.cod || 0), 0);
    res.json({
      startDate: (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) ? startDate : null,
      endDate:   (endDate   && /^\d{4}-\d{2}-\d{2}$/.test(endDate))   ? endDate   : null,
      count:     rows.length,
      totalCod:  Math.round(totalCod * 100) / 100,
      orders:    rows,
    });
  } catch (err) {
    console.error('[analytics/orders-by-status]', err.message);
    res.status(500).json({ error: 'خطأ في الخادم أثناء جلب الطلبات' });
  }
});

/* ── GET /api/analytics/my-performance — Any authenticated user ───── */
router.get('/my-performance', authenticate, async (req, res) => {
  const { startDate, endDate } = req.query;
  const params = [req.user.email];           // $1 is always the email
  params.push(req.user.business_id);         // $2 = tenant
  const bizIdx = params.length;
  const joinOn = buildJoinOn(params, startDate, endDate, bizIdx);

  const sql = buildAgentSql(joinOn, `WHERE u.email = $1 AND u.business_id = $${bizIdx}::integer`);

  /* ── All-time Employee-Ledger balance (date-INDEPENDENT) ────────────────────
     `earned_commission` above is the SELECTED PERIOD's earnings. But a payout
     settles the agent's LIFETIME balance, so an agent must see three distinct
     numbers or they think a past payout never happened:
       lifetime_commission = earned over ALL orders ever (same formula)
       total_paid          = Σ logged payouts (all-time)
       outstanding_balance = lifetime_commission − total_paid  (what is owed NOW)
     Identical to GET /agents so the agent's own view matches the admin's. Uses
     only $1 (email) + $2 (tenant) — never the date params.                     */
  const lifetimeSql = `
    SELECT
      ${EARNED_COMMISSION_SQL}         AS lifetime_commission,
      COALESCE(pay.total_paid, 0)      AS total_paid
    FROM users u
    LEFT JOIN orders o
      ON LOWER(TRIM(o."AssignedTo")) = LOWER(TRIM(u.email)) AND o.business_id = $2::integer
    LEFT JOIN (
      SELECT user_id, SUM(amount) AS total_paid
      FROM employee_payouts
      WHERE business_id = $2::integer
      GROUP BY user_id
    ) pay ON pay.user_id = u.id
    WHERE u.email = $1 AND u.business_id = $2::integer
    GROUP BY u.id, u.comm_confirmed, u.comm_delivered,
             u.comm_rejected, u.comm_no_answer, pay.total_paid
  `;

  try {
    const result = await pool.query(sql, params);
    if (!result.rows.length) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    /* Guarded so a missing employee_payouts table (pre-migration) degrades to
       earned-only instead of a 500. */
    const life = await pool.query(lifetimeSql, [req.user.email, req.user.business_id]).catch((e) => {
      console.warn('[analytics/my-performance] lifetime balance unavailable:', e.message);
      return { rows: [] };
    });
    const L        = life.rows[0];
    const lifetime = L ? (parseFloat(L.lifetime_commission) || 0) : 0;
    const paid     = L ? (parseFloat(L.total_paid)          || 0) : 0;

    res.json({
      ...result.rows[0],
      lifetime_commission: parseFloat(lifetime.toFixed(2)),
      total_paid:          parseFloat(paid.toFixed(2)),
      outstanding_balance: parseFloat((lifetime - paid).toFixed(2)),
    });
  } catch (err) {
    console.error('[analytics/my-performance] SQL error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/analytics/products-profitability  — Admin only
   ─────────────────────────────────────────────────────────────────────────
   For every product in the catalogue this returns:

     units_delivered     — confirmed-delivered orders in the period
                           (matched via orders.sku = products.sku)
     delivered_revenue   — sum of ProductPrice for those orders
     attributed_ad_spend — sum of Meta-sync expense rows whose parsed
                           sku matches the product SKU (case-insensitive)
     cogs                — cost_price × units_delivered
     net_profit          — delivered_revenue − cogs − attributed_ad_spend
     cpa                 — attributed_ad_spend / total_confirmed_orders

   Order date filter: uses Egypt-local timestamps against "updatedAt"
   (same strategy as every other analytics endpoint — matches Ads Manager).

   Expense date filter: plain DATE comparison against expense_date.

   Matching order: UPPER(sku) on both sides — survives any capitalisation
   difference between campaign names and the products catalogue.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/products-profitability', authenticate, async (req, res) => {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'media_buyer') {
    return res.status(403).json({ error: 'غير مصرح لك بعرض ربحية المنتجات' });
  }

  const { startDate, endDate } = req.query;

  /* AGENCY scope (admin-all / admin-impersonate / media_buyer-self). */
  const ppScope = await resolveAnalyticsScope(req);

  /* ── Affiliate plan: products come from external_affiliate_orders (the local
     orders/products tables are empty for affiliate tenants). Return the Safqa
     per-product breakdown directly, respecting the date + product + scope. */
  if (req.user.plan_type === 'affiliate') {
    const bd = await aggregateSafqaBreakdowns(req.user.business_id, {
      startDate, endDate, product: req.query.product, campaign: req.query.campaign,
      referralCodes: scopeOrders(ppScope), adAccountIds: scopeAdAcc(ppScope),
    });
    return res.json(bd.products);
  }

  /* ── EXPENSE DATE PARAMS: hardcoded as $1 / $2 ──────────────────────────────
     Expense dates MUST occupy the first two positions so the expense_stats CTE
     can use literal $1 / $2 with no dynamic string building.
     Both are always present (null when absent); IS NULL OR in the SQL makes a
     null param act as "no bound" — same semantics as before without any risk of
     the template string evaluating to an empty filter.                          */
  const params = [
    (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) ? startDate : null,  // $1 expense start
    (endDate   && /^\d{4}-\d{2}-\d{2}$/.test(endDate))   ? endDate   : null,  // $2 expense end
  ];

  /* ── ORDER TIMESTAMP BOUNDS: appended after expense params ($3, $4 …) ─────
     Filter on "createdAt" (order placement date).  "updatedAt" is auto-stamped
     on every status change and would drag old orders into the current window.  */
  let ordFilter = '';
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const offset = getEgyptOffset(startDate);
    params.push(`${startDate}T00:00:00${offset}`);
    ordFilter += ` AND o."createdAt" >= $${params.length}::timestamptz`;
  }
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    const offset = getEgyptOffset(endDate);
    params.push(`${endDate}T23:59:59${offset}`);
    ordFilter += ` AND o."createdAt" <= $${params.length}::timestamptz`;
  }

  /* ── Role-based scoping — AGENCY MODEL ───────────────────────────────────────
     Unified with /dashboard so Detailed Table ↔ Top Cards stay consistent:
       expense_stats → meta_account_id IN (scope.adAccountIds)        [$accIdx]
       order_stats   → orders.referral_code IN (scope.referralCodes)  [$refIdx]
     Admin-all → both NULL (no scope). A scoped-but-unconfigured user → empty.
     skuIdx (the old SKU-bridge attribution) is RETIRED but kept as a NULL no-op
     so the outer-SELECT WHERE template is unchanged. */
  let accIdx = 'NULL';   // expense-account scope
  let skuIdx = 'NULL';   // retired SKU-bridge → NULL no-op
  let refIdx = 'NULL';   // order referral_code scope
  if (!ppScope.all) {
    const hasOrderScope   = ppScope.referralCodes && ppScope.referralCodes.length > 0;
    const hasExpenseScope = ppScope.adAccountIds  && ppScope.adAccountIds.length  > 0;
    if (!hasOrderScope && !hasExpenseScope) return res.json([]);   // unconfigured → empty
    /* empty array → ANY('{}') = 0 rows (strict isolation); non-empty → scoped. */
    params.push(hasExpenseScope ? ppScope.adAccountIds : []);
    accIdx = `$${params.length}`;
    params.push(hasOrderScope ? ppScope.referralCodes : []);
    refIdx = `$${params.length}`;
  }

  /* ── TENANT ISOLATION param — appended after any media-buyer scope params ──
     Captures the $-position of req.user.business_id, referenced in every CTE
     below so products / orders / expenses are all locked to the caller's tenant. */
  params.push(req.user.business_id);
  const bizIdx = `$${params.length}`;

  /* ── Campaign filter ──────────────────────────────────────────────────────
     Restrict the returned products to those advertised by the selected Meta
     campaign (campaign_name CONTAINS the product SKU — the same naming convention
     used by ADS isolation + the dashboard campaign filter). This keeps the
     Detailed Products Table UNIFIED with the Top Cards: both reduce to the same
     campaign→SKU product set. NULL ('كل الحملات'/'') → all products.
     A campaign matching no catalogue product → empty table (consistent with the
     dashboard's 1=0 for the same case). */
  let campSkuIdx  = 'NULL';   // SQL literal NULL → no campaign product scope
  let campNameIdx = 'NULL';   // SQL literal NULL → no campaign ad-spend scope
  const campaignSel = typeof req.query.campaign === 'string' ? req.query.campaign.trim() : '';
  if (campaignSel && campaignSel !== 'كل الحملات') {
    const csRes = await pool.query(
      `SELECT DISTINCT UPPER(TRIM(sku)) AS sku
         FROM products
        WHERE business_id = $1::integer
          AND COALESCE(TRIM(sku), '') <> ''
          AND UPPER($2::text) LIKE '%' || UPPER(TRIM(sku)) || '%'`,
      [req.user.business_id, campaignSel]
    );
    const campSkus = csRes.rows.map((r) => r.sku);
    if (campSkus.length === 0) return res.json([]);   // campaign advertises no product
    params.push(campSkus);
    campSkuIdx = `$${params.length}`;
    /* Also scope the per-SKU ad-spend (expense_stats) to THIS campaign's name, so a
       product's attributed_ad_spend in the table matches the campaign-scoped
       meta_spend in the Top Cards (a SKU may run under several campaigns). */
    params.push(campaignSel.toUpperCase());
    campNameIdx = `$${params.length}`;
  }

  /* Inline price parser for delivered revenue (references orders alias "o") */
  const PRICE_O = `
    COALESCE(
      NULLIF(REGEXP_REPLACE(COALESCE(o."ProductPrice"::text,''),'[^0-9.]','','g'),'')::numeric,
      0
    )`;

  const sql = `
    WITH order_stats AS (
      /* ── Join products → orders to count confirmed/delivered per product ──────
         Two matching strategies handle the fact that "sku" on orders is a
         late-added nullable column (many existing orders have NULL sku):

           PRIMARY   – orders.sku is set and matches products.sku (exact, case-insensitive)
           FALLBACK  – orders.sku is NULL/empty → match on ProductName vs products.name

         COUNT(DISTINCT o.id) prevents double-counting if both conditions fire for
         a single order.  Date filter uses "createdAt" (placement date).          */
      SELECT
        p.id                                                                AS product_id,
        /* Authoritative DB order count for this product — ALL statuses, on the
           SAME createdAt date cohort. This is the order-count source of truth
           (matches the dashboard's total_orders), NOT the Meta pixel count. */
        COUNT(DISTINCT o.id)                                                AS db_order_count,
        COUNT(DISTINCT o.id) FILTER (WHERE o."Status" = 'تم التوصيل')     AS units_delivered,
        /* DR denominator — orders that actually LEFT the warehouse to the courier.
           Deliberately EXCLUDES 'تم التأكيد' (confirmed but not yet shipped) and
           'جديد'/'لا يرد' (never sent), so Product DR = delivered ÷ shipped.      */
        COUNT(DISTINCT o.id) FILTER (WHERE o."Status" IN (
          'تم الشحن','تم التوصيل','جاري الإعادة','تم الإرجاع'
        ))                                                                  AS units_shipped,
        COUNT(DISTINCT o.id) FILTER (WHERE o."Status" IN (
          'تم التأكيد','تم الشحن','تم التوصيل',
          'جاري الإعادة','تم الإرجاع'
        ))                                                                  AS total_confirmed,
        COALESCE(SUM(
          CASE WHEN o."Status" = 'تم التوصيل' THEN ${PRICE_O} ELSE 0 END
        ), 0)                                                               AS delivered_revenue,
        /* COGS — historically accurate + unit-based:
             Σ over the product's DELIVERED orders of
               COALESCE(o.unit_cost_price, p.cost_price) × COALESCE(o.quantity, 1)
           • unit_cost_price = the WAC SNAPSHOTTED on the order at confirmation —
             the true cost at sale time; falls back to the product's live cost_price
             when the snapshot is missing OR zero (NULLIF guards a 0 snapshot from
             being wrongly accepted as a real 0 cost).
           • × quantity so multi-unit orders cost the full units delivered, not 1. */
        COALESCE(SUM(
          CASE WHEN o."Status" = 'تم التوصيل'
            THEN COALESCE(NULLIF(o."unit_cost_price"::numeric, 0), p.cost_price::numeric, 0)
                 * COALESCE(o."quantity", 1)
            ELSE 0 END
        ), 0)                                                               AS cogs,
        /* Exact per-AWB shipping (Phase B1 / Option C): the true Bosta deduction
           (orders.actual_shipping_fee = priceAfterVat) for ALL of this product's
           DISPATCHED orders — delivered AND returned/rejected. Bosta STILL charges
           the shipping fee on failed/returned parcels, so gating this on
           'تم التوصيل' understated cost and inflated profit. actual_shipping_fee is
           only ever populated for parcels that actually shipped (captured per AWB
           by tracking number), so a plain SUM is exact: orders that never left the
           warehouse carry NULL → 0 and contribute nothing. */
        COALESCE(SUM(COALESCE(o."actual_shipping_fee"::numeric, 0)), 0)      AS shipping_cost
      FROM   products p
      JOIN   orders   o ON (
        o.business_id = ${bizIdx}::integer
        AND (
          /* SKU match — preferred when the order's SKU matches THIS product. */
          ( COALESCE(o.sku, '') <> '' AND UPPER(o.sku) = UPPER(p.sku) )
          OR
          /* ProductName fallback — fires when the order's SKU is missing OR is a
             junk/legacy SKU that matches NO product at all (NOT EXISTS guard).
             Previously this only fired when sku WAS EMPTY, so orders tagged with a
             non-matching SKU (e.g. 'ipl' instead of 'IPL-PRO-01') were dropped from
             COGS/profitability entirely — undercounting cost. The NOT EXISTS guard
             also stops an order from matching two products (one by SKU, one by name). */
          ( UPPER(TRIM(COALESCE(o."ProductName", ''))) = UPPER(TRIM(p.name))
            AND NOT EXISTS (
              SELECT 1 FROM products px
              WHERE px.business_id = ${bizIdx}::integer
                AND COALESCE(o.sku, '') <> ''
                AND UPPER(px.sku) = UPPER(o.sku)
            ) )
        )
      )
      WHERE  p.business_id = ${bizIdx}::integer${ordFilter}
        AND  (${refIdx}::text[] IS NULL OR o.referral_code = ANY(${refIdx}::text[]))
      GROUP  BY p.id
    ),
    expense_stats AS (
      /* Sum of Meta-synced spend + reported purchases per SKU in the date range.
         Date bounds use hardcoded $1 and $2 (expense startDate / endDate).
         IS NULL OR makes each bound optional; null param skips the condition.
         Alias meta_orders_total keeps the JS mapping below unambiguous.        */
      SELECT
        UPPER(e.sku)                              AS sku,
        SUM(e.amount)                             AS attributed_spend,
        COALESCE(SUM(e.meta_purchases), 0)        AS meta_orders_total
      FROM   expenses e
      WHERE  e.meta_sync = TRUE
        AND  e.business_id = ${bizIdx}::integer
        AND  e.sku IS NOT NULL AND e.sku <> ''
        AND  ($1::date IS NULL OR e.expense_date >= $1::date)
        AND  ($2::date IS NULL OR e.expense_date <= $2::date)
        AND  (${accIdx}::int[] IS NULL OR e.meta_account_id = ANY(${accIdx}))
        AND  (${campNameIdx}::text IS NULL OR UPPER(e.campaign_name) = ${campNameIdx})
      GROUP  BY UPPER(e.sku)
    )
    SELECT
      p.id::text                               AS product_id,
      p.name                                   AS product_name,
      p.sku,
      COALESCE(p.cost_price::numeric,   0)     AS cost_price,
      COALESCE(os.units_delivered,      0)     AS units_delivered,
      COALESCE(os.units_shipped,        0)     AS units_shipped,
      COALESCE(os.total_confirmed,      0)     AS erp_order_count,
      COALESCE(os.db_order_count,       0)     AS db_order_count,
      COALESCE(os.delivered_revenue,    0)     AS delivered_revenue,
      COALESCE(os.cogs,                 0)     AS cogs,
      COALESCE(os.shipping_cost,        0)     AS shipping_cost,
      COALESCE(es.attributed_spend,     0)     AS attributed_ad_spend,
      COALESCE(es.meta_orders_total,    0)     AS meta_orders_total
    FROM   products p
    LEFT   JOIN order_stats   os ON os.product_id = p.id
    LEFT   JOIN expense_stats es ON es.sku = UPPER(p.sku)
    WHERE  p.business_id = ${bizIdx}::integer
      AND  (${skuIdx}::text[] IS NULL OR UPPER(p.sku) = ANY(${skuIdx}))
      AND  (${campSkuIdx}::text[] IS NULL OR UPPER(TRIM(p.sku)) = ANY(${campSkuIdx}))
    ORDER  BY COALESCE(os.delivered_revenue, 0) DESC,
              COALESCE(es.attributed_spend,  0) DESC,
              p.name ASC
  `;

  try {
    const { rows } = await pool.query(sql, params).catch((err) => {
      /* Surface the FULL PostgreSQL error (message + detail + hint) so we can
         diagnose column-name typos, type mismatches, etc. in the backend log. */
      console.error('[Product API Error] SQL failed:');
      console.error('  message:', err.message);
      console.error('  detail: ', err.detail  ?? '—');
      console.error('  hint:   ', err.hint    ?? '—');
      console.error('  query:  ', err.query   ?? '(not attached)');
      throw err;   // re-throw so the outer catch sends the 500 with details
    });

    /* ── OPEX allocation (Path A+) — IDENTICAL model to /api/analytics/dashboard
       so the lower sections' Net Profit matches the top KPI cards exactly.
         • COMMISSIONS (source LIKE 'comm_%') → attributed EXACTLY per product by
           joining the treasury row's order to its product (same SKU→name fallback
           as the profitability CTE).
         • SHARED OPEX (everything else, AD_SPEND excluded) → one business-wide
           lump split by DELIVERED-ORDER COUNT across all products.
       Date-scoped by transaction_date with the SAME validated YYYY-MM-DD bounds
       ($1 start / $2 end) already used by this route. Mirrors opexSql /
       opexCommByProductSql in the dashboard route verbatim, so the two endpoints
       can never drift in how OPEX is computed.                                  */
    const opexParams = [req.user.business_id, params[0], params[1]];
    const [opexRes, opexCommRes] = await Promise.all([
      pool.query(`
        SELECT source, COALESCE(SUM(amount), 0) AS amount
        FROM   treasury_transactions
        WHERE  business_id = $1::integer
          AND  type = 'expense'
          /* Mirror the dashboard opexSql: exclude AD_SPEND (Meta-synced) and
             INVENTORY_PURCHASE (stock CapEx, not an operating cost) from P&L OPEX. */
          AND  source NOT IN ('AD_SPEND', 'INVENTORY_PURCHASE')
          AND  ($2::text IS NULL OR TO_CHAR(transaction_date, 'YYYY-MM-DD') >= $2)
          AND  ($3::text IS NULL OR TO_CHAR(transaction_date, 'YYYY-MM-DD') <= $3)
        GROUP  BY source
      `, opexParams).catch((err) => { console.error('[products-profitability/opex] failed:', err.message); return { rows: [] }; }),
      pool.query(`
        SELECT p.name AS product_name, COALESCE(SUM(tt.amount), 0) AS commission
        FROM   treasury_transactions tt
        JOIN   orders   o ON o.id = tt.order_id AND o.business_id = $1::integer
        JOIN   products p ON p.business_id = $1::integer
          AND (
            ( COALESCE(o.sku, '') <> '' AND UPPER(o.sku) = UPPER(p.sku) )
            OR
            ( UPPER(TRIM(COALESCE(o."ProductName", ''))) = UPPER(TRIM(p.name))
              AND NOT EXISTS (
                SELECT 1 FROM products px
                WHERE px.business_id = $1::integer
                  AND COALESCE(o.sku, '') <> ''
                  AND UPPER(px.sku) = UPPER(o.sku)
              ) )
          )
        WHERE  tt.business_id = $1::integer
          AND  tt.type = 'expense'
          AND  tt.source LIKE 'comm\\_%'
          AND  ($2::text IS NULL OR TO_CHAR(tt.transaction_date, 'YYYY-MM-DD') >= $2)
          AND  ($3::text IS NULL OR TO_CHAR(tt.transaction_date, 'YYYY-MM-DD') <= $3)
        GROUP  BY p.id, p.name
      `, opexParams).catch((err) => { console.error('[products-profitability/opex-comm] failed:', err.message); return { rows: [] }; }),
    ]);

    /* Split OPEX into commissions (exact per product) vs shared (count-split). */
    let opexShsTotal = 0, opexCommTotal = 0;
    for (const o of (opexRes.rows ?? [])) {
      const amt = parseFloat(o.amount) || 0;
      if (String(o.source).startsWith('comm_')) opexCommTotal += amt;
      else                                      opexShsTotal  += amt;
    }
    const commissionByProduct = {};
    for (const c of (opexCommRes.rows ?? [])) {
      commissionByProduct[c.product_name] = parseFloat(c.commission) || 0;
    }
    /* Shared OPEX is split by delivered-order COUNT across ALL products (the same
       denominator the frontend uses: Σ units_delivered over the full catalogue). */
    const totalDeliveredAll = rows.reduce((s, r) => s + (parseInt(r.units_delivered, 10) || 0), 0);

    /* Compute derived metrics in JS to keep the SQL readable */
    const result = rows.map((r) => {
      const costPrice        = parseFloat(r.cost_price)          || 0;
      const unitsDelivered   = parseInt(r.units_delivered,  10)  || 0;
      /* Units actually shipped to the courier — the DR denominator. */
      const unitsShipped     = parseInt(r.units_shipped,    10)  || 0;
      /* Product Delivery Rate = delivered ÷ shipped × 100 (0 when none shipped,
         so a product with only confirmed/new orders shows 0% rather than NaN). */
      const deliveryRate     = unitsShipped > 0
        ? parseFloat(((unitsDelivered / unitsShipped) * 100).toFixed(1))
        : 0;
      /* erp_order_count — ERP-internal confirmed count (kept for pixel efficiency).
         Column was renamed from total_orders → erp_order_count in the SQL above
         to prevent confusion with the authoritative Meta-sourced total_orders.    */
      const erpOrderCount    = parseInt(r.erp_order_count,  10)  || 0;
      /* Authoritative DB order count (all statuses, date-filtered) — the order
         total-of-truth for this product, mirroring the dashboard total_orders. */
      const dbOrderCount     = parseInt(r.db_order_count,   10)  || 0;
      const deliveredRevenue = parseFloat(r.delivered_revenue)   || 0;
      const attributedSpend  = parseFloat(r.attributed_ad_spend) || 0;

      /* metaOrders — read from the explicitly named meta_orders_total column.
         If the expense row has no SKU match the value is 0 (LEFT JOIN → NULL →
         COALESCE 0); that is a data attribution issue, not a code bug.          */
      const metaOrders  = parseInt(r.meta_orders_total, 10) || 0;
      /* COGS now comes straight from SQL: Σ(snapshot unit cost × delivered qty).
         No longer cost_price × delivered-order-count (which ignored quantity and
         the historical snapshot). costPrice above is kept only for display. */
      const cogs        = parseFloat((parseFloat(r.cogs) || 0).toFixed(2));
      /* Exact per-AWB shipping for this product's delivered orders (Option C).
         Folded into the product margin so net_profit reflects the TRUE cost of
         selling this product: revenue − COGS − ad spend − real shipping. */
      const shippingCost = parseFloat((parseFloat(r.shipping_cost) || 0).toFixed(2));
      /* Path A+ OPEX for THIS product = exact commission + shared × (units ÷ total).
         Identical to the dashboard's effectiveOpex for a selected product, so this
         row's net profit equals the top KPI Net Profit card when filtered to it. */
      const opexCommission = commissionByProduct[r.product_name] || 0;
      const opexShared     = totalDeliveredAll > 0
        ? opexShsTotal * (unitsDelivered / totalDeliveredAll)
        : 0;
      const opexAllocated  = parseFloat((opexCommission + opexShared).toFixed(2));
      /* TRUE net profit — now includes OPEX, matching /dashboard exactly:
         revenue − COGS − ad spend − per-AWB shipping − allocated OPEX. */
      const netProfit   = parseFloat((deliveredRevenue - cogs - attributedSpend - shippingCost - opexAllocated).toFixed(2));
      const cpa         = metaOrders > 0
        ? parseFloat((attributedSpend / metaOrders).toFixed(2))
        : null;

      return {
        product_id:          r.product_id ?? null,
        product_name:        r.product_name ?? '',   // never null — frontend renders directly
        sku:                 r.sku ?? '',             // never null — used in .toUpperCase() joins
        cost_price:          costPrice,
        units_delivered:     unitsDelivered,
        units_shipped:       unitsShipped,        // DR denominator (orders sent to courier)
        delivery_rate:       deliveryRate,        // delivered ÷ shipped × 100
        total_orders:        dbOrderCount,        // AUTHORITATIVE DB order count (all statuses, date-filtered)
        confirmed_orders:    erpOrderCount,       // confirmed+ statuses — CR numerator
        erp_orders:          erpOrderCount,       // alias kept for pixel-efficiency calc
        delivered_revenue:   deliveredRevenue,
        attributed_ad_spend: attributedSpend,
        cogs,
        shipping_cost:       shippingCost,       // exact per-AWB Bosta fee (Option C)
        opex_allocated:      opexAllocated,      // Path A+ OPEX folded into net_profit
        net_profit:          netProfit,
        cpa,
        meta_orders:         metaOrders,          // backward-compat alias (identical to total_orders)
      };
    });

    res.json(result);
  } catch (err) {
    /* Full error is already logged by the inner .catch() above; we just
       forward the message to the frontend so it can display it in the UI. */
    console.error('[Product API Error]:', err);
    res.status(500).json({ error: 'خطأ في الخادم', details: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/analytics/dashboard  — Admin + Media Buyer (role-scoped)
   ─────────────────────────────────────────────────────────────────────────
   Unified payload containing:
     overview           — order counts + revenue + expenses, date-filtered
     daily_chart_stats  — per-day breakdown (orders / revenue / ad spend)
     governorates_stats — per-city breakdown
     rejection_reasons  — cancelled orders grouped by rejectionReason

   MULTI-TENANT SCOPING (Objective 4):
     • Admin       → aggregates ALL Meta accounts + ALL orders.
     • Media Buyer → only the Meta account(s) assigned to them. Expenses are
                     scoped by meta_account_id; orders are scoped via the SKU
                     bridge (the SKUs their account(s) advertise, with a
                     ProductName fallback for legacy orders missing a sku).
     • Agent       → 403 (not permitted to view analytics).
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/dashboard', authenticate, async (req, res) => {
  try {
  /* ── Role gate ─────────────────────────────────────────────────────────── */
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'media_buyer') {
    return res.status(403).json({ error: 'غير مصرح لك بعرض لوحة التحليلات' });
  }

  const { startDate, endDate } = req.query;

  console.log(`[DASHBOARD DEBUG] role=${role} user=${req.user?.id} range:`, startDate, endDate);

  /* ── Date range (Egypt TZ) ──────────────────────────────────────────────
     The date bounds are pushed ONCE as params and then referenced by PER-METRIC
     predicates, because different metrics key off different dates:
       • placement metrics (orders/confirmed/rejected/pending/returned) → "createdAt"
       • DELIVERED count + REVENUE                                       → delivered_at
     This fixes the bug where "Today/Yesterday" showed 0 delivered/revenue: an
     order placed last week but DELIVERED today now counts under today.        */
  const ordParams = [req.user.business_id];   // $1 = tenant
  let startIdx = null, endIdx = null;
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    ordParams.push(`${startDate}T00:00:00${getEgyptOffset(startDate)}`); startIdx = ordParams.length;
  }
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    ordParams.push(`${endDate}T23:59:59${getEgyptOffset(endDate)}`); endIdx = ordParams.length;
  }
  /* Range predicate for a timestamp column → 'TRUE' when no bounds set. */
  const rangePred = (col) => {
    const parts = [];
    if (startIdx) parts.push(`${col} >= $${startIdx}::timestamptz`);
    if (endIdx)   parts.push(`${col} <= $${endIdx}::timestamptz`);
    return parts.length ? `(${parts.join(' AND ')})` : 'TRUE';
  };
  const CR = rangePred('"createdAt"');                                   // placement-date predicate
  const DR = `(delivered_at IS NOT NULL AND ${rangePred('delivered_at')})`; // delivery-date predicate

  /* ── Scope filter (tenant + role + product) — NO date; dates are per-metric. */
  let ordFilter = ` AND business_id = $1::integer`;

  /* Product filter (admin dropdown): resolve the selected product NAME → its SKU
     so we can match by SKU (preferred) with a ProductName fallback for legacy
     orders. Applied to every orders query below. 'كل المنتجات'/'' = no filter. */
  const productSel = typeof req.query.product === 'string' ? req.query.product.trim() : '';
  const hasProduct = productSel && productSel !== 'كل المنتجات';
  let prodSku = null;
  /* ALIAS-AWARE match set: an order belongs to the selected product when its sku
     OR ProductName matches the product's sku, its canonical name, OR ANY of its
     aliases (case-insensitive, trimmed) — the same resolution used everywhere
     else (resolveProductForOrder). prodSku stays the canonical SKU for ad-spend
     attribution ($5), which is keyed on the catalogue SKU. */
  let prodTokens = [];
  if (hasProduct) {
    const pr = await pool.query(
      `SELECT sku, name, COALESCE(aliases, '{}'::text[]) AS aliases
         FROM products
        WHERE UPPER(TRIM(name)) = UPPER(TRIM($1)) AND business_id = $2::integer LIMIT 1`,
      [productSel, req.user.business_id]);
    const prow = pr.rows[0];
    prodSku = prow?.sku ? String(prow.sku).toUpperCase() : null;
    prodTokens = [prow?.sku, prow?.name, ...(prow?.aliases || []), productSel]
      .map((t) => String(t ?? '').trim().toUpperCase())
      .filter((t) => t !== '');
  }

  /* ── Expense date boundaries — plain string params ($1 / $2) ────────────────
     Both params are always present in the array; null when the bound is absent.

     The SQL uses:
       TO_CHAR(expense_date, 'YYYY-MM-DD') >= $1
     instead of the type-cast form  expense_date >= $1::date.

     Why string comparison?
       • Completely timezone-independent — TO_CHAR produces 'YYYY-MM-DD' text
         without any UTC-offset conversion.
       • No risk of implicit DATE↔TIMESTAMPTZ coercion that can shift boundaries
         by one day on servers whose TimeZone GUC differs from the client.
       • $1 IS NULL (not $1::date IS NULL) — avoids cast failure on drivers that
         send null as an untyped OID.
       • 'YYYY-MM-DD' lexicographic order is identical to chronological order,
         so string >= / <= behaves exactly like date >= / <=.                   */
  const expParams = [
    (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) ? startDate : null,
    (endDate   && /^\d{4}-\d{2}-\d{2}$/.test(endDate))   ? endDate   : null,
  ];

  /* ── Role-based scoping — AGENCY MODEL ───────────────────────────────────────
     Scope is resolved from the JWT (admin = all, or admin impersonating via
     ?mediaBuyer; media_buyer = self, param ignored). Attribution:
       expenses → meta_account_id IN (scope.adAccountIds)              [$3 below]
       orders   → referral_code   IN (scope.referralCodes)
     A SCOPED caller with no codes/accounts sees ZERO — never unscoped data. */
  const scope = await resolveAnalyticsScope(req);
  /* $3 for both expense queries. null → admin-all; [] → scoped, 0 accounts →
     meta_account_id = ANY('{}') yields 0 spend (correct isolation). */
  const expAccountIds = scopeAdAcc(scope);

  if (!scope.all) {
    const hasOrderScope   = scope.referralCodes && scope.referralCodes.length > 0;
    const hasExpenseScope = scope.adAccountIds  && scope.adAccountIds.length  > 0;

    /* Fully-unconfigured scoped user (no referral code AND no ad accounts) →
       short-circuit to an empty (valid) dashboard instead of running every query. */
    if (!hasOrderScope && !hasExpenseScope) {
      return res.json({
        overview: {
          total_orders: 0, total_confirmed: 0, total_delivered: 0,
          total_rejected: 0, total_returned: 0, total_pending: 0,
          total_revenue: 0, total_expenses: 0, meta_spend: 0,
          in_transit_count: 0, outstanding_cash: 0,
        },
        daily_chart_stats: [], governorates_stats: [], rejection_reasons: [],
        externalStats: await getExternalAffiliateStats(req.user.business_id, {
          startDate, endDate, product: req.query.product, campaign: req.query.campaign,
          referralCodes: scopeOrders(scope), adAccountIds: expAccountIds,
        }),
      });
    }

    /* ORDERS → referral_code attribution (the buyer's unique UTM/Sub-ID). A scoped
       buyer with no referral code yet → 1=0 (their attributed order set is empty
       until order ingestion starts stamping orders.referral_code). */
    if (hasOrderScope) {
      ordParams.push(scope.referralCodes);   const refIdx = ordParams.length;
      ordFilter += ` AND referral_code = ANY($${refIdx}::text[])`;
    } else {
      ordFilter += ` AND 1=0`;
    }
  }

  /* Product filter clause (admin dropdown) — composes (AND) with any role scope.
     ALIAS-AWARE: matches the order's sku OR ProductName against the product's
     sku/name/aliases token set, so orders tagged with an alias still count. */
  if (hasProduct && prodTokens.length > 0) {
    ordParams.push(prodTokens);   const pTokIdx = ordParams.length;
    ordFilter += ` AND ( UPPER(TRIM(COALESCE(sku,'')))           = ANY($${pTokIdx}::text[])
                      OR UPPER(TRIM(COALESCE("ProductName",'')))  = ANY($${pTokIdx}::text[]) )`;
  }

  /* Campaign filter (admin dropdown) — composes (AND) with product/role scope.
     Orders have no campaign column, so we resolve the selected campaign NAME to
     the SKU/name/alias tokens of every product it advertises (campaign_name
     CONTAINS sku), then scope orders to those products — exactly like the product
     filter. Ad spend is scoped separately to the campaign NAME ($6). A campaign
     that matches no catalogue product yields 1=0 (no orders), while its spend can
     still surface via $6. 'كل الحملات'/'' = no filter. */
  const campaignSel = typeof req.query.campaign === 'string' ? req.query.campaign.trim() : '';
  const hasCampaign = campaignSel && campaignSel !== 'كل الحملات';
  if (hasCampaign) {
    const campTokens = await resolveCampaignTokens(req.user.business_id, campaignSel);
    if (campTokens.length === 0) {
      ordFilter += ` AND 1=0`;
    } else {
      ordParams.push(campTokens);   const cTokIdx = ordParams.length;
      ordFilter += ` AND ( UPPER(TRIM(COALESCE(sku,'')))           = ANY($${cTokIdx}::text[])
                        OR UPPER(TRIM(COALESCE("ProductName",'')))  = ANY($${cTokIdx}::text[]) )`;
    }
  }

  /* Expense scope param is ALWAYS $3 (null for admin → no-op via IS NULL OR). */
  expParams.push(expAccountIds);
  /* TENANT ISOLATION: business_id is ALWAYS $4 for both expense queries. */
  expParams.push(req.user.business_id);
  /* Product filter for ad-spend ($5): the selected product's SKU, so meta_spend
     + Meta order count also reflect the dropdown. NULL when "all" (or the product
     has no SKU to attribute spend to) → IS NULL OR leaves spend unfiltered. */
  expParams.push(hasProduct && prodSku ? prodSku : null);
  /* Campaign filter for ad-spend ($6): scope meta_spend + Meta order count to the
     selected campaign NAME (case-insensitive). Composes with the product SKU ($5).
     NULL when "all campaigns" → IS NULL OR leaves spend unfiltered. */
  expParams.push(hasCampaign ? campaignSel.toUpperCase() : null);
  /* Defense-in-depth ($7): the tenant's CATALOGUE product SKUs (UPPERCASED). The
     "All Products" ad-spend (meta_spend + daily ads_spend) sums ONLY rows whose sku
     is a real catalogue product, so foreign campaigns that ever slip into expenses
     — e.g. ANOTHER business's Safqa spend on a SHARED Meta ad account — can never
     inflate this tenant's total. NULL when the tenant has no catalogue (e.g. a pure
     affiliate tenant) → IS NULL OR leaves spend unfiltered (the affiliate dashboard
     isolates its own spend separately). */
  const catSkuRes = await pool.query(
    `SELECT ARRAY(SELECT UPPER(TRIM(sku)) FROM products
                   WHERE business_id = $1::integer AND COALESCE(TRIM(sku),'') <> '') AS skus`,
    [req.user.business_id]);
  const catalogueSkus = catSkuRes.rows[0]?.skus || [];
  expParams.push(catalogueSkus.length ? catalogueSkus : null);

  /* Inline ProductPrice parser (same as other endpoints) */
  const P = `COALESCE(NULLIF(REGEXP_REPLACE(COALESCE("ProductPrice"::text,''),'[^0-9.]','','g'),'')::numeric, 0)`;
  /* Deposit parser — same defensive numeric extraction; net COD = price − deposit. */
  const DEP = `COALESCE(NULLIF(REGEXP_REPLACE(COALESCE("depositAmount"::text,''),'[^0-9.]','','g'),'')::numeric, 0)`;

  /* ── "Actively on the road" pipeline predicate ──────────────────────────────
     SHARED by the 'طلبات في الطريق' count and the 'مستحقات لدى شركة الشحن' cash
     sum so the two can NEVER diverge — the status/COD/freshness half comes from
     the module-level FORWARD_STATIC (also used by the drill-down list endpoint),
     and we AND on this request's date range (${CR} on "createdAt") so the cards
     answer "of the orders PLACED in this window, how many are STILL on the road,
     and how much COD is floating" — the same placement-date cohort every other
     card buckets by, for accurate day-level pending cash / P&L. With NO date
     filter, ${CR} is the literal 'TRUE' ⇒ whole-history live snapshot (unchanged).
     The date range and the ghost cutoff inside FORWARD_STATIC COMPOSE: for a day
     >10 days in the past every order has already resolved or become a ghost, so
     the cards correctly trend to ~0 rather than showing stale money. This is
     CURRENT status for that cohort (the schema keeps only the live status), i.e.
     "still floating NOW", not "was in transit at the close of that day". */
  const FORWARD_PIPELINE = `${FORWARD_STATIC} AND ${CR}`;

  /* ── 1. Overview: order counts + delivered revenue ── */
  const overviewSql = `
    SELECT
      COUNT(id) FILTER (WHERE ${CR})                                                  AS total_orders,
      COUNT(id) FILTER (WHERE ${CR} AND "Status" IN (
        'تم التأكيد','تم الشحن','تم التوصيل','جاري الإعادة','تم الإرجاع'
      ))                                                                              AS total_confirmed,
      COUNT(id) FILTER (WHERE ${CR} AND "Status" = 'تم التوصيل')                     AS total_delivered,
      COUNT(id) FILTER (WHERE ${CR} AND "Status" = 'تم الرفض')                       AS total_rejected,
      COUNT(id) FILTER (WHERE ${CR} AND "Status" IN ('جاري الإعادة','تم الإرجاع'))   AS total_returned,
      COUNT(id) FILTER (WHERE ${CR} AND "Status" IN ('جديد','لا يرد'))              AS total_pending,
      COALESCE(SUM(CASE WHEN "Status"='تم التوصيل' AND ${CR} THEN ${P} ELSE 0 END), 0) AS total_revenue,
      /* ── Logistics pipeline (CURRENT snapshot — intentionally NOT date-bound) ──
         Forward-moving orders physically in Bosta toward the customer, plus the COD
         the courier will collect for them. Both use the SHARED FORWARD_PIPELINE
         predicate (defined above) so the count and the cash sum can never disagree,
         and so ghosts / returns / failed-delivery parcels are excluded from BOTH.
         Cash = SUM of Bosta's LIVE expected_cod (the exact per-AWB collection,
         already quantity-inclusive), falling back to (ProductPrice − deposit) — which
         is itself the ORDER TOTAL (qty × unit baked in at creation; verified against
         Bosta COD) — for genuinely-forward orders Bosta hasn't reported yet.        */
      COUNT(id) FILTER (WHERE ${FORWARD_PIPELINE})                                    AS in_transit_count,
      COALESCE(SUM(
        COALESCE("expected_cod"::numeric, GREATEST(${P} - ${DEP}, 0))
      ) FILTER (WHERE ${FORWARD_PIPELINE}), 0)                                        AS outstanding_cash
    FROM orders
    WHERE 1=1${ordFilter}
  `;

  /* ── 2. Expense totals (all + Meta-only + Meta purchase count) ──────────────
     $1 = startDate::date, $2 = endDate::date  — hardcoded positions, NO dynamic
     string interpolation.  IS NULL OR makes each bound optional:
       • When the caller sends a date  → filters to that bound.
       • When the param is null        → condition is TRUE (no bound applied).
     total_expenses    = ALL expenses (manual + Meta) in the date window.
     meta_spend        = only Meta-synced rows  (via FILTER).
     meta_total_orders = SUM of meta_purchases from ALL meta-synced rows (FILTER).
       ↳ Intentionally has NO "sku <> 'UNATTRIBUTED'" guard — purchases from
         campaigns that could not be matched to a product SKU must still count
         toward the Total Orders KPI.  Per-product attribution is handled
         separately in the products-profitability CTE.                          */
  const expSql = `
    SELECT
      COALESCE(SUM(amount),                                              0) AS total_expenses,
      COALESCE(SUM(amount)         FILTER (WHERE meta_sync = true
              AND ($7::text[] IS NULL OR UPPER(TRIM(sku)) = ANY($7::text[]))), 0) AS meta_spend,
      COALESCE(SUM(meta_purchases) FILTER (WHERE meta_sync = true),      0) AS meta_total_orders
    FROM expenses
    WHERE business_id = $4::integer
      AND ($1::text IS NULL OR TO_CHAR(expense_date, 'YYYY-MM-DD') >= $1)
      AND ($2::text IS NULL OR TO_CHAR(expense_date, 'YYYY-MM-DD') <= $2)
      AND ($3::int[] IS NULL OR meta_account_id = ANY($3))
      AND ($5::text IS NULL OR UPPER(sku) = $5)
      AND ($6::text IS NULL OR UPPER(campaign_name) = $6)
  `;

  /* ── 3. Daily orders grouped by Egypt-local creation date ── */
  /* Group on "createdAt" (when the order was placed).
     We shift by +3h before casting to ::date — this converts the UTC-stored
     TIMESTAMP to its Egypt-summer-time (EEST, UTC+3) calendar date without
     requiring an IANA timezone-name lookup, which avoids a class of silent
     errors on some hosted PostgreSQL configurations.
     e.g. an order stored as 2026-05-24 22:30 UTC → +3h → 2026-05-25 01:30
          → ::date → 2026-05-25  (correct Cairo date)                        */
  /* TO_CHAR forces the date column into a plain 'YYYY-MM-DD' text value.
     Without it the pg driver may return a JavaScript Date object (midnight UTC),
     and serialising that with toISOString() in certain server timezones produces
     the previous calendar day — causing the chart to shift one day to the left.  */
  /* Cohort daily series — orders, confirmed, delivered AND revenue ALL grouped
     by the order's createdAt day. Delivered/revenue are attributed back to the
     day the order was PLACED (cohort view), so an order created Monday but
     delivered Thursday lifts MONDAY's delivered + revenue. This is what makes
     per-day NDR / True CPA / ROAS meaningful for ad performance.               */
  const dailyCreatedSql = `
    SELECT
      TO_CHAR(("createdAt" + INTERVAL '3 hours')::date, 'YYYY-MM-DD') AS stat_date,
      COUNT(id)                                                        AS orders,
      COUNT(id) FILTER (WHERE "Status" IN (
        'تم التأكيد','تم الشحن','تم التوصيل','جاري الإعادة','تم الإرجاع'
      ))                                                               AS confirmed,
      COUNT(id) FILTER (WHERE "Status" = 'تم التوصيل')               AS delivered,
      COALESCE(SUM(CASE WHEN "Status"='تم التوصيل' THEN ${P} ELSE 0 END), 0) AS revenue
    FROM orders
    WHERE 1=1${ordFilter} AND ${CR}
    GROUP BY TO_CHAR(("createdAt" + INTERVAL '3 hours')::date, 'YYYY-MM-DD')
    ORDER BY stat_date ASC
  `;

  /* ── 4. Daily Meta ad spend + Meta purchase count for chart ─────────────────
     Uses the SAME $1 / $2 params as expSql above (expParams is shared).
     TO_CHAR forces DATE → 'YYYY-MM-DD' text so the pg driver never returns a
     JS Date object that would shift the day by one in some timezones.
     meta_orders = SUM of meta_purchases only — NEVER falls back to ERP count.
     IS NULL OR makes both date bounds optional (same semantics as expSql).      */
  const dailyExpSql = `
    SELECT
      TO_CHAR(expense_date, 'YYYY-MM-DD')       AS stat_date,
      COALESCE(SUM(amount) FILTER (
        WHERE $7::text[] IS NULL OR UPPER(TRIM(sku)) = ANY($7::text[])
      ), 0)                                     AS ads_spend,
      COALESCE(SUM(meta_purchases), 0)          AS meta_orders
    FROM expenses
    WHERE meta_sync = true
      AND business_id = $4::integer
      AND ($1::text IS NULL OR TO_CHAR(expense_date, 'YYYY-MM-DD') >= $1)
      AND ($2::text IS NULL OR TO_CHAR(expense_date, 'YYYY-MM-DD') <= $2)
      AND ($3::int[] IS NULL OR meta_account_id = ANY($3))
      AND ($5::text IS NULL OR UPPER(sku) = $5)
      AND ($6::text IS NULL OR UPPER(campaign_name) = $6)
    GROUP BY TO_CHAR(expense_date, 'YYYY-MM-DD')
    ORDER BY stat_date ASC
  `;

  /* ── 5. Governorates breakdown ── */
  const govSql = `
    SELECT
      COALESCE(NULLIF(TRIM("City"),''), 'غير محدد')                               AS governorate,
      COUNT(*)                                                                      AS total_orders,
      COUNT(*) FILTER (WHERE "Status" IN (
        'تم التأكيد','تم الشحن','تم التوصيل','جاري الإعادة','تم الإرجاع'
      ))                                                                            AS confirmed,
      COUNT(*) FILTER (WHERE "Status" = 'تم التوصيل')                             AS delivered,
      COUNT(*) FILTER (WHERE "Status" IN ('جاري الإعادة','تم الإرجاع'))           AS returned,
      COALESCE(SUM(CASE WHEN "Status"='تم التوصيل' THEN ${P} ELSE 0 END), 0)     AS revenue
    FROM orders
    WHERE 1=1${ordFilter} AND ${CR}
    GROUP BY COALESCE(NULLIF(TRIM("City"),''), 'غير محدد')
    ORDER BY delivered DESC, total_orders DESC
    LIMIT 50
  `;

  /* ── 6. Rejection reasons ── */
  const rejSql = `
    SELECT
      COALESCE(NULLIF(TRIM("rejectionReason"),''), 'غير محدد')   AS reason,
      COUNT(*)                                                      AS count
    FROM orders
    WHERE "Status" = 'تم الرفض'${ordFilter} AND ${CR}
    GROUP BY COALESCE(NULLIF(TRIM("rejectionReason"),''), 'غير محدد')
    ORDER BY count DESC
    LIMIT 10
  `;

  /* ── 7. Operating expenses (OPEX) from the treasury ledger ───────────────────
     The TRUE-net-profit costs that live OUTSIDE the ad-spend `expenses` table:
     confirmation commissions, courier/shipping settlements, packaging, and fixed
     operational / SaaS costs. Source of truth = treasury_transactions.
       • type = 'expense'      → only costs (never revenue / opening-balance rows).
       • source <> 'AD_SPEND'  → ad spend is owned authoritatively by the Meta-
                                 synced `expenses` table (drives total_expenses /
                                 meta_spend). The manual treasury AD_SPEND entry is
                                 a cash-flow duplicate of that, so it MUST be
                                 excluded here to avoid double-counting ad spend.
       • transaction_date window → calendar-dated, the SAME basis as ad spend.
     Business-wide; the frontend attributes OPEX to a selected product using the
     Path A+ model:
       · COMMISSIONS (source LIKE 'comm_%') are EXACT per product — each treasury
         commission row carries an order_id, so we join it to its order's product
         (same SKU/name-fallback logic as profitability) and sum per product.
       · SHARED costs (shipping / packaging / operational / SaaS / any other
         non-AD_SPEND, non-commission source) have no product link, so the
         frontend splits them by DELIVERED-ORDER COUNT — not revenue — because a
         cheap and an expensive product cost roughly the same to ship/pack.
     Source-agnostic on the shared side: any NEW expense category added in
     Treasury (other than AD_SPEND/commissions) flows into the count-split
     automatically. Grouped by source so the UI can render a cost stack.
     $1=tenant, $2=start, $3=end.                                             */
  const opexParams = [
    req.user.business_id,
    (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) ? startDate : null,
    (endDate   && /^\d{4}-\d{2}-\d{2}$/.test(endDate))   ? endDate   : null,
  ];
  const opexSql = `
    SELECT source,
           COALESCE(SUM(amount), 0) AS amount
    FROM   treasury_transactions
    WHERE  business_id = $1::integer
      AND  type   = 'expense'
      /* P&L OPEX excludes: AD_SPEND (owned by the Meta-synced expenses table) and
         INVENTORY_PURCHASE (a stock CapEx — cash leaves the drawer but it becomes
         an inventory asset, recognised as COGS on delivery, NOT an operating cost).
         Both are still counted in the Treasury cash balance (treasury.js).        */
      AND  source NOT IN ('AD_SPEND', 'INVENTORY_PURCHASE')
      AND  ($2::text IS NULL OR TO_CHAR(transaction_date, 'YYYY-MM-DD') >= $2)
      AND  ($3::text IS NULL OR TO_CHAR(transaction_date, 'YYYY-MM-DD') <= $3)
    GROUP  BY source
  `;

  /* ── 7b. EXACT per-product commissions (Path A+) ─────────────────────────────
     Commission treasury rows carry order_id → join to the order, then to its
     product via the SAME SKU-then-ProductName-fallback used by profitability so
     legacy/junk-SKU orders are not dropped. Summed per product, calendar-dated by
     transaction_date (consistent with the OPEX window). Orders whose product
     cannot be resolved stay in the business-wide commission total but are simply
     not attributed to any single product (acceptable, small residual). Same
     params as opexSql ($1 tenant, $2 start, $3 end).                          */
  const opexCommByProductSql = `
    SELECT p.name                         AS product_name,
           COALESCE(SUM(tt.amount), 0)    AS commission
    FROM   treasury_transactions tt
    JOIN   orders   o ON o.id = tt.order_id AND o.business_id = $1::integer
    JOIN   products p ON p.business_id = $1::integer
      AND (
        ( COALESCE(o.sku, '') <> '' AND UPPER(o.sku) = UPPER(p.sku) )
        OR
        ( UPPER(TRIM(COALESCE(o."ProductName", ''))) = UPPER(TRIM(p.name))
          AND NOT EXISTS (
            SELECT 1 FROM products px
            WHERE px.business_id = $1::integer
              AND COALESCE(o.sku, '') <> ''
              AND UPPER(px.sku) = UPPER(o.sku)
          ) )
      )
    WHERE  tt.business_id = $1::integer
      AND  tt.type = 'expense'
      AND  tt.source LIKE 'comm\\_%'
      AND  ($2::text IS NULL OR TO_CHAR(tt.transaction_date, 'YYYY-MM-DD') >= $2)
      AND  ($3::text IS NULL OR TO_CHAR(tt.transaction_date, 'YYYY-MM-DD') <= $3)
    GROUP  BY p.id, p.name
  `;

  /* Run all 7 queries concurrently.  Each has its own .catch() so a single
     broken query (e.g. a missing column) returns an empty result set instead
     of crashing the entire payload.  The exact failure is logged to the
     backend terminal so you can identify which query went wrong.           */
  const [ovRes, exRes, dayRes, dayExpRes, govRes, rejRes, opexRes, opexCommRes] = await Promise.all([
    pool.query(overviewSql, ordParams).catch(err => {
      console.error('[dashboard/overview]   QUERY FAILED:', err.message, err.detail ?? '');
      return { rows: [{ total_orders: 0, total_confirmed: 0, total_delivered: 0,
                        total_rejected: 0, total_returned: 0, total_pending: 0,
                        total_revenue: 0 }] };
    }),
    pool.query(expSql, expParams).catch(err => {
      console.error('[dashboard/expenses]   QUERY FAILED:', err.message, err.detail ?? '');
      return { rows: [{ total_expenses: 0, meta_spend: 0, meta_total_orders: 0 }] };
    }),
    pool.query(dailyCreatedSql, ordParams).catch(err => {
      console.error('[dashboard/daily]      QUERY FAILED:', err.message, err.detail ?? '');
      return { rows: [] };
    }),
    pool.query(dailyExpSql, expParams).catch(err => {
      console.error('[dashboard/daily-exp]  QUERY FAILED:', err.message, err.detail ?? '');
      return { rows: [] };
    }),
    pool.query(govSql, ordParams).catch(err => {
      console.error('[dashboard/gov]        QUERY FAILED:', err.message, err.detail ?? '');
      return { rows: [] };
    }),
    pool.query(rejSql, ordParams).catch(err => {
      console.error('[dashboard/rejection]  QUERY FAILED:', err.message, err.detail ?? '');
      return { rows: [] };
    }),
    pool.query(opexSql, opexParams).catch(err => {
      console.error('[dashboard/opex]       QUERY FAILED:', err.message, err.detail ?? '');
      return { rows: [] };
    }),
    pool.query(opexCommByProductSql, opexParams).catch(err => {
      console.error('[dashboard/opex-comm]  QUERY FAILED:', err.message, err.detail ?? '');
      return { rows: [] };
    }),
  ]);

    /* ── Build overview ──
       Defensive fallback: if either query result is somehow empty (should
       never happen given the COALESCE + per-query .catch() above, but belt
       and suspenders) substitute safe zero-objects so the rest of the build
       never throws a "cannot read property of undefined" error.             */
    const ov = ovRes.rows[0] ?? {
      total_orders: 0, total_confirmed: 0, total_delivered: 0,
      total_rejected: 0, total_returned: 0, total_pending: 0, total_revenue: 0,
    };
    const ex = exRes.rows[0] ?? { total_expenses: 0, meta_spend: 0, meta_total_orders: 0 };

    /* ── Operating expenses (OPEX) breakdown ──
       Map each treasury source code to an Arabic label and sum the total. The
       map is source-agnostic: an unknown/custom source falls back to its raw
       code so a new Treasury category still shows (and still counts) without a
       code change here. operating_expenses = the full business-wide OPEX in the
       window (ad spend already excluded by the query). */
    const OPEX_LABELS = {
      comm_confirmed:                'عمولات تأكيد',
      comm_delivered:                'عمولات توصيل',
      comm_rejected:                 'عمولات رفض',
      comm_no_answer:                'عمولات عدم رد',
      PACKAGING_COST:                'تغليف',
      SHIPPING_PACKAGE_SUBSCRIPTION: 'شحن',
      OPERATIONAL_EXPENSE:           'مصروفات تشغيلية',
    };
    let operating_expenses = 0;
    const opex_breakdown = (opexRes.rows ?? [])
      .map((r) => {
        const amount = parseFloat(r.amount) || 0;
        operating_expenses += amount;
        return {
          source: r.source,
          label:  OPEX_LABELS[r.source] || r.source,
          amount: parseFloat(amount.toFixed(2)),
        };
      })
      .sort((a, b) => b.amount - a.amount);
    operating_expenses = parseFloat(operating_expenses.toFixed(2));

    /* ── Path A+ OPEX split inputs ──
       commissions_total = the comm_* slice of OPEX (attributed EXACTLY per product
                           on the frontend via opex_commission_by_product).
       shared_total      = everything else (shipping/packaging/ops/…) → the frontend
                           splits this by DELIVERED-ORDER COUNT.
       opex_commission_by_product = { [product_name]: exact commission in window }. */
    const opex_commissions_total = parseFloat(
      opex_breakdown
        .filter((o) => String(o.source).startsWith('comm_'))
        .reduce((s, o) => s + o.amount, 0)
        .toFixed(2)
    );
    const opex_shared_total = parseFloat(
      (operating_expenses - opex_commissions_total).toFixed(2)
    );
    const opex_commission_by_product = {};
    for (const r of (opexCommRes.rows ?? [])) {
      opex_commission_by_product[r.product_name] =
        parseFloat((parseFloat(r.commission) || 0).toFixed(2));
    }

    const overview = {
      /* total_orders = AUTHORITATIVE direct COUNT of the internal `orders` table
         for the selected window (ov.total_orders = COUNT(id) FILTER (WHERE ${CR})).
         The Meta pixel misses events and never sees manually-added orders, so its
         purchase count is NOT the source of truth for this KPI. The Meta purchase
         count is preserved separately as `meta_orders` for ad-efficiency metrics
         (CPP/CPA) which must stay Meta-attributed. */
      total_orders:    parseInt(ov.total_orders, 10) || 0,
      /* Meta-reported purchases (SUM meta_purchases WHERE meta_sync) — ads CPP/CPA only. */
      meta_orders:     parseInt(ex.meta_total_orders, 10) || 0,
      total_confirmed: parseInt(ov.total_confirmed, 10) || 0,
      total_delivered: parseInt(ov.total_delivered, 10) || 0,
      total_rejected:  parseInt(ov.total_rejected,  10) || 0,
      total_returned:  parseInt(ov.total_returned,  10) || 0,
      total_pending:   parseInt(ov.total_pending,   10) || 0,
      total_revenue:   parseFloat(parseFloat(ov.total_revenue  || 0).toFixed(2)),
      /* Logistics pipeline (live snapshot) — forward-moving orders + their COD. */
      in_transit_count: parseInt(ov.in_transit_count, 10) || 0,
      outstanding_cash: parseFloat(parseFloat(ov.outstanding_cash || 0).toFixed(2)),
      total_expenses:  parseFloat(parseFloat(ex.total_expenses || 0).toFixed(2)),
      meta_spend:      parseFloat(parseFloat(ex.meta_spend     || 0).toFixed(2)),
      /* TRUE-net-profit OPEX from the treasury ledger (ad spend excluded).
         Business-wide total + Path A+ split inputs: commissions are attributed
         EXACTLY per product (opex_commission_by_product); shared costs are split
         by delivered-order count on the frontend. */
      operating_expenses,
      opex_breakdown,
      opex_commissions_total,
      opex_shared_total,
      opex_commission_by_product,
    };

    /* ── Build daily chart stats ──
       Primary "orders" line = Meta-reported purchases (meta_orders) sourced from the
       expenses table.  ERP order count is kept as "erp_orders" for pixel-efficiency.
       We union all dates from both sources so days with ad spend but zero ERP orders
       (or vice-versa) still appear in the chart.                                      */

    /* TO_CHAR in the SQL guarantees stat_date is always a plain 'YYYY-MM-DD' string.
       We keep the instanceof guard as a belt-and-suspenders safety net only.       */
    const expByDate = new Map();
    for (const row of dayExpRes.rows) {
      const key = row.stat_date instanceof Date
        ? row.stat_date.toISOString().split('T')[0]   // safety fallback (should not fire)
        : String(row.stat_date);                       // always 'YYYY-MM-DD' via TO_CHAR
      expByDate.set(key, {
        ads_spend:   parseFloat(row.ads_spend)     || 0,
        meta_orders: parseInt(row.meta_orders, 10) || 0,
      });
    }

    /* Cohort series — orders, confirmed, delivered AND revenue, all keyed by the
       order's createdAt day (delivered/revenue attributed to the placement day). */
    const erpByDate = new Map();
    for (const row of dayRes.rows) {
      const key = row.stat_date instanceof Date
        ? row.stat_date.toISOString().split('T')[0]   // safety fallback
        : String(row.stat_date);                       // always 'YYYY-MM-DD' via TO_CHAR
      erpByDate.set(key, {
        erp_orders: parseInt(row.orders,    10) || 0,
        confirmed:  parseInt(row.confirmed, 10) || 0,
        delivered:  parseInt(row.delivered, 10) || 0,
        revenue:    parseFloat(row.revenue)     || 0,
      });
    }

    /* Union of all dates from Meta expenses AND ERP (createdAt) cohorts. */
    const allDates = Array.from(new Set([
      ...expByDate.keys(), ...erpByDate.keys(),
    ])).sort();
    const daily_chart_stats = allDates.map((dateKey) => {
      /* IMPORTANT: when a date exists only in ERP (no Meta expense row), the
         default object supplies meta_orders = 0, NOT erp_orders.  This is
         intentional — we never substitute ERP orders for Meta orders, so the
         "Total Orders" line on the chart stays strictly Meta-sourced.          */
      const exp = expByDate.get(dateKey) ?? { ads_spend: 0, meta_orders: 0 };
      const erp = erpByDate.get(dateKey) ?? { erp_orders: 0, confirmed: 0, delivered: 0, revenue: 0 };
      return {
        date:       dateKey,
        orders:     exp.meta_orders,    // ← strictly Meta purchases; NEVER falls back to erp_orders
        erp_orders: erp.erp_orders,     // ← ERP count kept separately for pixel-efficiency only
        confirmed:  erp.confirmed,
        delivered:  erp.delivered,      // ← cohort: delivered orders attributed to their createdAt day
        revenue:    parseFloat(erp.revenue.toFixed(2)),
        ads_spend:  parseFloat(exp.ads_spend.toFixed(2)),
      };
    });

    /* ── Build governorates stats ── */
    const governorates_stats = govRes.rows.map((row) => ({
      governorate:  row.governorate,
      total_orders: parseInt(row.total_orders, 10) || 0,
      confirmed:    parseInt(row.confirmed,    10) || 0,
      delivered:    parseInt(row.delivered,    10) || 0,
      returned:     parseInt(row.returned,     10) || 0,
      revenue:      parseFloat(row.revenue)        || 0,
    }));

    /* ── Build rejection reasons ── */
    const rejection_reasons = rejRes.rows.map((row) => ({
      reason: row.reason,
      count:  parseInt(row.count, 10) || 0,
    }));

    /* ── External Affiliate Networks (affiliate-plan exclusive) ──────────────
       Pulls Taager / Safqa revenue when the tenant has saved API keys. Mock
       service for now; resolves to zeros when no keys are configured, so this
       is always safe to include in the payload for any plan. */
    const externalStats = await getExternalAffiliateStats(req.user.business_id, {
      startDate, endDate, product: req.query.product, campaign: req.query.campaign,
      referralCodes: scopeOrders(scope), adAccountIds: expAccountIds,
    });

    /* ── Affiliate plan: the lower widgets (daily chart, governorates, rejection
       reasons) aggregate from external_affiliate_orders, since the local orders
       table is empty for affiliate tenants. Override with Safqa breakdowns,
       respecting the global date range AND the product filter. */
    let dailyOut = daily_chart_stats, govOut = governorates_stats, rejOut = rejection_reasons;
    if (req.user.plan_type === 'affiliate') {
      const bd = await aggregateSafqaBreakdowns(req.user.business_id, {
        startDate, endDate, product: req.query.product, campaign: req.query.campaign,
        referralCodes: scopeOrders(scope), adAccountIds: expAccountIds,
      });
      dailyOut = bd.daily;
      govOut   = bd.governorates;
      rejOut   = bd.rejections;
    }

    res.json({ overview, daily_chart_stats: dailyOut, governorates_stats: govOut, rejection_reasons: rejOut, externalStats });

  } catch (error) {
    /* Log the FULL error object so PostgreSQL detail / hint are visible in the terminal */
    console.error('[Dashboard API Error]:', error);
    return res.status(500).json({
      error:   'Failed to fetch dashboard data',
      details: error.message,
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/analytics/delivered-orders  — Admin + Media Buyer
   ─────────────────────────────────────────────────────────────────────────
   Detailed list of DELIVERED orders, filtered by the TRUE delivery date
   (delivered_at) + optional product, grouped by Egypt-local day (newest first).
   Each row: customer name, phone, product, delivery datetime, order value.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/delivered-orders', authenticate, async (req, res) => {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'media_buyer') {
    return res.status(403).json({ error: 'غير مصرح لك بعرض هذه البيانات' });
  }

  const { startDate, endDate } = req.query;
  const params = [req.user.business_id];
  let where = ` AND business_id = $1::integer`;
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    params.push(`${startDate}T00:00:00${getEgyptOffset(startDate)}`);
    where += ` AND delivered_at >= $${params.length}::timestamptz`;
  }
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    params.push(`${endDate}T23:59:59${getEgyptOffset(endDate)}`);
    where += ` AND delivered_at <= $${params.length}::timestamptz`;
  }

  /* Optional product filter (name → sku, ProductName fallback). */
  const productSel = typeof req.query.product === 'string' ? req.query.product.trim() : '';
  if (productSel && productSel !== 'كل المنتجات') {
    const pr = await pool.query(
      `SELECT sku FROM products WHERE UPPER(TRIM(name)) = UPPER(TRIM($1)) AND business_id = $2::integer LIMIT 1`,
      [productSel, req.user.business_id]);
    const sku = pr.rows[0]?.sku ? String(pr.rows[0].sku).toUpperCase() : '';
    params.push(sku);        const ps = params.length;
    params.push(productSel); const pn = params.length;
    where += ` AND ( ($${ps} <> '' AND UPPER(COALESCE(sku,'')) = $${ps})
                     OR (UPPER(COALESCE("ProductName",'')) = UPPER($${pn})) )`;
  }

  /* Optional campaign filter — resolve the selected Meta campaign NAME to the
     match tokens of every product it advertises (campaign_name CONTAINS sku),
     then scope orders to those products, mirroring the dashboard campaign filter
     so the delivered drill-down stays consistent with the Top Cards. */
  const campaignSel = typeof req.query.campaign === 'string' ? req.query.campaign.trim() : '';
  if (campaignSel && campaignSel !== 'كل الحملات') {
    const campTokens = await resolveCampaignTokens(req.user.business_id, campaignSel);
    if (campTokens.length === 0) {
      where += ` AND 1=0`;
    } else {
      params.push(campTokens);   const ct = params.length;
      where += ` AND ( UPPER(TRIM(COALESCE(sku,'')))           = ANY($${ct}::text[])
                    OR UPPER(TRIM(COALESCE("ProductName",'')))  = ANY($${ct}::text[]) )`;
    }
  }

  /* AGENCY scope — a media buyer's drill-down must show ONLY their own delivered
     orders (referral_code). Admin sees all (or impersonates via ?mediaBuyer). */
  const doScope = await resolveAnalyticsScope(req);
  if (!doScope.all) {
    if (doScope.referralCodes && doScope.referralCodes.length > 0) {
      params.push(doScope.referralCodes);   const rc = params.length;
      where += ` AND referral_code = ANY($${rc}::text[])`;
    } else {
      where += ` AND 1=0`;   // scoped buyer with no referral code → no rows
    }
  }

  const P = `COALESCE(NULLIF(REGEXP_REPLACE(COALESCE("ProductPrice"::text,''),'[^0-9.]','','g'),'')::numeric, 0)`;

  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        "FullName"     AS name,
        "Phone"        AS phone,
        "ProductName"  AS product,
        TO_CHAR((delivered_at + INTERVAL '3 hours')::date, 'YYYY-MM-DD')      AS day,
        TO_CHAR(delivered_at + INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI')      AS delivered_at,
        ${P}::float                                                          AS value
      FROM orders
      WHERE "Status" = 'تم التوصيل' AND delivered_at IS NOT NULL${where}
      ORDER BY delivered_at DESC
      LIMIT 2000
    `, params);

    /* Group by Egypt-local day, newest first. */
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.day)) map.set(r.day, { date: r.day, count: 0, day_revenue: 0, orders: [] });
      const g = map.get(r.day);
      const v = parseFloat(r.value) || 0;
      g.count += 1;
      g.day_revenue += v;
      g.orders.push({
        id: r.id, name: r.name || '—', phone: r.phone || '—',
        product: r.product || '—', delivered_at: r.delivered_at, value: parseFloat(v.toFixed(2)),
      });
    }
    const days = [...map.values()]
      .map((d) => ({ ...d, day_revenue: parseFloat(d.day_revenue.toFixed(2)) }))
      .sort((a, b) => b.date.localeCompare(a.date));

    res.json({ total: rows.length, days });
  } catch (err) {
    console.error('[delivered-orders] Error:', err.message, err.detail ?? '');
    res.status(500).json({ error: 'خطأ في الخادم', details: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════════
   GET /api/analytics/campaigns  — Admin + Media Buyer
   ─────────────────────────────────────────────────────────────────────
   Real Meta campaign names for the filter dropdown, PLAN-ISOLATED so the
   affiliate and e-commerce systems never share campaigns:
     • affiliate plan  → only campaigns whose name contains a known Safqa SKU
                         (external_affiliate_orders, network='safqa').
     • e-commerce plan → only campaigns whose name contains a catalogue SKU
                         (products) — i.e. the tenant's own product campaigns.
   The "contains SKU" rule is the SAME naming convention used by every other
   campaign↔data link (ADS isolation, ad-spend attribution, campaign filter), so
   the dropdown only ever offers campaigns that can actually filter something.
   Returns a plain string[] (original-case names); '[]' on any error so the UI
   degrades to just "كل الحملات".
   ════════════════════════════════════════════════════════════════════ */
router.get('/campaigns', authenticate, async (req, res) => {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'media_buyer') {
    return res.status(403).json({ error: 'غير مصرح لك بعرض الحملات' });
  }

  const businessId = req.user.business_id;
  const isAffiliate = req.user.plan_type === 'affiliate';
  /* Plan-isolated EXISTS source: Safqa orders for affiliate, catalogue for e-com. */
  const skuSource = isAffiliate
    ? `external_affiliate_orders o
        WHERE o.business_id = $1::integer AND o.network = 'safqa'
          AND COALESCE(TRIM(o.sku), '') <> ''
          AND UPPER(e.campaign_name) LIKE '%' || UPPER(TRIM(o.sku)) || '%'`
    : `products p
        WHERE p.business_id = $1::integer
          AND COALESCE(TRIM(p.sku), '') <> ''
          AND UPPER(e.campaign_name) LIKE '%' || UPPER(TRIM(p.sku)) || '%'`;

  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT e.campaign_name AS name
         FROM expenses e
        WHERE e.business_id = $1::integer
          AND e.meta_sync = TRUE
          AND COALESCE(TRIM(e.campaign_name), '') <> ''
          AND EXISTS (SELECT 1 FROM ${skuSource})
        ORDER BY name ASC`,
      [businessId]
    );
    return res.json(rows.map((r) => r.name));
  } catch (err) {
    console.error('[analytics/campaigns] failed:', err.message, err.detail ?? '');
    return res.json([]);   // degrade gracefully → dropdown shows only "all"
  }
});

/* ════════════════════════════════════════════════════════════════════
   GET /api/analytics/media-buyers  — Admin only
   ─────────────────────────────────────────────────────────────────────
   Powers the admin "filter by Media Buyer" dropdown (impersonation). Returns
   every media_buyer in the tenant with their referral_code and the ad_account_id
   list assigned to them (via meta_accounts.assigned_user_id). Media buyers must
   NOT call this (they only ever see themselves) → admin-only guard. '[]' on error.
   ════════════════════════════════════════════════════════════════════ */
router.get('/media-buyers', authenticate, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'غير مصرح لك بعرض قائمة الميديا باير' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT u.id::text                         AS id,
              COALESCE(u.name, '')               AS name,
              u.email,
              u.referral_code,
              COALESCE(
                ARRAY_AGG(m.ad_account_id) FILTER (WHERE m.ad_account_id IS NOT NULL),
                '{}'
              )                                  AS ad_account_ids
         FROM users u
         LEFT JOIN meta_accounts m
                ON m.assigned_user_id = u.id AND m.business_id = u.business_id
        WHERE u.role = 'media_buyer' AND u.business_id = $1::integer
        GROUP BY u.id, u.name, u.email, u.referral_code
        ORDER BY name ASC`,
      [req.user.business_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error('[analytics/media-buyers] failed:', err.message, err.detail ?? '');
    return res.json([]);
  }
});

module.exports = router;
