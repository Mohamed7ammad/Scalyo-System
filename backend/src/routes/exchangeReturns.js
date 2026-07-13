/* ════════════════════════════════════════════════════════════════════════════
   Exchange & Returns Requests  (الاستبدال والاسترجاع)
   ════════════════════════════════════════════════════════════════════════════

   After-sales requests where the customer wants to EXCHANGE (استبدال) or
   RETURN (استرجاع) a delivered product. Any employee can log a request on
   behalf of a customer — including an evidence video link — and the request
   opens in the 'قيد المراجعة' (pending review) state.

   Distinct from after_sales_issues (خدمة ما بعد البيع): that table tracks
   free-form complaints; this one tracks formal exchange/return requests with
   a typed request_type and a review workflow.

   Open to every authenticated employee of the tenant (shared pool). Hard
   DELETE is admin-only; agents close requests by moving the status instead.
   ════════════════════════════════════════════════════════════════════════════ */

const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

/* The ONLY request types — mirrored by the frontend dropdown. */
const ALLOWED_TYPES = ['استبدال', 'استرجاع'];

/* The ONLY statuses a request may hold — mirrored by the frontend dropdown.
   'قيد المراجعة' is the opening state for every new request. */
const ALLOWED_STATUSES = [
  'قيد المراجعة',
  'تمت الموافقة',
  'مرفوض',
  'مكتمل',
];
const DEFAULT_STATUS = 'قيد المراجعة';

/* ── Idempotent schema bootstrap (runs once at module load) ─────────────────
   Same pattern as afterSales.js / returnCollections.js — IF NOT EXISTS only.
   product_id is a soft link to products(id) (UUID, no FK so deleting a product
   never breaks history); product_name is a snapshot for display/filter even if
   the product is later renamed or removed. The ALTER steps upgrade tables
   created by the pre-product version of this bootstrap already live on the
   server. */
pool.query(`
  CREATE TABLE IF NOT EXISTS after_sales_requests (
    id             SERIAL       PRIMARY KEY,
    business_id    INTEGER,
    customer_name  TEXT         NOT NULL,
    customer_phone VARCHAR(50)  NOT NULL,
    request_type   VARCHAR(50)  NOT NULL,
    product_id     UUID,
    product_name   TEXT,
    reason         TEXT,
    video_link     TEXT,
    status         VARCHAR(50)  NOT NULL DEFAULT '${DEFAULT_STATUS}',
    created_by     VARCHAR(255),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )
`)
  .then(() => pool.query(`ALTER TABLE after_sales_requests ADD COLUMN IF NOT EXISTS product_id UUID`))
  .then(() => pool.query(`ALTER TABLE after_sales_requests ADD COLUMN IF NOT EXISTS product_name TEXT`))
  .then(() => pool.query(`
    CREATE INDEX IF NOT EXISTS after_sales_requests_status_idx
      ON after_sales_requests (business_id, status)
  `))
  .then(() => console.log('✅  after_sales_requests table ready'))
  .catch((err) => console.warn('⚠️   after_sales_requests schema check:', err.message));

/* Display name for the creator — same convention as afterSales.js. */
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
   GET /api/exchange-returns?request_type=<استبدال|استرجاع>&status=<arabic>
   Shared pool: every employee sees all of the tenant's requests.
   ════════════════════════════════════════════════════════════════════════════ */
