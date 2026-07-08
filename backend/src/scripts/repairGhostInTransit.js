/* ─────────────────────────────────────────────────────────────────────────
   Ghost in-transit repair — resolve stale 'تم الشحن' / 'تم التأكيد' orders
   against Bosta's authoritative per-parcel state.

   WHY: the delivered transition only ever arrives via webhook. A missed
   webhook leaves the order frozen in the forward pipeline forever — it keeps
   counting as "قيد التوصيل", deflates the agent's Delivery Rate, and withholds
   the delivered commission. (The hourly reconcile only heals the RETURN side;
   see reconcileInTransitOrders.)

   HOW: for every order with a tracking code stuck in a forward status for
   more than --min-age-days, fetch that ONE parcel's live document from
   Bosta's integrations API (GET /deliveries/business/{trackingNumber} — the
   same endpoint the shipping-fee capture already uses) and classify it with
   the EXACT same canonical-status rules as the live webhook:

     state 45 / 'delivered'            → 'تم التوصيل'  (+ expected_cod, delivered_at,
                                          actual_shipping_fee backfill — no stock change)
     state 46 / FINAL return canonical → 'تم الإرجاع'  via applyPhysicalReturn()
                                          (same path as the webhook: restock + log, idempotent)
     returning/cancelled canonical     → 'جاري الإعادة' (+ expected_cod = 0 — no stock change)
     anything else                     → reported as UNRESOLVED, row untouched

   RATE-LIMIT SAFETY (this endpoint is NOT the consignee-ranking one that
   caused the bans, but we stay polite anyway):
     • hard sleep floor ≥4s between EVERY Bosta call
     • --max-lookups cap per run (default 200) — re-run to continue
     • circuit breaker: first 429/401/403 halts the tenant immediately

   DRY-RUN by default — prints the full proposed report, writes NOTHING.
   Add --live to apply.

   Usage (from the backend/ directory):
     node src/scripts/repairGhostInTransit.js                     # dry-run, all tenants
     node src/scripts/repairGhostInTransit.js --business 7        # dry-run, one tenant
     node src/scripts/repairGhostInTransit.js --live              # APPLY, all tenants
     node src/scripts/repairGhostInTransit.js --live --business 7
     node src/scripts/repairGhostInTransit.js --min-age-days 10 --max-lookups 200 --sleep-ms 4500
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const axios = require('axios');
const pool  = require('../config/db');
const { applyPhysicalReturn, canonicalizeStatus, FINAL_RETURN_STATUSES } = require('../routes/shippingWebhook');
const { extractPriceAfterVat } = require('../services/bostaShippingFee');

const INT_BASE = 'https://api.bosta.co/api/v2';

/* ── CLI args ──────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt  = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

const LIVE         = flag('live');
const ONLY_BIZ     = opt('business', null) ? Number(opt('business')) : null;
const MIN_AGE_DAYS = Math.max(1, Number(opt('min-age-days', 10)) || 10);
const MAX_LOOKUPS  = Math.max(1, Number(opt('max-lookups', 200)) || 200);
/* Hard floor: never closer than 4s between Bosta calls, even via CLI. */
const SLEEP_MS     = Math.max(4000, Number(opt('sleep-ms', 4500)) || 4500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Bosta doc parsing (mirrors parseBostaPayload in the webhook) ─────────── */
const pickStr = (...vals) => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
};

function classifyDoc(doc) {
  const stateCode = Number(doc?.state?.code ?? doc?.state?.stateCode ?? NaN);
  const stateStr  = pickStr(
    doc?.state?.value, doc?.state?.nameAr,
    doc?.masterStatus?.value, doc?.masterStatus?.nameAr,
    typeof doc?.masterStatus === 'string' ? doc.masterStatus : null,
    typeof doc?.status === 'string' ? doc.status : null
  );
  let canonical = canonicalizeStatus(stateStr);

  /* Numeric codes win over localised strings — same precedence as the webhook. */
  if (stateCode === 46) canonical = 'returned';
  else if (
    stateCode === 45 &&
    canonical !== 'returned' &&
    canonical !== 'returning_to_merchant' &&
    canonical !== 'delivered_to_merchant'
  ) canonical = 'delivered';

  /* A return-type parcel reporting "delivered" was delivered BACK to us. */
  const isReturn = doc?.isReturn === true || doc?.type === 30 || doc?.type?.code === 30;
  if (isReturn && (canonical === 'delivered' || canonical === 'delivered_to_merchant')) {
    canonical = 'returned';
  }

  let action = null; // 'delivered' | 'returned' | 'returning' | null (unresolved)
  if (canonical === 'delivered') action = 'delivered';
  else if (FINAL_RETURN_STATUSES.has(canonical)) action = 'returned';
  else if (canonical === 'returning_to_merchant' || canonical === 'cancelled') action = 'returning';

  const rawCod = doc?.specs?.cod ?? doc?.cod ?? doc?.deliverySpecs?.cod ?? null;
  const cod = rawCod !== null && rawCod !== undefined && !isNaN(Number(rawCod))
    ? Math.max(0, parseFloat(rawCod)) : null;

  const rawDeliveryTime = doc?.state?.deliveryTime ?? doc?.deliveryTime ?? doc?.deliveredAt ?? null;
  const deliveredAt = rawDeliveryTime && !isNaN(new Date(rawDeliveryTime).getTime())
    ? new Date(rawDeliveryTime).toISOString() : null;

  return { action, canonical, stateCode: Number.isFinite(stateCode) ? stateCode : null, stateStr, cod, deliveredAt };
}

