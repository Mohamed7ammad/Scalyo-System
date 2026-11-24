'use client';

/* «الربط مع واتساب» — the owner connects the business WhatsApp number (official
   Meta WhatsApp Cloud API) in three steps: paste the keys, send a test message to
   his own phone, wire the webhook so delivery ticks and replies come back.
   Nothing on this page messages a customer. The saved token / app secret never
   come back to the browser — only "saved ✓ …last 4". */

import { useCallback, useEffect, useState } from 'react';
import {
  getWhatsAppSettings,
  saveWhatsAppSettings,
  checkWhatsApp,
  sendWhatsAppTest,
  getWhatsAppAccountLink,
  linkWhatsAppAccount,
  type WhatsAppAccountLink,
  type WhatsAppMessage,
  type WhatsAppSettingsResponse,
} from '@/lib/api';
import { serverNow } from '@/lib/serverClock';

type Toast = { message: string; type: 'success' | 'error' } | null;

const errMsg = (e: unknown, fallback: string) => {
  const err = e as { response?: { status?: number; data?: { error?: string } } };
  if (err?.response?.status === 403) return 'الصفحة دي للمدير بس';
  return err?.response?.data?.error || fallback;
};

const fmtDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('ar-EG-u-nu-latn', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo',
  });
};

/* "من 5 دقايق" — on the SERVER's clock, so a wrong phone clock can't lie. */
const fmtAgo = (iso: string | null) => {
  if (!iso) return '';
  const mins = Math.floor((serverNow() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'دلوقتي';
  if (mins === 1) return 'من دقيقة';
  if (mins < 60) return `من ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return 'من ساعة';
  if (hours < 24) return `من ${hours} ساعة`;
  return fmtDate(iso);
};

/* "2010…" → "010…" — how the team reads numbers */
const localPhone = (p: string) => (/^201[0125]\d{8}$/.test(p) ? `0${p.slice(2)}` : p);

const QUALITY: Record<string, { label: string; cls: string }> = {
  GREEN:  { label: 'عالية',  cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  YELLOW: { label: 'متوسطة', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  RED:    { label: 'ضعيفة',  cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
};

const STATUS: Record<string, { label: string; cls: string }> = {
  sending:   { label: 'بتتبعت…',   cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  sent:      { label: 'اتبعتت ✓',  cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  delivered: { label: 'وصلت ✓✓',   cls: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
  read:      { label: 'اتقرت ✓✓',  cls: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  failed:    { label: 'موصلتش ✗', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  received:  { label: 'من العميل', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
};

const KIND: Record<string, string> = {
  test: 'رسالة تجربة', confirm: 'تأكيد أوردر', reminder: 'تذكير',
  button: 'داس على زرار', text: 'كتب رسالة', reaction: 'تفاعل', other: 'بعت حاجة',
};

const inputCls = `w-full min-w-0 px-3 py-2 rounded-xl text-sm outline-none bg-white dark:bg-slate-800
  border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100
  focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-60`;
const primaryBtn = `inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
  bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors`;
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 sm:p-6 space-y-4 shadow-sm';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the field is selectable as a fallback */ }
  };
  return (
    <button type="button" onClick={copy}
      className="shrink-0 px-3 py-2 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors">
      {copied ? 'اتنسخ ✓' : 'نسخ'}
    </button>
  );
}

function StepTitle({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-sm font-bold
        ${done ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
        {done ? '✓' : n}
      </span>
      <h2 className="text-base font-bold text-slate-900 dark:text-white">{title}</h2>
    </div>
  );
}

/* Meta's menu path, kept left-to-right with "→" — inside Arabic text a bare
   "WhatsApp ← API Setup" gets reordered and its arrow points the wrong way. */
const Path = ({ children }: { children: string }) => (
  <bdi dir="ltr" className="font-medium text-slate-600 dark:text-slate-300">{children}</bdi>
);

function Field({ label, saved, help, children }: {
  label: string; saved?: string | null; help?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 mb-1">
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</label>
        {saved && (
          <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            متحفظ ✓ آخره <bdi dir="ltr" className="font-mono">{saved}</bdi> — سيبه فاضي لو مش هتغيّره
          </span>
        )}
      </div>
      {children}
      {help && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{help}</p>}
    </div>
  );
}

function MessageRow({ m }: { m: WhatsAppMessage }) {
  const st = STATUS[m.status] ?? STATUS.sent;
  const out = m.direction === 'out';
  return (
    <li className="py-3 flex items-start gap-3">
      <span className={`mt-0.5 w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm
        ${out ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'}`}
        title={out ? 'مننا للعميل' : 'من العميل لينا'}>
        {out ? '↖' : '↘'}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <bdi dir="ltr" className="font-mono text-sm text-slate-800 dark:text-slate-100">{localPhone(m.phone)}</bdi>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {KIND[m.kind] ?? m.kind}{m.template && m.kind !== 'test' ? ` · ${m.template}` : ''}
            {m.order_id ? ` · أوردر #${m.order_id}` : ''}
          </span>
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
        </div>
        {!out && m.reply && <p className="text-sm text-slate-700 dark:text-slate-200 break-words">«{m.reply}»</p>}
        {out && m.reply && <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">ردّ العميل: «{m.reply}»</p>}
        {m.status === 'failed' && m.error_text && (
          <p className="text-xs text-red-600 dark:text-red-400 break-words">{m.error_text}</p>
        )}
      </div>
      <span className="shrink-0 text-[11px] text-slate-400 mt-1">{fmtAgo(m.created_at)}</span>
    </li>
  );
}

export default function WhatsAppPage() {
  const [data, setData]         = useState<WhatsAppSettingsResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadErr] = useState('');
  const [toast, setToast]       = useState<Toast>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId]               = useState('');
  const [token, setToken]                 = useState('');
  const [secret, setSecret]               = useState('');
  const [showSecrets, setShowSecrets]     = useState(false);
  const [saving, setSaving]               = useState(false);
  const [formError, setFormErr]           = useState('');

  const [checking, setChecking] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting]     = useState(false);
  const [testError, setTestErr]   = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [link, setLink]         = useState<WhatsAppAccountLink | null>(null);
  const [linking, setLinking]   = useState(false);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const applyData = useCallback((d: WhatsAppSettingsResponse) => {
    setData(d);
    setPhoneNumberId(d.settings.phone_number_id ?? '');
    setWabaId(d.settings.waba_id ?? '');
  }, []);

  const load = useCallback(async () => {
    try {
      const { data: d } = await getWhatsAppSettings();
      applyData(d);
      setLoadErr('');
    } catch (e) {
      setLoadErr(errMsg(e, 'تعذّر تحميل الإعدادات'));
    } finally {
      setLoading(false);
    }
  }, [applyData]);

  useEffect(() => { load(); }, [load]);

  /* messages AND connection state (the webhook's «last received»), but never the
     form fields — the owner may be typing in them */
  const refreshMessages = useCallback(async (quiet = true) => {
    if (!quiet) setRefreshing(true);
    try {
      const { data: d } = await getWhatsAppSettings();
      setData(d);
    } catch { /* keep what's on screen */ } finally {
      if (!quiet) setRefreshing(false);
    }
  }, []);

  /* while the page is open and visible, delivery ticks and replies show up by themselves */
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) refreshMessages(true); }, 15000);
    return () => clearInterval(t);
  }, [refreshMessages]);

  const runCheck = async (silentSuccess = false) => {
    setChecking(true);
    try {
      const { data: r } = await checkWhatsApp();
      setData((cur) => (cur ? { ...cur, settings: r.settings } : cur));
      if (!silentSuccess) showToast('الاتصال بميتا شغال ✓', 'success');
      return true;
    } catch (e) {
      const err = e as { response?: { data?: { settings?: WhatsAppSettingsResponse['settings'] } } };
      const s = err?.response?.data?.settings;
      if (s) setData((cur) => (cur ? { ...cur, settings: s } : cur));
      showToast(errMsg(e, 'تعذّر فحص الاتصال'), 'error');
      return false;
    } finally {
      setChecking(false);
    }
  };

  const handleSave = async () => {
    setFormErr('');
    setSaving(true);
    try {
      const { data: d } = await saveWhatsAppSettings({
        phone_number_id: phoneNumberId.trim(),
        waba_id:         wabaId.trim(),
        access_token:    token.trim(),
        app_secret:      secret.trim(),
      });
      applyData(d);
      setToken('');
      setSecret('');
      setShowSecrets(false);
      const ok = await runCheck(true);
      if (ok) showToast('اتحفظ، والاتصال بميتا شغال ✓', 'success');
    } catch (e) {
      setFormErr(errMsg(e, 'تعذّر الحفظ'));
    } finally {
      setSaving(false);
    }
  };

  /* is the WhatsApp account linked to our Meta app? (asked once the keys are saved) */
  const canAskLink = !!data?.settings.configured && !!data?.settings.waba_id;
  useEffect(() => {
    if (!canAskLink) { setLink(null); return; }
    let off = false;
    getWhatsAppAccountLink()
      .then(({ data: d }) => { if (!off) setLink(d); })
      .catch(() => { /* the button below still works */ });
    return () => { off = true; };
  }, [canAskLink, data?.settings.updated_at]);

  const handleLink = async () => {
    setLinking(true);
    try {
      const { data: d } = await linkWhatsAppAccount();
      setLink(d);
      showToast(d.linked ? 'حساب الواتساب اتربط بالتطبيق ✓' : 'ميتا مأكدتش الربط — جرّب تاني', d.linked ? 'success' : 'error');
    } catch (e) {
      const msg = errMsg(e, 'تعذّر الربط');
      setLink({ linked: null, apps: [], error: msg });
      showToast(msg, 'error');
    } finally {
      setLinking(false);
    }
  };

  const handleTest = async () => {
    setTestErr('');
    setTesting(true);
    try {
      await sendWhatsAppTest(testPhone.trim());
      showToast('اتبعتت ✓ بص على الواتساب في التليفون', 'success');
    } catch (e) {
      setTestErr(errMsg(e, 'تعذّر إرسال الرسالة'));
    } finally {
      setTesting(false);
      refreshMessages(true);
    }
  };

  if (loading) {
    return (
      <div className="py-20 text-center">
        <div className="inline-block w-8 h-8 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
      </div>
    );
  }
  if (loadError || !data) {
    return <div className="max-w-3xl mx-auto px-4 py-10 text-sm text-red-600 dark:text-red-400" dir="rtl">{loadError || 'تعذّر تحميل الإعدادات'}</div>;
  }

  const s = data.settings;
  const connected = s.configured && !!s.display_phone && !s.last_check_error;
  const webhookWired = !!s.last_webhook_at;
  const quality = s.quality_rating ? QUALITY[s.quality_rating] : null;
  const secretType = showSecrets ? 'text' : 'password';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5" dir="rtl">
      {toast && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-lg max-w-[90vw] text-center
          text-white text-sm font-medium ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">الربط مع واتساب</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
          نربط رقم واتساب البيزنس بسكاليو عشان نبعت للعميل رسالة تأكيد الأوردر ونستقبل ردّه — عن طريق واتساب الرسمي من ميتا.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          {['مفيش رسايل بتروح للعملاء من الصفحة دي', 'المفاتيح متحفظة على السيرفر بس', 'للمدير بس'].map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
              bg-emerald-50 text-emerald-700 border border-emerald-200
              dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800/50">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {t}
            </span>
          ))}
        </div>
      </div>

      {/* Status */}
      <div className={`rounded-2xl border p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between
        ${connected ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-800/60 dark:bg-emerald-950/20'
          : s.last_check_error ? 'border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/20'
          : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60'}`}>
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-500' : s.last_check_error ? 'bg-red-500' : 'bg-slate-400'}`} />
            <span className="font-bold text-slate-900 dark:text-white">
              {connected ? 'متوصل' : s.last_check_error ? 'فيه مشكلة في الاتصال' : s.configured ? 'المفاتيح متحفظة — افحص الاتصال' : 'لسه مش متوصل'}
            </span>
          </div>
          {connected ? (
            <div className="text-sm text-slate-700 dark:text-slate-300 flex flex-wrap items-center gap-x-3 gap-y-1">
              <bdi dir="ltr" className="font-mono">{s.display_phone}</bdi>
              {s.verified_name && <span>«{s.verified_name}»</span>}
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${quality?.cls ?? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
                جودة الرقم: {quality?.label ?? 'لسه متقيّمتش'}
              </span>
            </div>
          ) : s.last_check_error ? (
            <p className="text-sm text-red-700 dark:text-red-300 leading-relaxed">{s.last_check_error}</p>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">اتبع الخطوات اللي تحت — هنعملها مع بعض.</p>
          )}
          {s.last_check_at && <p className="text-[11px] text-slate-400">آخر فحص: {fmtAgo(s.last_check_at)}</p>}
        </div>
        {s.configured && (
          <button type="button" onClick={() => runCheck(false)} disabled={checking}
            className="shrink-0 px-4 py-2 rounded-xl text-sm font-semibold border border-slate-300 dark:border-slate-700
              text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-50">
            {checking ? 'بيفحص…' : 'افحص الاتصال'}
          </button>
        )}
      </div>

      {/* 1 — keys */}
      <div className={card}>
        <StepTitle n={1} title="مفاتيح ميتا" done={s.configured} />
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          هتلاقيهم في صفحة التطبيق على <bdi dir="ltr">developers.facebook.com</bdi>. الزقهم هنا بإيدك ودوس حفظ —
          التوكن والـ App secret بيتحفظوا على السيرفر ومبيرجعوش للصفحة تاني.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Phone number ID" help={<>من <Path>WhatsApp → API Setup</Path>، تحت رقم التليفون</>}>
            <input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} dir="ltr" inputMode="numeric"
              autoComplete="off" placeholder="106540352242922" className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Messaging account ID" help={<>نفس الصفحة — ميتا بتسميه كمان <Path>WhatsApp Business Account ID</Path></>}>
            <input value={wabaId} onChange={(e) => setWabaId(e.target.value)} dir="ltr" inputMode="numeric"
              autoComplete="off" placeholder="102290129340398" className={`${inputCls} font-mono`} />
          </Field>
        </div>
        <Field label="Access token" saved={s.has_token ? s.token_hint : null}
          help={<>للتجربة: التوكن المؤقت من <Path>API Setup → Generate access token</Path> (بيخلص بعد ساعات). وبعدين الدائم من <Path>Business Settings → System users</Path>، بصلاحيات <Path>business_management</Path> و <Path>whatsapp_business_messaging</Path> و <Path>whatsapp_business_management</Path></>}>
          <input value={token} onChange={(e) => setToken(e.target.value)} dir="ltr" type={secretType}
            autoComplete="new-password" data-lpignore="true" data-1p-ignore spellCheck={false}
            placeholder={s.has_token ? '••••••••••••' : 'EAAG…'}
            className={`${inputCls} font-mono`} />
        </Field>
        <Field label="App secret" saved={s.has_app_secret ? s.app_secret_hint : null}
          help={<>من <Path>App settings → Basic → App secret</Path> (دوس <Path>Show</Path>). لازم عشان نقبل الردود اللي جاية من ميتا</>}>
          <input value={secret} onChange={(e) => setSecret(e.target.value)} dir="ltr" type={secretType}
            autoComplete="new-password" data-lpignore="true" data-1p-ignore spellCheck={false}
            placeholder={s.has_app_secret ? '••••••••••••' : '0123…cdef (32)'}
            className={`${inputCls} font-mono`} />
        </Field>
        <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
          <input type="checkbox" checked={showSecrets} onChange={(e) => setShowSecrets(e.target.checked)} className="w-4 h-4 accent-emerald-600" />
          إظهار اللي بكتبه
        </label>
        {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <button type="button" onClick={handleSave} disabled={saving || !phoneNumberId.trim() || (!s.has_token && !token.trim())}
            className={`w-full sm:w-auto ${primaryBtn}`}>
            {saving ? 'بيتحفظ…' : 'حفظ'}
          </button>
          {s.updated_at && <span className="text-[11px] text-slate-400">آخر تعديل: {fmtDate(s.updated_at)}</span>}
        </div>
      </div>

      {/* 2 — test message */}
      <div className={card}>
        <StepTitle n={2} title="رسالة تجربة لتليفونك" done={data.messages.some((m) => m.kind === 'test' && m.status !== 'failed')} />
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
          هنبعت رسالة <bdi dir="ltr">«Hello World»</bdi> الجاهزة من ميتا للرقم اللي هتكتبه، عشان نتأكد إن الربط شغال.
        </p>
        <div className="flex flex-col sm:flex-row items-stretch gap-2">
          <input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} dir="ltr" inputMode="tel" autoComplete="off"
            placeholder="01xxxxxxxxx" disabled={!s.configured} className={`${inputCls} sm:max-w-xs font-mono`}
            onKeyDown={(e) => { if (e.key === 'Enter' && testPhone.trim() && !testing) handleTest(); }} />
          <button type="button" onClick={handleTest} disabled={!s.configured || testing || !testPhone.trim()} className={primaryBtn}>
            {testing ? 'بيتبعت…' : 'ابعت'}
          </button>
        </div>
        {testError && <p className="text-sm text-red-600 dark:text-red-400 leading-relaxed">{testError}</p>}
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          {!s.configured ? 'احفظ المفاتيح الأول. ' : ''}
          لو لسه شغال برقم التجربة بتاع ميتا، ضيف رقمك الأول في قائمة الأرقام المسموح بيها
          (<Path>API Setup → To → Manage phone number list</Path>). الحد الأقصى {data.test_per_hour} رسايل تجربة في الساعة.
        </p>
      </div>

      {/* 3 — webhook */}
      <div className={card}>
        <StepTitle n={3} title="استقبال الردود وعلامات الوصول" done={webhookWired} />
        {!s.verify_token ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">احفظ المفاتيح الأول، وبعدها هيظهرلك هنا العنوان والكلمة اللي هتحطهم في ميتا.</p>
        ) : (
          <>
            <ol className="list-decimal pr-5 space-y-1 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              <li>في صفحة التطبيق على ميتا: «حالات الاستخدام» ثم «تخصيص» ثم «الخطوة 2. إعداد التشغيل»، وافتح سطر «تكوين Webhooks».</li>
              <li>الزق العنوان والكلمة دول، ودوس «التحقق والحفظ».</li>
              <li>في قايمة الحقول خلّي <Path>messages</Path> «مشترك».</li>
              <li>ارجع هنا ودوس «اربط دلوقتي» تحت.</li>
            </ol>
            <Field label="Callback URL">
              <div className="flex flex-col sm:flex-row items-stretch gap-2">
                <input readOnly value={data.webhook_url} dir="ltr" onFocus={(e) => e.currentTarget.select()} className={`${inputCls} font-mono text-xs sm:text-sm`} />
                <CopyButton text={data.webhook_url} />
              </div>
            </Field>
            <Field label="Verify token">
              <div className="flex flex-col sm:flex-row items-stretch gap-2">
                <input readOnly value={s.verify_token} dir="ltr" onFocus={(e) => e.currentTarget.select()} className={`${inputCls} font-mono text-xs sm:text-sm`} />
                <CopyButton text={s.verify_token} />
              </div>
            </Field>
            {!s.has_app_secret && (
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                لازم تحفظ الـ App secret في الخطوة 1، من غيره هنرفض أي حاجة جاية من ميتا.
              </p>
            )}
            <p className={`text-sm font-semibold ${webhookWired ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'}`}>
              {webhookWired ? `✓ ميتا بتبعتلنا — آخر حاجة وصلت ${fmtAgo(s.last_webhook_at)}` : 'لسه موصلش حاجة من ميتا'}
            </p>
            {/* the account ↔ app link: without it Meta sends its dashboard test only, never real events */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 sm:p-4 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">ربط حساب الواتساب بالتطبيق</div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mt-0.5">
                    من غير الربط ده ميتا مش بتبعتلنا علامات «وصلت / اتقرت» ولا ردود العملاء.
                  </p>
                </div>
                {link?.linked !== true && (
                  <button type="button" onClick={handleLink} disabled={linking || !s.waba_id} className={`shrink-0 ${primaryBtn}`}>
                    {linking ? 'بيربط…' : 'اربط دلوقتي'}
                  </button>
                )}
              </div>
              {link?.linked === true && (
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                  ✓ مربوط{link.apps.length ? <> — <bdi dir="ltr">{link.apps.join(', ')}</bdi></> : null}
                </p>
              )}
              {link?.linked === false && <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">لسه مش مربوط — دوس «اربط دلوقتي».</p>}
              {link?.error && <p className="text-xs text-red-600 dark:text-red-400 leading-relaxed">{link.error}</p>}
              {!s.waba_id && <p className="text-xs text-amber-700 dark:text-amber-300">اكتب الـ Messaging account ID في الخطوة 1 واحفظ الأول.</p>}
            </div>
          </>
        )}
      </div>

      {/* Log */}
      <div className={card}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-white">سجل الرسايل</h2>
          <button type="button" onClick={() => refreshMessages(false)} disabled={refreshing}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700
              text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
            {refreshing ? '…' : 'تحديث'}
          </button>
        </div>
        {!data.messages.length ? (
          <p className="text-sm text-slate-400 py-6 text-center">لسه مفيش رسايل</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.messages.map((m) => <MessageRow key={m.id} m={m} />)}
          </ul>
        )}
        {!webhookWired && data.messages.some((m) => m.direction === 'out') && (
          <p className="text-xs text-slate-500 dark:text-slate-400">علامات «وصلت» و«اتقرت» وردود العملاء بتظهر بعد الخطوة 3.</p>
        )}
      </div>
    </div>
  );
}
