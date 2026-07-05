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

/* ── Order quantity ─────────────────────────────────────────────────────────
   Number of units in the order. Defaults to 1 for all legacy/imported rows.
   Used by the Bosta return webhook to restock the EXACT number of units, and
   available for accurate inventory/COGS math elsewhere.                       */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1`)
  .then(() => console.log('✅  Orders: "quantity" column ready'))
  .catch((err) => console.warn('⚠️   Orders quantity column check:', err.message));

/* ── Inventory-deduction flag ────────────────────────────────────────────────
   TRUE once this order's stock has been deducted from products (at confirmation).
   The single idempotency guard so stock can never be double-deducted or
   double-restocked across status changes.                                     */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "stock_deducted" BOOLEAN NOT NULL DEFAULT false`)
  .then(() => console.log('✅  Orders: "stock_deducted" column ready'))
  /* One-time catch-up: orders confirmed BEFORE this flag existed were already
     deducted by the previous logic but still carry stock_deducted=false, so a
     move to مؤجل/ملغي wouldn't restock. Flag every order currently IN a committed
     state as deducted so the lifecycle is consistent. Idempotent — after the
     first run there are no committed+unflagged rows left (the PATCH hook keeps
     the flag in sync going forward).                                           */
  .then(() => pool.query(`
    UPDATE orders SET "stock_deducted" = true
     WHERE "stock_deducted" = false
       AND TRIM("Status") IN ('تم التأكيد', 'تم التاكيد', 'تم الشحن', 'تم التوصيل')
  `))
  .then((r) => { if (r.rowCount) console.log(`✅  Orders: back-filled stock_deducted=true for ${r.rowCount} committed order(s)`); })
  .catch((err) => console.warn('⚠️   Orders stock_deducted column check:', err.message));

/* ── Postponed follow-up date ───────────────────────────────────────────────
   The date the customer asked to be re-contacted, captured when an agent moves
   an order to 'مؤجل'. Stored as DATE; the API returns it and the frontend
   normalises to YYYY-MM-DD for the date picker / badge.                       */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "PostponedDate" DATE`)
  .then(() => console.log('✅  Orders: "PostponedDate" column ready'))
  .catch((err) => console.warn('⚠️   Orders PostponedDate column check:', err.message));

/* ── Shipping notes ─────────────────────────────────────────────────────────
   Free-text note for the courier; mapped to Bosta's `notes` so it prints on the
   airway bill. Inline-editable in the orders table by admins and agents.      */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "ShippingNotes" TEXT`)
  .then(() => console.log('✅  Orders: "ShippingNotes" column ready'))
  .catch((err) => console.warn('⚠️   Orders ShippingNotes column check:', err.message));

/* ── No-answer call-attempt log ─────────────────────────────────────────────
   JSONB array of ISO timestamps — one per logged call attempt. The
   comm_no_answer commission is only earned once this reaches 5 attempts while
   the order is in 'لا يرد' (enforced in the attempt endpoint below).          */
pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS "no_answer_logs" JSONB NOT NULL DEFAULT '[]'::jsonb`)
  .then(() => console.log('✅  Orders: "no_answer_logs" column ready'))
  .catch((err) => console.warn('⚠️   Orders no_answer_logs column check:', err.message));

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
    /* LOST-ORDER ISOLATION: the live "تأكيد الطلبات" queue must NEVER show
       bulk-imported lost/historical orders. Default (no ?lost param) returns
       ONLY live orders (is_lost_order = false); the dedicated lost-orders page
       passes ?lost=true to fetch ONLY the isolated batch. */
    const lostOnly = String(req.query.lost).toLowerCase() === 'true';
    /* CUSTOMER FREQUENCY (local-only — zero Bosta calls): per-phone history
       aggregated over ALL of the tenant's orders (live + lost/historical) so
       the confirmation team sees the customer's real track record. Phones are
       compared digits-only — same normalisation as the bulk-import dedup — so
       "+20 10..." and "010..." count as one customer. Orders with no usable
       phone are NOT grouped together: they fall out of the LEFT JOIN and are
       treated as a first order (total 1 / all breakdown counts 0).
       Cancellations vs returns are SEPARATE on purpose: 'تم الرفض' happens on
       the confirmation call and costs nothing, while 'تم الإرجاع'/'جاري الإعادة'
       means a parcel actually shipped and came back — real shipping fees lost,
       the strongest red flag for the team.                                    */
    const result = await pool.query(
      `SELECT o.*,
              COALESCE(h.total_orders_count,     1) AS total_orders_count,
              COALESCE(h.delivered_orders_count, 0) AS delivered_orders_count,
              COALESCE(h.canceled_orders_count,  0) AS canceled_orders_count,
              COALESCE(h.returned_orders_count,  0) AS returned_orders_count
         FROM orders o
         LEFT JOIN (
           SELECT regexp_replace(COALESCE("Phone", ''), '\\D', '', 'g') AS phone_key,
                  COUNT(*)::int                                                        AS total_orders_count,
                  COUNT(*) FILTER (WHERE TRIM("Status") = 'تم التوصيل')::int            AS delivered_orders_count,
                  COUNT(*) FILTER (WHERE TRIM("Status") = 'تم الرفض')::int              AS canceled_orders_count,
                  COUNT(*) FILTER (WHERE TRIM("Status") IN ('تم الإرجاع', 'جاري الإعادة'))::int AS returned_orders_count
             FROM orders
            WHERE business_id = $1
            GROUP BY 1
         ) h ON h.phone_key <> ''
            AND h.phone_key = regexp_replace(COALESCE(o."Phone", ''), '\\D', '', 'g')
        WHERE o.business_id = $1 AND o.is_lost_order = $2
        ORDER BY o."createdAt" DESC`,
      [req.user.business_id, lostOnly]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/orders — manual order creation (admins + agents) ──────────────
   Creates an external order (WhatsApp / Facebook / phone) that behaves exactly
   like a store-imported one:
     • status initialised to 'جديد'
     • scoped to the creator's business_id
     • optional BostaTrackingCode stored so the existing Bosta webhooks/cron
       track it normally
     • fires the (throttled) Bosta consignee-ranking enrichment, like imports
   Assignment:
     • an AGENT who creates an order is assigned it directly (they brought the
       sale in)
     • an ADMIN's manual order is fairly auto-assigned to the least-loaded
       present agent
   Treasury/commission logic needs no special handling — it keys off status
   changes via PATCH, so manual orders integrate automatically.                */
router.post('/', authenticate, async (req, res) => {
  const { FullName, Phone, City, Address, ProductPrice, ProductName, sku, quantity } = req.body;

  if (!FullName || !String(FullName).trim() || !Phone || !String(Phone).trim()) {
    return res.status(400).json({ error: 'الاسم ورقم الهاتف مطلوبان' });
  }

  // Quantity: integer ≥ 1, defaults to 1 when omitted/invalid.
  const qty = Math.max(1, parseInt(quantity, 10) || 1);

  try {
    const result = await pool.query(
      `INSERT INTO orders
         ("FullName", "Phone", "City", "Address", "ProductName", "ProductPrice", "sku",
          "quantity", "DeliveryRate", "Status", order_source, business_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'بدون', 'جديد', 'manual', $9)
       RETURNING *`,
      [
        String(FullName).trim(),
        String(Phone).trim(),
        City ? String(City).trim() : null,
        Address ? String(Address).trim() : null,
        ProductName ? String(ProductName).trim() : null,
        ProductPrice != null && String(ProductPrice).trim() !== '' ? String(ProductPrice).trim() : null,
        sku ? String(sku).trim() : null,
        qty,
        req.user.business_id,
      ]
    );

    let order = result.rows[0];

    /* ── Assignment ─────────────────────────────────────────────────────────
       • AGENT creator → assign directly to them (they brought in the sale).
       • ADMIN creator → fairly auto-assign to the least-loaded present agent:
         the active, present agent with the FEWEST pending ('جديد') orders.
         This mirrors the auto-distribute philosophy for a single order WITHOUT
         reshuffling anyone else's existing assignments.
       Done BEFORE the response so the returned order already carries AssignedTo
       (frontend reflects it instantly).                                        */
    try {
      let assignee = null;

      if (req.user.role === 'agent') {
        assignee = req.user.email;
      } else {
        const { rows: agentRows } = await pool.query(
          `SELECT u.email,
                  COUNT(o.id) FILTER (WHERE o."Status" = 'جديد') AS load
             FROM users u
             LEFT JOIN orders o
               ON o."AssignedTo" = u.email AND o.business_id = u.business_id
            WHERE u.role = 'agent'
              AND COALESCE(u.is_active,  true)  = true
              AND COALESCE(u.is_absent, false)  = false
              AND u.business_id = $1
            GROUP BY u.email
            ORDER BY load ASC, u.email ASC
            LIMIT 1`,
          [req.user.business_id]
        );
        if (agentRows.length) assignee = agentRows[0].email;
      }

      if (assignee) {
        const upd = await pool.query(
          `UPDATE orders SET "AssignedTo" = $1, "updatedAt" = NOW()
            WHERE id = $2 AND business_id = $3 RETURNING *`,
          [assignee, order.id, req.user.business_id]
        );
        if (upd.rows.length) order = upd.rows[0];
        const how = req.user.role === 'agent' ? 'self (creator)' : 'least-loaded';
        console.log(`[Manual Order] 🤝 #${order.id} assigned to ${order.AssignedTo} (${how})`);
      } else {
        console.log(`[Manual Order] ℹ️  #${order.id} left unassigned — no present agents`);
      }
    } catch (assignErr) {
      console.warn('[Manual Order] assignment skipped:', assignErr.message);
    }

    console.log(`[Manual Order] ✅ #${order.id} created for tenant ${req.user.business_id}`);

    // DeliveryRate (حالة الاستلام) is filled later by the polite, rate-limit-safe
    // enrichment cron (cron/deliveryRateBackfill.js) — never fetched on-demand here,
    // which used to burst past Bosta's limit and get the account blocked.
    res.status(201).json(order);
  } catch (err) {
    console.error('[POST /orders] create error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/orders/bulk — CSV bulk import (admins + agents) ───────────────
   Imports an array of parsed order rows (e.g. abandoned carts from EasyOrders).
   PHONE DEDUPLICATION: any row whose phone already exists in the tenant's orders
   (digits-only comparison) is skipped — and duplicates WITHIN the file are also
   collapsed. New rows are bulk-inserted as 'جديد' (unassigned — distribute later).

   Body: { orders: [ { name|FullName, phone|Phone, address|Address, city|City,
                       product_name|ProductName, price|ProductPrice, notes|Note } ] }
   (a bare array is also accepted.)
   Response: { success, importedCount, skippedCount, duplicateCount, invalidCount } */
router.post('/bulk', authenticate, async (req, res) => {
  const businessId = req.user.business_id;
  const rawList = Array.isArray(req.body) ? req.body
    : Array.isArray(req.body?.orders) ? req.body.orders
    : null;

  /* Lost-order batch flag (from the upload modal's radio). When true, every
     inserted row is tagged is_lost_order = true so it's isolated from the live
     confirmation queue and only appears on the dedicated "الطلبات المفقودة" page.
     A bare-array body (legacy callers) has no flag → defaults to live (false). */
  const isLost = req.body?.is_lost_order === true || String(req.body?.is_lost_order).toLowerCase() === 'true';

  if (!rawList || rawList.length === 0) {
    return res.status(400).json({ error: 'لا توجد طلبات للاستيراد' });
  }

  const normPhone = (v) => String(v ?? '').replace(/\D/g, '');
  // Product normaliser — MUST mirror the SQL form below so JS and DB composite
  // keys match: lowercase, fold Arabic variants (أإآ→ا, ة→ه), strip ALL
  // punctuation/symbols (brackets, parens, dashes, quotes, *, _ …) and ALL
  // whitespace. Makes "[جهاز ليزر IPL]" === "جهاز ليزر IPL" and
  // "طقم دريل 47 قطعة" === "طقم دريل 47 قطعه ".
  const normProd  = (v) => String(v ?? '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, '');
  const pick = (o, ...keys) => {
    for (const k of keys) {
      if (o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== '') return String(o[k]).trim();
    }
    return '';
  };

  try {
    /* 1. Normalise rows. PHONE is the ONLY strictly-required field — messy
       imports (EasyOrders/Shopify abandoned carts) routinely omit name, city,
       address, price, etc. A row is "invalid" ONLY if it has no usable phone.
       All other fields fall back to NULL (columns are nullable); a missing name
       defaults to 'عميل جديد' so the order is still actionable. */
    let invalidCount = 0;
    const candidates = [];
    for (const o of rawList) {
      if (!o || typeof o !== 'object') { invalidCount++; continue; }
      const PhoneRaw = pick(o, 'Phone', 'phone', 'phone_number', 'mobile');
      const phoneKey = normPhone(PhoneRaw);
      if (!phoneKey) { invalidCount++; continue; }   // no phone → cannot dedup/contact
      const FullName = pick(o, 'FullName', 'name', 'full_name', 'customer_name') || 'عميل جديد';
      const ProductName = pick(o, 'ProductName', 'product_name', 'product', 'products') || null;
      candidates.push({
        FullName,
        Phone:        PhoneRaw,
        phoneKey,
        prodKey:      normProd(ProductName),
        City:         pick(o, 'City', 'city', 'government', 'governorate') || null,
        Address:      pick(o, 'Address', 'address', 'shipping_address') || null,
        ProductName,
        ProductPrice: pick(o, 'ProductPrice', 'price', 'total', 'amount') || null,
        Note:         pick(o, 'Note', 'notes', 'note', 'comment') || null,
      });
    }

    /* 2. Collapse duplicates WITHIN the file using the COMPOSITE key
       (phone + normalised product). A returning customer ordering a DIFFERENT
       product in the same file is NOT a duplicate. */
    const composite = (c) => `${c.phoneKey}|${c.prodKey}`;
    const batchSeen = new Set();
    const deduped = [];
    let duplicateCount = 0;
    for (const c of candidates) {
      const key = composite(c);
      if (batchSeen.has(key)) { duplicateCount++; continue; }
      batchSeen.add(key);
      deduped.push(c);
    }

    /* 3. One query → recent (phone + product) pairs that ALREADY exist in THIS
       tenant within the last 3 days. STRICT tenant isolation: scoped by
       business_id (this system's tenant id) so Merchant A's customers can never
       block Merchant B's orders. The product is normalised identically to the JS
       side (lowercase + fold أإآ→ا/ة→ه + strip ALL punctuation + ALL whitespace)
       so the composite keys line up despite Arabic spelling/spacing/bracket drift. */
    const phoneKeys = [...new Set(deduped.map((c) => c.phoneKey))];
    let recentPairs = new Set();
    if (phoneKeys.length) {
      const { rows } = await pool.query(
        `SELECT DISTINCT
                regexp_replace("Phone", '[^0-9]', '', 'g') AS p,
                LOWER(regexp_replace(regexp_replace(translate(COALESCE("ProductName", ''), 'أإآة', 'اااه'), '[[:punct:]]', '', 'g'), '\\s+', '', 'g')) AS prod
           FROM orders
          WHERE business_id = $1
            AND "createdAt" >= NOW() - INTERVAL '3 days'
            AND regexp_replace("Phone", '[^0-9]', '', 'g') = ANY($2::text[])`,
        [businessId, phoneKeys]
      );
      recentPairs = new Set(rows.map((r) => `${r.p}|${r.prod}`));
    }

    /* 4. A row is a duplicate ONLY IF the SAME phone+product was ordered in this
       tenant WITHIN THE LAST 3 DAYS. Same phone + different product → new order;
       same phone+product but older than 3 days → new order (returning customer). */
    const toInsert = deduped.filter((c) => !recentPairs.has(composite(c)));
    duplicateCount += deduped.length - toInsert.length;   // recent same-product skips

    /* 4b. Link to the canonical product catalog. Excel names arrive messy
       (brackets, spacing, Arabic drift) and carry no reliable price, which would
       spawn junk product variations and break inventory linking. We pre-fetch the
       tenant's products and build a normProd()-keyed map (over each product NAME
       and every alias), then for each survivor OVERRIDE the raw name with the
       clean catalogue name and the price with the product's selling_price.
       (Only selling_price is read — cost_price/COGS is never touched here.) */
    if (toInsert.length) {
      try {
        const { rows: products } = await pool.query(
          `SELECT name, selling_price, aliases FROM products WHERE business_id = $1`,
          [businessId]
        );
        const prodMap = new Map();   // normalised name/alias → { name, price }
        for (const p of products) {
          const price = p.selling_price != null ? parseFloat(p.selling_price) : null;
          const entry = { name: p.name, price };
          const nameKey = normProd(p.name);
          if (nameKey && !prodMap.has(nameKey)) prodMap.set(nameKey, entry);
          for (const a of (p.aliases || [])) {
            const aliasKey = normProd(a);
            if (aliasKey && !prodMap.has(aliasKey)) prodMap.set(aliasKey, entry);
          }
        }
        for (const c of toInsert) {
          const match = c.prodKey ? prodMap.get(c.prodKey) : null;
          if (match) {
            c.ProductName = match.name;                       // clean catalogue name
            if (match.price != null) c.ProductPrice = match.price;  // real selling price
          }
        }
      } catch (catalogErr) {
        // Non-fatal: fall back to the raw Excel name/price rather than lose the import.
        console.warn('[Bulk Import] catalogue link skipped:', catalogErr.message);
      }
    }

    /* 5. Bulk insert the new rows in a single statement. */
    let imported = [];
    if (toInsert.length) {
      const valuesSql = [];
      const params = [];
      let i = 1;
      for (const c of toInsert) {
        valuesSql.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, 'بدون', 'جديد', 'csv', $${i++}, 1, ${isLost ? 'TRUE' : 'FALSE'})`);
        params.push(c.FullName, c.Phone, c.City, c.Address, c.ProductName, c.ProductPrice, c.Note, businessId);
      }
      const { rows } = await pool.query(
        `INSERT INTO orders
           ("FullName", "Phone", "City", "Address", "ProductName", "ProductPrice", "Note",
            "DeliveryRate", "Status", order_source, business_id, quantity, is_lost_order)
         VALUES ${valuesSql.join(', ')}
         RETURNING id, "Phone"`,
        params
      );
      imported = rows;
    }

    /* 6. Auto-assign the freshly-imported orders to employees — same philosophy
       as single-order create (POST /api/orders) and /auto-distribute: present,
       active agents only. We fetch them ordered by current 'جديد' load ASC, then
       round-robin the new batch across them (starting from the lightest agent),
       so the import is spread evenly and fairly. Non-fatal: orders are already
       inserted, so an assignment hiccup must never fail the import.            */
    if (imported.length && !isLost) {
      try {
        const { rows: agents } = await pool.query(
          `SELECT u.email,
                  COUNT(o.id) FILTER (WHERE o."Status" = 'جديد') AS load
             FROM users u
             LEFT JOIN orders o
               ON o."AssignedTo" = u.email AND o.business_id = u.business_id
            WHERE u.role = 'agent'
              AND COALESCE(u.is_active,  true)  = true
              AND COALESCE(u.is_absent, false)  = false
              AND u.business_id = $1
            GROUP BY u.email
            ORDER BY load ASC, u.email ASC`,
          [businessId]
        );

        if (agents.length) {
          const ids    = [];
          const emails = [];
          imported.forEach((o, idx) => {
            ids.push(o.id);
            emails.push(agents[idx % agents.length].email);   // round-robin
          });
          await pool.query(
            `UPDATE orders AS o
                SET "AssignedTo" = m.email, "updatedAt" = NOW()
               FROM unnest($1::int[], $2::text[]) AS m(id, email)
              WHERE o.id = m.id AND o.business_id = $3`,
            [ids, emails, businessId]
          );
          console.log(`[Bulk Import] 🤝 distributed ${ids.length} order(s) round-robin across ${agents.length} agent(s)`);
        } else {
          console.log('[Bulk Import] ℹ️  imported orders left unassigned — no present agents');
        }
      } catch (assignErr) {
        console.warn('[Bulk Import] auto-assignment skipped:', assignErr.message);
      }
    }

    const importedCount = imported.length;
    const skippedCount  = rawList.length - importedCount;

    console.log(`[Bulk Import] tenant ${businessId}: imported ${importedCount}, skipped ${skippedCount} (dup ${duplicateCount}, invalid ${invalidCount})`);

    res.json({ success: true, importedCount, skippedCount, duplicateCount, invalidCount });

    // حالة الاستلام is filled later by the polite enrichment cron — no on-demand
    // Bosta calls here (they used to burst the rate limit on bulk imports).
  } catch (err) {
    console.error('[POST /orders/bulk] error:', err.message);
    res.status(500).json({ error: 'فشل استيراد الطلبات' });
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
  /* LOST-ORDER ISOLATION: live distribution must NEVER pull lost orders, and the
     dedicated lost page's "توزيع الطلبات المفقودة" button must touch ONLY lost orders.
     Same endpoint, scoped by the queue: lost=true → is_lost_order TRUE, else FALSE. */
  const lostOnly = req.body?.lost === true || String(req.body?.lost).toLowerCase() === 'true';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* 1. ALL 'جديد' orders in THIS queue (live or lost) — regardless of AssignedTo */
    const unassignedResult = await client.query(
      `SELECT id FROM orders
        WHERE "Status" = 'جديد' AND business_id = $1 AND is_lost_order = $2
        ORDER BY id ASC`,
      [businessId, lostOnly]
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

    /* 1. All pending LIVE 'جديد' orders for this tenant, stable order. Lost orders
       are excluded here — they're distributed only from the dedicated lost page via
       /auto-distribute { lost: true }, never through the live distribution modal. */
    const ordRes = await client.query(
      `SELECT id FROM orders
        WHERE "Status" = 'جديد' AND business_id = $1 AND is_lost_order = FALSE
        ORDER BY id ASC`,
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
            AND COALESCE(is_active, true) = true
            AND COALESCE(is_absent, false) = false      -- skip ABSENT agents even if given a %
            AND business_id = $2`,
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

/* NOTE: a second, shadowed `POST /api/orders/bulk` once lived here. Express matches
   the FIRST registered route, so the richer handler above (composite phone+product
   dedup, 3-day window, catalogue linking, is_lost_order tagging) always won and this
   one was dead code. Removed to avoid confusion. */

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
  'ProductName', 'ProductPrice', 'quantity', 'DeliveryRate', 'sku',
  // ── Workflow ──────────────────────────────────────────────────────
  'Status', 'Note', 'ShippingNotes', 'PostponedDate', 'rejectionReason', 'AssignedTo',
  // ── Shipping ──────────────────────────────────────────────────────
  'BostaTrackingCode',
  // ── Finance ───────────────────────────────────────────────────────
  'hasDeposit', 'depositAmount', 'unit_cost_price',
]);

// PATCH /api/orders/:id — agents restricted to Status + Note only
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

/* Accept either `Status` or lowercase `status` from the client (defensive —
   canonicalise to `Status` before the agent-field guard + whitelist run). */
function canonicalizeStatusKey(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    if (req.body.status !== undefined && req.body.Status === undefined) {
      req.body.Status = req.body.status;
      delete req.body.status;
    }
  }
  next();
}

router.patch('/:id', authenticate, canonicalizeStatusKey, filterAgentFields, async (req, res) => {
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

  /* Empty date string → NULL (the "PostponedDate" DATE column rejects '').
     Lets an agent clear a follow-up date without a 500. */
  if (updates.PostponedDate === '') updates.PostponedDate = null;

  /* ── Step 1: Fetch the current order from the DB ────────────────────
     The frontend only sends the fields being changed (e.g. {Status: '…'}).
     ProductName, sku, and the previous Status are NOT in req.body — they
     must come from the database.
     ─────────────────────────────────────────────────────────────────── */
  let currentProductName  = '';
  let currentStatus       = '';
  let currentSku          = null;   // null means no SKU → fall back to name match
  let currentProductPrice = '';
  let currentQty          = 1;
  let currentStockDeducted = false;

  try {
    const row = await pool.query(
      `SELECT "Status", "ProductName", "sku", "ProductPrice",
              COALESCE("quantity", 1) AS quantity,
              COALESCE("stock_deducted", false) AS stock_deducted
         FROM orders WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );
    if (!row.rows.length) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    currentProductName  = (row.rows[0].ProductName || '').trim();
    currentStatus       = row.rows[0].Status || '';
    // Treat empty string as null so the SQL $1 IS NOT NULL guard works correctly
    currentSku          = row.rows[0].sku || null;
    currentProductPrice = row.rows[0].ProductPrice ?? '';
    currentQty          = Math.max(1, parseInt(row.rows[0].quantity, 10) || 1);
    currentStockDeducted = row.rows[0].stock_deducted === true;
  } catch (err) {
    console.error('Step 1 – fetch order failed:', err.message);
    return res.status(500).json({ error: 'خطأ في الخادم' });
  }

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
        [businessId, currentSku, currentProductName]
      );
      if (prod.rows.length) unitPrice = parseFloat(prod.rows[0].selling_price) || null;
    } catch (e) {
      console.warn('[PATCH] product unit-price lookup failed:', e.message);
    }

    // Fallback: derive the unit price from the order's existing total.
    if (unitPrice == null || unitPrice <= 0) {
      const oldTotal = parsePrice(currentProductPrice);
      if (oldTotal > 0) unitPrice = oldTotal / currentQty;
    }

    if (unitPrice != null && unitPrice > 0) {
      const newTotal = Math.round(unitPrice * newQty * 100) / 100;
      updates.ProductPrice = String(newTotal);
      console.log(`[PATCH] qty ${currentQty}→${newQty} on order ${id}: unit=${unitPrice} → ProductPrice=${newTotal}`);
    }
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
     Stock is deducted the moment an order becomes COMMITTED (confirmed / shipped
     / delivered) and restocked when it leaves that group (cancelled / rejected /
     reverted / no-answer / postponed). The persisted `stock_deducted` flag is the
     SINGLE idempotency guard: stock moves exactly once per direction, no matter
     how many times the status flips (e.g. confirm → revert → confirm again).
     Deduction/restock are by the order's `quantity`, matched SKU-first.
     NOTE: physical returns from the Bosta webhook restock via applyPhysicalReturn,
     which also clears stock_deducted, so the two paths never double-count.     */
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

  if (updates.Status && updates.Status !== currentStatus) {
    const isCommitted = COMMITTED_STATES.includes(normState(updates.Status));
    console.log(`[DEBUG Inventory] Raw incoming status: "${updates.Status}" | normalized: "${normState(updates.Status)}" | isCommitted: ${isCommitted} | stock_deducted: ${currentStockDeducted} | order ${id}`);

    if (isCommitted && !currentStockDeducted) {
      /* ── Deduct on confirmation (entering committed, not yet deducted) ── */
      if (!currentProductName && !currentSku) {
        console.warn(`[Inventory] Order ${id} has no product — cannot deduct.`);
      } else {
        try {
          const prod = await resolveProductForOrder(businessId, currentSku, currentProductName);
          if (!prod) {
            console.warn(`⚠️ Inventory deduct: no product matched — order ${id} left undeducted.`);
            console.log(`[DEBUG Inventory] Product MATCH FAILED (deduct) for order ${id} | sku="${currentSku}" | product_name="${currentProductName}" — no products row whose sku/name/aliases match (business ${businessId}). Add an alias on the product.`);
          } else {
            const r = await pool.query(
              `UPDATE products SET stock_quantity = stock_quantity - $1
                WHERE id = $2 AND business_id = $3
                RETURNING name, sku, stock_quantity, cost_price`,
              [currentQty, prod.id, businessId]
            );
            await pool.query(
              'UPDATE orders SET "stock_deducted" = true WHERE id = $1 AND business_id = $2',
              [id, businessId]
            );
            console.log(`✅ Inventory: -${currentQty} → "${r.rows[0].name}" (SKU ${r.rows[0].sku}) now ${r.rows[0].stock_quantity} (order ${id} → ${updates.Status})`);

            /* WAC cost lock — freeze the product's current cost on the order so
               historical profitability stays accurate after future supply batches. */
            const lockedCost = parseFloat(r.rows[0].cost_price) || 0;
            if (lockedCost > 0) {
              pool.query(
                'UPDATE orders SET "unit_cost_price" = $1 WHERE id = $2 AND business_id = $3',
                [lockedCost, id, businessId]
              ).catch((e) => console.error('[Inventory] unit_cost_price lock failed:', e.message));
            }
          }
        } catch (err) {
          console.error(`[Inventory] Deduct error: ${err.message}`);
        }
      }

    } else if (!isCommitted && currentStockDeducted) {
      /* ── Restock on leaving committed (postpone / cancel / reject / revert) ── */
      try {
        const prod = await resolveProductForOrder(businessId, currentSku, currentProductName);
        if (!prod) {
          console.warn(`⚠️ Inventory restock: no product matched — order ${id}.`);
          console.log(`[DEBUG Inventory] Product MATCH FAILED (restock) for order ${id} | sku="${currentSku}" | product_name="${currentProductName}" — no products row whose sku/name/aliases match (business ${businessId}).`);
        } else {
          const r = await pool.query(
            `UPDATE products SET stock_quantity = stock_quantity + $1
              WHERE id = $2 AND business_id = $3
              RETURNING name, sku, stock_quantity`,
            [currentQty, prod.id, businessId]
          );
          console.log(`✅ Inventory: +${currentQty} → "${r.rows[0].name}" (SKU ${r.rows[0].sku}) now ${r.rows[0].stock_quantity} (order ${id} → ${updates.Status})`);
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
      console.log(`[Inventory] No stock move for order ${id} (committed=${isCommitted}, alreadyDeducted=${currentStockDeducted}).`);
    }
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
       'لا يرد'     → source 'comm_no_answer'   (comm_no_answer column)   */
  if (updates.Status && updates.Status !== currentStatus) {
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
  if (updates.Status && updates.Status !== currentStatus) {
    const STATUS_DRIVEN_SOURCES = [
      'comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer', 'bosta_cod',
    ];
    const VALID_BY_STATUS = {
      'تم التأكيد':  ['comm_confirmed'],
      'تم الشحن':   ['comm_confirmed'],
      'تم التوصيل': ['comm_confirmed', 'comm_delivered', 'bosta_cod'],
      'تم الرفض':   ['comm_rejected'],
      'لا يرد':     ['comm_no_answer'],
      'مؤجل':       [],   // postponed → NO automatic commission; void all (deposit kept)
      'معلق حتي الدفع': [],   // pending-until-payment → NO commission; void all (deposit kept)
    };
    const validSources = new Set(VALID_BY_STATUS[updates.Status] || []); // جديد/ملغي/… → none
    const toVoid = STATUS_DRIVEN_SOURCES.filter((s) => !validSources.has(s));

    if (toVoid.length > 0) {
      /* Excludes the source(s) the commission hook may be inserting concurrently,
         so the just-earned commission is never deleted — safe regardless of order. */
      pool.query(
        `DELETE FROM treasury_transactions
          WHERE order_id = $1 AND business_id = $2 AND source = ANY($3::text[])`,
        [id, businessId, toVoid]
      ).then((r) => {
        if (r.rowCount > 0) {
          console.log(`[Treasury] 🧹 Voided ${r.rowCount} stale txn(s) for order ${id} → "${updates.Status}" (removed sources: ${toVoid.join(', ')})`);
        }
      }).catch((e) => console.error('[Treasury] Void-on-revert failed:', e.message));
    }
  }

  /* ── Send 200 OK after all inventory + treasury work is dispatched ── */
  res.json(updatedOrder);
});

/* ── POST /api/orders/:id/no-answer-attempt ─────────────────────────────────
   Logs ONE call-attempt timestamp into orders.no_answer_logs (JSONB array).
   The comm_no_answer commission is awarded ONLY when the attempt count reaches
   NO_ANSWER_REQUIRED_ATTEMPTS (5) AND the order is currently in 'لا يرد'.
   Agents are allowed (this is their action). Strictly tenant-scoped.          */
const NO_ANSWER_REQUIRED_ATTEMPTS = 5;

router.post('/:id/no-answer-attempt', authenticate, async (req, res) => {
  const { id }     = req.params;
  const businessId = req.user.business_id;

  try {
    /* Append the current timestamp to the JSONB array atomically. */
    const upd = await pool.query(
      `UPDATE orders
          SET "no_answer_logs" = COALESCE("no_answer_logs", '[]'::jsonb) || to_jsonb(NOW())
        WHERE id = $1 AND business_id = $2
        RETURNING "no_answer_logs", "Status", "AssignedTo", "ProductName"`,
      [id, businessId]
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    const order = upd.rows[0];
    const logs  = Array.isArray(order.no_answer_logs) ? order.no_answer_logs : [];
    const count = logs.length;
    let commissionAwarded = false;

    /* Award the no-answer commission once the threshold is reached, but only
       while the order is actually in 'لا يرد'. Idempotent via the partial
       unique index (treasury_comm_na_uidx). */
    if (count >= NO_ANSWER_REQUIRED_ATTEMPTS && order.Status === 'لا يرد' && order.AssignedTo) {
      const uRes = await pool.query(
        `SELECT comm_no_answer AS rate FROM users
          WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) AND business_id = $2`,
        [order.AssignedTo, businessId]
      );
      const rate = parseFloat(uRes.rows[0]?.rate) || 0;
      if (rate > 0) {
        const desc =
          `عمولة لا يرد (${count} محاولات) — ${order.AssignedTo.split('@')[0]} — طلب #${id}` +
          (order.ProductName ? ` | ${order.ProductName}` : '');
        const ins = await pool.query(
          `INSERT INTO treasury_transactions
             (order_id, amount, type, source, description, transaction_date, business_id)
           VALUES ($1, $2, 'expense', 'comm_no_answer', $3, CURRENT_DATE, $4)
           ON CONFLICT (order_id) WHERE source = 'comm_no_answer'
           DO NOTHING
           RETURNING id`,
          [id, rate.toFixed(2), desc, businessId]
        );
        commissionAwarded = ins.rows.length > 0;
        if (commissionAwarded) {
          console.log(`[NoAnswer] 💰 order ${id} reached ${count} attempts → comm_no_answer ${rate} EGP awarded to ${order.AssignedTo}`);
        }
      }
    }

    res.json({
      no_answer_logs:    logs,
      count,
      required:          NO_ANSWER_REQUIRED_ATTEMPTS,
      commissionAwarded,
    });
  } catch (err) {
    console.error('[no-answer-attempt]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
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
