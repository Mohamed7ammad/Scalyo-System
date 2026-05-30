'use strict';

/**
 * verify_tenants.js — SaaS tenant-isolation health check.
 * ───────────────────────────────────────────────────────────────────────────
 * Standalone diagnostic. Connects to the same database the API uses and prints:
 *   1. Tenant summary   — how many business_profile rows (tenants) exist.
 *   2. Data distribution — per-tenant row counts for the core tables.
 *   3. Orphan check     — any rows with business_id IS NULL (back-fill misses).
 *
 * Run:  node verify_tenants.js
 *
 * Read-only: issues SELECTs only, mutates nothing. Safe to run on production.
 */

require('dotenv').config();
const pool = require('./src/config/db');

/* Tables we tally per tenant. `label` is what prints in the report. */
const DISTRIBUTION_TABLES = [
  { table: 'users',         label: 'Users'         },
  { table: 'orders',        label: 'Orders'        },
  { table: 'expenses',      label: 'Expenses'      },
  { table: 'products',      label: 'Products'      },
  { table: 'meta_accounts', label: 'Meta Accounts' },
];

/* Tables the orphan check scans for stray NULL business_id rows. */
const ORPHAN_TABLES = ['orders', 'expenses', 'products', 'users'];

/** Returns true if a table exists in the current database. */
async function tableExists(table) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
  return rows[0].reg !== null;
}

/**
 * Returns a Map<businessIdKey, count> for one table, grouped by business_id.
 * NULL business_id is keyed under the string 'NULL'.
 */
async function countByTenant(table) {
  const { rows } = await pool.query(
    `SELECT business_id, COUNT(*)::int AS n FROM ${table} GROUP BY business_id`
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.business_id === null ? 'NULL' : String(r.business_id), r.n);
  }
  return map;
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SaaS TENANT ISOLATION — DATABASE HEALTH REPORT');
  console.log('  ' + new Date().toISOString());
  console.log('══════════════════════════════════════════════════════════════\n');

  /* ── 1. Tenant summary ──────────────────────────────────────────────── */
  const { rows: tenants } = await pool.query(
    `SELECT id, COALESCE(brand_name, '(unnamed)') AS business_name
       FROM business_profile
      ORDER BY id ASC`
  );

  console.log(`1️⃣  TENANT SUMMARY — Total Tenants: ${tenants.length}\n`);
  console.table(
    tenants.map((t) => ({ 'Tenant ID': t.id, 'Business Name': t.business_name }))
  );

  if (tenants.length === 0) {
    console.warn('\n⚠️  No tenants found in business_profile — nothing to distribute.\n');
    return;
  }

  /* ── 2. Data distribution per tenant ────────────────────────────────── */
  console.log('\n2️⃣  DATA DISTRIBUTION (rows owned per tenant)\n');

  /* Collect a count-map for every distribution table (skip missing tables). */
  const countMaps = {};
  let sawNullBucket = false;
  for (const { table, label } of DISTRIBUTION_TABLES) {
    if (!(await tableExists(table))) {
      console.warn(`   ⚠️  Table "${table}" does not exist — skipped.`);
      countMaps[label] = null;
      continue;
    }
    const map = await countByTenant(table);
    if (map.has('NULL')) sawNullBucket = true;
    countMaps[label] = map;
  }

  /* Build one report row per tenant (+ an "Unassigned" row if NULLs exist). */
  const idKeys = tenants.map((t) => String(t.id));
  if (sawNullBucket) idKeys.push('NULL');

  const distributionRows = idKeys.map((key) => {
    const tenant = tenants.find((t) => String(t.id) === key);
    const row = {
      'Tenant ID':     key === 'NULL' ? '⚠️ UNASSIGNED' : key,
      'Business Name': key === 'NULL' ? '(orphaned rows)' : (tenant ? tenant.business_name : '(unknown)'),
    };
    for (const { label } of DISTRIBUTION_TABLES) {
      const map = countMaps[label];
      row[label] = map === null ? 'n/a' : (map.get(key) || 0);
    }
    return row;
  });

  console.table(distributionRows);

  /* ── 3. Orphan check ────────────────────────────────────────────────── */
  console.log('\n3️⃣  ORPHAN CHECK (rows where business_id IS NULL — should all be 0)\n');

  const orphanRows = [];
  let totalOrphans = 0;
  for (const table of ORPHAN_TABLES) {
    if (!(await tableExists(table))) {
      orphanRows.push({ Table: table, 'NULL business_id rows': 'n/a (no table)' });
      continue;
    }
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE business_id IS NULL`
    );
    const n = rows[0].n;
    totalOrphans += n;
    orphanRows.push({ Table: table, 'NULL business_id rows': n, Status: n === 0 ? '✅ clean' : '❌ ORPHANED' });
  }

  console.table(orphanRows);

  /* ── Verdict ────────────────────────────────────────────────────────── */
  console.log('\n──────────────────────────────────────────────────────────────');
  if (totalOrphans === 0) {
    console.log('✅  VERDICT: Back-fill complete — no orphaned rows. Foundation is rock solid.');
  } else {
    console.log(`❌  VERDICT: ${totalOrphans} orphaned row(s) found. Re-run the tenant back-fill before going live.`);
  }
  console.log('──────────────────────────────────────────────────────────────\n');
}

main()
  .catch((err) => {
    console.error('\n❌  verify_tenants.js failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
