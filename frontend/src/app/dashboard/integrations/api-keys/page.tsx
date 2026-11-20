'use client';

/* «الربط مع الأنظمة (API)» — the owner creates read-only keys so another system
   (the video studio) can READ product P&L, business numbers and orders without
   customer data. The full key is shown once; keys are stopped, never deleted. */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getApiKeys,
  createApiKey,
  revokeApiKey,
  type ApiKeyRow,
  type ApiKeyScope,
  type ApiKeysResponse,
} from '@/lib/api';
import { serverNow } from '@/lib/serverClock';

type Toast = { message: string; type: 'success' | 'error' } | null;

const SCOPE_INFO: Record<ApiKeyScope, { title: string; desc: string }> = {
  products: { title: 'ربحية المنتجات', desc: 'لكل منتج: الأوردرات والتأكيد والتسليم والمرتجع والإيراد والصرف، والمكسب أو الخسارة' },
  summary:  { title: 'أرقام البيزنس',  desc: 'الإجماليات ونسب التأكيد والتسليم وصافي الربح، والرسم اليومي والمحافظات وأسباب الرفض' },
  orders:   { title: 'الأوردرات',      desc: 'الحالة والمنتج والكمية والسعر والمحافظة والتاريخ، من غير اسم العميل ولا موبايله ولا عنوانه' },
};
const ALL_SCOPES: ApiKeyScope[] = ['products', 'summary', 'orders'];

const ENDPOINTS: [string, string][] = [
  ['GET /me', 'يتأكد إن المفتاح شغال'],
  ['GET /products?from=2026-11-01&to=2026-11-20', 'كل منتج بأرقامه، ومكسبه أو خسارته'],
  ['GET /summary?from=…&to=…', 'أرقام البيزنس والرسم اليومي والمحافظات'],
  ['GET /orders?from=…&to=…&group=delivered&page=1', 'الأوردرات من غير بيانات العملاء'],
];

const errMsg = (e: unknown, fallback: string) => {
  const err = e as { response?: { status?: number; data?: { error?: string } } };
  if (err?.response?.status === 403) return 'الصفحة دي للمدير بس';
  return err?.response?.data?.error || fallback;
};

const fmtDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('ar-EG-u-nu-latn', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo',
  });
};

