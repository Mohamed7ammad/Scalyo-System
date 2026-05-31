const express       = require('express');
const pool          = require('../config/db');
const authenticate  = require('../middleware/auth');
const { requireAdmin, filterAgentFields } = require('../middleware/roleGuard');

const router = express.Router();

/* ── Idempotent migration: add "sku" column to orders if absent ─────────────
   Same pattern used by shipping.js for BostaTrackingCode.
   Safe to run on every restart.                                              */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "sku" VARCHAR(100)`)
  .then(() => console.log('✅  Orders: "sku" column ready'))
  .catch((err) => console.warn('⚠️   Orders sku column check:', err.message));

/* Locks the product's WAC at confirmation time so historical profitability
   stays accurate even after cost_price is updated by a new supply batch.   */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "unit_cost_price" NUMERIC(10,2)`)
  .then(() => console.log('✅  Orders: "unit_cost_price" column ready'))
  .catch((err) => console.warn('⚠️   Orders unit_cost_price column check:', err.message));

/* ── "updatedAt" column — critical for analytics date filtering ─────────────
   This column MUST exist so the analytics LEFT JOIN ON clause can compare
   dates.  If it is missing, every analytics query throws "column does not
   exist" and the frontend receives an empty array.

   Steps (all idempotent, fire-and-forget):
   1. Add the column if absent (DEFAULT NOW() so new inserts are stamped).
   2. Backfill any NULL rows with "createdAt" so historical orders get a
      reasonable timestamp rather than NULL (NULL comparison → false → row
      excluded from every date filter).                                       */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ DEFAULT NOW()`)
  .then(() =>
    pool.query(`UPDATE orders SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL`)
  )
  .then((r) => console.log(`✅  Orders: "updatedAt" ready — backfilled ${r.rowCount} rows`))
  .catch((err) => console.warn('⚠️   Orders updatedAt migration:', err.message));

/* ── Deposit / down-payment columns ─────────────────────────────────────────
   hasDeposit   — boolean flag: was a partial payment (عربون) collected?
   depositAmount — the EGP amount already paid by the customer.

   Both are optional (nullable / DEFAULT 0) so existing rows are unaffected.
   The PATCH route's dynamic SET clause picks them up automatically once the
   columns exist — no further code changes required.                          */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "hasDeposit"   BOOLEAN     DEFAULT FALSE`)
  .then(() => console.log('✅  Orders: "hasDeposit" column ready'))
  .catch((err) => console.warn('⚠️   Orders hasDeposit column check:', err.message));

pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "depositAmount" NUMERIC(10,2) DEFAULT 0`)
  .then(() => console.log('✅  Orders: "depositAmount" column ready'))
  .catch((err) => console.warn('⚠️   Orders depositAmount column check:', err.message));

/* ── Rejection reason — stored when agent marks an order as 'تم الرفض' ───────
   Column is VARCHAR(255) and nullable; NULL rows are handled by COALESCE in
   the analytics dashboard query that groups rejection reasons.                */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "rejectionReason" VARCHAR(255)`)
  .then(() => console.log('✅  Orders: "rejectionReason" column ready'))
  .catch((err) => console.warn('⚠️   Orders rejectionReason column check:', err.message));

