/* ── Click-to-call ──────────────────────────────────────────────────────────
   Turns a stored customer phone — in whatever shape the customer typed it —
   into `tel:` links that dial correctly from any phone.

   phoneCallTargets() picks out every Egyptian mobile (010 / 011 / 012 / 015)
   in the value, so these all dial +201001488462:
     01001488462 · +201001488462 · 00201001488462 · 201001488462 · +2 0100…
     1001488462 (0 lost) · 10014884620 (0 typed at the END — RTL inputs)
     ٠١٠٠١٤٨٨٤٦٢ (Arabic digits) · 010 0148 8462 · "01001488462 العنوان…"
   and a field holding two numbers ("010…#011…", "010…//011…", "010…011…")
   gives two targets. Anything else (landline, foreign, typo) falls back to
   telHref(), which dials it as written.
   Pure — no React, no DOM. No regex lookbehind (unsupported on older iPhones). */

const toLatinDigits = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))     // Arabic-Indic
   .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));    // Persian

/** Single `tel:` link for any number, or null when it has too few digits. */
export function telHref(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = toLatinDigits(String(raw)).trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return null;

  /* Egyptian national number without the trunk 0 (mobile 1x…, landline 2…/3…/…) */
  let national: string | null = null;
  if (digits.startsWith('0020'))                                      national = digits.slice(4);
  else if (digits.startsWith('20') && (plus || digits.length >= 12))  national = digits.slice(2);
  else if (digits.startsWith('0') && !digits.startsWith('00'))        national = digits.slice(1);   // also «+0102…»
  else if (!plus && digits.length === 10 && digits.startsWith('1'))   national = digits;
  if (national && national.startsWith('0')) national = national.slice(1);   // «20 0109…»: trunk 0 typed after the code

  if (national && national.length >= 8 && national.length <= 10) return `tel:+20${national}`;
  if (plus || digits.startsWith('00')) return `tel:${plus ? '+' : ''}${digits}`;   // explicit international
  if (digits.length >= 11 && /^[2-9]/.test(digits)) return `tel:+${digits}`;      // foreign number typed without + (e.g. 2499…)
  return `tel:${digits}`;                                                          // unrecognised — dial as typed
}

export interface CallTarget {
  /** The number as shown next to its button (local form for Egyptian mobiles). */
  number: string;
  href:   string;
}

/* One Egyptian mobile at the START of a digit run: optional +/00, optional 20,
   optional trunk 0, then the 10-digit national mobile (captured). */
const MOBILE_AT_START = /^(?:\+|00)?(?:20)?0?(1[0125]\d{8})/;

/** Every number to offer a call button for — usually one. */
export function phoneCallTargets(raw: string | number | null | undefined): CallTarget[] {
  if (raw === null || raw === undefined) return [];
  /* spaces, dashes, dots and brackets live INSIDE numbers ("010 0148-8462");
     anything else (/, #, letters, commas) separates numbers */
  const s = toLatinDigits(String(raw)).replace(/[\s\-().]/g, '');
  const out: CallTarget[] = [];
  const seen = new Set<string>();
  for (const run of s.match(/\+?\d+/g) || []) {
    let rest = run;
    for (;;) {                                // "010…011…" glued together → both
      const m = MOBILE_AT_START.exec(rest);
      if (!m) break;
      const national = m[1];
      if (!seen.has(national)) {
        seen.add(national);
        out.push({ number: `0${national}`, href: `tel:+20${national}` });
      }
      rest = rest.slice(m[0].length);
    }
  }
  if (out.length) return out;
  const href = telHref(raw);
  return href ? [{ number: String(raw).trim(), href }] : [];
}