/* Tenant api_key (integrations API auth — NOT the app bearer token). */
async function readApiKey(businessId) {
  try {
    const { rows } = await pool.query(
      `SELECT api_key FROM shipping_settings
        WHERE provider_name = 'bosta' AND is_active = true AND business_id = $1`,
      [businessId]
    );
    return rows[0]?.api_key || process.env.BOSTA_API_KEY || null;
  } catch {
    return process.env.BOSTA_API_KEY || null;
  }
}

async function fetchDeliveryDoc(trackingNumber, apiKey) {
  const r = await axios.get(
    `${INT_BASE}/deliveries/business/${encodeURIComponent(trackingNumber)}`,
    { headers: { Authorization: apiKey, Accept: 'application/json' }, timeout: 20_000 }
  );
  return r.data?.data ?? r.data ?? null;
}

/* ── Live-mode appliers (webhook-equivalent side effects) ─────────────────── */
async function applyDelivered(order, info) {
  await pool.query(
    `UPDATE orders
        SET "Status" = 'تم التوصيل',
            expected_cod = COALESCE($1::numeric, expected_cod),
            bosta_action_required = FALSE,
            delivered_at = COALESCE(delivered_at, $2::timestamptz, NOW()),
            "updatedAt" = NOW()
      WHERE id = $3 AND business_id = $4`,
    [info.cod, info.deliveredAt, order.id, order.business_id]
  );
}

async function applyReturning(order) {
  await pool.query(
    `UPDATE orders
        SET "Status" = 'جاري الإعادة', expected_cod = 0,
            bosta_action_required = FALSE, "updatedAt" = NOW()
      WHERE id = $1 AND business_id = $2`,
    [order.id, order.business_id]
  );
}

/* Free backfill: we already hold the parcel doc, so persist the exact AWB fee
   if it was never captured (idempotent — only fills NULL). */
