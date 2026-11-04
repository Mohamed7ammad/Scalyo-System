'use strict';

/* Pure helpers for services/returnPickups.js — no DB access at load or call
   time, so they are unit-tested without a database (returnPickupsMatch.test.js). */

const { extractPriceAfterVat } = require('./bostaShippingFee');

const RECEIVED_STATE = 46;                 // Bosta «Returned to business»

/* Bosta type (string, code, or {code,value}) → 'pickup' | 'exchange' | null. */
function kindOf(type) {
  const raw = type && typeof type === 'object' ? (type.value ?? type.code) : type;
  const t = String(raw ?? '').toUpperCase().replace(/\s+/g, '_');
  if (t.includes('EXCHANGE') || t === '30') return 'exchange';
  if (t.includes('CUSTOMER_RETURN') || t.includes('CRP') || t === '25') return 'pickup';
  return null;
}

/* Text normalisation for matching free-text Bosta descriptions to products. */
const norm = (s) => String(s ?? '').toLowerCase()
  .replace(/[ً-ْـ]/g, '')            // tashkeel + tatweel
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const phone10 = (p) => { const d = String(p ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };

/* Both description fields (English + Arabic), de-duplicated — the catalogue
   name may match either one («Game TV stick 8k» vs «جهاز ألعاب تي في ستيك 8K»). */
const descOf = (pd) => {
  const parts = [pd && pd.description, pd && pd.descriptionAr].map((s) => String(s ?? '').trim()).filter(Boolean);
  const uniq = parts.filter((s, i) => parts.findIndex((x) => norm(x) === norm(s)) === i);
  return uniq.length ? uniq.join(' — ') : null;
};

/* What we need out of a Bosta delivery doc (GET /deliveries/business/:tn). */
function parseDoc(doc, kind) {
  const rs = (doc && doc.returnSpecs && doc.returnSpecs.packageDetails) || {};
  const fs = (doc && doc.specs && doc.specs.packageDetails) || {};
  const receiver = (doc && doc.receiver) || {};
  const st = (doc && doc.state) || {};
  const returnedAt = st.returnedToBusiness || (Number(st.code) === RECEIVED_STATE ? st.deliveryTime : null);
  return {
    customer_phone: phone10(receiver.phone),
    customer_name:  receiver.fullName || [receiver.firstName, receiver.lastName].filter(Boolean).join(' ') || null,
    return_desc:    descOf(rs) || (kind === 'pickup' ? descOf(fs) : null),
    return_qty:     Math.max(1, parseInt(rs.itemsCount, 10) || (kind === 'pickup' ? parseInt(fs.itemsCount, 10) : 0) || 1),
    forward_desc:   kind === 'exchange' ? descOf(fs) : null,
    forward_qty:    kind === 'exchange' ? Math.max(1, parseInt(fs.itemsCount, 10) || 1) : 0,
    pickup_fee:     extractPriceAfterVat(doc),
    collected_cod:  Math.max(0, Number(doc && doc.cod) || 0),
    bosta_created_at: doc && doc.createdAt ? new Date(doc.createdAt) : null,
    state_code:     Number.isFinite(Number(st.code)) ? Number(st.code) : null,
    received_at:    returnedAt ? new Date(returnedAt) : null,
  };
}

/* Free-text description → catalogue product: exact name / alias / sku first,
   then the LONGEST product name / alias contained in the text (or the text
   contained in it, for texts of 6+ characters). null when nothing fits. */
function matchProductText(products, text) {
  const t = norm(text);
  if (!t) return null;
  let best = null, bestLen = 0;
  for (const p of products) {
    const keys = [p.name, p.sku, ...(p.aliases || [])].map(norm).filter((k) => k.length >= 3);
    for (const k of keys) {
      if (k === t) return p;
      if ((t.includes(k) || (t.length >= 6 && k.includes(t))) && k.length > bestLen) { best = p; bestLen = k.length; }
    }
  }
  return best;
}

module.exports = { RECEIVED_STATE, kindOf, norm, phone10, parseDoc, matchProductText };
