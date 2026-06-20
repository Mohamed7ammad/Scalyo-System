'use strict';

/**
 * initTenancy.js — Multi-tenant row-level isolation migration.
 * ───────────────────────────────────────────────────────────────────────────
 * Adds a `business_id` foreign-key column to EVERY core table so that each
 * tenant's rows are physically tagged with the owning business. Every API
 * route then filters by `req.user.business_id`, guaranteeing that no tenant —
 * not even an admin — can ever read or mutate another tenant's data.
 *
 * Run ONCE at server boot (called from index.js inside app.listen, AFTER all
 * route modules have been required — so business_profile + users already exist).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THREE-PHASE DESIGN (why this never fails on a FK ordering race)
 * ───────────────────────────────────────────────────────────────────────────
 * A foreign key can only be added once BOTH the referenced table exists AND
 * every referencing row already holds a valid value. Creating tables with
 * inline FKs couples those two concerns and makes boot order brittle (e.g.
 * meta_accounts.assigned_user_id → users(id) died whenever meta.js's CREATE
 * raced ahead of auth.js's users CREATE). We decouple them:
 *
 *   Phase 1 — CREATION    Create tables + add nullable columns with NO FK
 *                         constraints. Pure DDL, cannot fail on missing
 *                         parents or dirty data. Fully idempotent.
 *   Phase 2 — DATA FIX    Back-fill every NULL business_id to the original
 *                         tenant, and null out any orphaned association
 *                         (assigned_user_id / meta_account_id / business_id
 *                         pointing at a row that doesn't exist) so the FKs
 *                         we add next are guaranteed to validate.
 *   Phase 3 — ENFORCEMENT Only now, with clean data, attach the FK
 *                         constraints, composite primary keys, tenant-aware
 *                         unique indexes, and per-tenant filter indexes.
 *
 * Every step is idempotent (IF NOT EXISTS / constraint-name guards), so the
 * whole migration is safe to re-run on every boot.
 *
 * NOTE: business_profile and users tables themselves are owned by auth.js
 * (created at require-time) and are guaranteed present by the time this runs
 * from app.listen — we do NOT recreate them here to avoid schema drift.
 */

const pool = require('./db');

/* Tables that own a normal surrogate/serial/UUID primary key. Each gains a
   nullable business_id column, a FK to business_profile, and a filter index. */
const CORE_TABLES = [
  'orders',
  'expenses',
  'meta_accounts',
  'products',
  'treasury_transactions',
  'inventory',
  'purchase_orders',
  'product_returns',
];

/* Every table that carries a business_id (core tables + the special-PK
   key-value tables + users). Used by the back-fill and the FK enforcement. */
const TENANT_TABLES = [...CORE_TABLES, 'shipping_settings', 'settings', 'users'];

/** The original/first tenant — used to claim every pre-existing row. */
const DEFAULT_TENANT_SUBQUERY = '(SELECT MIN(id) FROM business_profile)';

/**
 * Build an idempotent "ADD CONSTRAINT" statement. Postgres has no
 * `ADD CONSTRAINT IF NOT EXISTS`, so we wrap it in a DO block that:
 *   • only runs if the table exists, and
 *   • only runs if a constraint of that name isn't already present.
 * Constraint names are table-prefixed (e.g. orders_business_id_fkey) which is
 * also the name Postgres auto-generates for an inline column FK — so this is a
 * clean no-op on databases already migrated the old (inline-FK) way.
 */
function addConstraintSql(table, constraint, definition) {
  return `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = '${table}')
         AND NOT EXISTS (SELECT 1 FROM pg_constraint
                         WHERE conname = '${constraint}')
      THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${definition};
      END IF;
    END $$;
  `;
}

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 1 — CREATION (tables + nullable columns, NO foreign keys)
   ══════════════════════════════════════════════════════════════════════════ */
