/*
 * ════════════════════════════════════════════════════════════════════
 *  Governorate shipping rates — single source of truth (frontend)
 * ════════════════════════════════════════════════════════════════════
 *  MUST stay identical to backend/src/config/shippingRates.js. Flat per-ORDER
 *  shipping cost (EGP) added to the base product price when confirming a
 *  MISSING/lost order. Default 90 EGP; only the exceptions below differ.
 *  Drives the strict governorate <select> and the live client-side preview of
 *  the total price (the backend recompute on save is authoritative).
 */

const DEFAULT_SHIPPING = 90;

/* Canonical governorate → shipping cost (in the exact dropdown order). */
export const SHIPPING_RATES: Record<string, number> = {
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
export const GOVERNORATES: string[] = Object.keys(SHIPPING_RATES);

/* Normalise an Arabic governorate string so spelling variants (ة/ه, أإآ/ا,
   ى/ي, a leading "محافظة", tashkeel/tatweel/extra spaces) all compare equal. */
export function normalizeAr(s: string | null | undefined): string {
  return String(s ?? '')
    .trim()
    .replace(/^محافظة\s+/, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ً-ْـ]/g, '')   // tashkeel + tatweel
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const NORM_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {};
  for (const g of GOVERNORATES) idx[normalizeAr(g)] = g;
  const aliases: Record<string, string> = {
    'اسكندريه': 'الاسكندرية',
    'الساحل': 'الساحل الشمالي',
    'الساحل الشمالى': 'الساحل الشمالي',
    'الاقصر': 'الأقصر',
  };
  for (const k of Object.keys(aliases)) idx[normalizeAr(k)] = aliases[k];
  return idx;
})();

/* Raw City/governorate string → canonical name, or null when unrecognised. */
export function resolveGovernorate(city: string | null | undefined): string | null {
  const key = normalizeAr(city);
  if (!key) return null;
  return NORM_INDEX[key] ?? null;
}

/* Flat shipping cost for a raw City string; null when empty/unrecognised
   (caller decides — we never guess a rate for an unknown place). */
export function shippingRateFor(city: string | null | undefined): number | null {
  const canonical = resolveGovernorate(city);
  if (!canonical) return null;
  return SHIPPING_RATES[canonical] ?? DEFAULT_SHIPPING;
}

/* Total for a MISSING/lost order: base × qty (+ shipping when the governorate is
   recognised). Mirrors the backend rules exactly.
     • baseUnit null            → null  (no catalogue base ⇒ caller leaves price as-is)
     • city empty               → base × qty            (Rule A)
     • city recognised          → base × qty + shipping (Rules B / C)
     • city set but unrecognised → null (leave price unchanged — never guess)      */
export function computeLostOrderTotal(
  baseUnit: number | null,
  quantity: number,
  city: string | null | undefined,
): number | null {
  if (baseUnit == null || !(baseUnit > 0)) return null;
  const qty = Math.max(1, quantity || 1);
  const trimmed = String(city ?? '').trim();
  if (!trimmed) return Math.round(baseUnit * qty * 100) / 100;   // Rule A
  const rate = shippingRateFor(trimmed);
  if (rate == null) return null;                                 // unrecognised → leave
  return Math.round((baseUnit * qty + rate) * 100) / 100;        // Rules B / C
}
