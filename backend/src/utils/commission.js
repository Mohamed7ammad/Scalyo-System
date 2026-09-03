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

   ─────────────────────────────────────────────────────────────────────────────
   FROZEN-RATE MODEL (fixes the retroactive-repricing bug):
   Earned commission is NO LONGER  COUNT(status) × the agent's CURRENT rate — that
   re-priced an agent's ENTIRE history the instant their profile rate changed
   (e.g. raising Dina 5→7 EGP retroactively inflated all 390 past confirmations to
   2 730 instead of the 2 030 actually earned). Instead each order carries its own
   frozen `earned_commission`, stamped at the exact rate in force when its status
   changed (maintained from the treasury commission ledger by the status-change
   hooks in orders.js). Total earnings = SUM of those frozen per-order amounts, so
   changing an agent's rate in the future NEVER moves past earnings.

   The expression still assumes the surrounding query joins the agent's orders as
   `o` and GROUPs BY the user, so SUM aggregates that agent's frozen commissions
   (date-filtered by the join for the period view; unfiltered for the lifetime
   sum) — same shape as before, so every call-site keeps working unchanged.       */
const EARNED_COMMISSION_SQL = `ROUND(COALESCE(SUM(o.earned_commission), 0), 2)`;

module.exports = { EARNED_COMMISSION_SQL };
