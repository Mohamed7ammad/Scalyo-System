'use strict';

/* ── Email normalisation ──────────────────────────────────────────────────────
   Emails copied out of Arabic (RTL) text often carry INVISIBLE characters —
   e.g. U+200F RIGHT-TO-LEFT MARK or U+202C POP DIRECTIONAL FORMATTING — that are
   saved into the DB and then silently break login (the typed email no longer
   matches). A valid email can never contain whitespace or formatting/control
   characters, so strip them all and lowercase:
     \p{Cf}  format chars   → U+200B–U+200F, U+202A–U+202E, U+2060–U+2064,
                               U+2066–U+206F, U+FEFF (BOM), U+00AD (soft hyphen)
     \p{Cc}  control chars  → tabs, newlines, NUL …
     \p{Z}   separators     → spaces incl. NBSP U+00A0, U+2000–U+200A, U+2028/9, U+3000
   Used on EVERY email that enters the system: staff create/edit, register,
   login and OTP verification — so stored and typed values always compare equal. */
const INVISIBLE_OR_SPACE = /[\p{Cf}\p{Cc}\p{Z}\s]/gu;

function normalizeEmail(raw) {
  return String(raw ?? '').replace(INVISIBLE_OR_SPACE, '').toLowerCase();
}

module.exports = { normalizeEmail };
