'use strict';

/* DDL for the post-delivery return tables (P&L Phase 2, 2026-11-05).
   Pure — no DB access — so the reversible live-DB test can create TEMP twins
   without loading a module whose bootstrap would run on production.
   Applied at startup by services/orderRefunds.js and services/returnPickups.js. */

/* Finance: money paid back after delivery (services/orderRefunds.js). */
const REFUNDS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS order_refunds (
     id                     SERIAL        PRIMARY KEY,
     business_id            INTEGER       NOT NULL,
     order_id               INTEGER       NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
     refund_amount          NUMERIC(12,2) NOT NULL CHECK (refund_amount > 0),
     refunded_on            DATE          NOT NULL,
     treasury_tx_id         INTEGER       NOT NULL UNIQUE REFERENCES treasury_transactions(id) ON DELETE RESTRICT,
     converted_from_source  VARCHAR(50),
     after_sales_request_id INTEGER,
     note                   TEXT,
     created_by             TEXT,
     created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS order_refunds_order_idx    ON order_refunds (order_id)`,
  `CREATE INDEX IF NOT EXISTS order_refunds_business_idx ON order_refunds (business_id, refunded_on)`,
];

/* Physical: Bosta pickups / exchanges received back (services/returnPickups.js). */
const PICKUPS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS return_pickups (
     id                 SERIAL        PRIMARY KEY,
     business_id        INTEGER       NOT NULL,
     tracking_number    VARCHAR(40)   NOT NULL,
     kind               VARCHAR(12)   NOT NULL,              -- 'pickup' (CRP) | 'exchange'
     state_code         INTEGER,
     received_at        TIMESTAMPTZ,                          -- Bosta «Returned to business»
     details_fetched_at TIMESTAMPTZ,
     customer_phone     VARCHAR(20),                          -- last 10 digits (Bosta receiver)
     customer_name      TEXT,
     return_desc        TEXT,
     return_qty         INTEGER       NOT NULL DEFAULT 1,
     forward_desc       TEXT,                                 -- exchange: the replacement sent out
     forward_qty        INTEGER       NOT NULL DEFAULT 0,
     pickup_fee         NUMERIC(12,2),                        -- Bosta priceAfterVat of this AWB
     collected_cod      NUMERIC(12,2) NOT NULL DEFAULT 0,     -- COD Bosta collected on it
     bosta_created_at   TIMESTAMPTZ,
     order_id           INTEGER       REFERENCES orders(id) ON DELETE SET NULL,
     link_method        VARCHAR(10),                          -- 'auto' | 'manual'
     linked_by          TEXT,
     linked_at          TIMESTAMPTZ,
     return_product_id  UUID,
     forward_product_id UUID,
     unit_cost          NUMERIC(12,2),                        -- returned unit: the order's cost snapshot
     forward_unit_cost  NUMERIC(12,2),
     restocked_at       TIMESTAMPTZ,                          -- stock applied (exactly once)
     cleared_order_flag BOOLEAN       NOT NULL DEFAULT FALSE, -- we set orders.stock_deducted=false
     ignored_at         TIMESTAMPTZ,
     note               TEXT,
     last_payload       JSONB,
     created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
     updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
     UNIQUE (business_id, tracking_number)
   )`,
  `CREATE INDEX IF NOT EXISTS return_pickups_order_idx ON return_pickups (order_id) WHERE order_id IS NOT NULL`,
];

module.exports = { REFUNDS_SCHEMA, PICKUPS_SCHEMA };
