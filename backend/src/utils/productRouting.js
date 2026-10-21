'use strict';

/* ── Product-based agent routing helpers ─────────────────────────────────────
   An agent may carry an `allowed_products` list (TEXT[]). Semantics:
     • empty / null  → the agent handles ALL products (backward compatible).
     • non-empty     → the agent may ONLY handle products in the list.
   Matching is tolerant (normalized, bidirectional containment) so a slightly
   different order ProductName still matches its catalog entry — Arabic product
   names fragment in practice (e.g. "آلة صنع الآيس كريم…" vs "آلة صنع الآيس").   */

/* Lowercase, unify common Arabic letter variants, drop spaces/punctuation. */
function normalizeProduct(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

/* True when `productName` is within the agent's allowed set (or the set is
   empty → all allowed). A blank product name never blocks assignment. */
function agentAllowsProduct(allowedProducts, productName) {
  if (!Array.isArray(allowedProducts) || allowedProducts.length === 0) return true;
  const p = normalizeProduct(productName);
  if (!p) return true;
  return allowedProducts.some((a) => {
    const n = normalizeProduct(a);
    return n && (p.includes(n) || n.includes(p));
  });
}

/* ── Product-aware weighted assignment ───────────────────────────────────────
   `agents` = [{ email, weight, allowed }]; each `order` = { id, product }.
   For every order, among the agents ALLOWED to handle that product, picks the
   one furthest behind their weighted pace ((count+1)/weight is lowest) — a smooth
   weighted round-robin that also honours per-agent product restrictions. Orders
   with NO eligible agent are left unassigned (never force-routed to an untrained
   agent). With no restrictions this reproduces the old balanced distribution.
   Returns { byAgent: Map email→[orderIds], counts: Map email→n, unassigned:[] }. */
function assignProductAware(orders, agents) {
  const counts  = new Map(agents.map((a) => [a.email, 0]));
  const byAgent = new Map(agents.map((a) => [a.email, []]));
  const unassigned = [];
  for (const ord of orders) {
    let best = null, bestScore = Infinity;
    for (const a of agents) {
      if (!agentAllowsProduct(a.allowed, ord.product)) continue;
      const w = a.weight > 0 ? a.weight : 0.0001;
      const score = (counts.get(a.email) + 1) / w;
      if (score < bestScore) { bestScore = score; best = a; }
    }
    if (!best) { unassigned.push(ord.id); continue; }
    byAgent.get(best.email).push(ord.id);
    counts.set(best.email, counts.get(best.email) + 1);
  }
  return { byAgent, counts, unassigned };
}

module.exports = { normalizeProduct, agentAllowsProduct, assignProductAware };
