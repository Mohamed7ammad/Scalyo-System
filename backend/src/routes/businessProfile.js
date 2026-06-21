const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const { slugify }  = require('../utils/slugify');

const router = express.Router();

/* ── Slug column (boot migration, idempotent) ────────────────────────────────
   `slug` is the readable, URL-safe business identifier used in the public webhook
   URL (…/api/webhooks/easyorder/<slug>). Generated ONCE from brand_name and then
   STABLE (renaming the brand does NOT change it, so a webhook already registered
   in EasyOrder never breaks). Unique per tenant. */
pool.query(`ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS slug VARCHAR(120)`)
  .then(() => pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS business_profile_slug_uidx
       ON business_profile (slug) WHERE slug IS NOT NULL`))
  .then(() => backfillSlugs())
  .then(() => console.log('✅  business_profile.slug ready'))
  .catch((err) => console.warn('⚠️   business_profile.slug migration:', err.message));

/* Compute a unique slug for a tenant: slugify(brand_name), with the id appended
   only when another tenant already holds that base slug. */
async function computeUniqueSlug(businessId, brandName) {
  const base = slugify(brandName, businessId) || String(businessId);
  const { rows } = await pool.query(
    `SELECT 1 FROM business_profile WHERE slug = $1 AND id <> $2 LIMIT 1`,
    [base, businessId]
  );
  return rows.length ? `${base}-${businessId}` : base;
}

/* One-time backfill for any rows created before this column existed. */
async function backfillSlugs() {
  const { rows } = await pool.query(
    `SELECT id, brand_name FROM business_profile WHERE slug IS NULL OR slug = ''`);
  for (const r of rows) {
    const slug = await computeUniqueSlug(r.id, r.brand_name);
    await pool.query(`UPDATE business_profile SET slug = $1 WHERE id = $2`, [slug, r.id])
      .catch((e) => console.warn(`⚠️   slug backfill for biz ${r.id} skipped:`, e.message));
  }
}

/* Ensure THIS tenant has a slug (lazy-generate on first read), returning it. */
async function ensureSlug(businessId, brandName) {
  const { rows } = await pool.query(`SELECT slug FROM business_profile WHERE id = $1`, [businessId]);
  if (rows[0]?.slug) return rows[0].slug;
  const slug = await computeUniqueSlug(businessId, brandName);
  await pool.query(`UPDATE business_profile SET slug = $1 WHERE id = $2`, [slug, businessId]).catch(() => {});
  return slug;
}

/* GET /api/business-profile — returns ONLY the caller's own tenant profile.
   business_profile.id IS the tenant id, so we scope directly by it. */
router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM business_profile WHERE id = $1 LIMIT 1',
      [req.user.business_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No profile found' });
    const profile = rows[0];
    if (!profile.slug) profile.slug = await ensureSlug(profile.id, profile.brand_name);
    res.json(profile);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* PATCH /api/business-profile/:id — admin only.
   NOTE: editing brand_name does NOT regenerate the slug — keeping it stable so a
   webhook URL already configured in EasyOrder keeps working. */
router.patch('/:id', authenticate, requireAdmin, async (req, res) => {
  const { brand_name, contact_email, phone_number, industry, logo_url } = req.body;

  /* Ignore the URL :id entirely and pin the update to the caller's own tenant.
     This makes it impossible for one tenant's admin to edit another's profile. */
  const id = req.user.business_id;

  try {
    const { rows } = await pool.query(
      `UPDATE business_profile
       SET    brand_name    = COALESCE($1, brand_name),
              contact_email = COALESCE($2, contact_email),
              phone_number  = COALESCE($3, phone_number),
              industry      = COALESCE($4, industry),
              logo_url      = COALESCE($5, logo_url),
              updated_at    = NOW()
       WHERE  id = $6
       RETURNING *`,
      [brand_name ?? null, contact_email ?? null, phone_number ?? null,
       industry   ?? null, logo_url      ?? null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Profile not found' });
    const profile = rows[0];
    if (!profile.slug) profile.slug = await ensureSlug(profile.id, profile.brand_name);
    res.json(profile);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
