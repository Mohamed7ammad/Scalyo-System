/*
 * ════════════════════════════════════════════════════════════════════
 *  Governorate shipping rates — single source of truth (backend)
 * ════════════════════════════════════════════════════════════════════
 *  Flat per-ORDER shipping cost (EGP) charged on top of the base product
 *  price when confirming a MISSING/lost order. Default is 90 EGP for every
 *  governorate; only the exceptions below differ. The canonical governorate
 *  list + these rates MUST stay identical to the frontend copy in
 *  frontend/src/lib/shipping.ts.
 *
 *  Used by PATCH /api/orders/:id to recompute a lost order's total price
 *  (base × quantity + shipping) server-side — authoritative, so an agent
 *  (who cannot send ProductPrice directly) still gets correct repricing
 *  when they pick a governorate.
 */

const DEFAULT_SHIPPING = 90;

/* Canonical governorate → shipping cost. Order is preserved for the UI
   dropdown (frontend mirrors it). Any governorate not listed = DEFAULT. */
const SHIPPING_RATES = {
  'المنيا': 95,
  'الاسكندرية': 90,
  'البحيرة': 90,
  'الجيزة': 90,
  'اسوان': 110,
  'دمياط': 90,
  'القليوبية': 90,
  'بورسعيد': 90,
  'القاهرة': 90,
  'الفيوم': 95,
  'البحر الأحمر': 110,
  'الغربية': 90,
  'كفر الشيخ': 90,
  'المنوفية': 90,
  'جنوب سيناء': 120,
  'اسيوط': 90,
  'الاسماعيلية': 90,
  'مطروح': 110,
  'الأقصر': 110,
  'بني سويف': 95,
  'الوادي الجديد': 135,
  'الدقهلية': 90,
  'الشرقية': 90,
  'السويس': 90,
  'سوهاج': 95,
  'قنا': 110,
  'الساحل الشمالي': 115,
};

/* Canonical names in the exact dropdown order. */
const GOVERNORATES = Object.keys(SHIPPING_RATES);

/* Normalise an Arabic governorate string so spelling variants coming from
   imports (ة/ه, أإآ/ا, ى/ي, a leading "محافظة", stray tashkeel/spaces) all
   collapse to one comparable key. */
function normalizeAr(s) {
  return String(s || '')
    .trim()
    .replace(/^محافظة\s+/, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ى]/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')   // tashkeel + tatweel
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/* normalized key → canonical name (built once). A couple of common aliases
   are added on top of the canonical spellings. */
const NORM_INDEX = (() => {
  const idx = {};
  for (const g of GOVERNORATES) idx[normalizeAr(g)] = g;
  const aliases = {
    'اسكندريه': 'الاسكندرية',
    'الساحل': 'الساحل الشمالي',
    'الساحل الشمالى': 'الساحل الشمالي',
    'الاقصر': 'الأقصر',
  };
  for (const [k, v] of Object.entries(aliases)) idx[normalizeAr(k)] = v;
  return idx;
})();

/* Resolve a raw City/governorate string → its canonical name, or null when it
   doesn't match any known governorate. */
function resolveGovernorate(city) {
  const key = normalizeAr(city);
  if (!key) return null;
  return NORM_INDEX[key] || null;
}

/* Shipping cost for a raw City string. Returns the flat rate for a recognised
   governorate, or null when the value is empty/unrecognised (caller decides
   what to do — we never guess a rate for an unknown place). */
function shippingRateFor(city) {
  const canonical = resolveGovernorate(city);
  if (!canonical) return null;
  return SHIPPING_RATES[canonical] ?? DEFAULT_SHIPPING;
}

module.exports = {
  DEFAULT_SHIPPING,
  SHIPPING_RATES,
  GOVERNORATES,
  normalizeAr,
  resolveGovernorate,
  shippingRateFor,
};
