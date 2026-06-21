/**
 * slugify.js — turn a business name (Arabic or Latin) into a URL-safe slug for
 * the public webhook URL, e.g. "سلعة" → "slaaa", "متجر النخبة" → "mtgr-alnkhba".
 *
 * Deterministic Arabic→Latin (franco) transliteration: Arabic has no written
 * short vowels, so the output is consonantal and may differ slightly from a
 * human franco spelling — that's fine, it only has to be stable + unique.
 */

/* Letter-by-letter transliteration map (long forms like kh/sh/th included). */
const AR_MAP = {
  'ا': 'a', 'أ': 'a', 'إ': 'a', 'آ': 'a', 'ٱ': 'a', 'ء': 'a', 'ى': 'a', 'ة': 'a',
  'ؤ': 'o', 'ئ': 'e',
  'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'g', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh',
  'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'aa', 'غ': 'gh',
  'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n',
  'ه': 'h', 'و': 'w', 'ي': 'y',
  /* Arabic-Indic digits → ASCII */
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

/**
 * @param {string} input    the source name (Arabic and/or Latin).
 * @param {string|number} [fallback]  used when the result is empty (e.g. the id).
 * @returns {string} lowercase a-z0-9 + single dashes, trimmed; '' only if no fallback.
 */
function slugify(input, fallback) {
  const s = String(input ?? '').trim();
  let out = '';
  for (const ch of s) {
    if (AR_MAP[ch] !== undefined)       out += AR_MAP[ch];      // Arabic letter/digit
    else if (/[a-zA-Z0-9]/.test(ch))    out += ch.toLowerCase(); // Latin/number
    else if (/[\s_\-./]/.test(ch))      out += '-';              // separators → dash
    /* everything else (tashkeel diacritics, punctuation, emoji) is dropped */
  }
  out = out.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (out) return out;
  return fallback != null ? slugify(String(fallback), null) || String(fallback) : '';
}

module.exports = { slugify };
