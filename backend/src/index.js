require('dotenv').config();
const express                 = require('express');
const cors                    = require('cors');
const startOrderSyncCron      = require('./services/googleSheetSync');
const { startMetaSyncCron }   = require('./cron/metaSync');
const { startTaagerSyncCron } = require('./cron/taagerSync');
const pool                    = require('./config/db');
const { initTenancy }         = require('./config/initTenancy');

/* ── DB safety-net: auto-stamp "updatedAt" on every orders row change ──────
   This trigger fires BEFORE any UPDATE on the orders table, so even if a
   route forgets to include "updatedAt" = NOW() the column is always current.
   CREATE OR REPLACE + IF NOT EXISTS make this fully idempotent.             */
pool.query(`
  CREATE OR REPLACE FUNCTION fn_orders_set_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    NEW."updatedAt" = NOW();
    RETURN NEW;
  END;
  $$;
`).then(() =>
  pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_orders_updated_at'
          AND tgrelid = 'orders'::regclass
      ) THEN
        CREATE TRIGGER trg_orders_updated_at
        BEFORE UPDATE ON orders
        FOR EACH ROW EXECUTE FUNCTION fn_orders_set_updated_at();
      END IF;
    END $$;
  `)
)
.then(() => console.log('✅  DB trigger trg_orders_updated_at ready'))
.catch((err) => console.warn('⚠️   updatedAt trigger setup skipped:', err.message));

const authRoutes            = require('./routes/auth');
const ordersRoutes          = require('./routes/orders');
const webhookRoutes         = require('./routes/webhooks');
const shippingWebhookRoutes = require('./routes/shippingWebhook');
const returnsRoutes         = require('./routes/returns');
const inventoryRoutes       = require('./routes/inventory');
const productsRoutes        = require('./routes/products');
const shippingRoutes        = require('./routes/shipping');
const businessProfileRoutes = require('./routes/businessProfile');
const staffRoutes           = require('./routes/staff');
const analyticsRoutes       = require('./routes/analytics');
const accountingRoutes      = require('./routes/accounting');
const treasuryRoutes        = require('./routes/treasury');
const metaRoutes            = require('./routes/meta');
const bostaRoutes           = require('./routes/bosta');
const affiliateRoutes       = require('./routes/affiliate');

const app = express();

// Global request logger
app.use((req, _res, next) => {
  console.log(`➡️  Incoming request: ${req.method} ${req.url}`);
  next();
});

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

app.use('/api/auth',             authRoutes);
app.use('/api/orders',           ordersRoutes);
app.use('/api/webhooks',         webhookRoutes);
app.use('/api/webhooks',         shippingWebhookRoutes); // POST /api/webhooks/bosta
app.use('/api/returns',          returnsRoutes);
app.use('/api/inventory',        inventoryRoutes);
app.use('/api/products',         productsRoutes);
app.use('/api/shipping',         shippingRoutes);
app.use('/api/business-profile', businessProfileRoutes);
app.use('/api/staff',           staffRoutes);
app.use('/api/analytics',       analyticsRoutes);
app.use('/api/accounting',      accountingRoutes);
app.use('/api/treasury',        treasuryRoutes);
app.use('/api/meta',            metaRoutes);
app.use('/api/bosta',           bostaRoutes); // live wallet + follow-ups
app.use('/api/affiliate',       affiliateRoutes); // external affiliate networks (affiliate plan)

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  /* Tenant isolation migration MUST finish before the cron jobs (which
     insert tenant-scoped rows) begin firing. */
  await initTenancy();
  startOrderSyncCron();
  startMetaSyncCron();
  startTaagerSyncCron();
});
