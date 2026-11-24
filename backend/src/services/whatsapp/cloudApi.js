/* ── WhatsApp Cloud API client (Meta Graph API) ──────────────────────────────
   The official API, called with the token the owner saved on «الربط مع واتساب».
   Every Meta error comes back as a GraphError whose message is plain Arabic the
   owner can act on. The token is never logged and never put in an error. */
'use strict';

const GRAPH      = 'https://graph.facebook.com';
const VERSION    = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
const TIMEOUT_MS = 15000;

let fetchImpl = (...a) => globalThis.fetch(...a);
function _setFetchForTests(fn) { fetchImpl = fn; }

const SAME_RATE = 'بعتنا رسايل كتير بسرعة — استنى شوية وجرّب تاني.';
const NO_PERMISSION = 'التوكن ده مالوش صلاحية على واتساب — وانت بتعمله اختار whatsapp_business_messaging و whatsapp_business_management.';

/* Meta error code → what the owner should do. Unknown codes fall back to Meta's own text. */
const FRIENDLY = {
  190:    'التوكن انتهى أو اتلغى — اعمل توكن جديد من ميتا والزقه هنا.',
  10:     NO_PERMISSION,
  200:    NO_PERMISSION,
  100:    'ميتا رفضت الطلب لأن فيه رقم غلط — راجع الـ Phone number ID.',
  4:      SAME_RATE,
  80007:  SAME_RATE,
  130429: SAME_RATE,
  131056: 'بعتنا لنفس الرقم رسايل كتير ورا بعض — استنى شوية.',
  131030: 'الرقم ده مش في قائمة أرقام التجربة على ميتا — ضيفه الأول من صفحة API Setup، عند Manage phone number list.',
  131026: 'الرسالة موصلتش — الرقم ده غالبًا مالوش واتساب.',
  131047: 'مينفعش نبعت رسالة عادية بعد 24 ساعة من آخر رسالة من العميل — لازم رسالة متوافق عليها من ميتا (قالب).',
  131042: 'فيه مشكلة في الدفع على حساب الواتساب — راجع كارت الدفع في WhatsApp Manager.',
  131031: 'حساب الواتساب ده مقفول أو موقوف من ميتا.',
  133010: 'الرقم لسه مش متسجل على WhatsApp Cloud API.',
  132000: 'عدد البيانات اللي في الرسالة مش مطابق للقالب.',
  132001: 'القالب ده مش موجود أو لغته مختلفة — راجع اسمه ولغته في WhatsApp Manager.',
  368:    'ميتا موقفة الحساب مؤقتًا بسبب مخالفة لسياساتها.',
};

class GraphError extends Error {
  constructor({ message, code = null, subcode = null, details = null, httpStatus = null, metaMessage = null }) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
    this.subcode = subcode;
    this.details = details;
    this.httpStatus = httpStatus;
    this.metaMessage = metaMessage;
  }
}

function friendlyMessage(code, metaMessage) {
  if (code !== null && code !== undefined && FRIENDLY[code]) return FRIENDLY[code];
  return metaMessage ? `ميتا ردّت: ${String(metaMessage).slice(0, 300)}` : 'ميتا رفضت الطلب من غير سبب واضح.';
}

function toGraphError(httpStatus, err) {
  const code = Number.isInteger(err?.code) ? err.code : null;
  return new GraphError({
    message:     friendlyMessage(code, err?.message),
    code,
    subcode:     err?.error_subcode ?? null,
    details:     err?.error_data?.details ?? null,
    httpStatus,
    metaMessage: err?.message ?? null,
  });
}

async function graph(settings, method, path, body) {
  if (!settings?.access_token) throw new GraphError({ message: 'الزق التوكن الأول وبعدين احفظ.', code: 'missing_token' });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${GRAPH}/${VERSION}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${settings.access_token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok || data?.error) throw toGraphError(res.status, data?.error || { message: `HTTP ${res.status}` });
    return data;
  } catch (e) {
    if (e instanceof GraphError) throw e;
    if (e?.name === 'AbortError') throw new GraphError({ message: 'ميتا مردّتش في 15 ثانية — جرّب تاني.', code: 'timeout' });
    throw new GraphError({ message: 'مقدرناش نوصل لميتا دلوقتي — جرّب تاني بعد شوية.', code: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

/** The number behind the saved Phone number ID — proves the id + token work. */
async function checkPhoneNumber(settings) {
  return graph(settings, 'GET',
    `${encodeURIComponent(settings.phone_number_id)}?fields=display_phone_number,verified_name,quality_rating`);
}

/* Meta: without a leading "+", the BUSINESS number's country code is prepended
   (a US test number would turn 2010… into +12010…). Always send "+2010…". */
const withPlus = (to) => (String(to).startsWith('+') ? String(to) : `+${to}`);

/** Send an approved template to one WhatsApp number ("2010…" or "+2010…"). */
async function sendTemplate(settings, { to, name, language, components }) {
  const data = await graph(settings, 'POST', `${encodeURIComponent(settings.phone_number_id)}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                withPlus(to),
    type:              'template',
    template: {
      name,
      language: { code: language },
      ...(components && components.length ? { components } : {}),
    },
  });
  return {
    wa_id:          data?.contacts?.[0]?.wa_id ?? null,
    message_id:     data?.messages?.[0]?.id ?? null,
    message_status: data?.messages?.[0]?.message_status ?? null,
  };
}

/* Meta only delivers a WhatsApp account's real events (delivery reports, customer
   messages) to apps that account is SUBSCRIBED to — the dashboard's webhook
   fields alone are not enough. These two read and create that link. */
async function listSubscribedApps(settings) {
  const data = await graph(settings, 'GET', `${encodeURIComponent(settings.waba_id)}/subscribed_apps`);
  return (data?.data || []).map((a) => ({
    id:   a?.whatsapp_business_api_data?.id ? String(a.whatsapp_business_api_data.id) : null,
    name: a?.whatsapp_business_api_data?.name || null,
  }));
}

/** The Meta app this token belongs to — "our" app in the subscribed list. */
async function ownApp(settings) {
  const data = await graph(settings, 'GET', 'app?fields=id,name');
  return { id: data?.id ? String(data.id) : null, name: data?.name || null };
}

async function subscribeApp(settings) {
  const data = await graph(settings, 'POST', `${encodeURIComponent(settings.waba_id)}/subscribed_apps`);
  return data?.success === true;
}

module.exports = { GRAPH, VERSION, GraphError, friendlyMessage, toGraphError, checkPhoneNumber, sendTemplate,
  listSubscribedApps, subscribeApp, ownApp, _setFetchForTests };
