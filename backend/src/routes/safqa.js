'use strict';

/**
 * safqa.js — Safqa self-serve endpoints (affiliate plan).
 * POST /api/safqa/import-csv — upload a Safqa CSV export from the dashboard UI.
 *
 * Reuses services/safqaCsvImport.js (the SAME engine the CLI uses), so a web
 * upload behaves identically to `node src/scripts/syncHistoricalSafqa.js`.
 * The destructive --replace prune is intentionally NOT exposed here — the
 * self-serve upload is additive/merge-only (idempotent via the serial-keyed
 * UPSERT), so a client can re-upload safely without ever wiping rows.
 */

const express = require('express');
const multer  = require('multer');

const authenticate     = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleGuard');
const { importSafqaCsv } = require('../services/safqaCsvImport');

const router = express.Router();

/* In-memory upload — we only need the buffer to parse; nothing is written to disk.
   Cap at 20 MB and accept a single .csv/text file under the field name "file". */
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /csv|excel|text|octet-stream/i.test(file.mimetype || '') ||
               /\.csv$/i.test(file.originalname || '');
    cb(ok ? null : new Error('الملف يجب أن يكون بصيغة CSV'), ok);
  },
});

/* Affiliate-plan gate (same rule as routes/affiliate.js). */
function requireAffiliatePlan(req, res, next) {
  if (req.user?.plan_type !== 'affiliate') {
    return res.status(403).json({ error: 'هذه الميزة حصرية لباقة الأفليت' });
  }
  next();
}

/* POST /api/safqa/import-csv  (multipart/form-data, field "file"; ?dry=1 to preview) */
router.post(
  '/import-csv',
  authenticate,
  requireAdmin,
  requireAffiliatePlan,
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'فشل رفع الملف' });
    next();
  }),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
        return res.status(400).json({ error: 'لم يتم رفع ملف CSV' });
      }
      const text   = req.file.buffer.toString('utf8');
      const dryRun = String(req.query.dry ?? req.body?.dry ?? '') === '1' ||
                     String(req.query.dry ?? req.body?.dry ?? '').toLowerCase() === 'true';

      const summary = await importSafqaCsv(text, req.user.business_id, { dryRun });
      return res.json({ ok: true, ...summary });
    } catch (err) {
      console.error('[safqa/import-csv] failed:', err.message);
      /* Validation problems (empty file, missing id/status column) → 400 with the
         Arabic message; anything unexpected → still 400 so the UI shows it. */
      return res.status(400).json({ error: err.message || 'فشل استيراد الملف' });
    }
  }
);

module.exports = router;
