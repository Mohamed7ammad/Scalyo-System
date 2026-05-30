// Fields an agent is allowed to modify — everything else is blocked.
const AGENT_ALLOWED_FIELDS = new Set([
  'Status',
  'Note',
  'DeliveryRate',
  'ProductName',
  'PostponedDate',
  'rejectionReason',  // sent alongside Status='تم الرفض' from the rejection picker modal
]);

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'مطلوب صلاحيات المدير' });
  }
  next();
}

function filterAgentFields(req, res, next) {
  if (req.user.role === 'agent') {
    const forbidden = Object.keys(req.body).filter(f => !AGENT_ALLOWED_FIELDS.has(f));
    if (forbidden.length > 0) {
      return res.status(403).json({
        error: `غير مسموح للموظف بتعديل: ${forbidden.join(', ')}`,
      });
    }
  }
  next();
}

module.exports = { requireAdmin, filterAgentFields };
