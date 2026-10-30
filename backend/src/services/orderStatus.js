'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Order updates — ONE writer (WhatsApp module, Phase 1 — 2026-10-30)
   ════════════════════════════════════════════════════════════════════════════
   Everything that has to happen once an order update is allowed — repricing,
   stock deduction / restock + the WAC cost lock, the deposit / commission
   ledger rows, voiding commissions the order no longer qualifies for — lives
   here, so an agent's dropdown (PATCH /orders/:id) and the WhatsApp bot
   produce exactly the same result. Callers keep their own "who may do what"
   guards; this module is "what happens once it's allowed".

   COMPARE-AND-SET: an update that carries a Status names the status it
   replaces (`expectedStatus` — what the agent's screen showed, or what the bot
   read; otherwise the status loaded just before). The UPDATE only lands while
   the order is still in it, so two writers can never both apply a transition:
   no overwrite, no double stock deduction. The loser gets STATUS_CONFLICT with
   the order as it is now, and nothing else runs. Every status change is
   stamped (status_changed_at / status_changed_by = an email, or 'whatsapp'). */

const pool = require('../config/db');
const { resolveGovernorate, shippingRateFor } = require('../config/shippingRates');
const noAnswer = require('./noAnswerCycles');

/* ── Schema ─────────────────────────────────────────────────────────────────
   Stamping is skipped (never fails an update) if the columns couldn't be added. */
let stampColumns = false;
const schemaReady = pool.query(
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
                      ADD COLUMN IF NOT EXISTS status_changed_by TEXT`)
  .then(() => { stampColumns = true; console.log('✅  Order updates: status stamp columns ready'); })
  .catch((e) => console.error('❌  Order updates: status stamp columns failed:', e.message));

/* PG btrim() parity (spaces only) — the JS side of the compare-and-set. */
const bt = (s) => String(s ?? '').replace(/^ +| +$/g, '');
const sameStatus = (a, b) => bt(a) === bt(b);

/* Treasury ledger sources that make up an agent's earned commission for an order.
   (bosta_cod / deposit are revenue/cash, NOT commission — excluded.) */
const COMMISSION_SOURCES = ['comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer'];

/* Re-freeze one order's earned_commission = the SUM of its CURRENT valid frozen
   commission ledger rows. Called after any hook that adds/voids a commission txn,
   so the denormalised column always mirrors the (already rate-frozen, funnel-aware)
   treasury ledger. Best-effort: never throws into the request path.
   NOTE: this is the order's TOTAL across every agent who earned on it. Agent
   balances are NOT derived from it — they sum the ledger rows each agent owns
   (utils/commission.js), so a transferred order's commission stays with its earner. */
async function syncEarnedCommission(orderId, businessId) {
  try {
    await pool.query(
      `UPDATE orders SET earned_commission = COALESCE((
          SELECT SUM(amount::numeric) FROM treasury_transactions
           WHERE order_id = $1 AND business_id = $2 AND source = ANY($3::text[])
        ), 0)
        WHERE id = $1 AND business_id = $2`,
      [orderId, businessId, COMMISSION_SOURCES]
    );
  } catch (e) {
    console.error('[earned_commission] sync failed for order', orderId, '—', e.message);
  }
}

/* Fire-and-forget batch insert of assignment-change rows. A logging failure must
   NEVER break the actual transfer, so every error is swallowed with a warning.
   `rows` = [{ orderId, fromAgent, toAgent, status }]. */
async function recordAssignmentLog(rows, { businessId, changedBy, changedById, source }) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const values = [];
  const params = [];
  let i = 1;
  for (const r of rows) {
    params.push(r.orderId, businessId, r.fromAgent ?? null, r.toAgent ?? null,
                changedBy ?? null, changedById ?? null, source, r.status ?? null);
    values.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
  }
  try {
    await pool.query(
      `INSERT INTO order_assignment_log
         (order_id, business_id, from_agent, to_agent, changed_by, changed_by_id, source, order_status)
       VALUES ${values.join(',')}`,
      params
    );
  } catch (e) {
    console.warn('[assignment-log] insert skipped:', e.message);
  }
}

/* ── Alias-aware product resolver ─────────────────────────────────────────────
   Resolve the product an order maps to. Matches the order's sku OR product name
   against a product's main `sku`, `name`, OR any entry in its `aliases` array —
   all case-insensitive + trimmed. Returns the product row (or null). Preference
   order: exact SKU → exact name → alias match.                                 */
async function resolveProductForOrder(businessId, sku, name) {
  const skuKey  = (sku  ?? '').trim();
  const nameKey = (name ?? '').trim();
  if (!skuKey && !nameKey) return null;

  const { rows } = await pool.query(
    `SELECT id, name, sku, stock_quantity, cost_price,
            CASE
              WHEN LOWER(TRIM(sku))  = LOWER(NULLIF($1, '')) THEN 1
              WHEN LOWER(TRIM(name)) = LOWER(NULLIF($2, '')) THEN 2
              ELSE 3
            END AS match_rank
       FROM products
      WHERE business_id = $3
        AND (
              LOWER(TRIM(sku))  = LOWER(NULLIF($1, ''))
           OR LOWER(TRIM(name)) = LOWER(NULLIF($2, ''))
           OR EXISTS (
                SELECT 1 FROM unnest(COALESCE(aliases, '{}'::text[])) AS a
                 WHERE LOWER(TRIM(a)) = LOWER(NULLIF($1, ''))
                    OR LOWER(TRIM(a)) = LOWER(NULLIF($2, ''))
              )
            )
      ORDER BY match_rank ASC
      LIMIT 1`,
    [skuKey, nameKey, businessId]
  );
  return rows[0] || null;
}

/* ── Load ────────────────────────────────────────────────────────────────────
   The order as callers' guards and the update pipeline need it (null = not
   found). `row` is the full DB row — what a caller that lost the
   compare-and-set gets back. */
async function loadOrder(businessId, orderId) {
  const { rows: [row] } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND business_id = $2`, [orderId, businessId]);
  if (!row) return null;
  return {
    row,
    status:        row.Status || '',
    productName:   (row.ProductName || '').trim(),
    sku:           row.sku || null,   // null means no SKU → fall back to name match
    productPrice:  row.ProductPrice ?? '',
    qty:           Math.max(1, parseInt(row.quantity, 10) || 1),
    stockDeducted: row.stock_deducted === true,
    assignedTo:    row.AssignedTo ?? null,
    city:          row.City ?? '',
    isLost:        row.is_lost_order === true,   // dynamic shipping pricing applies to lost orders ONLY
    postponedDate: row.PostponedDate ?? null,
    postponeCount: Number(row.postpone_count) || 0,
  };
}