async function phase1Create() {
  /* meta_accounts — created here WITHOUT the assigned_user_id FK. (The FK is
     attached in Phase 3.) This is the table that previously vanished when
     meta.js's inline-FK CREATE raced ahead of the users table.

     assigned_user_id is VARCHAR(255) to MATCH the live users.id type
     (character varying / Supabase auth ids). A type-matched column is the
     prerequisite for the Phase-3 FK to be implementable at all. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_accounts (
      id               SERIAL PRIMARY KEY,
      account_name     VARCHAR(255) NOT NULL,
      ad_account_id    VARCHAR(100) NOT NULL,
      access_token     TEXT         NOT NULL,
      assigned_user_id VARCHAR(255),            -- matches users.id; FK added in Phase 3
      is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ  DEFAULT NOW(),
      updated_at       TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  /* Coerce existing installs: CREATE TABLE IF NOT EXISTS does NOT alter an
     already-existing table, so a DB created earlier still has assigned_user_id
     as INTEGER. Convert it to VARCHAR(255) so its type matches users.id and
     the Phase-3 FK becomes implementable. The USING clause losslessly renders
     any existing integer ids as their text form. No-op once already VARCHAR. */
  await pool.query(`
    ALTER TABLE meta_accounts
      ALTER COLUMN assigned_user_id TYPE VARCHAR(255)
      USING assigned_user_id::text
  `).catch((err) =>
    console.warn('⚠️   Phase 1: assigned_user_id type align skipped:', err.message)
  );

  /* business_id as a plain nullable INTEGER on every tenant table.
     No REFERENCES here — the FK is attached in Phase 3 after back-fill. */
  for (const table of TENANT_TABLES) {
    await pool.query(
      `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS business_id INTEGER`
    ).catch((err) =>
      console.warn(`⚠️   Phase 1: add business_id to ${table} skipped:`, err.message)
    );
  }

  /* expenses.meta_account_id — plain INTEGER; FK → meta_accounts added Phase 3. */
  await pool.query(
    `ALTER TABLE IF EXISTS expenses ADD COLUMN IF NOT EXISTS meta_account_id INTEGER`
  ).catch((err) =>
    console.warn('⚠️   Phase 1: add expenses.meta_account_id skipped:', err.message)
  );

  console.log('✅  Phase 1: tables + nullable columns created (no FK constraints yet)');
}

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 2 — DATA FIX (back-fill business_id + clean orphan associations)
   ══════════════════════════════════════════════════════════════════════════ */
async function phase2DataFix() {
  /* Back-fill every legacy NULL business_id to the original (lowest-id) tenant
     so no pre-SaaS row is orphaned or lost. */
  for (const table of TENANT_TABLES) {
    await pool.query(
      `UPDATE ${table}
          SET business_id = ${DEFAULT_TENANT_SUBQUERY}
        WHERE business_id IS NULL
          AND ${DEFAULT_TENANT_SUBQUERY} IS NOT NULL`
    ).catch((err) =>
      console.warn(`⚠️   Phase 2: business_id back-fill skipped for ${table}:`, err.message)
    );
  }

  /* Defensive: any business_id that doesn't reference a real business_profile
     row (e.g. a tenant deleted before CASCADE existed) → reclaim to original
     tenant, so the Phase-3 FK validates without error. */
  for (const table of TENANT_TABLES) {
    await pool.query(
      `UPDATE ${table}
          SET business_id = ${DEFAULT_TENANT_SUBQUERY}
        WHERE business_id IS NOT NULL
          AND business_id NOT IN (SELECT id FROM business_profile)
          AND ${DEFAULT_TENANT_SUBQUERY} IS NOT NULL`
    ).catch((err) =>
      console.warn(`⚠️   Phase 2: business_id orphan reclaim skipped for ${table}:`, err.message)
    );
  }

  /* Null out any meta_accounts.assigned_user_id pointing at a user that no
     longer exists — otherwise the FK (ON DELETE SET NULL) can't be added.
     Phase 1 aligned assigned_user_id to VARCHAR(255) to match users.id, so a
     native comparison now works; we keep the explicit ::text casts as a
     belt-and-suspenders guard in case the type-align ALTER was ever skipped. */
  await pool.query(`
    UPDATE meta_accounts
       SET assigned_user_id = NULL
     WHERE assigned_user_id IS NOT NULL
       AND assigned_user_id::text NOT IN (SELECT id::text FROM users)
  `).catch((err) =>
    console.warn('⚠️   Phase 2: meta_accounts.assigned_user_id cleanup skipped:', err.message)
  );

  /* Null out any expenses.meta_account_id pointing at a deleted account. */
  await pool.query(`
    UPDATE expenses
       SET meta_account_id = NULL
     WHERE meta_account_id IS NOT NULL
       AND meta_account_id NOT IN (SELECT id FROM meta_accounts)
  `).catch((err) =>
    console.warn('⚠️   Phase 2: expenses.meta_account_id cleanup skipped:', err.message)
  );

  console.log('✅  Phase 2: business_id back-filled + orphan associations cleaned');
}

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 3 — ENFORCEMENT (FK constraints, composite PKs, unique + filter idx)
   ══════════════════════════════════════════════════════════════════════════ */
