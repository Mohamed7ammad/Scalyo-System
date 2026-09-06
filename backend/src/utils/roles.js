'use strict';

/* ── Multi-role RBAC helpers ──────────────────────────────────────────────────
   A user now holds an ARRAY of roles (`users.roles`). For backward-compat the
   single `role` column/JWT claim is kept in sync as the PRIMARY role (the most
   privileged one), so any check we haven't migrated still degrades gracefully.
   These helpers are the single place that understands both shapes.             */

const VALID_ROLES = ['agent', 'admin', 'media_buyer', 'supervisor', 'after_sales', 'moderator'];

/* Most-privileged first — drives the primary role and the display badge order. */
const ROLE_PRIORITY = ['admin', 'supervisor', 'media_buyer', 'agent', 'after_sales', 'moderator'];

/* Every role a user holds, as a clean array. Tolerant of a legacy object that
   only carries `role`, or a JWT that carries `roles`. */
function rolesOf(user) {
  if (!user) return [];
  if (Array.isArray(user.roles) && user.roles.length) {
    return user.roles.map((r) => String(r).trim()).filter(Boolean);
  }
  if (typeof user.role === 'string' && user.role.trim()) return [user.role.trim()];
  return [];
}

function hasRole(user, role)      { return rolesOf(user).includes(role); }
function hasAnyRole(user, ...rs)  { const s = new Set(rolesOf(user)); return rs.some((r) => s.has(r)); }

/* The primary role: the most-privileged role the user holds. Used for the
   compat `role` field/claim and the single "main" badge / redirect target. */
function primaryRole(input) {
  const arr = Array.isArray(input) ? input : rolesOf(input);
  for (const r of ROLE_PRIORITY) if (arr.includes(r)) return r;
  return arr[0] || 'agent';
}

/* Sanitise an inbound roles value (array OR legacy single string) → a distinct,
   trimmed, VALID-only array. Falls back to `fallback` (or 'agent') when empty. */
function normalizeRoles(input, fallback = 'agent') {
  let arr = Array.isArray(input) ? input : (typeof input === 'string' && input ? [input] : []);
  arr = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))].filter((r) => VALID_ROLES.includes(r));
  if (arr.length === 0) arr = [fallback];
  return arr;
}

module.exports = { VALID_ROLES, ROLE_PRIORITY, rolesOf, hasRole, hasAnyRole, primaryRole, normalizeRoles };
