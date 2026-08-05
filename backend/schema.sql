-- Run this file against your PostgreSQL database to initialize the schema.
-- For Supabase: paste into the SQL Editor and run.

CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  email        VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role         VARCHAR(20) DEFAULT 'agent' CHECK (role IN ('agent', 'admin', 'media_buyer', 'supervisor', 'after_sales')),
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id                SERIAL PRIMARY KEY,
  "FullName"        VARCHAR(255),
  "Phone"           VARCHAR(50),
  "DeliveryRate"    VARCHAR(100),
  "City"            VARCHAR(100),
  "Address"         TEXT,
  "Status"          VARCHAR(50) DEFAULT 'جديد',
  "Note"            TEXT,
  "createdAt"       TIMESTAMP DEFAULT NOW(),
  "ProductName"     VARCHAR(255),
  "ProductPrice"    VARCHAR(100),
  "AssignedTo"      VARCHAR(255),
  "Quantity"        INTEGER,
  "PostponedDate"   DATE,
  "BostaTrackingCode" VARCHAR(100),
  "rejectionReason" VARCHAR(255),
  "hasDeposit"      BOOLEAN      DEFAULT FALSE,
  "depositAmount"   NUMERIC(10,2) DEFAULT 0
);

-- ── Migrations (run on existing databases) ─────────────────────
-- Safe to run multiple times; IF NOT EXISTS / idempotent guards throughout.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "ProductName"      VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "ProductPrice"     VARCHAR(100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "AssignedTo"       VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "Quantity"         INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "PostponedDate"    DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "BostaTrackingCode" VARCHAR(100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "rejectionReason"  VARCHAR(255);
-- Deposit / down-payment columns (added 2026-05-23)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "hasDeposit"       BOOLEAN       DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "depositAmount"    NUMERIC(10,2) DEFAULT 0;
-- SKU Shield: stores the inventory SKU so deductions use SKU-first matching
-- instead of brittle name-string comparison.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "sku"              VARCHAR(100);
-- Dynamic COGS / WAC: locks the product's weighted-average cost at the moment
-- an order is confirmed, so historical profitability stays accurate even after
-- cost_price is updated by a new supply batch.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "unit_cost_price"  NUMERIC(10,2);

-- ── Purchase Orders (Supply Batches) ───────────────────────────
-- Records every incoming supply batch so WAC recalculation is auditable.
-- Inserting here is the ONLY way to update a product's cost_price — never
-- edit it directly — to keep the WAC formula consistent.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            SERIAL        PRIMARY KEY,
  product_id    UUID          REFERENCES products(id) ON DELETE CASCADE,
  quantity      INTEGER       NOT NULL CHECK (quantity > 0),
  unit_cost     NUMERIC(10,2) NOT NULL,
  purchase_date DATE          DEFAULT CURRENT_DATE,
  created_by    VARCHAR(255),
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);

-- ── DeliveryRate default ────────────────────────────────────────
-- 'بدون' = "not checked yet" (initial state before Bosta enrichment runs).
-- The webhook inserts 'بدون' then immediately fires a background Bosta fetch
-- that overwrites it with the real rating ('ممتاز', 'متوسط', 'ضعيف', 'جديد').
ALTER TABLE orders ALTER COLUMN "DeliveryRate" SET DEFAULT 'بدون';

-- Seed an initial admin user (password: admin123).
-- Change the password immediately after first login.
-- Run: node scripts/seed.js  to create this user instead of inserting manually.

-- ── Products (Inventory) ────────────────────────────────────────
-- UUID primary key; requires pgcrypto (enabled by default on Supabase).
CREATE TABLE IF NOT EXISTS products (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(255)  NOT NULL,
  sku            VARCHAR(100)  UNIQUE NOT NULL,
  cost_price     NUMERIC(10,2) DEFAULT 0,   -- COGS per unit — feeds Analytics gross margin
  selling_price  NUMERIC(10,2) DEFAULT 0,
  stock_quantity INTEGER       DEFAULT 0,
  image_url      TEXT,
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);

-- ── Product Returns Log ────────────────────────────────────────
-- Daily aggregate: one row per (product_name, return_date).
-- Populated exclusively by the Bosta webhook when the parcel is
-- physically received back by the merchant (status = 'returned').
-- NEVER incremented on 'returning_to_merchant' or other in-transit events.
CREATE TABLE IF NOT EXISTS product_returns (
  id            SERIAL        PRIMARY KEY,
  product_name  VARCHAR(255)  NOT NULL,
  return_date   DATE          NOT NULL DEFAULT CURRENT_DATE,
  quantity      INTEGER       NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (product_name, return_date)
);

-- ── Business Profile ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_profile (
  id            SERIAL PRIMARY KEY,
  brand_name    VARCHAR(255) NOT NULL DEFAULT 'My Brand',
  contact_email VARCHAR(255),
  phone_number  VARCHAR(50),
  industry      VARCHAR(100),
  logo_url      TEXT,
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- Insert one default row (idempotent — only runs if table is empty)
INSERT INTO business_profile (brand_name, contact_email, phone_number, industry, logo_url)
SELECT 'Product Pulse', 'admin@example.com', '', 'تجارة إلكترونية', ''
WHERE NOT EXISTS (SELECT 1 FROM business_profile LIMIT 1);