router.get('/', authenticate, async (req, res) => {
  const businessId = req.user.business_id;
  const { request_type, status } = req.query;

  const params = [businessId];
  let where = 'r.business_id = $1';
  if (request_type && ALLOWED_TYPES.includes(String(request_type))) {
    params.push(String(request_type));
    where += ` AND r.request_type = $${params.length}`;
  }
  if (status && ALLOWED_STATUSES.includes(String(status))) {
    params.push(String(status));
    where += ` AND r.status = $${params.length}`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT r.*,
              ${CREATOR_NAME_SQL} AS created_by_name,
              u.email             AS created_by_email
       FROM   after_sales_requests r
       LEFT   JOIN users u ON u.id = r.created_by
       WHERE  ${where}
       ORDER  BY r.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[exchange-returns GET]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/exchange-returns
   { customer_name, customer_phone, request_type, product_id (or product_name),
     reason, video_link? }
   Opens a new request in the default 'قيد المراجعة' state, stamped with the
   creating employee. The product is REQUIRED — a return/exchange cannot be
   processed without knowing which product it concerns.
   ════════════════════════════════════════════════════════════════════════════ */
router.post('/', authenticate, async (req, res) => {
  const businessId = req.user.business_id;
  const customerName  = String(req.body.customer_name ?? '').trim();
  const customerPhone = String(req.body.customer_phone ?? '').trim();
  const requestType   = String(req.body.request_type ?? '').trim();
  const productId     = req.body.product_id ? String(req.body.product_id) : null;
  const rawProductName = req.body.product_name ? String(req.body.product_name).trim() : null;
  const reason        = String(req.body.reason ?? '').trim();
  const videoLink     = req.body.video_link ? String(req.body.video_link).trim() : null;

  if (!customerName)  return res.status(400).json({ error: 'اسم العميل مطلوب' });
  if (!customerPhone) return res.status(400).json({ error: 'رقم هاتف العميل مطلوب' });
  if (!ALLOWED_TYPES.includes(requestType)) {
    return res.status(400).json({ error: 'نوع الطلب يجب أن يكون استبدال أو استرجاع' });
  }
  if (!productId && !rawProductName) {
    return res.status(400).json({ error: 'المنتج مطلوب' });
  }
  if (!reason) return res.status(400).json({ error: 'سبب الطلب مطلوب' });

  try {
    /* Prefer the canonical product name from the products table; fall back to
       whatever free-text name the client sent (unlinked / legacy product). */
    const resolvedName = await resolveProductName(productId, businessId);
    const productName  = resolvedName ?? rawProductName;
    if (!productName) return res.status(400).json({ error: 'المنتج غير موجود' });

    const { rows } = await pool.query(
      `INSERT INTO after_sales_requests
         (business_id, customer_name, customer_phone, request_type, product_id,
          product_name, reason, video_link, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [businessId, customerName, customerPhone, requestType, productId,
       productName, reason, videoLink, DEFAULT_STATUS, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[exchange-returns POST]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   PATCH /api/exchange-returns/:id
   Allowlisted partial update: status (validated), request_type (validated),
   reason, video_link, customer_name, customer_phone, product_id (re-resolves
   the snapshot name).
   ════════════════════════════════════════════════════════════════════════════ */
router.patch('/:id', authenticate, async (req, res) => {
  const businessId = req.user.business_id;
  const { id }     = req.params;
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

  if (has('status') && !ALLOWED_STATUSES.includes(String(req.body.status))) {
    return res.status(400).json({ error: 'حالة غير صالحة' });
  }
  if (has('request_type') && !ALLOWED_TYPES.includes(String(req.body.request_type))) {
    return res.status(400).json({ error: 'نوع الطلب غير صالح' });
  }

  const sets   = [];
  const params = [];
  const push = (sql, val) => { params.push(val); sets.push(`${sql} = $${params.length}`); };

  if (has('status'))         push('status',         String(req.body.status));
  if (has('request_type'))   push('request_type',   String(req.body.request_type));
  if (has('reason'))         push('reason',         req.body.reason == null ? '' : String(req.body.reason));
  if (has('video_link'))     push('video_link',     req.body.video_link ? String(req.body.video_link).trim() : null);
  if (has('customer_name'))  push('customer_name',  String(req.body.customer_name ?? '').trim());
  if (has('customer_phone')) push('customer_phone', String(req.body.customer_phone ?? '').trim());
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
      `UPDATE after_sales_requests SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND business_id = $${params.length}
       RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'السجل غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[exchange-returns PATCH]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   DELETE /api/exchange-returns/:id  — admin-only (agents close requests via
   status, they never hard-delete history).
   ════════════════════════════════════════════════════════════════════════════ */
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  const businessId = req.user.business_id;
  const { id }     = req.params;

  try {
    const { rows } = await pool.query(
      `DELETE FROM after_sales_requests WHERE id = $1 AND business_id = $2 RETURNING id`,
      [id, businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'السجل غير موجود' });
    res.json({ message: 'تم حذف السجل', id: rows[0].id });
  } catch (err) {
    console.error('[exchange-returns DELETE]', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
