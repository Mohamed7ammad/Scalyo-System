/**
 * referral.js — extract a Media-Buyer referral code (UTM / Sub-ID) from an
 * inbound order payload (EasyOrder webhook, landing-page POST, Google-Sheet row).
 *
 * The referral code is the buyer's unique tag appended to their ad links. It can
 * arrive under many names, so we scan a PRIORITISED set of keys:
 *   1. explicit referral fields  (referral_code, sub_id, aff_sub, …)
 *   2. UTM fields                (utm_content, utm_term, utm_campaign)
 *   3. nested containers         (utm{}, tracking{}, attribution{}, …)
 *   4. custom_fields[] arrays    ({ name|key, value })
 *
 * We deliberately do NOT read a bare `ref` key — the EasyOrder ingest already
 * uses `body.ref` as an order-id fallback, so reusing it would mis-attribute.
 *
 * Returns the trimmed code (≤100 chars to fit users/orders.referral_code) or
 * null when nothing usable is present.
 */
function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, 100);
}

function extractReferralCode(body) {
  if (!body || typeof body !== 'object') return null;

  /* 1 + 2 — explicit referral/sub-id first, then standard UTM slots. */
  const direct =
    body.referral_code ?? body.referralCode ?? body.referral ??
    body.sub_id ?? body.subId ?? body.subid ?? body.sub1 ?? body.s1 ??
    body.aff_sub ?? body.affSub ?? body.affiliate_id ?? body.affiliateId ??
    body.utm_content ?? body.utm_term ?? body.utm_campaign ?? null;
  const directClean = clean(direct);
  if (directClean) return directClean;

  /* 3 — nested containers commonly used by landing pages / EasyOrder. */
  for (const container of [body.utm, body.tracking, body.attribution, body.meta, body.marketing]) {
    if (container && typeof container === 'object') {
      const v = clean(
        container.referral_code ?? container.sub_id ?? container.subId ??
        container.content ?? container.term ?? container.campaign ?? null
      );
      if (v) return v;
    }
  }

  /* 4 — custom_fields: [{ name|key|label, value }]. */
  const cf = body.custom_fields ?? body.customFields ?? body.fields ?? null;
  if (Array.isArray(cf)) {
    for (const item of cf) {
      const key = String(item?.name ?? item?.key ?? item?.label ?? '').toLowerCase();
      if (/(referral|sub[_-]?id|utm[_-]?content|utm[_-]?term|aff[_-]?sub)/.test(key)) {
        const v = clean(item?.value ?? item?.val ?? null);
        if (v) return v;
      }
    }
  }

  return null;
}

/* Every payload field that can carry a media-buyer tag. FB Ads frequently
   misplaces the campaign name into utm_source / utm_medium / referrer instead of
   utm_campaign, so we scan ALL of them (top-level + nested utm{}/tracking{}). */
const TRACKING_KEYS = [
  'utm_campaign', 'utm_source', 'utm_medium', 'utm_content', 'utm_term',
  'campaign_name', 'campaign', 'referral_code', 'referralCode', 'referral',
  'referrer', 'ref_source', 'source', 'sub_id', 'subId', 'subid', 'aff_sub',
];

/* Collect every tracking string present in the payload (top-level, nested
   containers, and custom_fields[]), lower-cased, for substring scanning. */
function collectTrackingStrings(body) {
  const out = [];
  const push = (v) => { if (v != null && String(v).trim() !== '') out.push(String(v).trim().toLowerCase()); };
  if (!body || typeof body !== 'object') return out;
  for (const k of TRACKING_KEYS) push(body[k]);
  for (const c of [body.utm, body.tracking, body.attribution, body.meta, body.marketing]) {
    if (c && typeof c === 'object') for (const k of TRACKING_KEYS) push(c[k]);
  }
  const cf = body.custom_fields ?? body.customFields ?? body.fields ?? null;
  if (Array.isArray(cf)) for (const item of cf) push(item?.value ?? item?.val);
  return out;
}

/**
 * resolveMarketerCode — turn a raw inbound payload into a CANONICAL marketer code,
 * resolved against the tenant's KNOWN media-buyer referral codes.
 *
 * Why this exists: media-buyer tags arrive dirty. The value can be a full campaign
 * name CONTAINING the buyer's name ("adham", "adham_botagaz_v2"), a bare Facebook
 * campaign id ("120245087774520218"), and FB often drops the tag into the WRONG
 * field (utm_source/utm_medium/referrer instead of utm_campaign). Returning a
 * single field verbatim mis-attributes or invents junk numeric "marketers".
 *
 * Resolution against `knownCodes` (the tenant's users.referral_code list):
 *   1. Scan EVERY tracking field for a known code as an exact value or substring
 *      (case-insensitive, longest known code wins) → that canonical known code.
 *   2. Else fall back to the single best extract (extractReferralCode): keep an
 *      unregistered non-numeric tag; drop a bare all-digit FB campaign id → null.
 *
 * Returns the canonical code, or null when nothing attributable is present.
 */
function resolveMarketerCode(body, knownCodes = []) {
  const codes = (Array.isArray(knownCodes) ? knownCodes : [])
    .map((c) => String(c == null ? '' : c).trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);   // longest first → "adham_pro" beats "adham"

  /* 1 — aggressive, but token-aware so a SHORT code can't hijack an unrelated word
     (e.g. code 'sara' must NOT match 'mascara'). A field matches a code when:
       • the whole field equals the code, OR
       • a token (field split on non-alphanumerics) equals the code — this is what
         catches "adham_botagaz", "facebook.com/adham", "adham|stove", OR
       • the code is ≥5 chars and appears as a substring of a token (kept aggressive
         for real name-slugs like 'adham' → 'adhamx', where a 5+ char coincidence is
         negligible). Shorter codes require an exact token to avoid false positives. */
  const haystacks = collectTrackingStrings(body);
  const matches = (field, needle) => {
    if (field === needle) return true;
    const tokens = field.split(/[^a-z0-9]+/i).filter(Boolean);
    if (tokens.includes(needle)) return true;
    return needle.length >= 5 && tokens.some((t) => t.includes(needle));
  };
  for (const code of codes) {
    const needle = code.toLowerCase();
    if (haystacks.some((h) => matches(h, needle))) return code;
  }

  /* 2 — fall back to the single best raw extract. */
  const raw = extractReferralCode(body);
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return null;   // bare FB campaign id → not a marketer
  return raw;                           // unregistered buyer tag — keep as-is
}

module.exports = { extractReferralCode, resolveMarketerCode };
