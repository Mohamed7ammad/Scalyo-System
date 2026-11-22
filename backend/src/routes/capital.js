/* «رأس المال» — GET /api/capital, the owner's page (admin only).
   Money (Bosta wallet + treasury) + goods at cost (shelf, confirmed, on the road,
   coming back). See services/capital.js. */
'use strict';

const express          = require('express');
const authenticate     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const capital          = require('../services/capital');
const { routeHandler, callHandler } = require('../utils/internalCall');

const router = express.Router();

/* The wallet number = exactly what the treasury page shows: routes/bosta.js
   GET /wallet, called in-process (one read per page view, nothing new for Bosta). */
let walletHandle = null;
let walletOverride = null;                         // previews / tests only
function _setWalletFetcher(fn) { walletOverride = fn; }

async function fetchWallet(user) {
  if (walletOverride) return walletOverride();
  if (!walletHandle) walletHandle = routeHandler(require('./bosta'), '/wallet');
  const out = await callHandler(walletHandle, user, {});
  const balance = out.body && out.body.balance;
  if (out.status === 200 && balance !== null && balance !== undefined && Number.isFinite(Number(balance))) {
    return { ok: true, balance: Number(balance) };
  }
  return { ok: false, balance: null, error: (out.body && out.body.error) || `HTTP ${out.status}` };
}

router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const data = await capital.computeCapital({
      businessId:  req.user.business_id,
      fetchWallet: () => fetchWallet(req.user),
    });
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('[capital] failed:', err.message);
    res.status(500).json({ error: 'تعذّر حساب رأس المال' });
  }
});

module.exports = router;
module.exports._setWalletFetcher = _setWalletFetcher;
