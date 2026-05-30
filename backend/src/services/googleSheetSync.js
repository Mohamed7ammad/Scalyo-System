const cron  = require('node-cron');
const axios = require('axios');
const pool  = require('../config/db');
const { enrichDeliveryRate } = require('./bostaEnrich');

const SHEET_URL =
  'https://script.google.com/macros/s/AKfycbwUsAT0ui9ZeJVXD_96V6RZAlMpSn5dQPrMhGq16zw7ezsIFoEzEqUM4q3Oug33-phP/exec';


const startOrderSyncCron = () => {
  cron.schedule('*/5 * * * *', async () => {
    try {
      console.log('🔄 Running background sync from Google Sheets...');

      const response  = await axios.get(SHEET_URL, { timeout: 15_000 });
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

      for (const orderData of newOrders) {
        // Assign to next agent in rotation (null if no agents exist)
        const assignedTo = agents.length > 0
          ? agents[agentIndex % agents.length]
          : null;
        agentIndex++;

        // Insert as 'بدون' (not-yet-checked). enrichDeliveryRate fires immediately
        // after and overwrites it with the real Bosta rating within seconds.
        // orderData.DeliveryRate (always 'بدون' from the sheet) is intentionally ignored.
        const insertResult = await pool.query(
          `INSERT INTO orders
             ("FullName", "Phone", "DeliveryRate", "City", "Address",
              "Status", "Note", "ProductName", "ProductPrice", "AssignedTo", business_id)
           VALUES ($1, $2, 'بدون', $3, $4, 'جديد', $5, $6, $7, $8, $9)
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
            defaultBusinessId,               // $9 — ORIGINAL tenant
          ]
        );

        // Fire-and-forget — do NOT await; never block the sync loop
        enrichDeliveryRate(insertResult.rows[0].id, orderData.Phone);

        await axios.post(SHEET_URL, {
          action:   'markSynced',
          rowIndex: orderData.rowIndex,
        }, { timeout: 10_000 });

        syncedCount++;
      }

      console.log(`✅ Synced ${syncedCount} orders. Agents in rotation: ${agents.length || 'none (unassigned)'}`);
    } catch (error) {
      console.error('❌ Error syncing from sheets:', error.message);
    }
  });

  console.log('📅 Google Sheets sync cron started (every 5 minutes).');
};

module.exports = startOrderSyncCron;
