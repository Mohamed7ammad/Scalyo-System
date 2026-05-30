const express      = require('express');
const pool         = require('../config/db');
const authenticate = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');

const router = express.Router();

const getShortName = (name) => { return name ? name.trim().split(/\s+/).slice(0, 3).join(' ') : ''; };

// GET /api/inventory — admin only
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM inventory WHERE business_id = $1 ORDER BY "ProductName" ASC',
      [req.user.business_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/inventory — admin only, upsert stock for a product
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { ProductName, StockQuantity } = req.body;

  if (!ProductName || StockQuantity === undefined || StockQuantity === null) {
    return res.status(400).json({ error: 'ProductName و StockQuantity مطلوبان' });
  }

  const qty       = parseInt(StockQuantity, 10);
  const shortName = getShortName(ProductName);

  if (isNaN(qty) || qty < 0) {
    return res.status(400).json({ error: 'StockQuantity يجب أن يكون رقماً موجباً' });
  }
  if (!shortName) {
    return res.status(400).json({ error: 'ProductName غير صالح' });
  }

  console.log(`Inventory upsert: "${shortName}" → ${qty}`);

  try {
    const result = await pool.query(
      `INSERT INTO inventory ("ProductName", "StockQuantity", "updatedAt", business_id)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT ("ProductName", business_id)
       DO UPDATE SET "StockQuantity" = $2, "updatedAt" = NOW()
       RETURNING *`,
      [shortName, qty, req.user.business_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
