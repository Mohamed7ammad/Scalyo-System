'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getBostaSettings, saveBostaSettings } from '@/lib/api';
import type { BostaSettings } from '@/lib/api';

/* ══════════════════════════════════════════════════════════════════════════
   Tiny shared helpers
   ══════════════════════════════════════════════════════════════════════════ */

/** Formats an ISO timestamp as Arabic locale time (HH:MM) */
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('ar-EG', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   StatusBadge
   ══════════════════════════════════════════════════════════════════════════ */
function StatusBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
      bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200
      dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-800/60">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      متصل
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
      bg-amber-100 text-amber-700 ring-1 ring-amber-200
      dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-800/60">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      غير مكتمل
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Alert
   ══════════════════════════════════════════════════════════════════════════ */
interface AlertProps {
  type:      'success' | 'error' | 'info';
  children:  React.ReactNode;
  onDismiss?: () => void;
}
function Alert({ type, children, onDismiss }: AlertProps) {
  const s = {
    success: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-300',
    error:   'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800/50 text-rose-700 dark:text-rose-300',
    info:    'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800/50 text-blue-700 dark:text-blue-300',
  }[type];

  const icons = {
    success: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    error: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    info: (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  };

  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${s}`}>
      {icons[type]}
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100 transition-opacity">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Spinner
   ══════════════════════════════════════════════════════════════════════════ */
function Spin({ cls = 'w-4 h-4' }: { cls?: string }) {
  return (
    <svg className={`${cls} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   PasswordField — a reusable input with show/hide toggle
   ══════════════════════════════════════════════════════════════════════════ */
interface PasswordFieldProps {
  id:          string;
  label:       string;
  sublabel:    string;
  placeholder: string;
  value:       string;
  onChange:    (v: string) => void;
  savedPreview?: string | null;   // e.g. "261d13********************"
  required?:   boolean;
}
function PasswordField({
  id, label, sublabel, placeholder, value, onChange, savedPreview, required,
}: PasswordFieldProps) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
        {label}
        {required && <span className="text-rose-500 mr-0.5">*</span>}
      </label>
      <div className="relative">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          placeholder={
            savedPreview && !value
              ? `المحفوظ: ${savedPreview}`
              : placeholder
          }
          value={value}
          onChange={(e) => onChange(e.target.value)}
          dir="ltr"
          className="w-full rounded-xl border border-slate-200 dark:border-slate-600
            bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white
            px-4 py-2.5 pl-12 text-sm font-mono
            focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-400
            placeholder:text-slate-400 dark:placeholder:text-slate-600"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute left-3 top-1/2 -translate-y-1/2
            text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          title={show ? 'إخفاء' : 'إظهار'}
        >
          {show ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-600">{sublabel}</p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Page
   ══════════════════════════════════════════════════════════════════════════ */
export default function BostaIntegrationPage() {
  const router = useRouter();

  /* ── State ──────────────────────────────────────────────────────────── */
  const [settings,    setSettings]   = useState<BostaSettings | null>(null);
  const [loadingCfg,  setLoadingCfg] = useState(true);

  /* Credential form */
  const [apiKey,         setApiKey]         = useState('');
  const [bearerToken,    setBearerToken]     = useState('');
  const [webhookSecret,  setWebhookSecret]   = useState('');
  const [loginEmail,     setLoginEmail]      = useState('');
  const [loginPassword,  setLoginPassword]   = useState('');
  const [saving,         setSaving]          = useState(false);
  const [saveMsg,        setSaveMsg]         = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  /* ── Admin guard ─────────────────────────────────────────────────── */
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || '{}');
      if (u.role !== 'admin') router.replace('/dashboard');
    } catch { router.replace('/dashboard'); }
  }, [router]);

  /* ── Load existing settings ──────────────────────────────────────── */
  const loadSettings = useCallback(async () => {
    setLoadingCfg(true);
    try {
      const { data } = await getBostaSettings();
      setSettings(data);
      /* Leave credential fields blank on load — user must type to change.
         The masked preview from the server is shown as placeholder text.    */
    } catch {
      /* Non-fatal — page still usable without pre-fill */
    } finally {
      setLoadingCfg(false);
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  /* ── Save ────────────────────────────────────────────────────────── */
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    /* Require at least one field to be non-empty on first save */
    if (!settings?.configured && !apiKey.trim() && !bearerToken.trim()) {
      setSaveMsg({ type: 'error', text: 'أدخل API Key أو Bearer Token على الأقل للبدء.' });
      return;
    }

    setSaving(true);
    setSaveMsg(null);
    try {
      await saveBostaSettings({
        provider_name:  'bosta',
        api_key:        apiKey.trim(),        // '' = keep existing (backend COALESCE)
        bearer_token:   bearerToken.trim(),
        webhook_secret: webhookSecret.trim(),
        email:          loginEmail.trim(),
        password:       loginPassword.trim(),
        is_active:      true,
      });
      setSaveMsg({ type: 'success', text: 'تم حفظ بيانات Bosta بنجاح ✓' });
      /* Clear fields after save — treat like password inputs */
      setApiKey('');
      setBearerToken('');
      setWebhookSecret('');
      setLoginEmail('');
      setLoginPassword('');
      await loadSettings(); // refresh masked previews
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveMsg({ type: 'error', text: msg || 'فشل الحفظ. حاول مجدداً.' });
    } finally {
      setSaving(false);
    }
  };

  /* ── Derived display values ──────────────────────────────────────── */
  const isFullyConfigured =
    !!settings?.configured &&
    !!settings?.api_key &&
    !!settings?.bearer_token;

  /* ══════════════════════════════════════════════════════════════════
     Render
     ══════════════════════════════════════════════════════════════════ */
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 p-4 sm:p-6 lg:p-8" dir="rtl">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* ── Page header ────────────────────────────────────────────── */}
        <div className="flex items-start gap-4">
          {/* Bosta truck icon with orange gradient */}
          <div className="w-12 h-12 rounded-2xl shrink-0 flex items-center justify-center shadow-lg
            bg-gradient-to-br from-orange-400 via-orange-500 to-red-500
            shadow-orange-500/25 dark:shadow-orange-900/40">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
              الربط مع Bosta
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-500 mt-0.5">
              إنشاء الشحنات تلقائياً وتتبع الإيصالات وتحديث المخزون عند الإرجاع
            </p>
          </div>
          {!loadingCfg && settings && (
            <div className="mr-auto pt-1">
              <StatusBadge configured={isFullyConfigured} />
            </div>
          )}
        </div>

        {/* ── Credentials card ───────────────────────────────────────── */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white dark:bg-slate-900 overflow-hidden">

          {/* Card header */}
          <div className="flex items-center gap-3 px-6 py-4
            border-b border-slate-200/60 dark:border-slate-700/40
            bg-slate-50/60 dark:bg-slate-800/40">
            <div className="w-8 h-8 rounded-lg bg-orange-100 dark:bg-orange-900/40 flex items-center justify-center">
              <svg className="w-4 h-4 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-slate-800 dark:text-slate-200">بيانات الاتصال</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-500">
                {settings?.configured && settings?.updated_at
                  ? `آخر تحديث: ${fmtDate(settings.updated_at)}`
                  : 'لم يتم الإعداد بعد — أدخل البيانات أدناه'}
              </p>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSave} className="px-6 py-5 space-y-5">

            {/* API Key */}
            <PasswordField
              id="bosta-api-key"
              label="API Key"
              sublabel="مفتاح API لإنشاء الشحنات من خلال لوحة التحكم."
              placeholder="261d13563f..."
              value={apiKey}
              onChange={setApiKey}
              savedPreview={settings?.api_key}
              required
            />

            {/* Bearer Token */}
            <PasswordField
              id="bosta-bearer-token"
              label="Bearer Token"
              sublabel="يُستخدم لجلب تقييم العميل (Consignee Ranking) من Bosta. يجب أن يبدأ بـ Bearer."
              placeholder="Bearer eyJhbGci..."
              value={bearerToken}
              onChange={setBearerToken}
              savedPreview={settings?.bearer_token}
              required
            />

            {/* Webhook Secret */}
            <PasswordField
              id="bosta-webhook-secret"
              label="Webhook Secret"
              sublabel="اختياري — إذا ضبطته في لوحة Bosta، أدخله هنا لتأمين التحديثات الواردة."
              placeholder="whsec_..."
              value={webhookSecret}
              onChange={setWebhookSecret}
              savedPreview={settings?.webhook_secret}
            />

            {/* ── Auto-login section ──────────────────────────────────────
               Bosta dashboard tokens expire often. Storing the login email +
               password lets the server refresh the Bearer token automatically
               whenever the wallet / follow-ups requests hit a 401.            */}
            <div className="pt-2 border-t border-slate-200/60 dark:border-slate-700/40">
              <div className="flex items-center gap-2 mb-3 mt-3">
                <svg className="w-4 h-4 text-orange-500 dark:text-orange-400 shrink-0"
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                  تسجيل الدخول التلقائي (لتجديد التوكن تلقائياً)
                </p>
              </div>

              {/* Login email */}
              <div className="mb-4">
                <label htmlFor="bosta-email" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  البريد الإلكتروني للوحة Bosta
                </label>
                <input
                  id="bosta-email"
                  type="email"
                  dir="ltr"
                  placeholder={settings?.email ? `المحفوظ: ${settings.email}` : 'name@company.com'}
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-600
                    bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white
                    px-4 py-2.5 text-sm
                    focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-400
                    placeholder:text-slate-400 dark:placeholder:text-slate-600"
                />
                <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-600">
                  نفس البريد الذي تستخدمه لتسجيل الدخول على business.bosta.co
                </p>
              </div>

              {/* Login password */}
              <PasswordField
                id="bosta-password"
                label="كلمة مرور لوحة Bosta"
                sublabel="تُخزَّن بشكل آمن وتُستخدم فقط لتجديد التوكن تلقائياً عند انتهاء صلاحيته."
                placeholder={settings?.password_set ? 'محفوظة — اتركها فارغة للإبقاء عليها' : '••••••••'}
                value={loginPassword}
                onChange={setLoginPassword}
              />
            </div>

            {/* Note about partial updates */}
            <div className="flex items-start gap-2.5 p-3 rounded-xl
              bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/40">
              <svg className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0 mt-0.5"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-[11px] text-slate-500 dark:text-slate-500 leading-relaxed">
                اترك أي حقل فارغاً لإبقاء القيمة المحفوظة دون تغيير.
                لن يؤدي الحفظ بحقل فارغ إلى حذف البيانات الموجودة.
              </p>
            </div>

            {/* Alert */}
            {saveMsg && (
              <Alert type={saveMsg.type} onDismiss={() => setSaveMsg(null)}>
                {saveMsg.text}
              </Alert>
            )}

            {/* Save button */}
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
                bg-orange-500 hover:bg-orange-600 text-white
                shadow-sm shadow-orange-500/25 dark:shadow-orange-900/40
                disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-150"
            >
              {saving ? <Spin /> : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
              {saving ? 'جاري الحفظ…' : 'حفظ الإعدادات'}
            </button>
          </form>
        </div>

        {/* ── Webhook URL card ───────────────────────────────────────── */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white dark:bg-slate-900 overflow-hidden">

          <div className="flex items-center gap-3 px-6 py-4
            border-b border-slate-200/60 dark:border-slate-700/40
            bg-slate-50/60 dark:bg-slate-800/40">
            <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
              <svg className="w-4 h-4 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800 dark:text-slate-200">إعداد Webhook في Bosta</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-500">
                سجّل هذا الرابط في لوحة Bosta لاستقبال تحديثات حالة الشحنات تلقائياً
              </p>
            </div>
          </div>

          <div className="px-6 py-5 space-y-4">

            {/* Webhook URL display */}
            <div>
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Webhook Endpoint URL
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700
                  rounded-xl px-4 py-2.5 text-xs text-slate-700 dark:text-slate-300 font-mono truncate"
                  dir="ltr">
                  https://your-domain.com/api/webhooks/bosta
                </code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText('https://your-domain.com/api/webhooks/bosta');
                  }}
                  title="نسخ"
                  className="shrink-0 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700
                    text-slate-400 hover:text-slate-700 dark:hover:text-slate-300
                    hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-150"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-600">
                استبدل <code className="bg-slate-100 dark:bg-slate-700 px-1 py-0.5 rounded text-[10px]">your-domain.com</code> بعنوان السيرفر الفعلي.
              </p>
            </div>

            {/* Status row */}
            <div className="flex items-center justify-between p-3 rounded-xl
              bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/40">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0"
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <span className="text-xs text-slate-500 dark:text-slate-500">Webhook Secret</span>
              </div>
              {settings?.webhook_secret ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full
                  bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  محمي بـ Secret
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full
                  bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  مفتوح (بدون Secret)
                </span>
              )}
            </div>

            {/* Events handled */}
            <div>
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                الأحداث التي يعالجها النظام تلقائياً
              </p>
              <div className="space-y-2">
                {[
                  { event: 'returned / delivered_to_merchant', effect: 'زيادة المخزون +1 وتسجيل مرتجع', color: 'emerald' },
                  { event: 'delivered',                        effect: 'تحديث حالة الطلب إلى "تم التوصيل"', color: 'blue' },
                  { event: 'out_for_delivery',                 effect: 'تحديث حالة الطلب إلى "تم الشحن"', color: 'indigo' },
                  { event: 'returning_to_merchant',            effect: 'تحديث الحالة إلى "جاري الإعادة" (بدون تغيير مخزون)', color: 'amber' },
                  { event: 'cancelled',                        effect: 'تحديث الحالة إلى "تم الرفض"', color: 'slate' },
                ] .map(({ event, effect, color }) => (
                  <div key={event}
                    className="flex items-start gap-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                    <code className={`shrink-0 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded
                      ${color === 'emerald' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                        color === 'blue'    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'             :
                        color === 'indigo'  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'     :
                        color === 'amber'   ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'         :
                                             'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                      }`}
                    >
                      {event}
                    </code>
                    <span className="text-[11px] text-slate-500 dark:text-slate-500 leading-relaxed mt-0.5">
                      {effect}
                    </span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>

        {/* ── How to get credentials card ────────────────────────────── */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4
            border-b border-slate-200/60 dark:border-slate-700/40
            bg-slate-50/60 dark:bg-slate-800/40">
            <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center">
              <svg className="w-4 h-4 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800 dark:text-slate-200">كيفية الحصول على البيانات</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-500">دليل خطوة بخطوة من لوحة Bosta Business</p>
            </div>
          </div>

          <div className="px-6 py-5">
            <ol className="space-y-4">
              {[
                {
                  step: '١',
                  title: 'افتح Bosta Business Dashboard',
                  desc: (
                    <>
                      اذهب إلى{' '}
                      <a href="https://business.bosta.co" target="_blank" rel="noopener noreferrer"
                        className="text-orange-600 dark:text-orange-400 underline underline-offset-2 hover:no-underline">
                        business.bosta.co
                      </a>
                      {' '}وسجّل الدخول بحساب الشركة.
                    </>
                  ),
                },
                {
                  step: '٢',
                  title: 'احصل على API Key',
                  desc: 'اذهب إلى الإعدادات (Settings) → API. انسخ الـ API Key الخاص بحسابك. هذا المفتاح يُستخدم لإنشاء الشحنات.',
                },
                {
                  step: '٣',
                  title: 'احصل على Bearer Token',
                  desc: 'سجّل الدخول في المتصفح على business.bosta.co، افتح أدوات المطور (F12)، اذهب إلى Network، انسخ قيمة Authorization header من أي طلب. يجب أن تبدأ بـ Bearer.',
                },
                {
                  step: '٤',
                  title: 'اضبط الـ Webhook (اختياري)',
                  desc: 'من إعدادات Bosta Business، اذهب إلى Webhooks → Add Webhook. أدخل عنوان الـ Endpoint، واختر الأحداث التي تريد تتبعها (delivered, returned, إلخ). إذا ضبطت Secret، أدخله في الحقل أعلاه.',
                },
                {
                  step: '٥',
                  title: 'احفظ وجرّب',
                  desc: 'بعد حفظ الإعدادات، اذهب إلى لوحة الطلبات وجرّب إنشاء شحنة من أي طلب مؤكد. ستظهر رسالة نجاح مع رقم التتبع.',
                },
              ].map(({ step, title, desc }) => (
                <li key={step} className="flex gap-4">
                  <div className="w-7 h-7 rounded-full bg-orange-100 dark:bg-orange-900/40
                    flex items-center justify-center
                    text-orange-700 dark:text-orange-400 text-xs font-bold shrink-0 mt-0.5">
                    {step}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{title}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 leading-relaxed">{desc}</p>
                  </div>
                </li>
              ))}
            </ol>

            {/* Security note */}
            <div className="mt-5 flex items-start gap-3 p-4 rounded-xl
              bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30">
              <svg className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <div>
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">تنبيه أمني</p>
                <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-0.5 leading-relaxed">
                  لا تشارك API Key أو Bearer Token مع أحد. هذه البيانات تُخزَّن في قاعدة البيانات
                  وتُعرَض مقنّعة فقط. تأكد من تجديد الـ Bearer Token إذا شعرت بأنه قد تسرّب.
                </p>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
