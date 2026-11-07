/* ─────────────────────────────────────────────────────────────────────────
   Backfill orders.bosta_payment_type / bosta_payment_ref (electronic payments).

   A customer who pays ELECTRONICALLY at the door (Bosta «Flash» / card) makes
   Bosta zero the cash amount (expected_cod = 0) although the order was paid in
   full. The webhook now records that from Bosta's delivery doc; this script does
   it for past DELIVERED orders whose Bosta cash is below price − deposit.

   For each candidate it fetches the delivery doc once (api_key, the same call
   the shipping-fee capture makes) and records paymentInfo when present. Orders
   without paymentInfo stay untouched — the delivered list shows them as
   «فرق تحصيل» (collected less than the price, no electronic payment on record).

   DRY-RUN by default (prints what it would write). Idempotent: only fills NULLs.

   Usage (from the backend/ directory):
       node src/scripts/backfillBostaPayments.js            # dry run
       node src/scripts/backfillBostaPayments.js --live     # write
       node src/scripts/backfillBostaPayments.js --tracking 6561671166 [--live]
   ───────────────────────────────────────────────────────────────────────── */

require('dotenv').config();
const pool = require('../config/db');
const fee  = require('../services/bostaShippingFee');

const LIVE = process.argv.includes('--live');
const tIdx = process.argv.indexOf('--tracking');
const ONLY = tIdx > -1 ? String(process.argv[tIdx + 1] || '').trim() : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const P   = `COALESCE(NULLIF(REGEXP_REPLACE(COALESCE("ProductPrice"::text,''),'[^0-9.]','','g'),'')::numeric, 0)`;
const DEP = `COALESCE(NULLIF(REGEXP_REPLACE(COALESCE("depositAmount"::text,''),'[^0-9.]','','g'),'')::numeric, 0)`;

async function main() {
  console.log(`💳 [backfillBostaPayments] ${LIVE ? 'LIVE — will write' : 'DRY RUN — nothing is written'}${ONLY ? ` · only ${ONLY}` : ''}\n`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bosta_payment_type VARCHAR(30),
                                   ADD COLUMN IF NOT EXISTS bosta_payment_ref  VARCHAR(80)`);

  const { rows } = await pool.query(
    `SELECT id, business_id, "BostaTrackingCode" AS tn, ${P}::float AS price, ${DEP}::float AS deposit,
            expected_cod::float AS cod,
            TO_CHAR(delivered_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS delivered_on
       FROM orders
      WHERE "Status" = 'تم التوصيل'
        AND COALESCE(TRIM("BostaTrackingCode"), '') <> ''
        AND bosta_payment_type IS NULL
        AND ${ONLY ? `"BostaTrackingCode" = $1` : `expected_cod IS NOT NULL AND expected_cod < ${P} - ${DEP} - 0.5`}
      ORDER BY delivered_at DESC NULLS LAST`,
    ONLY ? [ONLY] : []);
  console.log(`candidates: ${rows.length}`);

  const keys = new Map();          // business_id → api_key
  const byType = {};
  let paid = 0, notPaid = 0, failed = 0, failStreak = 0, checked = 0;
  for (const o of rows) {
    if (!keys.has(o.business_id)) keys.set(o.business_id, await fee.readApiKey(o.business_id));
    const doc = await fee.fetchDeliveryDoc(o.tn, keys.get(o.business_id));
    checked++;
    if (!doc) {
      failed++; failStreak++;
      console.log(`  #${o.id} ${o.tn}: Bosta doc unavailable`);
      /* Bosta refusing several in a row (rate limit / outage) → stop instead of
         hammering it; rerun later — the script only picks still-NULL orders. */
      if (failStreak >= 3) { console.log(`\n⛔ 3 doc fetches failed in a row — stopping after ${checked}/${rows.length}. Rerun later.`); break; }
      await sleep(300); continue;
    }
    failStreak = 0;
    const payment = fee.extractPaymentInfo(doc);
    if (payment) {
      paid++;
      byType[payment.type] = (byType[payment.type] || 0) + 1;
      if (LIVE) await fee.recordPaymentInfo(o.tn, o.business_id, payment);
      console.log(`  #${o.id} ${o.tn} delivered ${o.delivered_on}: price ${o.price} − deposit ${o.deposit}, cash ${o.cod} → ${payment.type}${LIVE ? ' ✓ recorded' : ''}`);
    } else {
      notPaid++;
      console.log(`  #${o.id} ${o.tn} delivered ${o.delivered_on}: price ${o.price} − deposit ${o.deposit}, cash ${o.cod} → no paymentInfo (stays «فرق تحصيل»)`);
    }
    await sleep(300);                // gentle on Bosta
  }
  console.log(`\npaid electronically: ${paid} ${JSON.stringify(byType)} · no paymentInfo: ${notPaid} · doc unavailable: ${failed}`);
  console.log(LIVE ? '✅ written.' : 'ℹ️  dry run — rerun with --live to record.');
}

main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
