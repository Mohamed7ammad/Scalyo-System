'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   Closed orders — the two «مغلق» statuses (pure constants, no requires, so
   services/orderStatus.js and the routes can share them without a cycle).

   «مغلق - لن يشحن»  — a CONFIRMED order the owner decided not to ship (a test
     product he won't stock, or just this one order). It keeps everything the
     agent earned and still counts as CONFIRMED in every confirmation rate, but
     it is out of «تم التأكيد» / «بانتظار الشحن», the Bosta batch and every
     forecast — those all filter on the exact status 'تم التأكيد'.
   «مغلق - منتج متوقف» — an order of a STOPPED product that was NOT confirmed
     (جديد / لا يرد / مؤجل / …) or that arrived after the stop. It leaves every
     queue and counts neither for nor against the agent.

   Only an admin closes / reopens (routes/orders.js PATCH, routes/products.js).
   Closing never takes money away (orderStatus VALID_BY_STATUS), and stock a
   confirmed order had reserved goes back (it leaves the committed states).
   The CLOSED_CONFIRMED literal also sits inside the confirmed-family IN lists
   of routes/analytics.js, routes/orders.js (/stats) and routes/treasury.js —
   grep the literal before renaming it.
   ════════════════════════════════════════════════════════════════════════════ */

const CLOSED_CONFIRMED = 'مغلق - لن يشحن';
const CLOSED_PRODUCT   = 'مغلق - منتج متوقف';
const CLOSED_STATUSES  = [CLOSED_CONFIRMED, CLOSED_PRODUCT];

/* What «إيقاف المنتج» sweeps (anything else — rejected, shipped, delivered,
   returned, the no-answer terminal — is history and stays as it is). */
const STOP_CONFIRMED_FROM = ['تم التأكيد'];
const STOP_OPEN_FROM      = ['جديد', 'مراجعة جديدة', 'لا يرد', 'مؤجل', 'معلق حتي الدفع'];

const isClosed = (s) => CLOSED_STATUSES.includes(String(s ?? '').trim());

/* SQL literal list for STATIC SQL (these constants only — never user input). */
const sqlList = (arr) => arr.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(', ');

module.exports = {
  CLOSED_CONFIRMED, CLOSED_PRODUCT, CLOSED_STATUSES,
  STOP_CONFIRMED_FROM, STOP_OPEN_FROM, isClosed, sqlList,
};