async function backfillShippingFee(order, doc) {
  const fee = extractPriceAfterVat(doc);
  if (fee == null) return;
  await pool.query(
    `UPDATE orders SET actual_shipping_fee = $1
      WHERE id = $2 AND business_id = $3 AND actual_shipping_fee IS NULL`,
    [fee, order.id, order.business_id]
  );
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main() {
  console.log(
    `\n👻 [repairGhostInTransit] mode=${LIVE ? '🔴 LIVE (writes enabled)' : '🟢 DRY-RUN (no writes)'} ` +
    `| min-age=${MIN_AGE_DAYS}d | max-lookups=${MAX_LOOKUPS} | sleep=${SLEEP_MS}ms\n`
  );

  let businesses;
  if (ONLY_BIZ) {
    businesses = [ONLY_BIZ];
  } else {
    const b = await pool.query(
      `SELECT DISTINCT business_id FROM orders WHERE business_id IS NOT NULL ORDER BY business_id`
    );
    businesses = b.rows.map((r) => r.business_id);
  }

  let lookupsUsed = 0;
  const totals = { delivered: 0, returned: 0, restocked: 0, returning: 0, unresolved: 0, notFound: 0, errors: 0 };

  for (const biz of businesses) {
    const { rows: ghosts } = await pool.query(
      `SELECT id, "BostaTrackingCode" AS tn, "Status", "AssignedTo", "ProductName",
              "sku", COALESCE("quantity", 1) AS quantity, "createdAt", business_id
         FROM orders
        WHERE business_id = $1
          AND "Status" IN ('تم الشحن', 'تم التأكيد')
          AND "BostaTrackingCode" IS NOT NULL AND TRIM("BostaTrackingCode") <> ''
          AND "createdAt" < NOW() - ($2 || ' days')::interval
        ORDER BY "createdAt" ASC`,
      [biz, String(MIN_AGE_DAYS)]
    );

    if (!ghosts.length) { console.log(`— tenant ${biz}: no ghost in-transit orders ✓`); continue; }

    const apiKey = await readApiKey(biz);
    if (!apiKey) {
      console.warn(`— tenant ${biz}: ${ghosts.length} ghost(s) but NO Bosta api_key in shipping_settings — skipped. ` +
        `Add the api_key (integrations API) and re-run.`);
      continue;
    }

    console.log(`\n═══ tenant ${biz}: ${ghosts.length} ghost order(s) older than ${MIN_AGE_DAYS} days ═══`);
    const perAgent = new Map();   // agent → report lines, for the audit-friendly summary
    const note = (agent, line) => {
      const key = agent || '(غير مسند)';
      if (!perAgent.has(key)) perAgent.set(key, []);
      perAgent.get(key).push(line);
    };

    let halted = false;
    for (const g of ghosts) {
      if (halted) break;
      if (lookupsUsed >= MAX_LOOKUPS) {
        console.warn(`\n⏸  lookup cap (${MAX_LOOKUPS}) reached — remaining ghosts untouched. Re-run to continue.`);
        break;
      }

      let doc = null;
      try {
        lookupsUsed++;
        doc = await fetchDeliveryDoc(g.tn, apiKey);
      } catch (err) {
        const st = err.response?.status;
        if (st === 429 || st === 401 || st === 403) {
          console.warn(`🛑 circuit breaker: Bosta HTTP ${st} on ${g.tn} — halting tenant ${biz}. Re-run later.`);
          halted = true;
          break;
        }
        if (st === 404) {
          totals.notFound++;
          note(g.AssignedTo, `❓ #${g.id} ${g.tn} — Bosta لا يعرف هذا الرقم (404). راجعه يدوياً.`);
        } else {
          totals.errors++;
          note(g.AssignedTo, `⚠️ #${g.id} ${g.tn} — فشل الاستعلام (HTTP ${st ?? 'ERR'}): ${err.message}`);
        }
        await sleep(SLEEP_MS);
        continue;
      }

      const info = classifyDoc(doc || {});
      const created = new Date(g.createdAt).toISOString().slice(0, 10);
      const label = `#${g.id} ${g.tn} (${created}, ${g.Status})`;

      if (info.action === 'delivered') {
        totals.delivered++;
        note(g.AssignedTo, `✅ ${label} → 'تم التوصيل' [Bosta: ${info.stateStr ?? info.canonical} / code ${info.stateCode ?? '?'}]` +
          (info.cod !== null ? ` COD=${info.cod}` : ''));
        if (LIVE) { await applyDelivered(g, info); await backfillShippingFee(g, doc); }
      } else if (info.action === 'returned') {
        const r = LIVE ? await applyPhysicalReturn(g) : null;
        if (LIVE) {
          await pool.query(`UPDATE orders SET expected_cod = 0 WHERE id = $1 AND business_id = $2`, [g.id, g.business_id]);
          await backfillShippingFee(g, doc);
          if (r?.restocked) totals.restocked++;
        }
        totals.returned++;
        note(g.AssignedTo, `📦 ${label} → 'تم الإرجاع' (مرتجع فعلياً${LIVE && r?.restocked ? `، أُعيد ${r.qty} للمخزون` : ''}) ` +
          `[Bosta: ${info.stateStr ?? info.canonical} / code ${info.stateCode ?? '?'}]`);
      } else if (info.action === 'returning') {
        totals.returning++;
        note(g.AssignedTo, `↩️ ${label} → 'جاري الإعادة' [Bosta: ${info.stateStr ?? info.canonical} / code ${info.stateCode ?? '?'}]`);
        if (LIVE) { await applyReturning(g); await backfillShippingFee(g, doc); }
      } else {
        totals.unresolved++;
        note(g.AssignedTo, `❔ ${label} — حالة غير محسومة عند Bosta: "${info.stateStr ?? '?'}" (code ${info.stateCode ?? '?'}) — لم يُلمس.`);
      }

      await sleep(SLEEP_MS);   // polite gap between EVERY Bosta call
    }

    /* Per-agent report — matches the audit workflow (who caused what). */
    for (const [agent, lines] of perAgent.entries()) {
      console.log(`\n  ${agent} — ${lines.length} order(s):`);
      for (const l of lines) console.log(`    ${l}`);
    }
  }

  console.log(
    `\n${LIVE ? '✅ APPLIED' : '🟢 DRY-RUN REPORT (nothing written)'} — ` +
    `delivered→تم التوصيل: ${totals.delivered} | physically returned→تم الإرجاع: ${totals.returned}` +
    (LIVE ? ` (restocked ${totals.restocked})` : '') +
    ` | return leg→جاري الإعادة: ${totals.returning} | unresolved: ${totals.unresolved} | ` +
    `404: ${totals.notFound} | errors: ${totals.errors} | Bosta lookups used: ${lookupsUsed}/${MAX_LOOKUPS}`
  );
  if (!LIVE) console.log(`\nRe-run with --live to apply exactly the transitions listed above.\n`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [repairGhostInTransit] Failed:', err.message);
  process.exit(1);
});
