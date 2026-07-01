const cron  = require('node-cron');
const axios = require('axios');
const pool  = require('../config/db');
const { extractReferralCode } = require('../utils/referral');

const SHEET_URL =
  'https://script.google.com/macros/s/AKfycbwUsAT0ui9ZeJVXD_96V6RZAlMpSn5dQPrMhGq16zw7ezsIFoEzEqUM4q3Oug33-phP/exec';

/* Google Apps Script can be slow to spin up; 10s was too tight and timed out.
   Env-overridable, default 30s. */
const SHEET_TIMEOUT_MS = Number(process.env.SHEET_TIMEOUT_MS) || 30_000;

/* ── Idempotency migration (boot, idempotent) ────────────────────────────────
   The sheet sync used to be a blind INSERT: every row the Apps Script returned
   became a NEW order. If markSynced ever failed (timeout / local run), the next
   tick re-inserted the SAME rows as fresh 'جديد' duplicates — flooding the board
   and firing a Bosta enrichment per duplicate (429 storm). We now key each DB
   order to its source sheet row via `sheet_row_index` and INSERT ... ON CONFLICT
   DO NOTHING, so re-processing a row is a guaranteed no-op. Legacy rows keep a
   NULL sheet_row_index (NULLs are distinct in a UNIQUE index, so they never
   collide).
   NOTE: the "Phone" 50→255 widen that prevents the "value too long" abort lives
   with the other schema migrations in config/initTenancy.js. */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sheet_row_index INTEGER`)
  .then(() => pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS orders_sheet_row_uidx
       ON orders (business_id, sheet_row_index)`
  ))
  .then(() => console.log('✅  orders.sheet_row_index idempotency guard ready'))
  .catch((err) => console.warn('⚠️   sheet-sync idempotency migration skipped:', err.message));


const startOrderSyncCron = () => {
  cron.schedule('*/5 * * * *', async () => {
    try {
      console.log('🔄 Running background sync from Google Sheets...');

      const response  = await axios.get(SHEET_URL, { timeout: SHEET_TIMEOUT_MS });
      const newOrders = response.data;

      if (!Array.isArray(newOrders) || newOrders.length === 0) {
        console.log('✅ No new orders to sync.');
        return;
      }

      // ── TENANT: the public Google Sheet has no tenant context, so synced
      //    orders are claimed by the ORIGINAL tenant (lowest business_profile.id).
      //    Agents are likewise restricted to that tenant so we never assign
      //    another business's agent to these orders.                         */
      const { rows: tenantRows } = await pool.query(
        'SELECT MIN(id) AS business_id FROM business_profile'
      );
      const defaultBusinessId = tenantRows[0]?.business_id ?? null;

      // ── Fetch active agents (default tenant) for round-robin distribution ──
      const agentsResult = await pool.query(
        "SELECT email FROM users WHERE role = 'agent' AND business_id = $1 ORDER BY id ASC",
        [defaultBusinessId]
      );
      const agents = agentsResult.rows.map((r) => r.email);
      let agentIndex = 0;

      let syncedCount = 0;
      let skippedCount = 0;
      let crossChannelSkipped = 0;
      /* EasyOrder fires an order webhook (order_source='easyorder', external_order_id
         set) AND writes the same order to this sheet → it would land twice. Skip a
         sheet row when a recent WEBHOOK order with the same phone+product exists. */
      const DEDUP_HOURS = Number(process.env.SHEET_DEDUP_WINDOW_HOURS) || 24;

      for (const orderData of newOrders) {
        // Assign to next agent in rotation (null if no agents exist)
        const assignedTo = agents.length > 0
          ? agents[agentIndex % agents.length]
          : null;
        agentIndex++;

        // sheet_row_index is the IDEMPOTENCY KEY: the order's source row in the
        // sheet. ON CONFLICT DO NOTHING means re-processing a row never creates a
        // duplicate and never re-fires enrichment. (NULL rowIndex → no dedup
        // possible, falls back to plain insert; rare, the Apps Script always
        // sends rowIndex for markSynced.)
        const sheetRowIndex = Number.isInteger(orderData.rowIndex) ? orderData.rowIndex : null;
        /* Media-Buyer attribution: a referral/UTM column on the sheet row, if present
           (forward-compatible — captured automatically once the sheet adds one). */
        const referralCode = extractReferralCode(orderData);

        /* CROSS-CHANNEL DEDUP — skip if the EasyOrder webhook already created this
           order (same phone+product, recent). Manual sheet-only orders (no webhook
           twin) have no match and are inserted normally. */
        let crossChannelDup = false;
        if (orderData.Phone) {
          const dup = await pool.query(
            `SELECT 1 FROM orders
              WHERE business_id = $1
                AND external_order_id IS NOT NULL
                AND "Phone" = $2
                AND UPPER(TRIM(COALESCE("ProductName",''))) = UPPER(TRIM($3))
                AND "createdAt" > NOW() - make_interval(hours => $4)
              LIMIT 1`,
            [defaultBusinessId, orderData.Phone, orderData.ProductName || '', DEDUP_HOURS]
          );
          crossChannelDup = dup.rows.length > 0;
        }

        let insertedId = null;
        if (crossChannelDup) {
          // The webhook already ingested this order → don't duplicate it from the sheet.
          crossChannelSkipped++;
        } else {
          // Insert as 'بدون' (not-yet-checked). The polite enrichment cron
          // (cron/deliveryRateBackfill.js) fills the real Bosta rating later in a
          // rate-limit-safe way — no on-demand fetch here.
          // orderData.DeliveryRate (always 'بدون' from the sheet) is intentionally ignored.
          const insertResult = await pool.query(
            `INSERT INTO orders
               ("FullName", "Phone", "DeliveryRate", "City", "Address",
                "Status", "Note", "ProductName", "ProductPrice", "AssignedTo",
                referral_code, sheet_row_index, business_id)
             VALUES ($1, $2, 'بدون', $3, $4, 'جديد', $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (business_id, sheet_row_index) DO NOTHING
             RETURNING id`,
            [
              orderData.FullName     || null,  // $1
              orderData.Phone        || null,  // $2
              orderData.City         || null,  // $3
              orderData.Address      || null,  // $4
              orderData.Note         || null,  // $5
              orderData.ProductName  || null,  // $6
              orderData.ProductPrice || null,  // $7
              assignedTo,                      // $8
              referralCode,                    // $9 — Media-Buyer attribution (nullable)
              sheetRowIndex,                   // $10 — idempotency key
              defaultBusinessId,               // $11 — ORIGINAL tenant
            ]
          );
          insertedId = insertResult.rows[0]?.id;
          if (insertedId) {
            // NEW row — DeliveryRate stays 'بدون' until the enrichment cron fills it.
            syncedCount++;
          } else {
            // Already imported by sheet_row_index conflict — mark synced.
            skippedCount++;
          }
        }

        // Mark the source row synced regardless, so the sheet stops re-sending it.
        await axios.post(SHEET_URL, {
          action:   'markSynced',
          rowIndex: orderData.rowIndex,
        }, { timeout: SHEET_TIMEOUT_MS });
      }

      console.log(`✅ Synced ${syncedCount} new order(s), skipped ${skippedCount} already-imported, ${crossChannelSkipped} webhook-duplicate(s). Agents in rotation: ${agents.length || 'none (unassigned)'}`);
    } catch (error) {
      console.error('❌ Error syncing from sheets:', error.message);
    }
  });

  console.log('📅 Google Sheets sync cron started (every 5 minutes).');
};

module.exports = startOrderSyncCron;
