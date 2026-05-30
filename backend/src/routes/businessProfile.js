const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

/* GET /api/business-profile — returns ONLY the caller's own tenant profile.
   business_profile.id IS the tenant id, so we scope directly by it. */
router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM business_profile WHERE id = $1 LIMIT 1',
      [req.user.business_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No profile found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* PATCH /api/business-profile/:id — admin only */
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
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
