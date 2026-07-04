/* ════════════════════════════════════════════════════════════════════════════
   After-Sales Service  (خدمة ما بعد البيع)
   ════════════════════════════════════════════════════════════════════════════

   Tracks customer issues AFTER delivery. Two teams touch each row:
     • Confirmation team  → opens the issue (issue_description = the complaint)
     • After-Sales team   → works it and records the resolution
       (after_sales_notes) + moves the status through the fixed Arabic set.

   Open to every authenticated employee of the tenant (shared pool, like the
   return-collections queue). Hard DELETE is admin-only; agents close issues by
   setting a terminal status instead.
   ════════════════════════════════════════════════════════════════════════════ */

const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

/* The ONLY statuses an issue may hold — mirrored by the frontend dropdown.
   'جاري العمل' is the opening state for every new issue. */
const ALLOWED_STATUSES = [
  'جاري العمل',
  'تم حل المشكلة',
  'استبدال',
  'استرجاع',
  'العميل لم يرد',
  'المشكلة من العميل',
];
const DEFAULT_STATUS = 'جاري العمل';

/* ── Idempotent schema bootstrap (runs once at module load) ─────────────────
   Same pattern as returnCollections.js / treasury.js — IF NOT EXISTS only.
   product_id is a soft link to products(id) (UUID, no FK so deleting a product
   never breaks history); product_name is a snapshot for display/filter even if
   the product is later renamed or removed. */
pool.query(`
  CREATE TABLE IF NOT EXISTS after_sales_issues (
    id                SERIAL       PRIMARY KEY,
    business_id       INTEGER,
    customer_name     TEXT         NOT NULL,
    customer_phone    VARCHAR(50)  NOT NULL,
    product_id        UUID,
    product_name      TEXT,
    issue_description TEXT,
    status            VARCHAR(50)  NOT NULL DEFAULT '${DEFAULT_STATUS}',
    after_sales_notes TEXT,
    created_by        VARCHAR(255),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )
`)
  .then(() => pool.query(`
    CREATE INDEX IF NOT EXISTS after_sales_issues_status_idx
      ON after_sales_issues (business_id, status)
  `))
  .then(() => pool.query(`
    CREATE INDEX IF NOT EXISTS after_sales_issues_product_idx
      ON after_sales_issues (business_id, product_id)
  `))
  .then(() => console.log('✅  after_sales_issues table ready'))
  .catch((err) => console.warn('⚠️   after_sales_issues schema check:', err.message));

/* Display name for the creator — same convention as returnCollections.js. */
const CREATOR_NAME_SQL = `COALESCE(NULLIF(TRIM(u.name), ''), SPLIT_PART(u.email, '@', 1))`;

/* Resolve the snapshot product_name for a given product_id within the tenant.
   Returns null when the id is missing/unknown (caller falls back to the raw
   product_name string from the request body). */
async function resolveProductName(productId, businessId) {
  if (!productId) return null;
  const { rows } = await pool.query(
    `SELECT name FROM products WHERE id = $1 AND business_id = $2`,
    [productId, businessId]
  );
  return rows.length ? rows[0].name : null;
}

/* ════════════════════════════════════════════════════════════════════════════
   GET /api/after-sales?product_id=<uuid>&status=<arabic status>
   Shared pool: every employee sees all of the tenant's issues.
   ════════════════════════════════════════════════════════════════════════════ */
