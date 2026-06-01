'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  getEasyorderSettings,
  saveEasyorderSettings,
  type EasyorderSettings,
} from '@/lib/api';

/* ── Tiny toast ──────────────────────────────────────────────────── */
type Toast = { message: string; type: 'success' | 'error' } | null;

/* ── Read-only field with a copy button ──────────────────────────── */
function CopyField({
  label, value, hint,
}: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <div>
      <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">{label}</label>
      <div className="flex items-stretch gap-2">
        <input
          readOnly
          value={value}
          dir="ltr"
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 px-3 py-2 rounded-xl text-sm font-mono outline-none
            bg-slate-50 dark:bg-slate-800/70 border border-slate-300 dark:border-slate-700
            text-slate-700 dark:text-slate-200 select-all"
        />
        <button
          onClick={copy}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold
            bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white transition active:scale-95"
        >
          {copied ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
          {copied ? 'تم' : 'نسخ'}
        </button>
      </div>
      {hint && <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

export default function EasyorderIntegrationPage() {
  const [settings, setSettings] = useState<EasyorderSettings | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [rotating, setRotating] = useState(false);
  const [token,    setToken]    = useState('');
  const [toast,    setToast]    = useState<Toast>(null);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    try {
      const { data } = await getEasyorderSettings();
      setSettings(data);
    } catch {
      showToast('تعذّر تحميل الإعدادات', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data } = await saveEasyorderSettings({ api_token: token });
      setSettings(data);
      setToken('');
      showToast('تم حفظ التوكن بنجاح', 'success');
    } catch {
      showToast('فشل حفظ التوكن', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRotate = async () => {
    if (!window.confirm('سيتم إنشاء سر جديد للويب هوك. يجب تحديثه في لوحة EasyOrder. متابعة؟')) return;
    setRotating(true);
    try {
      const { data } = await saveEasyorderSettings({ regenerate_secret: true });
      setSettings(data);
      showToast('تم إنشاء سر جديد', 'success');
    } catch {
      showToast('فشل إنشاء السر', 'error');
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6" dir="rtl">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-lg
          text-white text-sm font-medium ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">الربط مع إيزي أوردر</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            استقبل طلبات EasyOrder تلقائياً داخل النظام عبر الـ Webhook.
          </p>
        </div>
        {!loading && settings && (
          settings.connected ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
              bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200
              dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-800/60">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> متصل
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
              bg-amber-100 text-amber-700 ring-1 ring-amber-200
              dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-800/60">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> غير مكتمل
            </span>
          )
        )}
      </div>

      {loading ? (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 py-20 text-center">
          <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
        </div>
      ) : !settings ? (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 py-16 text-center text-slate-400">
          تعذّر تحميل الإعدادات.
        </div>
      ) : (
        <>
          {/* Webhook URL card */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-4 shadow-sm">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">رابط الـ Webhook الخاص بك</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                انسخ هذا الرابط والصقه في إعدادات الـ Webhook داخل لوحة تحكم EasyOrder ليتم إرسال كل طلب جديد إلى النظام تلقائياً.
              </p>
            </div>

            <CopyField label="Webhook URL" value={settings.webhook_url} />

            <CopyField
              label="سر الـ Webhook (Webhook Secret)"
              value={settings.webhook_secret}
              hint="اختياري — إن كانت لوحة EasyOrder تدعم إضافة Header مخصص، أضِف الترويسة x-easyorder-secret بهذه القيمة لمزيد من الأمان."
            />

            <button
              onClick={handleRotate}
              disabled={rotating}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium
                bg-slate-100 hover:bg-slate-200 text-slate-600
                dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 transition disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {rotating ? 'جارٍ…' : 'إنشاء سر جديد'}
            </button>
          </div>

          {/* API Token card */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-4 shadow-sm">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">توكن EasyOrder API</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                التوكن الخاص بحسابك في EasyOrder. يُستخدم للمزامنة المستقبلية وللتحقق من الطلبات.
              </p>
            </div>

            {settings.api_token && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                التوكن الحالي: <span className="font-mono text-slate-700 dark:text-slate-300">{settings.api_token}</span>
              </div>
            )}

            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
                {settings.api_token ? 'تحديث التوكن' : 'إدخال التوكن'}
              </label>
              <input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={settings.api_token ? 'اتركه فارغاً للإبقاء على الحالي' : 'الصق توكن EasyOrder هنا'}
                dir="ltr"
                className="w-full px-3 py-2 rounded-xl text-sm font-mono outline-none
                  bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                  text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                  focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
              />
            </div>

            <button
              onClick={handleSave}
              disabled={saving || (!token.trim() && !settings.api_token)}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
                bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white shadow-sm transition active:scale-95
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'جارٍ الحفظ…' : 'حفظ'}
            </button>
          </div>

          {/* Setup steps */}
          <div className="bg-indigo-50/60 dark:bg-indigo-950/20 rounded-2xl border border-indigo-100 dark:border-indigo-900/40 p-6">
            <h3 className="text-sm font-bold text-indigo-800 dark:text-indigo-300 mb-2">خطوات الإعداد</h3>
            <ol className="list-decimal pr-5 space-y-1.5 text-xs text-indigo-700/90 dark:text-indigo-300/80 leading-relaxed">
              <li>انسخ رابط الـ Webhook بالأعلى.</li>
              <li>ادخل إلى لوحة تحكم EasyOrder ← الإعدادات ← Webhooks.</li>
              <li>أضِف Webhook جديداً والصق الرابط لحدث «طلب جديد».</li>
              <li>(اختياري) أضِف الترويسة <span className="font-mono">x-easyorder-secret</span> بقيمة السر بالأعلى.</li>
              <li>احفظ — سيظهر أي طلب جديد فوراً في صفحة الطلبات.</li>
            </ol>
          </div>
        </>
      )}
    </div>
  );
}