// GET /api/orders — all roles (strictly scoped to the caller's tenant)
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE business_id = $1 ORDER BY "createdAt" DESC',
      [req.user.business_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/orders/bulk-transfer — admin only
// Transfers all 'جديد' orders from one agent to another.
router.post('/bulk-transfer', authenticate, requireAdmin, async (req, res) => {
  const { fromAgent, toAgent } = req.body;

  if (!fromAgent || !toAgent) {
    return res.status(400).json({ error: 'fromAgent و toAgent مطلوبان' });
  }

  try {
    const result = await pool.query(
      `UPDATE orders
       SET    "AssignedTo" = $1,
              "updatedAt"  = NOW()
       WHERE  "AssignedTo" = $2
         AND  "Status"     = 'جديد'
         AND  business_id  = $3
       RETURNING id`,
      [toAgent, fromAgent, req.user.business_id]
    );

    res.json({
      message:     `تم نقل ${result.rows.length} طلب بنجاح`,
      transferred: result.rows.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const getShortName = (name) => { return name ? name.trim().split(/\s+/).slice(0, 3).join(' ') : ''; };

/* ── POST /api/orders/auto-distribute — admin only ───────────────────────────
   Finds all "جديد" orders with no AssignedTo value and distributes them
   round-robin across every active + present agent, inside a transaction.      */
router.post('/auto-distribute', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* 1. ALL 'جديد' orders — regardless of current AssignedTo value */
    const unassignedResult = await client.query(
      `SELECT id FROM orders WHERE "Status" = 'جديد' AND business_id = $1 ORDER BY id ASC`,
      [businessId]
    );
    const orderIds = unassignedResult.rows.map((r) => r.id);

    if (orderIds.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ message: 'لا توجد طلبات بحالة جديد', distributed: 0, agentsCount: 0 });
    }

    /* 2. Present, active agents */
    const agentsResult = await client.query(
      `SELECT email FROM users
       WHERE  role = 'agent'
         AND  COALESCE(is_active, true)  = true
         AND  COALESCE(is_absent, false) = false
         AND  business_id = $1`,
      [businessId]
    );
    const agents = agentsResult.rows;

    if (agents.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'لا يوجد موظفون حاضرون لتوزيع الطلبات عليهم' });
    }

    /* 3. Round-robin assignment */
    for (let i = 0; i < orderIds.length; i++) {
      const target = agents[i % agents.length];
      await client.query(
        `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW() WHERE id = $2 AND business_id = $3`,
        [target.email, orderIds[i], businessId]
      );
    }

    await client.query('COMMIT');

    console.log(
      `[AutoDistribute] ✅ ${orderIds.length} orders → ${agents.length} agents`
    );

    res.json({
      message:     `تم توزيع ${orderIds.length} طلب على ${agents.length} موظف`,
      distributed: orderIds.length,
      agentsCount: agents.length,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[auto-distribute] Transaction error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

/* ── Largest-remainder (Hamilton) apportionment ──────────────────────────────
   Splits `total` into integer counts proportional to `weights` (percentages),
   guaranteeing the counts sum EXACTLY to `total`. e.g. 10 with [33,33,34] → [3,3,4].
   The leftover units go to the agents with the largest fractional parts.        */
function apportion(total, weights) {
  const raw  = weights.map((w) => (total * w) / 100);
  const base = raw.map(Math.floor);
  const used = base.reduce((a, b) => a + b, 0);
  let remainder = total - used;

  /* Hand out the remaining units to the largest fractional parts first. */
  const order = raw
    .map((v, i) => ({ i, frac: v - base[i] }))
    .sort((a, b) => b.frac - a.frac);

  const counts = [...base];
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    counts[order[k].i] += 1;
  }
  return counts;
}

/* ── POST /api/orders/distribute — admin only ────────────────────────────────
   Distributes ALL 'جديد' orders across agents, either equally or by custom %.
   Body:
     { mode: 'equal' }                                  → split evenly across
                                                           present, active agents
     { mode: 'custom', allocations: [{ agentId, percentage }, …] }
                                                        → exact %-based split
                                                          (percentages must sum to 100)
   The backend owns the math (atomic, no order IDs round-tripped to the client). */
router.post('/distribute', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const mode = req.body?.mode === 'custom' ? 'custom' : 'equal';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* 1. All pending 'جديد' orders for this tenant, stable order. */
    const ordRes = await client.query(
      `SELECT id FROM orders WHERE "Status" = 'جديد' AND business_id = $1 ORDER BY id ASC`,
      [businessId]
    );
    const orderIds = ordRes.rows.map((r) => r.id);
    if (orderIds.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ message: 'لا توجد طلبات بحالة جديد', distributed: 0, breakdown: [] });
    }

    /* 2. Resolve the target agents + their weights. */
    let targets;   // [{ email, weight }]
    if (mode === 'custom') {
      const allocations = Array.isArray(req.body.allocations) ? req.body.allocations : [];
      if (allocations.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'لم يتم تحديد نسب التوزيع' });
      }

      /* Validate percentages sum to exactly 100 (integers). */
      const sum = allocations.reduce((s, a) => s + (Number(a.percentage) || 0), 0);
      if (Math.round(sum) !== 100) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `مجموع النسب يجب أن يساوي 100% (الحالي: ${sum}%)` });
      }

      /* Map each agentId → email, scoped to active agents in this tenant.
         users.id is VARCHAR in this DB (auth UUIDs), so compare as text — NOT
         int[] (which throws "invalid input syntax for integer" / type mismatch). */
      const ids = allocations.map((a) => String(a.agentId));
      const usersRes = await client.query(
        `SELECT id, email FROM users
          WHERE id::text = ANY($1::text[]) AND role = 'agent'
            AND COALESCE(is_active, true) = true AND business_id = $2`,
        [ids, businessId]
      );
      const emailById = new Map(usersRes.rows.map((u) => [String(u.id), u.email]));

      targets = allocations
        .map((a) => ({ email: emailById.get(String(a.agentId)), weight: Number(a.percentage) || 0 }))
        .filter((t) => t.email && t.weight > 0);   // drop unknown agents / 0%

      if (targets.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'لا يوجد موظفون صالحون في نسب التوزيع' });
      }
    } else {
      /* Equal mode — present, active agents share evenly. */
      const agentsRes = await client.query(
        `SELECT email FROM users
          WHERE role = 'agent' AND COALESCE(is_active, true) = true
            AND COALESCE(is_absent, false) = false AND business_id = $1
          ORDER BY id ASC`,
        [businessId]
      );
      if (agentsRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'لا يوجد موظفون حاضرون لتوزيع الطلبات عليهم' });
      }
      const equalWeight = 100 / agentsRes.rows.length;
      targets = agentsRes.rows.map((r) => ({ email: r.email, weight: equalWeight }));
    }

    /* 3. Exact integer counts via largest-remainder. */
    const counts = apportion(orderIds.length, targets.map((t) => t.weight));

    /* 4. Assign sequential slices of the order list to each agent. */
    let cursor = 0;
    const breakdown = [];
    for (let t = 0; t < targets.length; t++) {
      const slice = orderIds.slice(cursor, cursor + counts[t]);
      cursor += counts[t];
      if (slice.length > 0) {
        await client.query(
          /* Re-assert "Status" = 'جديد' on the UPDATE so a processed order
             (confirmed / rejected / shipped …) can NEVER be reassigned, even if
             its status changed between the SELECT above and this write. */
          `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW()
            WHERE id = ANY($2::int[]) AND business_id = $3 AND "Status" = 'جديد'`,
          [targets[t].email, slice, businessId]
        );
      }
      breakdown.push({ email: targets[t].email, count: slice.length });
    }

    await client.query('COMMIT');
    console.log(`[Distribute] ✅ ${mode} — ${orderIds.length} orders → ${targets.length} agents`);

    res.json({
      message:     `تم توزيع ${orderIds.length} طلب على ${targets.length} موظف`,
      distributed: orderIds.length,
      mode,
      breakdown,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    /* Full PostgreSQL detail in the terminal for diagnosis. */
    console.error('[distribute] Transaction error:');
    console.error('  message:', err.message);
    console.error('  detail: ', err.detail ?? '—');
    console.error('  hint:   ', err.hint   ?? '—');
    console.error(err);
    res.status(500).json({ error: 'فشل التوزيع', details: err.message });
  } finally {
    client.release();
  }
});

