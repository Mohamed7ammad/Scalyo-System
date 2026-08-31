// Fields an agent is allowed to modify — everything else is blocked.
const AGENT_ALLOWED_FIELDS = new Set([
  'Status',
  'Note',
  'ShippingNotes',    // inline shipping-notes column (printed on the Bosta AWB)
  'DeliveryRate',
  'ProductName',
  'quantity',         // agents can correct the order quantity from the edit modal
  'PostponedDate',
  'rejectionReason',  // sent alongside Status='تم الرفض' from the rejection picker modal
  // Quick-edit customer / shipping details — agents fix customer typos
  // (wrong phone, missing detailed address, etc.) from the orders table.
  'FullName',
  'Phone',
  'City',
  'Address',
  // Deposit (العربون) — agents can record/adjust a customer deposit; the PATCH
  // treasury hook logs it to treasury_transactions exactly as it does for admins.
  'hasDeposit',
  'depositAmount',
]);

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'مطلوب صلاحيات المدير' });
  }
  next();
}

/**
 * Allow admins through unconditionally; otherwise require the caller's JWT
 * `permissions` array to include the given granular permission key. Mirrors the
 * frontend gate (isAdmin || permissions.includes(key)). Permissions are baked
 * into the JWT at login (see routes/auth.js), so this needs no DB round-trip.
 */
function requireAdminOrPermission(permission) {
  return function (req, res, next) {
    if (req.user.role === 'admin') return next();
    const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (perms.includes(permission)) return next();
    return res.status(403).json({ error: 'مطلوب صلاحيات المدير' });
  };
}

/**
 * Like requireAdminOrPermission but passes when the caller's JWT holds ANY ONE
 * of the given permission keys (admins always pass). Used where a route serves
 * more than one privileged role — e.g. the staff roster, which both a
 * team-leader (manage_staff) and a reassigning supervisor (reassign_orders) need.
 */
function requireAdminOrAnyPermission(...permissions) {
  return function (req, res, next) {
    if (req.user.role === 'admin') return next();
    const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (permissions.some((p) => perms.includes(p))) return next();
    return res.status(403).json({ error: 'مطلوب صلاحيات المدير' });
  };
}

/* Restrict order-field edits for EVERY non-admin role (agent AND supervisor).
   A supervisor is a team-leader, not a super-admin: when they inline-edit an
   order they get exactly the same safe field set as an agent — never price or
   other sensitive columns. Admins remain unrestricted.

   ONE exception: a team-leader carrying 'reassign_orders' may also patch
   "AssignedTo" — that IS their job (the inline reassignment dropdown), and it's
   the same power the dedicated /transfer + /distribute endpoints already grant
   them. Plain agents never get it. */
function filterAgentFields(req, res, next) {
  if (req.user.role !== 'admin') {
    const allowed = new Set(AGENT_ALLOWED_FIELDS);
    if (Array.isArray(req.user.permissions) && req.user.permissions.includes('reassign_orders')) {
      allowed.add('AssignedTo');
      // Team-leaders (supervisors) may also correct the total price — the same
      // capability granted by the dedicated PATCH /:id/price route and the full
      // "تعديل الطلب" modal. Plain agents (no reassign_orders) still cannot.
      allowed.add('ProductPrice');
    }
    const forbidden = Object.keys(req.body).filter(f => !allowed.has(f));
    if (forbidden.length > 0) {
      return res.status(403).json({
        error: `غير مسموح للموظف بتعديل: ${forbidden.join(', ')}`,
      });
    }
  }
  next();
}

module.exports = { requireAdmin, filterAgentFields, requireAdminOrPermission, requireAdminOrAnyPermission };