router.get('/', authenticate, async (req, res) => {
  const businessId = req.user.business_id;
  const { product_id, status } = req.query;

  const params = [businessId];
  let where = 'a.business_id = $1';
  if (product_id) {
    params.push(String(product_id));
    where += ` AND a.product_id = $${params.length}`;
  }
  if (status && ALLOWED_STATUSES.includes(String(status))) {
    params.push(String(status));
    where += ` AND a.status = $${params.length}`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT a.*,
              ${CREATOR_NAME_SQL} AS created_by_name,
              u.email             AS created_by_email
       FROM   after_sales_issues a
       LEFT   JOIN users u ON u.id = a.created_by
       WHERE  ${where}
       ORDER  BY a.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[after-sales GET]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/after-sales
   { customer_name, customer_phone, product_id?, product_name?, issue_description }
   Opens a new issue in the default 'جاري العمل' state, stamped with the creator.
   ════════════════════════════════════════════════════════════════════════════ */
router.post('/', authenticate, async (req, res) => {
  const businessId = req.user.business_id;
  const customerName  = String(req.body.customer_name ?? '').trim();
  const customerPhone = String(req.body.customer_phone ?? '').trim();
  const issueDesc     = String(req.body.issue_description ?? '').trim();
  const productId     = req.body.product_id ? String(req.body.product_id) : null;

  if (!customerName)  return res.status(400).json({ error: 'اسم العميل مطلوب' });
  if (!customerPhone) return res.status(400).json({ error: 'رقم هاتف العميل مطلوب' });
  if (!issueDesc)     return res.status(400).json({ error: 'وصف المشكلة مطلوب' });

  try {
    /* Prefer the canonical product name from the products table; fall back to
       whatever free-text name the client sent (unlinked / legacy product). */
    const resolvedName = await resolveProductName(productId, businessId);
    const productName  = resolvedName
      ?? (req.body.product_name ? String(req.body.product_name).trim() : null);

    const { rows } = await pool.query(
      `INSERT INTO after_sales_issues
         (business_id, customer_name, customer_phone, product_id, product_name,
          issue_description, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [businessId, customerName, customerPhone, productId, productName,
       issueDesc, DEFAULT_STATUS, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[after-sales POST]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   PATCH /api/after-sales/:id
   Allowlisted partial update: status (validated against the fixed set),
   after_sales_notes, issue_description, customer_name, customer_phone,
   product_id (re-resolves the snapshot name).
   ════════════════════════════════════════════════════════════════════════════ */
router.patch('/:id', authenticate, async (req, res) => {
  const businessId = req.user.business_id;
  const { id }     = req.params;
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

  if (has('status') && !ALLOWED_STATUSES.includes(String(req.body.status))) {
    return res.status(400).json({ error: 'حالة غير صالحة' });
  }

  const sets   = [];
  const params = [];
  const push = (sql, val) => { params.push(val); sets.push(`${sql} = $${params.length}`); };

  if (has('status'))            push('status',            String(req.body.status));
  if (has('after_sales_notes')) push('after_sales_notes', req.body.after_sales_notes == null ? '' : String(req.body.after_sales_notes));
  if (has('issue_description')) push('issue_description', req.body.issue_description == null ? '' : String(req.body.issue_description));
  if (has('customer_name'))     push('customer_name',     String(req.body.customer_name ?? '').trim());
  if (has('customer_phone'))    push('customer_phone',    String(req.body.customer_phone ?? '').trim());
  if (has('product_id')) {
    const productId = req.body.product_id ? String(req.body.product_id) : null;
    push('product_id', productId);
    const resolvedName = await resolveProductName(productId, businessId).catch(() => null);
    push('product_name', resolvedName
      ?? (req.body.product_name ? String(req.body.product_name).trim() : null));
  }

  if (!sets.length) return res.status(400).json({ error: 'لا توجد حقول للتحديث' });
  sets.push('updated_at = NOW()');

  params.push(id, businessId);
  try {
    const { rows } = await pool.query(
      `UPDATE after_sales_issues SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND business_id = $${params.length}
       RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'السجل غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[after-sales PATCH]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   DELETE /api/after-sales/:id  — admin-only (same convention as the rest of
   the system: agents resolve/close via status, they never hard-delete history).
   ════════════════════════════════════════════════════════════════════════════ */
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const { id }     = req.params;

  try {
    const { rows } = await pool.query(
      `DELETE FROM after_sales_issues WHERE id = $1 AND business_id = $2 RETURNING id`,
      [id, businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'السجل غير موجود' });
    res.json({ message: 'تم حذف السجل', id: rows[0].id });
  } catch (err) {
    console.error('[after-sales DELETE]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
