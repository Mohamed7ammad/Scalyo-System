'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAffiliateSettings, saveAffiliateSettings, disconnectAffiliate, syncTaagerOrders } from '@/lib/api';
import type { AffiliateSettings, AffiliateNetworkSetting, AffiliateSettingsPayload } from '@/lib/api';

/* ══════════════════════════════════════════════════════════════════════════
   Toast
   ══════════════════════════════════════════════════════════════════════════ */
interface Toast { message: string; type: 'success' | 'error' }

/* ══════════════════════════════════════════════════════════════════════════
   Per-network card config — each affiliate network gets its own identity.
   ══════════════════════════════════════════════════════════════════════════ */
type NetworkId = 'taager' | 'safqa';

interface NetworkMeta {
  id:                  NetworkId;
  name:               string;   // Arabic display name
  latin:              string;   // Latin name
  blurb:              string;   // short description
  urlLabel:           string;   // API URL input label
  urlPlaceholder:     string;
  merchantLabel:      string;   // Merchant ID input label
  merchantPlaceholder: string;
  tokenLabel:         string;   // API Token input label
  tokenPlaceholder:   string;
  /** Tailwind gradient + accent classes giving each card a distinct look. */
  ring:               string;
  gradient:           string;
  chip:               string;
  button:             string;
  glyph:              string;   // first letter / mark shown in the avatar
}

const NETWORKS: NetworkMeta[] = [
  {
    id: 'taager',
    name: 'تاجر',
    latin: 'Taager',
    blurb: 'اربط حساب تاجر لجلب إيراداتك من المنصة تلقائياً إلى لوحة التحكم.',
    urlLabel: 'رابط الـ API للمنصة',
    urlPlaceholder: 'https://api.taager.com/v1',
    merchantLabel: 'رقم التاجر (Merchant ID)',
    merchantPlaceholder: 'tg-merchant-000000',
    tokenLabel: 'مفتاح الـ API (API Token)',
    tokenPlaceholder: 'tg_live_xxxxxxxxxxxxxxxx',
    ring: 'ring-orange-200 dark:ring-orange-800/50',
    gradient: 'from-orange-500 to-amber-600',
    chip: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
    button: 'bg-orange-600 hover:bg-orange-700 active:bg-orange-800 shadow-orange-600/25',
    glyph: 'ت',
  },
  {
    id: 'safqa',
    name: 'صفقة',
    latin: 'Safqa',
    blurb: 'اربط حساب صفقة عبر رقم التاجر ومفتاح الـ API لمزامنة أرباحك.',
    urlLabel: 'رابط الـ API للمنصة',
    urlPlaceholder: 'https://api.safqa.com/v1',
    merchantLabel: 'رقم التاجر (Merchant ID)',
    merchantPlaceholder: 'sfq-merchant-000000',
    tokenLabel: 'مفتاح الـ API (API Token)',
    tokenPlaceholder: 'الصق التوكن هنا — وليس في خانة الرابط',
    ring: 'ring-teal-200 dark:ring-teal-800/50',
    gradient: 'from-teal-500 to-cyan-600',
    chip: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
    button: 'bg-teal-600 hover:bg-teal-700 active:bg-teal-800 shadow-teal-600/25',
    glyph: 'ص',
  },
];

/* ══════════════════════════════════════════════════════════════════════════
   Connection status badge
   ══════════════════════════════════════════════════════════════════════════ */
function StatusBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
      bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200
      dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-800/60">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      متصل
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
      bg-slate-100 text-slate-500 ring-1 ring-slate-200
      dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      غير متصل
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Network connection card
   ══════════════════════════════════════════════════════════════════════════ */
/* Shared input class — keeps the three fields visually identical. */
const INPUT_CLS = `w-full px-3.5 py-2.5 rounded-xl text-sm outline-none
  bg-white dark:bg-slate-800
  border border-slate-300 dark:border-slate-700
  text-slate-800 dark:text-slate-100
  placeholder-slate-400 dark:placeholder-slate-600
  focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition`;