/* "من 5 دقايق" — measured on the SERVER's clock, so a wrong device clock can't lie. */
const fmtAgo = (iso: string | null) => {
  if (!iso) return 'لسه ما اتستخدمش';
  const mins = Math.floor((serverNow() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'دلوقتي';
  if (mins < 60) return `من ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `من ${hours} ساعة`;
  return fmtDate(iso);
};

function CopyButton({ text, label = 'نسخ' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the text is selectable as a fallback */ }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold
        bg-indigo-600 hover:bg-indigo-700 text-white transition-colors"
    >
      {copied ? 'اتنسخ ✓' : label}
    </button>
  );
}

function CodeLine({ children }: { children: string }) {
  return (
    <pre dir="ltr" className="text-xs font-mono bg-slate-900 text-slate-100 rounded-xl px-3 py-2.5 overflow-x-auto whitespace-pre">{children}</pre>
  );
}

export default function ApiKeysPage() {
  const [data, setData]         = useState<ApiKeysResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadErr] = useState('');
  const [name, setName]         = useState('سيستم الفيديوهات');
  const [scopes, setScopes]     = useState<ApiKeyScope[]>([...ALL_SCOPES]);
  const [creating, setCreating] = useState(false);
  const [formError, setFormErr] = useState('');
  const [newKey, setNewKey]     = useState<{ name: string; key: string } | null>(null);
  const [busyId, setBusyId]     = useState<number | null>(null);
  const [toast, setToast]       = useState<Toast>(null);
  const revealRef               = useRef<HTMLDivElement>(null);

  /* The new key appears at the top — bring it into view (on a phone the button is far below). */
  useEffect(() => {
    if (newKey) revealRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [newKey]);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    try {
      const { data: d } = await getApiKeys();
      setData(d);
      setLoadErr('');
    } catch (e) {
      setLoadErr(errMsg(e, 'تعذّر تحميل المفاتيح'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleScope = (s: ApiKeyScope) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : ALL_SCOPES.filter((x) => x === s || cur.includes(x))));

  const handleCreate = async () => {
    setFormErr('');
    if (!name.trim()) { setFormErr('اكتب اسم للمفتاح'); return; }
    if (!scopes.length) { setFormErr('اختار حاجة واحدة على الأقل'); return; }
    setCreating(true);
    try {
      const { data: created } = await createApiKey({ name: name.trim(), scopes });
      setNewKey({ name: created.name, key: created.key });
      await load();
    } catch (e) {
      setFormErr(errMsg(e, 'تعذّر إنشاء المفتاح'));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (k: ApiKeyRow) => {
    if (!window.confirm(`إيقاف مفتاح «${k.name}»؟\n\nالسيستم اللي بيستخدمه هيبطّل يقرا الأرقام فورًا، والمفتاح ده مش هيرجع يشتغل تاني (تقدر تعمل مفتاح جديد).`)) return;
    setBusyId(k.id);
    try {
      await revokeApiKey(k.id);
      if (newKey && newKey.name === k.name) setNewKey(null);
      showToast('المفتاح اتوقف', 'success');
      await load();
    } catch (e) {
      showToast(errMsg(e, 'تعذّر إيقاف المفتاح'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const active  = data?.keys.filter((k) => k.active) ?? [];
  const stopped = data?.keys.filter((k) => !k.active) ?? [];
  const baseUrl = data?.base_url ?? '';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5" dir="rtl">
      {toast && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-lg
          text-white text-sm font-medium ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">الربط مع الأنظمة (API)</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
          اعمل مفتاح لسيستم تاني (زي سيستم الفيديوهات) عشان يقرا أرقام المنتجات والبيزنس والأوردرات من Scalyo.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          {['قراءة بس: مستحيل يعدّل أو يمسح أي حاجة', 'بيانات العملاء مخفية', 'توقفه بضغطة في أي وقت'].map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
              bg-emerald-50 text-emerald-700 border border-emerald-200
              dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800/50">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {t}
            </span>
          ))}
        </div>
      </div>

      {/* The new key — shown ONCE */}
      {newKey && (
        <div ref={revealRef} className="scroll-mt-4 rounded-2xl border-2 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 sm:p-5 space-y-3">
          <div>
            <h2 className="text-base font-bold text-amber-900 dark:text-amber-200">انسخ المفتاح دلوقتي، مش هيظهر تاني</h2>
            <p className="text-xs text-amber-800/90 dark:text-amber-300/80 mt-1 leading-relaxed">
              حطّه في إعدادات سيستم «{newKey.name}» على السيرفر بتاعه. متبعتهوش لحد ومتحطهوش في صفحة بتفتح في المتصفح.
              لو ضاع، وقّفه واعمل واحد جديد.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-stretch gap-2">
            <input
              readOnly
              value={newKey.key}
              dir="ltr"
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 px-3 py-2 rounded-xl text-xs sm:text-sm font-mono outline-none select-all
                bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 text-slate-800 dark:text-slate-100"
            />
            <CopyButton text={newKey.key} label="نسخ المفتاح" />
          </div>
          <button
            type="button"
            onClick={() => setNewKey(null)}
            className="text-xs font-semibold text-amber-900 dark:text-amber-200 underline underline-offset-2"
          >
            تمام، نسخته
          </button>
        </div>
      )}

      {/* Create */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 sm:p-6 space-y-4 shadow-sm">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">مفتاح جديد</h2>
        <div>
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">اسم المفتاح</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="مثلًا: سيستم الفيديوهات"
            className="w-full px-3 py-2 rounded-xl text-sm outline-none bg-white dark:bg-slate-800
              border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100
              focus:ring-2 focus:ring-indigo-500/40"
          />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-700 dark:text-slate-300">هيشوف إيه؟</div>
          {ALL_SCOPES.map((s) => {
            const on = scopes.includes(s);
            return (
              <label
                key={s}
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors
                  ${on
                    ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-700 dark:bg-indigo-950/30'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
              >
                <input type="checkbox" checked={on} onChange={() => toggleScope(s)} className="mt-1 w-4 h-4 accent-indigo-600 shrink-0" />
                <span>
                  <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{SCOPE_INFO[s].title}</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{SCOPE_INFO[s].desc}</span>
                </span>
              </label>
            );
          })}
        </div>
        {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating || !name.trim() || !scopes.length}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
            bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {creating ? 'بيتعمل…' : 'إنشاء مفتاح'}
        </button>
      </div>

      {/* Keys */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 sm:p-6 space-y-3 shadow-sm">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">المفاتيح</h2>
        {loading ? (
          <div className="py-10 text-center">
            <div className="inline-block w-7 h-7 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
          </div>
        ) : loadError ? (
          <p className="text-sm text-red-600 dark:text-red-400 py-4">{loadError}</p>
        ) : !data?.keys.length ? (
          <p className="text-sm text-slate-400 py-6 text-center">مفيش مفاتيح لسه</p>
        ) : (
          <div className="space-y-3">
            {[...active, ...stopped].map((k) => (
              <div
                key={k.id}
                className={`rounded-xl border p-3 sm:p-4 space-y-2 ${k.active
                  ? 'border-slate-200 dark:border-slate-700'
                  : 'border-slate-200/70 dark:border-slate-800 opacity-60'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white break-words">{k.name}</span>
                      {k.active ? (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">شغال</span>
                      ) : (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400">متوقف</span>
                      )}
                    </div>
                    <div dir="ltr" className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-1 text-right break-all">{k.key_hint}</div>
                  </div>
                  {k.active && (
                    <button
                      type="button"
                      onClick={() => handleRevoke(k)}
                      disabled={busyId === k.id}
                      className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold border border-red-300 text-red-600
                        hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30 disabled:opacity-50"
                    >
                      {busyId === k.id ? '…' : 'إيقاف'}
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {k.scopes.map((s) => (
                    <span key={s} className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
                      {SCOPE_INFO[s]?.title ?? s}
                    </span>
                  ))}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-1 text-xs text-slate-500 dark:text-slate-400">
                  <span>اتعمل: {fmtDate(k.created_at)}</span>
                  <span>آخر استخدام: {k.active || k.last_used_at ? fmtAgo(k.last_used_at) : '—'}</span>
                  <span>الطلبات: {k.request_count.toLocaleString('en-US')}</span>
                  {!k.active && <span className="sm:col-span-3">اتوقف: {fmtDate(k.revoked_at)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* For the developer */}
      {data && (
        <details className="group bg-indigo-50/60 dark:bg-indigo-950/20 rounded-2xl border border-indigo-100 dark:border-indigo-900/40 p-4 sm:p-6">
          <summary className="cursor-pointer text-sm font-bold text-indigo-800 dark:text-indigo-300 select-none">
            للمبرمج: طريقة الاستخدام
          </summary>
          <div className="mt-4 space-y-4 text-xs text-indigo-900/90 dark:text-indigo-200/90 leading-relaxed">
            <div>
              <div className="font-semibold mb-1">العنوان</div>
              <div className="flex flex-col sm:flex-row items-stretch gap-2">
                <input readOnly value={baseUrl} dir="ltr" onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 min-w-0 px-3 py-2 rounded-xl text-xs font-mono outline-none bg-white dark:bg-slate-900
                    border border-indigo-200 dark:border-indigo-800 text-slate-800 dark:text-slate-100" />
                <CopyButton text={baseUrl} />
              </div>
            </div>
            <div>
              <div className="font-semibold mb-1">المفتاح بيتبعت في الهيدر (من السيرفر بس)</div>
              <CodeLine>{'X-Api-Key: scalyo_…'}</CodeLine>
            </div>
            <div>
              <div className="font-semibold mb-1">الروابط</div>
              <ul className="space-y-2.5">
                {ENDPOINTS.map(([path, desc]) => (
                  <li key={path}>
                    {/* own LTR block: a path inside an Arabic sentence gets its slashes flipped */}
                    <code dir="ltr" className="block w-fit max-w-full overflow-x-auto whitespace-nowrap font-mono text-[11px] px-2 py-1 rounded-lg
                      bg-white/80 dark:bg-slate-900 border border-indigo-100 dark:border-indigo-900/50 text-slate-800 dark:text-slate-100">
                      {path}
                    </code>
                    <span className="block mt-1">{desc}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="font-semibold mb-1">مثال</div>
              <CodeLine>{`curl -H "X-Api-Key: scalyo_…" "${baseUrl}/products?from=2026-11-01&to=2026-11-20"`}</CodeLine>
            </div>
            <p>
              التواريخ بتوقيت القاهرة، والأرقام بالجنيه، وهي نفس أرقام صفحة التحليلات بالظبط.
              الحد الأقصى {data.requests_per_minute} طلب في الدقيقة لكل مفتاح، والتقارير بتتحدث كل دقيقتين.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
