'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  Incoming Returns — المرتجعات القادمة   (Admin only)
 * ════════════════════════════════════════════════════════════════════
 *  Stock physically on its way BACK from Bosta ("مرتجعاتك العائدة") that
 *  hasn't been received in the warehouse yet — per product, with Bosta's
 *  expected arrival day. Built to answer: "which out-of-stock products have
 *  units coming back, and when, so I can keep their ads running?"
 *  Backend: GET /api/inventory/incoming-returns (Bosta-cached; ?fresh=1).
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getIncomingReturns, userHasRole, IncomingReturnsResponse, IncomingReturnProduct } from '@/lib/api';

const fmt = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString('en-US');
/* Arabic count agreement: 1 شحنة · 2 شحنتان · 3–10 شحنات · 11+ شحنة. */
const shipments = (n: number) => n === 2 ? 'شحنتان' : (n >= 3 && n <= 10 ? `${fmt(n)} شحنات` : `${fmt(n)} شحنة`);

/* Whole days between two 'YYYY-MM-DD' strings (b − a), timezone-proof. */
const dayDiff = (a: string, b: string) => {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
};
/* 'YYYY-MM-DD' → 'السبت، 3 أكتوبر' (Latin digits, like Bosta's dashboard). */
const arDay = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const arShort = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', timeZone: 'UTC' });

type ArrivalKind = 'overdue' | 'today' | 'tomorrow' | 'later' | 'unknown';
function classify(date: string | null, today: string): { kind: ArrivalKind; label: string } {
  if (!date) return { kind: 'unknown', label: 'موعد غير محدد' };
  const d = dayDiff(today, date);
  if (d < 0)   return { kind: 'overdue',  label: `متأخر · ${arShort(date)}` };
  if (d === 0) return { kind: 'today',    label: 'اليوم' };
  if (d === 1) return { kind: 'tomorrow', label: 'غداً' };
  return { kind: 'later', label: arDay(date) };
}
const CHIP: Record<ArrivalKind, string> = {
  today:    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800/60',
  tomorrow: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-800/60',
  later:    'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-800/60',
  overdue:  'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/60',
  unknown:  'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
};

