const express              = require('express');
const bcrypt               = require('bcryptjs');
const jwt                  = require('jsonwebtoken');
const { createClient }     = require('@supabase/supabase-js');
const pool                 = require('../config/db');

const router = express.Router();

/* ── SaaS multi-tenant migrations (boot-time) ────────────────────────
   Adds plan_type to tenant table + business_id link on users so new
   business owners can self-register and be scoped to their tenant.   */
const saasMigrations = [
  `ALTER TABLE business_profile
     ADD COLUMN IF NOT EXISTS plan_type VARCHAR(20) NOT NULL DEFAULT 'ecommerce'`,
  `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES business_profile(id) ON DELETE SET NULL`,
];
Promise.all(saasMigrations.map((sql) => pool.query(sql)))
  .then(() => console.log('✅  Auth: SaaS multi-tenant schema ready'))
  .catch((err) => console.error('⚠️  Auth SaaS migration failed:', err.message));

const VALID_PLANS = ['affiliate', 'ecommerce'];

// Lazy-initialised so the app still starts if the vars are absent
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set in .env');
    _supabase = createClient(url, key);
  }
  return _supabase;
}

/** Sign a local JWT with the same shape the dashboard expects */
function signToken(user) {
  return jwt.sign(
    {
      id:          user.id,
      email:       user.email,
      role:        user.role,
      permissions: user.permissions || ['orders'],
      business_id: user.business_id || null,
      plan_type:   user.plan_type || 'ecommerce',
    },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
}

/** Normalise the user object returned to the client (never expose password_hash) */
function publicUser(user) {
  return {
    id:          user.id,
    email:       user.email,
    role:        user.role,
    permissions: user.permissions || ['orders'],
    business_id: user.business_id || null,
    plan_type:   user.plan_type || 'ecommerce',
  };
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
  }

  try {
    // ── 1. Look up the user in our local users table ─────────────────
    //    Left-join the tenant row so we can surface plan_type to the client.
    const result = await pool.query(
      `SELECT u.*, bp.plan_type AS plan_type
         FROM users u
         LEFT JOIN business_profile bp ON bp.id = u.business_id
        WHERE u.email = $1`,
      [email]
    );
    const user   = result.rows[0];

    // ── 2. Try local bcrypt verification first ────────────────────────
    const isSupabaseManaged = user?.password_hash === 'SUPABASE_AUTH_MANAGED';
    const localPasswordOk   =
      user && !isSupabaseManaged && (await bcrypt.compare(password, user.password_hash));

    if (localPasswordOk) {
      // Fast path — regular local user
      return res.json({
        token : signToken(user),
        user  : publicUser(user),
      });
    }

    // ── 3. Fall back to Supabase Auth ─────────────────────────────────
    //    Triggered when:
    //      a) password_hash === 'SUPABASE_AUTH_MANAGED'  (explicit sentinel), OR
    //      b) local check failed but the user record still exists (safety net)
    if (user) {
      const { data: sbData, error: sbError } = await getSupabase()
        .auth.signInWithPassword({ email, password });

      if (!sbError && sbData?.user) {
        // Supabase confirmed the credentials — issue our own JWT
        return res.json({
          token : signToken(user),
          user  : publicUser(user),
        });
      }
    }

    // ── 4. Both paths failed ──────────────────────────────────────────
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── SaaS self-service registration ───────────────────────────────────
   Creates a brand-new tenant (business_profile) + its first admin user.
   Payload: { email, password, brand_name, plan_type }                 */
router.post('/register', async (req, res) => {
  const { email, password, brand_name, plan_type } = req.body || {};

  // ── Validation ───────────────────────────────────────────────────
  if (!email || !password || !brand_name) {
    return res.status(400).json({ error: 'البريد الإلكتروني وكلمة المرور واسم البراند مطلوبة' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  }
  const plan = VALID_PLANS.includes(plan_type) ? plan_type : 'ecommerce';

  const client = await pool.connect();
  try {
    // ── 1. Reject duplicate emails ──────────────────────────────────
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'هذا البريد الإلكتروني مسجّل بالفعل' });
    }

    // ── 2. Hash the password ────────────────────────────────────────
    const password_hash = await bcrypt.hash(password, 10);

    // ── 3-4. Create tenant + admin user atomically ──────────────────
    await client.query('BEGIN');

    const bpRes = await client.query(
      `INSERT INTO business_profile (brand_name, contact_email, plan_type)
       VALUES ($1, $2, $3)
       RETURNING id, plan_type`,
      [brand_name, email, plan]
    );
    const business = bpRes.rows[0];

    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, role, business_id, permissions)
       VALUES ($1, $2, 'admin', $3, $4)
       RETURNING id, email, role, permissions, business_id`,
      [email, password_hash, business.id, ['orders', 'analytics', 'inventory']]
    );

    await client.query('COMMIT');

    const user = { ...userRes.rows[0], plan_type: business.plan_type };

    // ── 5. Issue JWT ────────────────────────────────────────────────
    return res.status(201).json({
      token: signToken(user),
      user:  publicUser(user),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Register error:', err);
    res.status(500).json({ error: 'تعذّر إنشاء الحساب، حاول مرة أخرى' });
  } finally {
    client.release();
  }
});

module.exports = router;
