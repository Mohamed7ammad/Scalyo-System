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

/**
 * resolveMarketerCode — turn a raw inbound payload into a CANONICAL marketer code,
 * resolved against the tenant's KNOWN media-buyer referral codes.
 *
 * Why this exists: `utm_campaign` is the attribution source for EasyOrder affiliate
 * orders, but its value is often NOT a clean slug — it can be a full campaign name
 * that CONTAINS the buyer's name ("adham", "adham_botagaz_v2") or a bare Facebook
 * campaign id ("120245087774520218"). Returning that verbatim (the old behaviour)
 * either mis-attributes (full string ≠ 'adham') or invents junk numeric "marketers".
 *
 * Resolution order against `knownCodes` (the tenant's users.referral_code list):
 *   1. exact match (case-insensitive)                      → canonical known code
 *   2. the raw value CONTAINS a known code as a substring  → that known code
 *   3. raw is all-digits (a bare FB campaign id) → null (organic / main_account)
 *   4. otherwise keep the raw code (a new/unregistered buyer tag)
 *
 * Returns the canonical code, or null when nothing attributable is present.
 */
function resolveMarketerCode(body, knownCodes = []) {
  const raw = extractReferralCode(body);
  if (!raw) return null;

  const codes = (Array.isArray(knownCodes) ? knownCodes : [])
    .map((c) => String(c == null ? '' : c).trim())
    .filter(Boolean);
  const lower = raw.toLowerCase();

  const exact = codes.find((c) => c.toLowerCase() === lower);
  if (exact) return exact;

  /* Longest known code first so "adham_pro" beats "adham" when both are registered. */
  const contained = codes
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((c) => lower.includes(c.toLowerCase()));
  if (contained) return contained;

  if (/^\d+$/.test(raw)) return null;   // bare FB campaign id → not a marketer
  return raw;                           // unregistered buyer tag — keep as-is
}

module.exports = { extractReferralCode, resolveMarketerCode };