/* ── POST /api/orders/transfer — admin only ──────────────────────────────────
   Transfers a specific set of order IDs to a target agent (identified by DB
   user id).  Looks up the agent's email and updates AssignedTo for each row.  */
router.post('/transfer', authenticate, requireAdmin, async (req, res) => {
  const { orderIds, targetAgentId } = req.body;

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: 'orderIds (array) مطلوب' });
  }
  if (!targetAgentId) {
    return res.status(400).json({ error: 'targetAgentId مطلوب' });
  }

  try {
    /* Look up the agent's email so AssignedTo stays consistent (email-based) */
    const agentResult = await pool.query(
      `SELECT email FROM users WHERE id = $1 AND COALESCE(is_active, true) = true AND business_id = $2`,
      [targetAgentId, req.user.business_id]
    );
    if (!agentResult.rows.length) {
      return res.status(404).json({ error: 'الموظف غير موجود أو غير نشط' });
    }
    const targetEmail = agentResult.rows[0].email;

    const result = await pool.query(
      `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW() WHERE id = ANY($2::int[]) AND business_id = $3 RETURNING id`,
      [targetEmail, orderIds, req.user.business_id]
    );

    console.log(
      `[Transfer] ✅ ${result.rows.length} orders → "${targetEmail}"`
    );

    res.json({
      message:     `تم نقل ${result.rows.length} طلب إلى ${targetEmail}`,
      transferred: result.rows.length,
      targetEmail,
    });
  } catch (err) {
    console.error('[transfer]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── Bulk delete — admin only ───────────────────────────────────────────────
   Deletes many orders in ONE query. Strictly tenant-scoped (business_id) so a
   tenant can never delete another tenant's rows. Registered BEFORE DELETE /:id
   so the literal "/bulk" path is matched first (Express matches in order).    */
router.delete('/bulk', authenticate, requireAdmin, async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids (array) مطلوب' });
  }
  /* Coerce to integers and drop anything non-numeric — defends the int[] cast. */
  const cleanIds = ids.map((n) => parseInt(n, 10)).filter(Number.isInteger);
  if (cleanIds.length === 0) {
    return res.status(400).json({ error: 'لا توجد معرّفات صالحة للحذف' });
  }

  try {
    const result = await pool.query(
      'DELETE FROM orders WHERE id = ANY($1::int[]) AND business_id = $2 RETURNING id',
      [cleanIds, req.user.business_id]
    );
    console.log(`[Bulk Delete] 🗑️  ${result.rows.length} order(s) deleted for tenant ${req.user.business_id}`);
    res.json({ message: `تم حذف ${result.rows.length} طلب`, deleted: result.rows.length });
  } catch (err) {
    console.error('[bulk-delete]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── Strict whitelist of DB columns that PATCH is allowed to touch ──────────
   Any key in req.body that is NOT in this set is silently dropped before the
   SET clause is built.  This prevents:
     • UI-only / calculated fields (e.g. remainingCod, displayLabel) crashing
       the query with "column does not exist".
     • Accidental overwrites of system columns (id, createdAt, etc.).
   Add a new column here whenever a new DB column is introduced.              */
const PATCH_WHITELIST = new Set([
  // ── Customer details ──────────────────────────────────────────────
  'FullName', 'Phone', 'Email',
  // ── Address ───────────────────────────────────────────────────────
  'City', 'Governorate', 'Address', 'Zone', 'District',
  // ── Order details ─────────────────────────────────────────────────
  'ProductName', 'ProductPrice', 'Quantity', 'DeliveryRate', 'sku',
  // ── Workflow ──────────────────────────────────────────────────────
  'Status', 'Note', 'PostponedDate', 'rejectionReason', 'AssignedTo',
  // ── Shipping ──────────────────────────────────────────────────────
  'BostaTrackingCode',
  // ── Finance ───────────────────────────────────────────────────────
  'hasDeposit', 'depositAmount', 'unit_cost_price',
]);

// PATCH /api/orders/:id — agents restricted to Status + Note only
router.patch('/:id', authenticate, filterAgentFields, async (req, res) => {
  const { id } = req.params;
  const businessId = req.user.business_id;

  /* ── Strip any UI-only / unknown keys before touching the DB ─────── */
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([key]) => {
      const allowed = PATCH_WHITELIST.has(key);
      if (!allowed) {
        console.warn(`[PATCH /:id] Dropping unknown field from body: "${key}"`);
      }
      return allowed;
    })
  );

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'لا توجد حقول للتحديث' });
  }

  /* ── Step 1: Fetch the current order from the DB ────────────────────
     The frontend only sends the fields being changed (e.g. {Status: '…'}).
     ProductName, sku, and the previous Status are NOT in req.body — they
     must come from the database.
     ─────────────────────────────────────────────────────────────────── */
  let currentProductName = '';
  let currentStatus      = '';
  let currentSku         = null;   // null means no SKU → fall back to name match

  try {
    const row = await pool.query(
      'SELECT "Status", "ProductName", "sku" FROM orders WHERE id = $1 AND business_id = $2',
      [id, businessId]
    );
    if (!row.rows.length) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    currentProductName = (row.rows[0].ProductName || '').trim();
    currentStatus      = row.rows[0].Status || '';
    // Treat empty string as null so the SQL $1 IS NOT NULL guard works correctly
    currentSku         = row.rows[0].sku || null;
  } catch (err) {
    console.error('Step 1 – fetch order failed:', err.message);
    return res.status(500).json({ error: 'خطأ في الخادم' });
  }

  /* ── Step 2: Execute the main order update ──────────────────────────
     SET clause is built only from whitelisted fields (see PATCH_WHITELIST).
     Only this block can return a 500 to the client; everything below is
     fire-and-forget.
     ─────────────────────────────────────────────────────────────────── */
  const fields     = Object.keys(updates);
  const values     = Object.values(updates);
  // Always stamp the action time so analytics date-filters see the update today.
  const setClauses = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ')
                   + ', "updatedAt" = NOW()';

  let updatedOrder;
  try {
    const result = await pool.query(
      `UPDATE orders SET ${setClauses} WHERE id = $${fields.length + 1} AND business_id = $${fields.length + 2} RETURNING *`,
      [...values, id, businessId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    updatedOrder = result.rows[0];
  } catch (err) {
    console.error('PATCH Order Error (Step 2 – update failed):', err.message);
    console.error('  → SET clause fields:', fields);
    console.error('  → Full PG error:',     err);
    return res.status(500).json({ error: 'خطأ في الخادم' });
  }

  /* ── Step 3: Inventory lifecycle (runs BEFORE res.json) ────────────
     Stock is considered "reserved" (deducted) once an order enters ANY of
     these terminal-flow statuses.  Moving WITHIN the group (e.g. confirmed
     → shipped → delivered) does NOT touch stock — the item is already gone.

     Deduct : oldStatus NOT in group  AND  newStatus IS  in group
     Restore: oldStatus IS  in group  AND  newStatus NOT in group  (e.g. cancelled)
     Skip   : both in same group, or no Status field, or status unchanged
     ─────────────────────────────────────────────────────────────────── */
  const RESERVED = new Set(['تم التأكيد', 'تم الشحن', 'تم التوصيل']);

  if (updates.Status && updates.Status !== currentStatus) {
    const newStatus  = updates.Status;
    const wasReserved = RESERVED.has(currentStatus);
    const isReserved  = RESERVED.has(newStatus);

    console.log(`[Inventory] Status change detected`);
    console.log(`  Old Status   : "${currentStatus}" (reserved=${wasReserved})`);
    console.log(`  New Status   : "${newStatus}" (reserved=${isReserved})`);
    console.log(`  Product Name : "${currentProductName}"`);
    console.log(`  SKU          : ${currentSku ? `"${currentSku}" → matching by SKU` : 'null → matching by name'}`);

    if (wasReserved === isReserved) {
      console.log('[Inventory] Case C — same reservation group, skipping.');

    } else if (!currentProductName) {
      console.warn('[Inventory] No ProductName on this order — skipping adjustment.');

    } else if (!wasReserved && isReserved) {
      /* ── Case A: Deduct ─────────────────────────────────────────────────
         Build the query in JS based on whether we have a SKU.
         This avoids passing null as a typed parameter, which can confuse
         PostgreSQL's query planner and cause type-mismatch errors.         */
      const hasSku = Boolean(currentSku);
      const deductSql = hasSku
        ? `UPDATE products SET stock_quantity = stock_quantity - 1
           WHERE sku = $1 AND business_id = $2 AND stock_quantity > 0
           RETURNING name, sku, stock_quantity, cost_price`
        : `UPDATE products SET stock_quantity = stock_quantity - 1
           WHERE TRIM(name) = TRIM($1) AND business_id = $2 AND stock_quantity > 0
           RETURNING name, sku, stock_quantity, cost_price`;
      const deductParam = hasSku ? currentSku : currentProductName;

      console.log(`[Inventory] Case A — deducting 1 unit (${hasSku ? 'SKU' : 'name'}: "${deductParam}")`);
      try {
        const r = await pool.query(deductSql, [deductParam, businessId]);
        if (r.rowCount === 0) {
          console.warn(`⚠️ Inventory Deduct Failed: no match for ${hasSku ? 'SKU' : 'name'} "${deductParam}"`);
        } else {
          console.log(`✅ Inventory deducted: stock now ${r.rows[0].stock_quantity} for "${r.rows[0].name}" (SKU: ${r.rows[0].sku ?? 'none'})`);

          /* ── WAC cost lock: write the product's current WAC into the order
             so historical analytics stay accurate even after future supply
             batches change cost_price.  Fire-and-forget — doesn't block res. */
          const lockedCost = parseFloat(r.rows[0].cost_price) || 0;
          if (lockedCost > 0) {
            pool.query(
              'UPDATE orders SET "unit_cost_price" = $1 WHERE id = $2 AND business_id = $3',
              [lockedCost, id, businessId]
            ).catch((e) => console.error('[Inventory] unit_cost_price lock failed:', e.message));
          }
        }
      } catch (err) {
        console.error(`[Inventory] Deduct query error: ${err.message}`);
      }

    } else {
      /* ── Case B: Restore ────────────────────────────────────────────────
         Same JS-driven dispatch — no null parameters passed to PostgreSQL. */
      const hasSku = Boolean(currentSku);
      const restoreSql = hasSku
        ? `UPDATE products SET stock_quantity = stock_quantity + 1
           WHERE sku = $1 AND business_id = $2
           RETURNING name, sku, stock_quantity`
        : `UPDATE products SET stock_quantity = stock_quantity + 1
           WHERE TRIM(name) = TRIM($1) AND business_id = $2
           RETURNING name, sku, stock_quantity`;
      const restoreParam = hasSku ? currentSku : currentProductName;

      console.log(`[Inventory] Case B — restoring 1 unit (${hasSku ? 'SKU' : 'name'}: "${restoreParam}")`);
      try {
        const r = await pool.query(restoreSql, [restoreParam, businessId]);
        if (r.rowCount === 0) {
          console.warn(`⚠️ Inventory Restore Failed: no match for ${hasSku ? 'SKU' : 'name'} "${restoreParam}"`);
        } else {
          console.log(`✅ Inventory restored: stock now ${r.rows[0].stock_quantity} for "${r.rows[0].name}" (SKU: ${r.rows[0].sku ?? 'none'})`);
        }
      } catch (err) {
        console.error(`[Inventory] Restore query error: ${err.message}`);
      }
    }
  } else {
    console.log(`[Inventory] No status change in this update — skipping. (updates.Status = ${JSON.stringify(updates.Status)})`);
  }

  /* ── Step 3.5a: Treasury — deposit hook (fire-and-forget) ───────────────
     Fires whenever depositAmount is part of this PATCH payload.
     Uses the partial unique index treasury_deposit_order_uidx
     (ON CONFLICT … WHERE source = 'deposit') for idempotency so that
     updating the amount on an existing deposit correctly UPDATES the row
     rather than inserting a duplicate.
     If the amount is cleared to 0 the treasury entry is deleted.            */
  if (updates.depositAmount !== undefined) {
    const depositAmt = parseFloat(updates.depositAmount) || 0;

    if (depositAmt > 0) {
      const depositDesc =
        `عربون طلب #${id}` +
        (updatedOrder.FullName    ? ` — ${updatedOrder.FullName}`       : '') +
        (updatedOrder.ProductName ? ` | ${updatedOrder.ProductName}`    : '');

      pool.query(
        `INSERT INTO treasury_transactions
           (order_id, amount, type, source, description, transaction_date, business_id)
         VALUES ($1, $2, 'revenue', 'deposit', $3, CURRENT_DATE, $4)
         ON CONFLICT (order_id) WHERE source = 'deposit'
         DO UPDATE SET
           amount      = EXCLUDED.amount,
           description = EXCLUDED.description`,
        [id, depositAmt.toFixed(2), depositDesc, businessId]
      ).catch((e) => console.error('[Treasury] Deposit hook failed:', e.message));

    } else {
      /* Deposit cleared → remove treasury entry if it exists */
      pool.query(
        `DELETE FROM treasury_transactions WHERE order_id = $1 AND source = 'deposit' AND business_id = $2`,
        [id, businessId]
      ).catch((e) => console.error('[Treasury] Deposit clear failed:', e.message));
    }
  }

  /* ── Step 3.5b: Treasury — commission hook (fire-and-forget) ────────────
     Fires when Status changes to a commission-triggering state.
     Looks up the assigned agent's rate for the new status from the users
     table and logs the amount as an expense in treasury_transactions.

     Idempotency: each (order_id, source) pair has its own partial unique
     index, so the same commission can never be double-counted even if the
     frontend sends the same status update twice.

     Mapping:
       'تم التأكيد'  → source 'comm_confirmed'  (comm_confirmed column)
       'تم التوصيل' → source 'comm_delivered'   (comm_delivered column)
       'تم الرفض'   → source 'comm_rejected'    (comm_rejected column)
       'لا يرد'     → source 'comm_no_answer'   (comm_no_answer column)
       'مؤجل'       → source 'comm_no_answer'   (same bucket as لا يرد)   */
  if (updates.Status && updates.Status !== currentStatus) {
    const COMM_MAP = {
      'تم التأكيد':  { field: 'comm_confirmed', source: 'comm_confirmed', label: 'تأكيد'   },
      'تم التوصيل': { field: 'comm_delivered',  source: 'comm_delivered',  label: 'توصيل'   },
      'تم الرفض':   { field: 'comm_rejected',   source: 'comm_rejected',   label: 'رفض'     },
      'لا يرد':     { field: 'comm_no_answer',  source: 'comm_no_answer',  label: 'لا يرد'  },
      'مؤجل':       { field: 'comm_no_answer',  source: 'comm_no_answer',  label: 'مؤجل'    },
    };

    const commInfo   = COMM_MAP[updates.Status];
    const assignedTo = updatedOrder.AssignedTo;

    if (commInfo && assignedTo) {
      pool.query(
        `SELECT "${commInfo.field}" AS rate FROM users WHERE email = $1 AND business_id = $2`,
        [assignedTo, businessId]
      ).then(({ rows: uRows }) => {
        if (!uRows.length) return null;
        const rate = parseFloat(uRows[0].rate) || 0;
        if (rate <= 0) return null;   // agent has no commission for this status

        const commDesc =
          `عمولة ${commInfo.label} — ${assignedTo.split('@')[0]} — طلب #${id}` +
          (updatedOrder.ProductName ? ` | ${updatedOrder.ProductName}` : '');

        /* source literal is hardcoded (not user input) — safe to interpolate
           into the ON CONFLICT WHERE clause (cannot use a bind parameter there) */
        return pool.query(
          `INSERT INTO treasury_transactions
             (order_id, amount, type, source, description, transaction_date, business_id)
           VALUES ($1, $2, 'expense', $3, $4, CURRENT_DATE, $5)
           ON CONFLICT (order_id) WHERE source = '${commInfo.source}'
           DO NOTHING`,
          [id, rate.toFixed(2), commInfo.source, commDesc, businessId]
        );
      }).catch((e) => console.error('[Treasury] Commission hook failed:', e.message));
    }
  }

  /* ── Send 200 OK after all inventory + treasury work is dispatched ── */
  res.json(updatedOrder);
});

// DELETE /api/orders/:id — admin only
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM orders WHERE id = $1 AND business_id = $2 RETURNING id',
      [req.params.id, req.user.business_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    res.json({ message: 'تم حذف الطلب بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