/* Current-stock badge — stock can be NEGATIVE (oversold). */
function StockBadge({ stock }: { stock: number | null }) {
  if (stock === null) return <span className="text-xs text-slate-400">غير مسجّل</span>;
  const cls = stock <= 0
    ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
    : stock <= 5
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${cls}`} dir="rtl">
      {stock <= 0 ? 'نفد' : 'متوفر'} <span dir="ltr">({fmt(stock)})</span>
    </span>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 px-5 py-4 shadow-sm">
      <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold tracking-tight ${accent}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function IncomingReturnsPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [data, setData]       = useState<IncomingReturnsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [oosOnly, setOosOnly] = useState(false);   // show only out-of-stock products

  /* Auth guard — strictly admin (the endpoint is admin-only). */
  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!token || !u) { router.replace('/'); return; }
      if (!userHasRole(u, 'admin')) { router.replace('/dashboard'); return; }
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  const load = useCallback(async (fresh: boolean) => {
    fresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const res = await getIncomingReturns(fresh);
      setData(res.data);
    } catch (err: unknown) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر جلب المرتجعات القادمة من بوسطة');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useEffect(() => { if (allowed) load(false); }, [allowed, load]);

  const today = data?.today ?? '';

  /* Per-product view model: split on-schedule vs overdue units; projected stock
     counts ONLY on-schedule units (overdue parcels may never make it back). */
  const rows = useMemo(() => {
    if (!data) return [];
    const list = data.products.map((p: IncomingReturnProduct) => {
      const chips   = p.arrivals.map((a) => ({ ...a, ...classify(a.date, today) }));
      const overdue = chips.filter((c) => c.kind === 'overdue').reduce((s, c) => s + c.units, 0);
      const onTime  = p.total_units - overdue;
      return {
        ...p, chips, overdue, onTime,
        projected: p.current_stock === null ? null : p.current_stock + onTime,
        oos: p.current_stock !== null && p.current_stock <= 0,
      };
    });
    /* Out-of-stock products with units coming back first — they're the ad-scaling
       opportunities — then by incoming volume. */
    list.sort((a, b) => Number(b.oos && b.onTime > 0) - Number(a.oos && a.onTime > 0) || b.onTime - a.onTime || b.total_units - a.total_units);
    return oosOnly ? list.filter((r) => r.oos) : list;
  }, [data, today, oosOnly]);

  const kpis = useMemo(() => {
    const all = data ? data.products.flatMap((p) => p.arrivals.map((a) => ({ ...a, kind: classify(a.date, today).kind }))) : [];
    const sum = (f: (k: ArrivalKind) => boolean) => all.filter((a) => f(a.kind)).reduce((s, a) => s + a.units, 0);
    return {
      soon:    sum((k) => k === 'today' || k === 'tomorrow'),
      overdue: sum((k) => k === 'overdue'),
      /* Same rule as the row highlight: out of stock AND ≥1 on-schedule unit. */
      oosWithIncoming: data ? data.products.filter((p) =>
        p.current_stock !== null && p.current_stock <= 0 &&
        p.arrivals.some((a) => classify(a.date, today).kind !== 'overdue')).length : 0,
    };
  }, [data, today]);

  if (!allowed) return null;

  const updatedAt = data ? new Date(data.fetched_at).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="min-h-full" dir="rtl">
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 pt-8 pb-10 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">المرتجعات القادمة</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              بضاعة في طريق العودة من بوسطة ولم تُستلم في المخزن بعد — حسب المنتج وموعد الوصول المتوقع
            </p>
          </div>
          <div className="flex items-center gap-3">
            {data && (
              <span className="text-xs text-slate-400 dark:text-slate-500">
                آخر تحديث {updatedAt}{data.cached ? ' (مخزّن مؤقتًا)' : ''}
              </span>
            )}
            <button
              onClick={() => load(true)}
              disabled={refreshing || loading}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white
                rounded-xl text-sm font-semibold shadow-sm shadow-indigo-500/30 transition disabled:opacity-50"
            >
              <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {refreshing ? 'جارٍ التحديث…' : 'تحديث من بوسطة'}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 px-4 py-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* KPIs */}
        {data && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="إجمالي القطع القادمة" value={fmt(data.totals.units)} sub={`في ${shipments(data.totals.parcels)}`} accent="text-slate-800 dark:text-white" />
            <Kpi label="تصل اليوم أو غداً" value={fmt(kpis.soon)} sub="قطعة" accent="text-emerald-600 dark:text-emerald-400" />
            <Kpi label="منتجات نفدت ولها مرتجعات قادمة" value={fmt(kpis.oosWithIncoming)} sub="فرص لاستمرار الإعلانات" accent="text-rose-600 dark:text-rose-400" />
            <Kpi label="متأخرة عن موعدها" value={fmt(kpis.overdue)} sub="قطعة — قد لا تصل" accent={kpis.overdue > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500'} />
          </div>
        )}

        {/* Filter */}
        {data && data.products.length > 0 && (
          <div className="flex items-center gap-2">
            {[{ v: false, l: 'كل المنتجات' }, { v: true, l: 'نفد من المخزون فقط' }].map((o) => (
              <button key={String(o.v)} onClick={() => setOosOnly(o.v)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition
                  ${oosOnly === o.v ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'}`}>
                {o.l}
              </button>
            ))}
          </div>
        )}

        {/* Table */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-20">
              <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-3" />
              <p className="text-slate-400 text-sm">جارٍ جلب المرتجعات من بوسطة…</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-20 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">
                {oosOnly ? 'لا توجد منتجات نافدة لها مرتجعات قادمة' : 'لا توجد مرتجعات في الطريق حاليًا'}
              </p>
            </div>
          ) : (
            <>
            {/* Phones: one stacked card per product — every number visible without
                sideways scrolling (the table below is for tablet/desktop). */}
            <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((r) => (
                <div key={r.key} className={`p-4 space-y-3 ${r.oos && r.onTime > 0 ? 'bg-rose-50/40 dark:bg-rose-900/10' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 dark:text-slate-100 leading-snug">{r.name}</p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        {r.sku && <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500" dir="ltr">{r.sku}</span>}
                        {r.source === 'bosta' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">من بيانات بوسطة</span>}
                      </div>
                    </div>
                    <StockBadge stock={r.current_stock} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 px-3 py-2">
                      <p className="text-[11px] text-slate-400">القادم</p>
                      <p className="text-lg font-bold text-indigo-600 dark:text-indigo-400 leading-tight">{fmt(r.total_units)}</p>
                      <p className="text-[10px] text-slate-400">{shipments(r.parcels)}</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 px-3 py-2">
                      <p className="text-[11px] text-slate-400">المخزون بعد الوصول</p>
                      {r.projected === null ? <p className="text-lg font-bold text-slate-400 leading-tight">—</p> : (
                        <p className={`text-lg font-bold leading-tight ${r.projected <= 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`} dir="ltr">{fmt(r.projected)}</p>
                      )}
                      {r.overdue > 0 && <p className="text-[10px] text-amber-600 dark:text-amber-400">بدون {fmt(r.overdue)} متأخرة</p>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {r.chips.map((c) => (
                      <span key={`${c.date}`} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium ${CHIP[c.kind]}`}>
                        {c.label}
                        <span className="font-bold">{fmt(c.units)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs">
                  <tr>
                    <th className="text-right font-semibold px-4 py-3">المنتج</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المخزون الحالي</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">القادم</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المخزون بعد الوصول</th>
                    <th className="text-right font-semibold px-4 py-3">موعد الوصول</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((r) => (
                    <tr key={r.key} className={`align-top ${r.oos && r.onTime > 0 ? 'bg-rose-50/40 dark:bg-rose-900/10' : ''}`}>
                      <td className="px-4 py-3 min-w-[14rem]">
                        <p className="font-semibold text-slate-800 dark:text-slate-100 leading-snug">{r.name}</p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          {r.sku && <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500" dir="ltr">{r.sku}</span>}
                          {r.source === 'bosta' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">من بيانات بوسطة</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap"><StockBadge stock={r.current_stock} /></td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="text-lg font-bold text-indigo-600 dark:text-indigo-400 leading-none">{fmt(r.total_units)}</p>
                        <p className="text-[11px] text-slate-400 mt-1">{shipments(r.parcels)}</p>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {r.projected === null ? <span className="text-xs text-slate-400">—</span> : (
                          <>
                            <p className={`text-lg font-bold leading-none ${r.projected <= 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`} dir="ltr">
                              {fmt(r.projected)}
                            </p>
                            {r.overdue > 0 && <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">بدون {fmt(r.overdue)} متأخرة</p>}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {r.chips.map((c) => (
                            <span key={`${c.date}`} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium whitespace-nowrap ${CHIP[c.kind]}`}>
                              {c.label}
                              <span className="font-bold">{fmt(c.units)}</span>
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>

        {/* Honest footnotes */}
        {data && (
          <div className="text-[11px] leading-relaxed text-slate-400 dark:text-slate-500 space-y-1">
            <p>• موعد الوصول هو «وقت التوصيل المتوقع» من بوسطة (بحد أقصى نهاية ذلك اليوم). «المخزون بعد الوصول» = الحالي + القطع في موعدها فقط، بدون المتأخرة.</p>
            <p>• بعض المرتجعات قد تصل تالفة أو ناقصة — افحصها عند الاستلام قبل إعادة بيعها.</p>
            {data.totals.received_excluded > 0 && (
              <p>• تم استبعاد {shipments(data.totals.received_excluded)} ما زالت بوسطة تعرضها كمرتجعة لكنها سُجّلت بالفعل في سجل المرتجعات.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