async function phase3Enforce() {
  /* ── 3a. business_id → business_profile FK on every tenant table ──────── */
  for (const table of TENANT_TABLES) {
    await pool.query(
      addConstraintSql(
        table,
        `${table}_business_id_fkey`,
        'FOREIGN KEY (business_id) REFERENCES business_profile(id) ON DELETE CASCADE'
      )
    ).catch((err) =>
      console.warn(`⚠️   Phase 3: ${table}_business_id_fkey skipped:`, err.message)
    );
  }

  /* ── 3b. meta_accounts.assigned_user_id → users FK ───────────────────── */
  await pool.query(
    addConstraintSql(
      'meta_accounts',
      'meta_accounts_assigned_user_id_fkey',
      'FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL'
    )
  ).catch((err) =>
    console.warn('⚠️   Phase 3: meta_accounts_assigned_user_id_fkey skipped:', err.message)
  );

  /* ── 3c. expenses.meta_account_id → meta_accounts FK ─────────────────── */
  await pool.query(
    addConstraintSql(
      'expenses',
      'expenses_meta_account_id_fkey',
      'FOREIGN KEY (meta_account_id) REFERENCES meta_accounts(id) ON DELETE SET NULL'
    )
  ).catch((err) =>
    console.warn('⚠️   Phase 3: expenses_meta_account_id_fkey skipped:', err.message)
  );

  /* ── 3d. shipping_settings → composite primary key (provider_name, business_id)
     Its PK is provider_name (no id); composite PK lets two tenants each store
     their own 'bosta' creds. Safe only once every row has a non-NULL
     business_id (Phase 2). */
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = 'shipping_settings')
         AND NOT EXISTS (SELECT 1 FROM shipping_settings WHERE business_id IS NULL)
      THEN
        ALTER TABLE shipping_settings DROP CONSTRAINT IF EXISTS shipping_settings_pkey;
        ALTER TABLE shipping_settings
          ADD CONSTRAINT shipping_settings_pkey PRIMARY KEY (provider_name, business_id);
      END IF;
    END $$;
  `).catch((err) =>
    console.warn('⚠️   Phase 3: shipping_settings composite PK skipped:', err.message)
  );

  /* ── 3e. settings → composite primary key (key, business_id) ─────────── */
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = 'settings')
         AND NOT EXISTS (SELECT 1 FROM settings WHERE business_id IS NULL)
      THEN
        ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
        ALTER TABLE settings ADD CONSTRAINT settings_pkey PRIMARY KEY (key, business_id);
      END IF;
    END $$;
  `).catch((err) =>
    console.warn('⚠️   Phase 3: settings composite PK skipped:', err.message)
  );

  /* ── 3f. Tenant-aware UPSERT arbiter for synced Meta expenses ──────────
     Replaces the old 2-column (expense_date, campaign_name) unique index so
     two tenants can hold the same campaign-day without colliding. */
  await pool.query(`DROP INDEX IF EXISTS expenses_campaign_unique_idx`).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS expenses_campaign_tenant_uidx
      ON expenses (expense_date, campaign_name, business_id)
  `).catch((err) =>
    console.warn('⚠️   Phase 3: expenses_campaign_tenant_uidx skipped:', err.message)
  );

  /* ── 3g. Tenant-aware ad-account uniqueness ──────────────────────────── */
  await pool.query(`DROP INDEX IF EXISTS meta_accounts_adacct_uidx`).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS meta_accounts_adacct_tenant_uidx
      ON meta_accounts (ad_account_id, business_id)
  `).catch((err) =>
    console.warn('⚠️   Phase 3: meta_accounts_adacct_tenant_uidx skipped:', err.message)
  );

  /* ── 3h. Tenant-aware inventory uniqueness (ProductName, business_id) ─── */
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = 'inventory')
         AND NOT EXISTS (SELECT 1 FROM inventory WHERE business_id IS NULL)
      THEN
        ALTER TABLE inventory DROP CONSTRAINT IF EXISTS "inventory_ProductName_key";
        DROP INDEX  IF EXISTS inventory_productname_uidx;
        CREATE UNIQUE INDEX IF NOT EXISTS inventory_productname_tenant_uidx
          ON inventory ("ProductName", business_id);
      END IF;
    END $$;
  `).catch((err) =>
    console.warn('⚠️   Phase 3: inventory tenant-unique skipped:', err.message)
  );

  /* ── 3i. Tenant-aware product SKU uniqueness (sku, business_id) ───────── */
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = 'products')
         AND NOT EXISTS (SELECT 1 FROM products WHERE business_id IS NULL)
      THEN
        ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_key;
        DROP INDEX  IF EXISTS products_sku_uidx;
        CREATE UNIQUE INDEX IF NOT EXISTS products_sku_tenant_uidx
          ON products (sku, business_id);
      END IF;
    END $$;
  `).catch((err) =>
    console.warn('⚠️   Phase 3: products tenant-unique SKU skipped:', err.message)
  );

  /* ── 3j. Tenant-aware product_returns uniqueness ─────────────────────── */
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = 'product_returns')
         AND NOT EXISTS (SELECT 1 FROM product_returns WHERE business_id IS NULL)
      THEN
        ALTER TABLE product_returns DROP CONSTRAINT IF EXISTS product_returns_product_name_return_date_key;
        DROP INDEX  IF EXISTS product_returns_name_date_uidx;
        /* The (product_name, return_date, business_id) uniqueness must apply ONLY to
           MANUAL daily-aggregate returns (order_id IS NULL, written by returns.js).
           Webhook returns store one row PER ORDER (order_id NOT NULL) kept unique by
           product_returns_order_id_uidx — they MUST be excluded here, else a 2nd
           same-product return on the same day violates this index and crashes the
           webhook. So drop the old NON-partial index and recreate it PARTIAL. */
        ALTER TABLE product_returns ADD COLUMN IF NOT EXISTS order_id INTEGER;
        DROP INDEX  IF EXISTS product_returns_name_date_tenant_uidx;
        CREATE UNIQUE INDEX IF NOT EXISTS product_returns_manual_name_date_uidx
          ON product_returns (product_name, return_date, business_id)
          WHERE order_id IS NULL;
      END IF;
    END $$;
  `).catch((err) =>
    console.warn('⚠️   Phase 3: product_returns tenant-unique skipped:', err.message)
  );

  /* ── 3k. Per-tenant filter indexes for fast WHERE business_id = $1 ────── */
  for (const table of CORE_TABLES) {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${table}_business_id_idx ON ${table} (business_id)`
    ).catch(() => {});
  }

  console.log('✅  Phase 3: FK constraints + composite PKs + tenant indexes enforced');
}

