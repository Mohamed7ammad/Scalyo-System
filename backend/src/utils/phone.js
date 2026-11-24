/* ── Customer phone → WhatsApp number ────────────────────────────────────────
   orders."Phone" is free text, typed however the customer typed it. WhatsApp
   wants the full international number without "+": 201001488462.

   Same rules as the dashboard's click-to-call (frontend/src/lib/phone.ts →
   phoneCallTargets), so these all give 201001488462:
     01001488462 · +201001488462 · 00201001488462 · 201001488462 · +2 0100…
     1001488462 (0 lost) · 10014884620 (0 typed at the END — RTL inputs)
     ٠١٠٠١٤٨٨٤٦٢ (Arabic digits) · 010 0148 8462 · "01001488462 العنوان…"
   and a field holding two numbers ("010…#011…", "010…//011…") gives both.

   Only Egyptian MOBILES (010 / 011 / 012 / 015) come out. A landline, a foreign
   number or a typo gives nothing: we never message a number we aren't sure of.
   Pure — no I/O. */
'use strict';

const toLatinDigits = (s) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))    // Arabic-Indic
   .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));   // Persian

/* One Egyptian mobile at the START of a digit run: optional +/00, optional 20,
   optional trunk 0, then the 10-digit national mobile (captured). */
const MOBILE_AT_START = /^(?:\+|00)?(?:20)?0?(1[0125]\d{8})/;

/** Every Egyptian mobile in the value, as WhatsApp numbers ("2010…"). */
function whatsappNumbers(raw) {
  if (raw === null || raw === undefined) return [];
  /* spaces, dashes, dots and brackets live INSIDE numbers ("010 0148-8462");
     anything else (/, #, letters, commas) separates numbers */
  const s = toLatinDigits(String(raw)).replace(/[\s\-().]/g, '');
  const out = [];
  for (const run of s.match(/\+?\d+/g) || []) {
    let rest = run;
    for (;;) {                                // "010…011…" glued together → both
      const m = MOBILE_AT_START.exec(rest);
      if (!m) break;
      const n = `20${m[1]}`;
      if (!out.includes(n)) out.push(n);
      rest = rest.slice(m[0].length);
    }
  }
  return out;
}

/** The first Egyptian mobile in the value, or null. */
const whatsappNumber = (raw) => whatsappNumbers(raw)[0] || null;

/** "201001488462" → "01001488462" (how the team reads numbers). */
const localForm = (n) => (/^201[0125]\d{8}$/.test(String(n || '')) ? `0${String(n).slice(2)}` : String(n || ''));

module.exports = { whatsappNumbers, whatsappNumber, localForm };
