'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   Bosta per-AWB shipping-fee capture (Phase B1)
   ────────────────────────────────────────────────────────────────────────────
   Fetches the EXACT shipping cost for a delivered shipment from Bosta's
   integrations API (api.bosta.co, api_key) and stores it on the order as
   orders.actual_shipping_fee.

   We store `priceAfterVat` — the NET fee the merchant actually pays for that
   AWB (base after any bundle discount + insurance + the conditional 7 EGP
   open-package fee, all incl. VAT). This is the true marginal shipping cost and
   ties cleanly to the wallet settlement.

   Source of truth confirmed by discovery spike:
     GET /deliveries/business/{trackingNumber}
       → top-level `shipmentFees`  = net priceBeforeVat
       → log[].actionsList.pricing.{before,after} carries the full breakdown
         (shippingFee, bundleDiscount, openingPackageFee, insuranceFee, vat,
          transit.cost = governorate component, priceBeforeVat, priceAfterVat)

   No writes to treasury here — analytics consumes actual_shipping_fee directly.
   ════════════════════════════════════════════════════════════════════════════ */
const axios = require('axios');
const pool  = require('../config/db');

const INT_BASE = 'https://api.bosta.co/api/v2';

/* Pull the net priceAfterVat out of a Bosta delivery document. The clean value
   lives in the pricing event-log (newest wins); we fall back to the top-level
   shipmentFees (= priceBeforeVat) grossed up by VAT when the log is absent. */
function extractPriceAfterVat(d) {
  let priceAfterVat, priceBeforeVat, vat;
  const consider = (pr) => {
    if (!pr) return;
    if (pr.priceAfterVat  != null) priceAfterVat  = Number(pr.priceAfterVat);
    if (pr.priceBeforeVat != null) priceBeforeVat = Number(pr.priceBeforeVat);
    if (pr.vat            != null) vat            = Number(pr.vat);
  };
  consider(d && d.pricing);
  if (d && Array.isArray(d.log)) {
    for (const e of d.log) {            // chronological → last defined wins
      consider(e && e.actionsList && e.actionsList.pricing && e.actionsList.pricing.before);
      consider(e && e.actionsList && e.actionsList.pricing && e.actionsList.pricing.after);
    }
  }
  if (priceBeforeVat == null && d && d.shipmentFees != null) priceBeforeVat = Number(d.shipmentFees);
  if (priceAfterVat == null && priceBeforeVat != null) {
    priceAfterVat = +(priceBeforeVat * (1 + (vat != null ? vat : 0.14))).toFixed(2);
  }
  return (priceAfterVat != null && Number.isFinite(priceAfterVat)) ? +priceAfterVat.toFixed(2) : null;
}

/* GET the delivery doc and return its net shipping fee, or null on any failure. */
async function fetchActualShippingFee(trackingNumber, apiKey) {
  if (!trackingNumber || !apiKey) return null;
  try {
    const r = await axios.get(`${INT_BASE}/deliveries/business/${encodeURIComponent(trackingNumber)}`, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
      timeout: 20000,
    });
    return extractPriceAfterVat(r.data && (r.data.data || r.data));
  } catch (err) {
    console.warn(`[shippingFee] fetch failed for AWB ${trackingNumber}:`,
      err.response ? `HTTP ${err.response.status}` : err.message);
    return null;
  }
}

/* Read the tenant's Bosta api_key from shipping_settings (env fallback). */
async function readApiKey(businessId) {
  try {
    const { rows } = await pool.query(
      `SELECT api_key FROM shipping_settings
       WHERE provider_name = 'bosta' AND is_active = true AND business_id = $1`,
      [businessId]
    );
    return rows[0] && rows[0].api_key ? rows[0].api_key : (process.env.BOSTA_API_KEY || null);
  } catch (err) {
    console.warn('[shippingFee] could not read api_key:', err.message);
    return process.env.BOSTA_API_KEY || null;
  }
}

/* Fetch + persist actual_shipping_fee for one order (by tracking number).
   onlyIfNull (default true) makes it idempotent — never overwrites a value that
   is already set, so repeated webhook events / backfills don't churn the field.
   Returns the stored fee, or null if nothing was written. */
async function captureActualShippingFee(trackingNumber, businessId, { onlyIfNull = true } = {}) {
  const apiKey = await readApiKey(businessId);
  const fee = await fetchActualShippingFee(trackingNumber, apiKey);
  if (fee == null) return null;
  const guard = onlyIfNull ? 'AND actual_shipping_fee IS NULL' : '';
  const { rowCount } = await pool.query(
    `UPDATE orders SET actual_shipping_fee = $1
     WHERE "BostaTrackingCode" = $2 AND business_id = $3 ${guard}`,
    [fee, trackingNumber, businessId]
  );
  return rowCount > 0 ? fee : null;
}

module.exports = { extractPriceAfterVat, fetchActualShippingFee, captureActualShippingFee };
