'use strict';

/* ── Single source of truth for the EARNED-commission formula ─────────────────
   Used by every place that must agree on "how much has an agent earned":
     • analytics buildAgentSql        — period view (date-filtered join)
     • analytics /agents lifetime sum  — all-time global balance
     • staff payout validation         — one agent, all-time
   Keeping it in ONE place means the period column and the global balance can
   never diverge (Employee-Ledger requirement #2).

   The expression assumes the surrounding query exposes:
     • u  → the users row  (u.comm_confirmed / comm_delivered / comm_rejected / comm_no_answer)
     • o  → the joined orders row (o."Status", o."no_answer_logs")
   and that the query GROUPs BY the user.

   Rule (MUST mirror the treasury hooks in orders.js / treasury.js):
     confirmed×cc + delivered×cd + rejected×cr + noAnswer×cn
     where 'لا يرد' earns comm_no_answer ONLY after ≥5 logged call attempts
     (anti-abuse) and 'مؤجل' earns nothing automatically.                       */
const EARNED_COMMISSION_SQL = `
  ROUND(
      COUNT(o.id) FILTER (WHERE o."Status" IN (
        'تم التأكيد', 'تم الشحن', 'تم التوصيل', 'جاري الإعادة', 'تم الإرجاع'
      )) * COALESCE(u.comm_confirmed, 0)
    + COUNT(o.id) FILTER (WHERE o."Status" = 'تم التوصيل')
        * COALESCE(u.comm_delivered, 0)
    + COUNT(o.id) FILTER (WHERE o."Status" = 'تم الرفض')
        * COALESCE(u.comm_rejected, 0)
    + COUNT(o.id) FILTER (WHERE
        o."Status" = 'لا يرد'
        AND COALESCE(jsonb_array_length(o."no_answer_logs"), 0) >= 5
      ) * COALESCE(u.comm_no_answer, 0),
    2
  )`;

module.exports = { EARNED_COMMISSION_SQL };