function NetworkCard({
  meta, setting, onSaved, showToast,
}: {
  meta:      NetworkMeta;
  setting:   AffiliateNetworkSetting | undefined;
  onSaved:   () => void;
  showToast: (m: string, t: Toast['type']) => void;
}) {
  const [url,        setUrl]        = useState(setting?.api_url ?? '');
  const [merchantId, setMerchantId] = useState(setting?.merchant_id ?? '');
  const [token,      setToken]      = useState('');   // secret — never prefilled
  const [saving,     setSaving]     = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing,    setSyncing]    = useState(false);

  const configured = setting?.configured ?? false;
  const busy = saving || disconnecting || syncing;

  /* Keep URL + Merchant ID in sync with saved values (e.g. after a reload).
     The token input intentionally stays blank — the secret is never prefilled. */
  useEffect(() => { setUrl(setting?.api_url ?? ''); },        [setting?.api_url]);
  useEffect(() => { setMerchantId(setting?.merchant_id ?? ''); }, [setting?.merchant_id]);

  const handleSave = async () => {
    const apiUrl   = url.trim();
    const merchant = merchantId.trim();
    const apiToken = token.trim();
    if (!apiUrl && !merchant && !apiToken) {
      showToast('من فضلك أدخل بيانات الربط أولاً', 'error');
      return;
    }
    setSaving(true);
    try {
      /* Send all three fields. Blank fields are ignored server-side (existing
         values preserved), so updating only one field is safe. */
      const payload: AffiliateSettingsPayload =
        meta.id === 'taager'
          ? { taager_api_url: apiUrl, taager_merchant_id: merchant, taager_api_token: apiToken }
          : { safqa_api_url: apiUrl,  safqa_merchant_id: merchant,  safqa_api_token: apiToken };
      await saveAffiliateSettings(payload);
      setToken('');   // clear the secret input; URL + Merchant ID re-sync on reload
      showToast(`تم حفظ بيانات ${meta.name} بنجاح`, 'success');
      onSaved();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل في حفظ البيانات';
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm(`هل أنت متأكد من فك الربط مع ${meta.name}؟ سيتم حذف الرابط ورقم التاجر والتوكن.`)) {
      return;
    }
    setDisconnecting(true);
    try {
      await disconnectAffiliate(meta.id);
      /* Clear every local input so the card resets to a fresh state. */
      setUrl('');
      setMerchantId('');
      setToken('');
      showToast(`تم فك الربط مع ${meta.name}`, 'success');
      onSaved();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشل في فك الربط';
      showToast(msg, 'error');
    } finally {
      setDisconnecting(false);
    }
  };

  /* Deep-sync Taager orders into our DB (Taager card only). */
  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data } = await syncTaagerOrders();
      const enriched = data.productsUpserted ?? 0;
      showToast(
        `تمت المزامنة: ${data.upserted} طلب` +
        (enriched > 0 ? ` و إثراء ${enriched} منتج بالكتالوج` : `، وإضافة ${data.productsCreated} منتج`),
        'success',
      );
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'فشلت مزامنة الطلبات — تحقق من التوكن والرابط';
      showToast(msg, 'error');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className={`relative overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800
      bg-white dark:bg-slate-900 shadow-sm hover:shadow-md transition-all duration-200 ring-1 ${meta.ring}`}>

      {/* Decorative corner glow */}
      <div className={`pointer-events-none absolute -top-12 -left-12 w-40 h-40 rounded-full
        bg-gradient-to-br ${meta.gradient} opacity-10 blur-2xl`} />

      <div className="relative p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className={`w-12 h-12 shrink-0 rounded-2xl bg-gradient-to-br ${meta.gradient}
              flex items-center justify-center text-white text-xl font-black shadow-lg`}>
              {meta.glyph}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-900 dark:text-white leading-tight">{meta.name}</h3>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${meta.chip}`}>{meta.latin}</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-snug">{meta.blurb}</p>
            </div>
          </div>
          <StatusBadge connected={configured} />
        </div>

        {/* Saved-token preview */}
        {configured && setting?.token_preview && (
          <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-xl
            bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60">
            <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            <span className="text-xs font-mono text-slate-600 dark:text-slate-300 tracking-wide" dir="ltr">
              {setting.token_preview}
            </span>
            <span className="mr-auto text-[10px] font-semibold text-slate-400">التوكن المحفوظ</span>
          </div>
        )}

        {/* 1. API URL */}
        <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
          {meta.urlLabel}
        </label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          placeholder={meta.urlPlaceholder}
          dir="ltr"
          className={`${INPUT_CLS} mb-3.5`}
        />

        {/* 2. Merchant ID */}
        <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
          {meta.merchantLabel}
        </label>
        <input
          type="text"
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          placeholder={meta.merchantPlaceholder}
          dir="ltr"
          className={`${INPUT_CLS} mb-3.5`}
        />

        {/* 3. API Token (secret) */}
        <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
          {meta.tokenLabel}
        </label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          placeholder={configured ? '•••••••• (اتركه فارغاً للإبقاء على التوكن الحالي)' : meta.tokenPlaceholder}
          dir="ltr"
          className={`${INPUT_CLS} mb-4`}
        />

        {/* Actions: Save + Disconnect */}
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={busy}
            className={`flex-1 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl
              text-sm font-semibold text-white shadow-md transition-all duration-150
              active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed ${meta.button}`}
          >
            {saving ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                جارٍ الحفظ…
              </>
            ) : configured ? 'تحديث البيانات' : 'ربط المنصة'}
          </button>

          {/* Disconnect — only meaningful once something is saved */}
          {configured && (
            <button
              onClick={handleDisconnect}
              disabled={busy}
              title="فك الربط وحذف جميع البيانات"
              className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl
                text-sm font-semibold transition-all duration-150 active:scale-[0.98]
                text-rose-600 dark:text-rose-400
                bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/50
                border border-rose-200 dark:border-rose-800/50
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {disconnecting ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1M3 3l18 18" />
                  </svg>
                  فك الربط
                </>
              )}
            </button>
          )}
        </div>

        {/* Deep sync — Taager only, once connected. Pulls real orders into our DB
            so Products Profitability + the dashboard light up with native data. */}
        {meta.id === 'taager' && configured && (
          <button
            onClick={handleSync}
            disabled={busy}
            title="جلب طلبات تاجر الفعلية وإضافتها لقاعدة البيانات"
            className="mt-3 w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl
              text-sm font-semibold transition-all duration-150 active:scale-[0.98]
              text-orange-700 dark:text-orange-300
              bg-orange-50 dark:bg-orange-950/40 hover:bg-orange-100 dark:hover:bg-orange-900/50
              border border-orange-200 dark:border-orange-800/50
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncing ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                جارٍ مزامنة الطلبات…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                مزامنة الطلبات من تاجر
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   PAGE
   ══════════════════════════════════════════════════════════════════════════ */
export default function ExternalAffiliatePage() {
  const router = useRouter();

  const [settings, setSettings] = useState<AffiliateSettings | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [toast,    setToast]    = useState<Toast | null>(null);

  const showToast = (message: string, type: Toast['type']) => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  /* Plan guard — affiliate plan only. Non-affiliate tenants are bounced. */
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!u) { router.replace('/'); return; }
      if (u.plan_type !== 'affiliate') { router.replace('/dashboard'); return; }
    } catch {
      router.replace('/');
    }
  }, [router]);

  const load = useCallback(async () => {
    try {
      setError('');
      const res = await getAffiliateSettings();
      setSettings(res.data);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401) { router.replace('/'); return; }
      if (status === 403) { router.replace('/dashboard'); return; }
      setError('تعذّر تحميل بيانات الربط. تحقق من الاتصال بالخادم.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  const settingFor = (id: NetworkId) =>
    id === 'taager' ? settings?.taager : settings?.safqa;

  return (
    <div dir="rtl" className="min-h-full">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-lg
          text-white text-sm font-medium ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'}`}>
          {toast.message}
        </div>
      )}

      <div className="max-w-screen-lg mx-auto px-6 pt-8 pb-12 space-y-6">

        {/* Page header */}
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 shrink-0 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-700
            flex items-center justify-center shadow-lg shadow-indigo-500/25">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white leading-tight">
              الربط مع منصات الأفليت
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-snug">
              اربط حساباتك على منصات الأفليت الخارجية لمزامنة الإيرادات تلقائياً مع لوحة التحكم.
              <span className="block text-xs text-indigo-500 dark:text-indigo-400 font-medium mt-0.5">
                ميزة حصرية لباقة الأفليت
              </span>
            </p>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-rose-50 dark:bg-rose-950/30
            border border-rose-200 dark:border-rose-800/50 text-rose-700 dark:text-rose-300 text-sm">
            {error}
          </div>
        )}

        {/* Cards */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {[0, 1].map((i) => (
              <div key={i} className="h-52 rounded-2xl bg-slate-100 dark:bg-slate-800/50 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {NETWORKS.map((meta) => (
              <NetworkCard
                key={meta.id}
                meta={meta}
                setting={settingFor(meta.id)}
                onSaved={load}
                showToast={showToast}
              />
            ))}
          </div>
        )}

        {/* Security note */}
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl
          bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800
          text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          <svg className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span>
            مفاتيحك مخزّنة بشكل آمن ومرتبطة بحسابك فقط — لا يمكن لأي تاجر آخر الاطلاع عليها.
            بعد الربط، تظهر أرباحك من تاجر وصفقة في بطاقات مخصّصة داخل لوحة التحليلات.
          </span>
        </div>
      </div>
    </div>
  );
}
