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

module.exports = { normalizeProduct, agentAllowsProduct };
