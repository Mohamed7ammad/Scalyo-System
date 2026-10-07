'use strict';

/* ── Single source of truth for the EARNED-commission formula ─────────────────
   Used by every place that must agree on "how much has an agent earned":
     • analytics buildAgentSql          — period view (order createdAt window)
     • analytics /agents + /my-performance lifetime — all-time global balance
     • staff payout validation          — one agent, all-time
   Keeping it in ONE place means the period column and the global balance can
   never diverge (Employee-Ledger requirement #2).

   ─────────────────────────────────────────────────────────────────────────────
   FROZEN-RATE MODEL (fixes the retroactive-repricing bug):
   Earned commission is NOT  COUNT(status) × the agent's CURRENT rate — that
   re-priced an agent's ENTIRE history the instant their profile rate changed
   (e.g. raising Dina 5→7 EGP retroactively inflated all 390 past confirmations to
   2 730 instead of the 2 030 actually earned). Each commission is a treasury
   ledger row stamped at the exact rate in force when it was earned, so changing
   a rate never moves past earnings.

   OWNERSHIP MODEL (fixes «commission lost after transfer»):
   The total is the SUM of the ledger rows the agent OWNS — not of the orders she
   currently holds. A row's owner is its agent_email (stamped at award time, or
   frozen to the outgoing agent by trg_orders_commission_owner when the order is
   reassigned — see treasury.js); legacy rows never reassigned since have no
   agent_email and belong to the order's current holder. So a transferred order's
   commission stays with whoever earned it, and the new holder earns her own.

   earnedCommissionSql(bizRef, rangeSql) returns a scalar SQL expression. The
   surrounding query must expose the agent as `u` (users row). `bizRef` is the
   tenant bind ref (e.g. '$1::integer'); `rangeSql` optionally restricts to
   commissions on orders in a window, written against the order alias `co`
   (e.g. 'AND co."createdAt" >= $2::timestamptz').                              */
const COMMISSION_SOURCES = ['comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer'];

function earnedCommissionSql(bizRef, rangeSql = '') {
  return `ROUND(COALESCE((
      SELECT SUM(ct.amount::numeric)
        FROM treasury_transactions ct
        JOIN orders co ON co.id = ct.order_id
       WHERE co.business_id = ${bizRef}
         AND ct.source IN (${COMMISSION_SOURCES.map((s) => `'${s}'`).join(', ')})
         AND LOWER(TRIM(COALESCE(ct.agent_email, co."AssignedTo"))) = LOWER(TRIM(u.email))
         ${rangeSql}
    ), 0), 2)`;
}

module.exports = { earnedCommissionSql, COMMISSION_SOURCES };