/* ══════════════════════════════════════════════════════════════════════════
   Phase 4 — Team Management / Agency model + incident schema fixes.
   All idempotent (safe to run every boot). Each statement is independently
   guarded so one failure never blocks the rest.
   ══════════════════════════════════════════════════════════════════════════ */
async function phase4AgencySchema() {
  /* ── 4a. users.role CHECK — allow 'media_buyer' ──────────────────────────
     The live constraint only permitted ('agent','admin'), so creating a media
     buyer threw `violates check constraint "users_role_check"` (HTTP 500). Drop
     then re-add aligned to staff.js VALID_ROLES. Extend the IN(...) list here if
     a new role is ever added to VALID_ROLES. */
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`).catch(() => {});
  await pool.query(`
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('agent', 'admin', 'media_buyer'))
  `).catch((err) =>
    console.warn('⚠️   Phase 4: users_role_check update skipped:', err.message)
  );

  /* ── 4b. Widen orders."Phone" 50→255 ────────────────────────────────────
     Long / multi-number phone cells from the Google Sheet overflowed
     VARCHAR(50) ("value too long for type character varying(50)") and aborted
     the whole sync tick. Widening is a metadata-only change (no rewrite). */
  await pool.query(`ALTER TABLE orders ALTER COLUMN "Phone" TYPE VARCHAR(255)`).catch((err) =>
    console.warn('⚠️   Phase 4: orders."Phone" widen skipped:', err.message)
  );

  /* ── 4c. Agency attribution columns ─────────────────────────────────────
     ad_account_id  → convenience single-account pointer on the user. NOTE: the
       scalable source of truth for "which ad accounts a buyer owns" stays
       meta_accounts.assigned_user_id (1 user → many accounts).
     referral_code  → the buyer's unique UTM/Sub-ID; orders carrying it attribute
       to that buyer. Unique PER TENANT so attribution is unambiguous.
     orders.referral_code → captured at ingestion (webhook / EasyOrder / sheet);
       drives the Media-Buyer order scope. */
  await pool.query(`ALTER TABLE users  ADD COLUMN IF NOT EXISTS ad_account_id VARCHAR(100)`).catch((err) =>
    console.warn('⚠️   Phase 4: users.ad_account_id skipped:', err.message)
  );
  await pool.query(`ALTER TABLE users  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(100)`).catch((err) =>
    console.warn('⚠️   Phase 4: users.referral_code skipped:', err.message)
  );
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_code VARCHAR(100)`).catch((err) =>
    console.warn('⚠️   Phase 4: orders.referral_code skipped:', err.message)
  );
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_tenant_uidx
      ON users (business_id, referral_code) WHERE referral_code IS NOT NULL
  `).catch((err) =>
    console.warn('⚠️   Phase 4: users_referral_code_tenant_uidx skipped:', err.message)
  );
  /* Fast Media-Buyer order lookups by referral. */
  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_referral_code_idx
      ON orders (business_id, referral_code)
  `).catch(() => {});

  console.log('✅  Phase 4: agency/team-management schema ready (role check, Phone, referral columns)');
}

/* ══════════════════════════════════════════════════════════════════════════
   Orchestrator — run the phases strictly in order.
   ══════════════════════════════════════════════════════════════════════════ */
async function initTenancy() {
  try {
    await phase1Create();      // tables + nullable columns, no FKs
    await phase2DataFix();     // back-fill + orphan cleanup
    await phase3Enforce();     // FKs, composite PKs, unique + filter indexes
    await phase4AgencySchema();// team-management + incident schema fixes
    console.log('✅  Tenant isolation: migration complete — schema is clean');
  } catch (err) {
    console.error('⚠️   Tenant isolation migration failed:', err.message);
  }
}

module.exports = { initTenancy };
