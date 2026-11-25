/* ── WhatsApp message templates (roadmap step 5) ─────────────────────────────
   The texts the OWNER approved on 2026-11-25. A business-initiated WhatsApp
   message must be a template Meta has reviewed, so these are submitted once to
   the business's Messaging account and then sent with the order's values in
   {{1}}, {{2}}, …

   Both are UTILITY: they speak only about the order the customer just placed —
   no offer, no discount, no invitation to buy. Keep them that way: Meta
   re-labels anything promotional as MARKETING, which costs far more per message.

   To change a text later, add a NEW version (…_v2): Meta does not allow editing
   an approved template's meaning in place, and messages already sent keep the
   old one. Pure — no I/O. */
'use strict';

const LANGUAGE = 'ar';

const TEMPLATES = [
  {
    key:   'confirm',
    name:  'order_confirm_v1',
    title: 'رسالة تأكيد الأوردر',
    when:  'بتتبعت للعميل أول ما الأوردر ييجي',
    /* {{1}} name · {{2}} product · {{3}} quantity · {{4}} amount to collect · {{5}} governorate + address */
    body: (brand) => [
      'أهلًا {{1}} 👋',
      `استلمنا طلبك من ${brand}:`,
      '',
      '📦 المنتج: {{2}}',
      '🔢 الكمية: {{3}}',
      '💵 الإجمالي: {{4}} جنيه، الدفع عند الاستلام',
      '📍 العنوان: {{5}}',
      '',
      'لو البيانات صح دوس «تأكيد الطلب» عشان نشحنه لك على طول. ولو فيها حاجة محتاجة تعديل دوس «طلب الدعم» وهنكلمك.',
    ].join('\n'),
    example: ['منى عادل', 'داش كام', '1', '1,210', 'الجيزة، الدقي، 12 شارع المساحة، الدور الثالث'],
    buttons: ['تأكيد الطلب', 'إلغاء الطلب', 'طلب الدعم'],
  },
  {
    key:   'reminder',
    name:  'order_confirm_reminder_v1',
    title: 'رسالة التذكير',
    when:  'مرة واحدة للعميل اللي مردّش على رسالة التأكيد',
    /* {{1}} name · {{2}} product · {{3}} amount to collect */
    body: () => [
      'أهلًا {{1}}، لسه مستنيين تأكيدك على طلب {{2}} بإجمالي {{3}} جنيه.',
      'دوس «تأكيد الطلب» عشان نشحنه لك، أو «إلغاء الطلب» لو مش محتاجه دلوقتي.',
    ].join('\n'),
    example: ['منى عادل', 'داش كام', '1,210'],
    buttons: ['تأكيد الطلب', 'إلغاء الطلب'],
  },
];

const cleanBrand = (brand) => String(brand || '').replace(/[\r\n\t{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/* Meta's limits, checked before we ever call them (a rejected submit costs a review round). */
function validate(text, t) {
  const problems = [];
  const nums = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const want = t.example.map((_, i) => i + 1);
  if (JSON.stringify([...new Set(nums)].sort((a, b) => a - b)) !== JSON.stringify(want)) problems.push('variables must be {{1}}…{{n}} with one example each');
  if (text.length > 1024) problems.push('body is over 1024 characters');
  if (/^\{\{\d+\}\}/.test(text) || /\{\{\d+\}\}$/.test(text)) problems.push('body cannot start or end with a variable');
  if (/\n{3,}/.test(text)) problems.push('no more than one empty line in a row');
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(text)) problems.push('two variables cannot touch');
  if (t.buttons.length > 3) problems.push('at most 3 quick replies here');
  for (const b of t.buttons) if (b.length > 25) problems.push(`button «${b}» is over 25 characters`);
  return problems;
}

/** The templates for one business, ready to show and to submit. */
function build(brand) {
  const b = cleanBrand(brand);
  if (!b) throw Object.assign(new Error('اكتب اسم البراند في «بروفايل البيزنس» الأول'), { status: 400 });
  return TEMPLATES.map((t) => {
    const body = t.body(b);
    const problems = validate(body, t);
    if (problems.length) throw new Error(`template ${t.name}: ${problems.join('; ')}`);
    return { key: t.key, name: t.name, title: t.title, when: t.when, language: LANGUAGE, category: 'UTILITY',
      body, example: [...t.example], buttons: [...t.buttons] };
  });
}

/** What Meta's "create template" call takes. */
function toMetaPayload(t) {
  return {
    name:     t.name,
    language: t.language,
    category: t.category,
    components: [
      { type: 'BODY', text: t.body, example: { body_text: [t.example] } },
      { type: 'BUTTONS', buttons: t.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) },
    ],
  };
}

/** The body as the customer will read it, with the example values filled in. */
const preview = (t) => t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => t.example[Number(n) - 1] ?? '');

module.exports = { LANGUAGE, build, toMetaPayload, preview, validate, cleanBrand };
