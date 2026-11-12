'use strict';
/* Pure DDL for closed orders / stopped products (no DB requires — a test
   harness can create everything on TEMP copies before anything else loads).

   A product is stopped in one of two ways:
     • an INVENTORY product → products.stopped_at;
     • a product that is NOT in inventory (a test product nobody stocked) →
       a stopped_products row whose `keys` are its lower-cased name / sku(s).

   ORDER MATTERS: tables and columns first, the trigger LAST — it reads both
   and writes orders.closed_*, so it must never exist without them. Its body
   swallows ANY error: an incoming order is never lost because of it. */

const { CLOSED_PRODUCT } = require('./closedStatuses');

const COLUMNS = [
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ,
                        ADD COLUMN IF NOT EXISTS stopped_by TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS closed_from_status VARCHAR(50),
                      ADD COLUMN IF NOT EXISTS closed_at          TIMESTAMPTZ,
                      ADD COLUMN IF NOT EXISTS closed_by          TEXT,
                      ADD COLUMN IF NOT EXISTS closed_reason      VARCHAR(20)`,
  `CREATE TABLE IF NOT EXISTS stopped_products (
     id          SERIAL      PRIMARY KEY,
     business_id INTEGER     NOT NULL,
     name        TEXT        NOT NULL,
     keys        TEXT[]      NOT NULL DEFAULT '{}',
     stopped_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     stopped_by  TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS stopped_products_biz_name
     ON stopped_products (business_id, (LOWER(TRIM(name))))`,
];

/* A NEW order (status جديد / empty, live queue) of a stopped product is born
   «مغلق - منتج متوقف» — every entry path (EasyOrder, manual, CSV, sync) at
   once, before anyone calls. Inventory first: the product resolveProductForOrder
   would pick (sku > name > alias) decides; only an order that matches NO
   inventory product is checked against stopped_products. */
const TRIGGER_FN = `
CREATE OR REPLACE FUNCTION scalyo_close_order_of_stopped_product() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  k_sku     TEXT;
  k_name    TEXT;
  inv_found BOOLEAN;
  stopped   BOOLEAN;
BEGIN
  BEGIN
    IF COALESCE(NEW.is_lost_order, FALSE) THEN RETURN NEW; END IF;
    IF btrim(COALESCE(NEW."Status", '')) NOT IN ('', 'جديد') THEN RETURN NEW; END IF;
    k_sku  := LOWER(NULLIF(btrim(COALESCE(NEW.sku, '')), ''));
    k_name := LOWER(NULLIF(btrim(COALESCE(NEW."ProductName", '')), ''));
    IF k_sku IS NULL AND k_name IS NULL THEN RETURN NEW; END IF;

    SELECT TRUE, p.stopped_at IS NOT NULL INTO inv_found, stopped
      FROM products p
     WHERE p.business_id = NEW.business_id
       AND ( LOWER(TRIM(p.sku)) = k_sku
          OR LOWER(TRIM(p.name)) = k_name
          OR EXISTS (SELECT 1 FROM unnest(COALESCE(p.aliases, '{}'::text[])) a
                      WHERE LOWER(TRIM(a)) = k_sku OR LOWER(TRIM(a)) = k_name) )
     ORDER BY CASE WHEN LOWER(TRIM(p.sku)) = k_sku  THEN 1
                   WHEN LOWER(TRIM(p.name)) = k_name THEN 2
                   ELSE 3 END
     LIMIT 1;

    IF inv_found IS NOT TRUE THEN
      SELECT EXISTS (SELECT 1 FROM stopped_products s
                      WHERE s.business_id = NEW.business_id
                        AND (k_name = ANY(s.keys) OR k_sku = ANY(s.keys)))
        INTO stopped;
    END IF;

    IF stopped IS TRUE THEN
      NEW.closed_from_status := COALESCE(NULLIF(btrim(NEW."Status"), ''), 'جديد');
      NEW.closed_at          := NOW();
      NEW.closed_reason      := 'product';
      NEW."Status"           := '${CLOSED_PRODUCT}';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'scalyo_close_order_of_stopped_product skipped: %', SQLERRM;
  END;
  RETURN NEW;
END
$fn$`;

/* CREATE OR REPLACE (PG 14+, like trg_orders_no_answer_cycle) — no DROP, so a
   restart never takes an exclusive lock on orders. */
const TRIGGER = [
  `CREATE OR REPLACE TRIGGER trg_orders_close_if_product_stopped BEFORE INSERT ON orders
     FOR EACH ROW EXECUTE FUNCTION scalyo_close_order_of_stopped_product()`,
];

/* Statements in the order they must run. */
const STATEMENTS = [...COLUMNS, TRIGGER_FN, ...TRIGGER];

module.exports = { COLUMNS, TRIGGER_FN, TRIGGER, STATEMENTS };
