'use strict';

/* Stamps users.last_action_at after a SUCCESSFUL write to a work route (order
   status / note / any field, call attempt, manual order) — the action clock the
   confirmation-team discipline system reads for its 13-minute "هل ما زلتِ هنا؟"
   prompt and the Team Leader's idle view. Deliberately separate from
   last_active_at, which the 90-second presence ping writes whether or not the
   agent is working. Only enrolled agents (agent_track set) are written.
   Mounted BEFORE the router: req.user is set by the router's authenticate and
   is read here only once the response has finished. */
const pool = require('../config/db');

module.exports = function trackAction(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.user?.id) return;
    pool.query(
      `UPDATE users SET last_action_at = NOW() WHERE id = $1 AND agent_track IS NOT NULL`,
      [String(req.user.id)]
    ).catch((err) => console.warn('[trackAction] skipped:', err.message));
  });
  next();
};
