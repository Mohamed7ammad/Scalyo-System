'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   /api/discipline — confirmation-team checkpoints, check-in and breaks (Stage 1)
   Logic lives in services/agentDiscipline.js; this file is the HTTP surface.

   Agent (enrolled = users.agent_track set):
     GET  /me                              today's checkpoints, status, break balance
     POST /checkin   { code? }             check in to the open checkpoint (server time)
     POST /break     { action: 'start'|'end' }
     POST /still-here                      "نعم، ما زلت هنا" (resets the inactivity clock; logged)
   Admin / Team Leader (supervisor):
     GET  /checkpoints                     checkpoint settings (defaults seeded on first read)
     PUT  /checkpoints/:code               { label_ar?, due_time?, grace_minutes?, tracks?, is_active? }
                                           → { checkpoint, today: { retimed, removed, kept } }
                                           (today's not-yet-due rows follow the edit; see updateCheckpoint)
     GET  /agents                          agents, their track and today's status
     GET  /work-windows                    active work windows (idle tracking only runs inside)
     PUT  /work-windows { windows: [{start,end}] }  replace them (validated, no overlaps)
     GET  /live                            live board for the Team Leader grid
     GET  /alerts                          tiny snapshot for the dashboard-wide alert toasts
     PATCH /agents/:id/track               { track: 'confirmation' | 'review' | null }
     POST /reinstate { user_id }           lift today's withdrawal
   ════════════════════════════════════════════════════════════════════════════ */

const express      = require('express');
const authenticate = require('../middleware/auth');
const { hasRole }  = require('../utils/roles');
const svc          = require('../services/agentDiscipline');

const router = express.Router();

function requireAdminOrTeamLeader(req, res, next) {
  if (hasRole(req.user, 'admin') || hasRole(req.user, 'supervisor')) return next();
  return res.status(403).json({ error: 'مطلوب صلاحيات المدير أو التيم ليدر' });
}

/* Uniform error mapping: DisciplineError → its status + Arabic message. */
const handle = (fn) => async (req, res) => {
  try {
    await svc.schemaReady;
    res.json(await fn(req));
  } catch (e) {
    if (e instanceof svc.DisciplineError) return res.status(e.status).json({ error: e.message, ...e.extra });
    console.error(`[discipline ${req.method} ${req.path}]`, e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
};

/* ── Agent ─────────────────────────────────────────────────────────────────── */
router.get('/me', authenticate, handle(async (req) => {
  await svc.seedToday({ userId: req.user.id });   // first visit before the cron's tick
  return svc.getAgentState(req.user.id, req.user.business_id);
}));

router.post('/checkin', authenticate, handle((req) => {
  const code = typeof req.body?.code === 'string' && req.body.code.trim() ? req.body.code.trim() : null;
  return svc.checkIn(req.user.id, req.user.business_id, code);
}));

router.post('/break', authenticate, handle((req) => {
  const action = req.body?.action;
  if (action === 'start') return svc.startBreak(req.user.id, req.user.business_id);
  if (action === 'end')   return svc.endBreak(req.user.id, req.user.business_id);
  throw new svc.DisciplineError(400, "action يجب أن تكون 'start' أو 'end'");
}));

router.post('/still-here', authenticate, handle((req) => svc.stillHere(req.user.id, req.user.business_id)));

/* ── Admin / Team Leader ───────────────────────────────────────────────────── */
router.get('/alerts', authenticate, requireAdminOrTeamLeader, handle((req) =>
  svc.alertSnapshot(req.user.business_id)));

router.get('/live', authenticate, requireAdminOrTeamLeader, handle(async (req) => {
  await svc.seedToday();
  return svc.liveBoard(req.user.business_id);
}));

router.get('/checkpoints', authenticate, requireAdminOrTeamLeader, handle((req) =>
  svc.listCheckpoints(req.user.business_id)));

router.put('/checkpoints/:code', authenticate, requireAdminOrTeamLeader, handle((req) =>
  svc.updateCheckpoint(req.user.business_id, req.params.code, req.body || {})));

router.get('/work-windows', authenticate, requireAdminOrTeamLeader, handle((req) =>
  svc.listWorkWindows(req.user.business_id)));

router.put('/work-windows', authenticate, requireAdminOrTeamLeader, handle((req) =>
  svc.setWorkWindows(req.user.business_id, req.body?.windows)));

router.get('/agents', authenticate, requireAdminOrTeamLeader, handle((req) =>
  svc.listAgents(req.user.business_id)));

router.patch('/agents/:id/track', authenticate, requireAdminOrTeamLeader, handle((req) => {
  const raw = req.body?.track;
  const track = raw === null || raw === '' || raw === undefined ? null : String(raw);
  return svc.setAgentTrack(req.user.business_id, req.params.id, track);
}));

router.post('/reinstate', authenticate, requireAdminOrTeamLeader, handle((req) => {
  if (!req.body?.user_id) throw new svc.DisciplineError(400, 'user_id مطلوب');
  return svc.reinstate(req.user.business_id, req.body.user_id, req.user.email);
}));

module.exports = router;