function conflictMessage(row) {
  const st = bt(row.Status);
  const by = String(row.status_changed_by ?? '');
  if (by === 'whatsapp') return `العميل ردّ على واتساب — الأوردر بقى «${st}»`;
  if (by.includes('@')) return `الأوردر اتغيّر من حساب ${by.split('@')[0]} — الحالة دلوقتي «${st}»`;
  return `الأوردر اتغيّر — الحالة دلوقتي «${st}»`;
}
const conflict = (row) => ({ ok: false, status: 409, code: 'STATUS_CONFLICT', error: conflictMessage(row), current: row });

/* Stock is held ONLY while the order is actively in the fulfilment pipeline.
   ANY other state (مؤجل / ملغي / مرفوض / لا يرد / جديد / …) must release it.
   Hamza/diacritic-resilient normalisation: unify أإآ→ا, ى→ي, ة→ه, strip
   harakat + tatweel + spaces — so 'تم التاكيد' (no hamza) == 'تم التأكيد'.    */
const normState = (s) => (s ?? '')
  .normalize('NFC')
  .replace(/[أإآ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[ً-ْـ]/g, '')   // harakat + tatweel
  .replace(/\s+/g, ' ')
  .trim();
const COMMITTED_STATES = ['تم التأكيد', 'تم الشحن', 'تم التوصيل'].map(normState);

/* ── Apply ───────────────────────────────────────────────────────────────────
   Apply an ALLOWED update. `current` = loadOrder(); `updates` = whitelisted
   columns (repricing may add ProductPrice). Returns
     { ok: true, order, settled } — `settled` resolves once every background
                                    ledger write is done (never rejects);
     { ok: false, status, code, error, current? } — NOT_FOUND / STATUS_CONFLICT
                                    / UPDATE_FAILED: nothing was changed.
   `actor` = { email, id } (a user) or { label: 'whatsapp' }; `source` names the
   assignment-log origin. `effects.commission: false` skips the status
   commission (how a WhatsApp confirmation pays is a Phase 2 decision). */
async function applyUpdate({ businessId, orderId, current, updates, expectedStatus = null, actor = {}, effects = {} }) {
  const id = orderId;
  const has = (k) => Object.prototype.hasOwnProperty.call(updates, k);
  await schemaReady;

  /* A stale screen / a bot that read an older status: refuse before anything runs. */
  if (has('Status') && expectedStatus != null && !sameStatus(expectedStatus, current.status)) {
    return conflict(current.row);
  }
  const statusChanging = !!updates.Status && !sameStatus(updates.Status, current.status);
  const pending = [];   // background ledger writes → `settled`

  /* ── Step 1b: Recalculate total price when quantity changes ─────────
     total = unit_price × new_qty. Unit price is taken from the product
     catalogue (by SKU, else name) and, when the order has no matching product
     (manual/imported), derived from the order's own current unit price
     (oldTotal ÷ oldQty). The new ProductPrice is injected into `updates` so it
     is saved and returned to the frontend. (No per-order shipping-fee column
     exists — Bosta shipping/COD is handled separately.)                    */
  if (updates.quantity !== undefined) {
    const newQty = Math.max(1, parseInt(updates.quantity, 10) || 1);
    updates.quantity = newQty;   // normalise

    const parsePrice = (v) =>
      parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')) || 0;

    let unitPrice = null;
    try {
      const prod = await pool.query(
        `SELECT selling_price FROM products
          WHERE business_id = $1 AND (sku = $2 OR TRIM(name) = TRIM($3))
          ORDER BY (sku = $2) DESC
          LIMIT 1`,
        [businessId, current.sku, current.productName]
      );
      if (prod.rows.length) unitPrice = parseFloat(prod.rows[0].selling_price) || null;
    } catch (e) {
      console.warn('[PATCH] product unit-price lookup failed:', e.message);
    }

    // Fallback: derive the unit price from the order's existing total.
    if (unitPrice == null || unitPrice <= 0) {
      const oldTotal = parsePrice(current.productPrice);
      if (oldTotal > 0) unitPrice = oldTotal / current.qty;
    }

    if (unitPrice != null && unitPrice > 0) {
      const newTotal = Math.round(unitPrice * newQty * 100) / 100;
      updates.ProductPrice = String(newTotal);
      console.log(`[PATCH] qty ${current.qty}→${newQty} on order ${id}: unit=${unitPrice} → ProductPrice=${newTotal}`);
    }
  }

  /* ── Step 1c: Dynamic governorate shipping — MISSING/lost orders ONLY ─────────
     Total = (base unit price × quantity) + flat governorate shipping. This is the
     AUTHORITATIVE repricing so an agent (who can't send ProductPrice) still gets a
     correct total when they pick a governorate. It fires when the governorate is
     changed (Rule B) OR when a lost order is confirmed (Rule C — "save on confirm"),
     and covers Rule A (no governorate ⇒ base only, 0 shipping). Normal store orders
     are never touched — their price already includes shipping.
       • base price unresolvable (no matching catalogue product) → LEAVE price as-is.
       • City non-empty but UNRECOGNISED                          → LEAVE price as-is
         (never guess a shipping rate for an unknown place).
       • City empty                                                → base × qty only.
       • City recognised                                           → base × qty + rate. */
  const cityIsChanging   = has('City');
  const confirmingLost   = updates.Status && String(updates.Status).trim() === 'تم التأكيد'
                                          && current.status !== 'تم التأكيد';
  if (current.isLost && (cityIsChanging || confirmingLost)) {
    const effectiveCity = cityIsChanging ? String(updates.City ?? '').trim() : String(current.city ?? '').trim();
    const qty = updates.quantity !== undefined
      ? Math.max(1, parseInt(updates.quantity, 10) || 1)
      : current.qty;

    // Base UNIT price from the catalogue (SKU first, then name). No fallback to the
    // order's own price here — without a real base we must not guess (decision: leave).
    let baseUnit = null;
    try {
      const prod = await pool.query(
        `SELECT selling_price FROM products
          WHERE business_id = $1 AND (sku = $2 OR TRIM(name) = TRIM($3))
          ORDER BY (sku = $2) DESC
          LIMIT 1`,
        [businessId, current.sku, current.productName]
      );
      if (prod.rows.length) baseUnit = parseFloat(prod.rows[0].selling_price) || null;
    } catch (e) {
      console.warn('[PATCH] lost-order base-price lookup failed:', e.message);
    }

    if (baseUnit != null && baseUnit > 0) {
      const canonical = resolveGovernorate(effectiveCity);   // null when empty/unknown
      let newTotal = null;
      if (!effectiveCity) {
        newTotal = baseUnit * qty;                            // Rule A: no governorate
      } else if (canonical) {
        newTotal = baseUnit * qty + shippingRateFor(effectiveCity);   // Rules B / C
      } // else: recognised-but-unknown string → leave price unchanged (newTotal stays null)

      if (newTotal != null) {
        updates.ProductPrice = String(Math.round(newTotal * 100) / 100);
        console.log(`[PATCH] lost order ${id} reprice: base=${baseUnit}×${qty} + ship(${canonical ?? 'none'}) → ProductPrice=${updates.ProductPrice}`);
      }
    }
  }

  /* ── Step 2: Execute the main order update (compare-and-set) ─────────
     SET clause is built only from the caller's whitelisted fields. With a
     Status in the payload the row must still hold the expected status — a
     concurrent writer that got there first makes this a STATUS_CONFLICT.
     Everything below is best-effort (ledger writes in the background).
     ─────────────────────────────────────────────────────────────────── */
  const fields = Object.keys(updates);
  const params = [...Object.values(updates), id, businessId];
  // Always stamp the action time so analytics date-filters see the update today.
  let setClauses = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ')
                 + ', "updatedAt" = NOW()';

  /* Dedicated shipped_at stamp the moment this update moves the order to 'تم الشحن'.
     Idempotent (COALESCE keeps the first ship time) and a fixed SQL literal — no
     user parameter — so a later edit that re-touches the row never shifts it. */
  if (String(updates.Status ?? '').trim() === 'تم الشحن') {
    setClauses += ', shipped_at = COALESCE(shipped_at, NOW())';
  }
  if (statusChanging && stampColumns) {
    params.push(actor.email ?? actor.label ?? null);
    setClauses += `, status_changed_at = NOW(), status_changed_by = $${params.length}`;
  }
  let where = `id = $${fields.length + 1} AND business_id = $${fields.length + 2}`;
  if (has('Status')) {
    params.push(expectedStatus ?? current.status);
    where += ` AND COALESCE(btrim("Status"), '') = btrim($${params.length})`;
  }

  let updatedOrder;
  try {
    const result = await pool.query(`UPDATE orders SET ${setClauses} WHERE ${where} RETURNING *`, params);
    if (!result.rows.length) {
      const { rows: [now] } = await pool.query(
        `SELECT * FROM orders WHERE id = $1 AND business_id = $2`, [id, businessId]);
      if (!now) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'الطلب غير موجود' };
      console.warn(`[orders] status compare-and-set lost on order ${id}: expected "${bt(expectedStatus ?? current.status)}", now "${bt(now.Status)}" (by ${now.status_changed_by ?? '?'})`);
      return conflict(now);
    }
    updatedOrder = result.rows[0];

    /* Audit trail — log an AssignedTo change once it has actually landed and
       the owner really differs (a no-op re-select of the same agent isn't a
       transfer). Fire-and-forget so it can never fail the update. */
    if (has('AssignedTo') && String(updates.AssignedTo ?? '') !== String(current.assignedTo ?? '')) {
      pending.push(recordAssignmentLog(
        [{ orderId: Number(id), fromAgent: current.assignedTo, toAgent: updatedOrder.AssignedTo, status: current.status }],
        { businessId, changedBy: actor.email ?? actor.label ?? null, changedById: actor.id ?? null, source: actor.source ?? 'inline' }
      ));
    }
  } catch (err) {
    console.error('PATCH Order Error (Step 2 – update failed):', err.message);
    console.error('  → SET clause fields:', fields);
    console.error('  → Full PG error:',     err);
    return { ok: false, status: 500, code: 'UPDATE_FAILED', error: 'خطأ في الخادم' };
  }

  /* ── Step 3: Inventory lifecycle (awaited) ─────────────────────────
     Stock is deducted the moment an order becomes COMMITTED (confirmed / shipped
     / delivered) and restocked when it leaves that group (cancelled / rejected /
     reverted / no-answer / postponed). The persisted `stock_deducted` flag is the
     idempotency guard, and the compare-and-set above guarantees only ONE writer
     applies a given transition — so stock moves exactly once per direction, no
     matter how many times (or by whom) the status flips.
     Deduction/restock are by the order's `quantity`, matched SKU-first.
     NOTE: physical returns from the Bosta webhook restock via applyPhysicalReturn,
     which also clears stock_deducted, so the two paths never double-count.     */
  if (statusChanging) {
    const isCommitted = COMMITTED_STATES.includes(normState(updates.Status));
    console.log(`[DEBUG Inventory] Raw incoming status: "${updates.Status}" | normalized: "${normState(updates.Status)}" | isCommitted: ${isCommitted} | stock_deducted: ${current.stockDeducted} | order ${id}`);

    if (isCommitted && !current.stockDeducted) {
      /* ── Deduct on confirmation (entering committed, not yet deducted) ── */
      if (!current.productName && !current.sku) {
        console.warn(`[Inventory] Order ${id} has no product — cannot deduct.`);
      } else {
        try {
          const prod = await resolveProductForOrder(businessId, current.sku, current.productName);
          if (!prod) {
            console.warn(`⚠️ Inventory deduct: no product matched — order ${id} left undeducted.`);
            console.log(`[DEBUG Inventory] Product MATCH FAILED (deduct) for order ${id} | sku="${current.sku}" | product_name="${current.productName}" — no products row whose sku/name/aliases match (business ${businessId}). Add an alias on the product.`);
          } else {
            const r = await pool.query(
              `UPDATE products SET stock_quantity = stock_quantity - $1
                WHERE id = $2 AND business_id = $3
                RETURNING name, sku, stock_quantity, cost_price`,
              [current.qty, prod.id, businessId]
            );
            await pool.query(
              'UPDATE orders SET "stock_deducted" = true WHERE id = $1 AND business_id = $2',
              [id, businessId]
            );
            console.log(`✅ Inventory: -${current.qty} → "${r.rows[0].name}" (SKU ${r.rows[0].sku}) now ${r.rows[0].stock_quantity} (order ${id} → ${updates.Status})`);

            /* WAC cost lock — freeze the product's current cost on the order so
               historical profitability stays accurate after future supply batches. */
            const lockedCost = parseFloat(r.rows[0].cost_price) || 0;
            if (lockedCost > 0) {
              pending.push(pool.query(
                'UPDATE orders SET "unit_cost_price" = $1 WHERE id = $2 AND business_id = $3',
                [lockedCost, id, businessId]
              ).catch((e) => console.error('[Inventory] unit_cost_price lock failed:', e.message)));
            }
          }
        } catch (err) {
          console.error(`[Inventory] Deduct error: ${err.message}`);
        }
      }

    } else if (!isCommitted && current.stockDeducted) {
      /* ── Restock on leaving committed (postpone / cancel / reject / revert) ── */
      try {
        const prod = await resolveProductForOrder(businessId, current.sku, current.productName);
        if (!prod) {
          console.warn(`⚠️ Inventory restock: no product matched — order ${id}.`);
          console.log(`[DEBUG Inventory] Product MATCH FAILED (restock) for order ${id} | sku="${current.sku}" | product_name="${current.productName}" — no products row whose sku/name/aliases match (business ${businessId}).`);
        } else {
          const r = await pool.query(
            `UPDATE products SET stock_quantity = stock_quantity + $1
              WHERE id = $2 AND business_id = $3
              RETURNING name, sku, stock_quantity`,
            [current.qty, prod.id, businessId]
          );
          console.log(`✅ Inventory: +${current.qty} → "${r.rows[0].name}" (SKU ${r.rows[0].sku}) now ${r.rows[0].stock_quantity} (order ${id} → ${updates.Status})`);
        }
        // Order no longer committed → clear the flag (even if no product matched,
        // so the lifecycle state stays consistent).
        await pool.query(
          'UPDATE orders SET "stock_deducted" = false WHERE id = $1 AND business_id = $2',
          [id, businessId]
        );
      } catch (err) {
        console.error(`[Inventory] Restock error: ${err.message}`);
      }

    } else {
      console.log(`[Inventory] No stock move for order ${id} (committed=${isCommitted}, alreadyDeducted=${current.stockDeducted}).`);
    }
  }

  /* ── Step 3.5a: Treasury — deposit hook (background) ────────────────────
     Fires whenever depositAmount is part of this update.
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

      pending.push(pool.query(
        `INSERT INTO treasury_transactions
           (order_id, amount, type, source, description, transaction_date, business_id)
         VALUES ($1, $2, 'revenue', 'deposit', $3, CURRENT_DATE, $4)
         ON CONFLICT (order_id) WHERE source = 'deposit'
         DO UPDATE SET
           amount      = EXCLUDED.amount,
           description = EXCLUDED.description`,
        [id, depositAmt.toFixed(2), depositDesc, businessId]
      ).catch((e) => console.error('[Treasury] Deposit hook failed:', e.message)));

    } else {
      /* Deposit cleared → remove treasury entry if it exists */
      pending.push(pool.query(
        `DELETE FROM treasury_transactions WHERE order_id = $1 AND source = 'deposit' AND business_id = $2`,
        [id, businessId]
      ).catch((e) => console.error('[Treasury] Deposit clear failed:', e.message)));
    }
  }

  /* ── Step 3.5b: Treasury — commission hook (background) ─────────────────
     Fires when Status changes to a commission-triggering state.
     Looks up the assigned agent's rate for the new status from the users
     table and logs the amount as an expense in treasury_transactions.

     Idempotency: each (order_id, source) pair has its own partial unique
     index, so the same commission can never be double-counted even if the
     frontend sends the same status update twice.

     Mapping:
       'تم التأكيد'  → source 'comm_confirmed'  (comm_confirmed column)
       'تم التوصيل' → source 'comm_delivered'   (comm_delivered column)
       'تم الرفض'   → source 'comm_rejected'    (comm_rejected column)       */
  if (statusChanging && effects.commission !== false) {
    const COMM_MAP = {
      'تم التأكيد':  { field: 'comm_confirmed', source: 'comm_confirmed', label: 'تأكيد'   },
      'تم التوصيل': { field: 'comm_delivered',  source: 'comm_delivered',  label: 'توصيل'   },
      'تم الرفض':   { field: 'comm_rejected',   source: 'comm_rejected',   label: 'رفض'     },
      /* NOTE: neither 'لا يرد' nor 'مؤجل' is here.
         • 'لا يرد' earns comm_no_answer ONLY after 5 logged call attempts —
           handled by POST /:id/no-answer-attempt, not on the status change.
         • 'مؤجل' grants NO automatic commission at all. */
    };

    const commInfo   = COMM_MAP[updates.Status];
    const assignedTo = updatedOrder.AssignedTo;

    if (commInfo && assignedTo) {
      pending.push(pool.query(
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
             (order_id, amount, type, source, description, transaction_date, business_id, agent_email)
           VALUES ($1, $2, 'expense', $3, $4, CURRENT_DATE, $5, $6)
           ON CONFLICT (order_id) WHERE source = '${commInfo.source}'
           DO NOTHING`,
          [id, rate.toFixed(2), commInfo.source, commDesc, businessId, assignedTo]
        );
      })
        /* Re-freeze the order's earned_commission from the ledger AFTER the insert. */
        .then(() => syncEarnedCommission(id, businessId))
        .catch((e) => console.error('[Treasury] Commission hook failed:', e.message)));
    }
  }

  /* ── Step 3.5c: Treasury — VOID stale commission/revenue on status change ───
     The hooks above only ADD commission/revenue on forward transitions; they
     never remove anything. So reverting an order (e.g. تم الشحن → جديد, or
     تم التوصيل → تم التأكيد, or → ملغي) used to leave phantom commissions and
     expected revenue in the treasury. Here we delete every status-driven txn
     that is NO LONGER valid for the order's new status.

     Funnel-aware validity (a milestone's commission survives only while the
     order is at/past that milestone):
       تم التأكيد / تم الشحن → comm_confirmed
       تم التوصيل            → comm_confirmed + comm_delivered + bosta_cod (COD revenue)
       تم الرفض              → comm_rejected
       لا يرد                → comm_no_answer (only if 5+ attempts already logged)
       مؤجل                  → NONE  (no automatic commission)
       جديد / ملغي / غيره    → NONE  (all status-driven txns voided)

     NOTE: source 'deposit' is intentionally NOT touched — it represents real
     collected cash and is managed solely by the depositAmount hook above.       */
  if (statusChanging) {
    const STATUS_DRIVEN_SOURCES = [
      'comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer', 'bosta_cod',
    ];
    const VALID_BY_STATUS = {
      'تم التأكيد':  ['comm_confirmed'],
      'تم الشحن':   ['comm_confirmed'],
      'تم التوصيل': ['comm_confirmed', 'comm_delivered', 'bosta_cod'],
      'تم الرفض':   ['comm_rejected'],
      'لا يرد':     ['comm_no_answer'],
      [noAnswer.TERMINAL]: ['comm_no_answer'],   // closed after the no-answer cycle → her 5-attempt commission stays
      [noAnswer.REVIEW_NEW]: ['comm_no_answer'], // handed to a review account → still inside the no-answer cycle
      'مؤجل':       [],   // postponed → NO automatic commission; void all (deposit kept)
      'معلق حتي الدفع': [],   // pending-until-payment → NO commission; void all (deposit kept)
    };
    const validSources = new Set(VALID_BY_STATUS[updates.Status] || []); // جديد/ملغي/… → none
    const toVoid = STATUS_DRIVEN_SOURCES.filter((s) => !validSources.has(s));

    if (toVoid.length > 0) {
      /* Excludes the source(s) the commission hook may be inserting concurrently,
         so the just-earned commission is never deleted — safe regardless of order.
         OWNERSHIP LOCK: only rows owned by the order's CURRENT holder (or unowned
         rows, which mean the same thing) are voided. A commission a PREVIOUS agent
         earned before the order was transferred — e.g. her 5-attempt عمولة عدم الرد
         — is her completed work and survives whatever the new holder does next. */
      pending.push(pool.query(
        `DELETE FROM treasury_transactions
          WHERE order_id = $1 AND business_id = $2 AND source = ANY($3::text[])
            AND (agent_email IS NULL
                 OR LOWER(TRIM(agent_email)) = LOWER(TRIM(COALESCE($4::text, ''))))`,
        [id, businessId, toVoid, updatedOrder.AssignedTo ?? null]
      ).then((r) => {
        if (r.rowCount > 0) {
          console.log(`[Treasury] 🧹 Voided ${r.rowCount} stale txn(s) for order ${id} → "${updates.Status}" (removed sources: ${toVoid.join(', ')})`);
        }
      })
        /* Re-freeze earned_commission AFTER the void so a reverted order drops the
           commission it no longer qualifies for. */
        .then(() => syncEarnedCommission(id, businessId))
        .catch((e) => console.error('[Treasury] Void-on-revert failed:', e.message)));
    }
  }

  return { ok: true, order: updatedOrder, settled: Promise.allSettled(pending).then(() => undefined) };
}

/* For writers without a route of their own (the WhatsApp bot): move an order
   `from` → `to` (plus extra columns, e.g. rejectionReason) under
   compare-and-set — if it isn't in `from` any more, nothing happens. */
async function changeStatus({ businessId, orderId, from, to, fields = {}, actor, effects }) {
  const current = await loadOrder(businessId, orderId);
  if (!current) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'الطلب غير موجود' };
  return applyUpdate({
    businessId, orderId, current, updates: { ...fields, Status: to }, expectedStatus: from, actor, effects,
  });
}

module.exports = {
  schemaReady, sameStatus, loadOrder, applyUpdate, changeStatus, conflictMessage,
  syncEarnedCommission, recordAssignmentLog, resolveProductForOrder,
};
