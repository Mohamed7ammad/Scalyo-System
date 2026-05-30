'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getPurchaseHistory, PurchaseHistoryItem } from '@/lib/api';

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const parseN = (v: string | number | null | undefined): number =>
  parseFloat(String(v ?? 0)) || 0;

const fmtNum = (v: number): string =>
  v % 1 === 0
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtEGP = (v: number): string => `${fmtNum(v)} ج.م`;

/* ── Sub-components ──────────────────────────────────────────────────────── */

function StatCard({
  label, value, sub, accent, icon,
}: {
  label: string; value: string; sub?: string;
  accent: string; icon: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200
      dark:border-slate-800 px-5 py-4 shadow-sm flex items-start gap-4">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${accent.replace('text-', 'bg-').replace('-600', '-100').replace('-400', '-900/30')}`}>
        <span className={accent}>{icon}</span>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-0.5">
          {label}
        </p>
        <p className={`text-xl font-bold tracking-tight ${accent}`}>{value}</p>
        {sub && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────────────────────── */
export default function PurchasesHistoryPage() {
  const router = useRouter();

  const [purchases, setPurchases] = useState<PurchaseHistoryItem[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [search,    setSearch]    = useState('');

  /* ── Auth guard — admin only ────────────────────────────────────────── */
  useEffect(() => {
    const token    = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (!token || !userData) { router.push('/'); return; }
    try {
      const u = JSON.parse(userData);
      if (u.role !== 'admin') router.push('/dashboard');
    } catch { router.push('/'); }
  }, [router]);

  /* ── Data fetch ─────────────────────────────────────────────────────── */
  const fetchPurchases = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const res = await getPurchaseHistory();
      setPurchases(res.data);
    } catch {
      setError('فشل تحميل سجل الشحنات — تحقق من الاتصال');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPurchases(); }, [fetchPurchases]);

  /* ── Derived data ───────────────────────────────────────────────────── */

  // Must be declared BEFORE stats (which reads it) to avoid TDZ crash.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return purchases;
    return purchases.filter(
      (p) =>
        p.product_name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q)
    );
  }, [purchases, search]);

  const stats = useMemo(() => {
    // All four summary cards reflect the *filtered* rows so they stay in sync
    // with whatever the search box is showing in the table.
    const totalBatches = filtered.length;
    const totalUnits   = filtered.reduce((s, p) => s + p.quantity, 0);
    const totalCostVal = filtered.reduce(
      (s, p) => s + p.quantity * parseN(p.cost_price), 0
    );

    /* WAC is only financially meaningful for a SINGLE product.
       Blending costs across different products produces a number that has
       no real-world meaning — so we detect that case and refuse to show it. */
    const uniqueSkus      = new Set(filtered.map((p) => p.sku));
    const isSingleProduct = uniqueSkus.size === 1 && filtered.length > 0;
    const wac             = isSingleProduct && totalUnits > 0
      ? totalCostVal / totalUnits
      : null;

    return { totalBatches, totalUnits, totalCostVal, wac, isSingleProduct };
  }, [filtered]);

  /* ── Render ─────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-full" dir="rtl">
      <div className="max-w-screen-2xl mx-auto px-6 pt-8 pb-12 space-y-6">

        {/* ── Page header ──────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              {/* Back breadcrumb */}
              <button
                onClick={() => router.push('/dashboard/inventory')}
                className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-500
                  hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                إدارة المخزون
              </button>
              <span className="text-slate-300 dark:text-slate-700 text-xs">/</span>
              <span className="text-xs text-slate-400 dark:text-slate-500">سجل الشحنات</span>
            </div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">
              سجل الشحنات الواردة
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              أرشيف كامل لجميع الشحنات المضافة وتكاليف الشراء من الموردين
            </p>
          </div>

          <button
            onClick={fetchPurchases}
            disabled={loading}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5
              bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800
              border border-slate-200 dark:border-slate-700
              rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300
              shadow-sm transition-all disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            تحديث
          </button>
        </div>

        {/* ── Stats row ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="إجمالي الشحنات"
            value={String(stats.totalBatches)}
            sub="دفعة واردة"
            accent="text-indigo-600 dark:text-indigo-400"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            }
          />
          <StatCard
            label="إجمالي الوحدات"
            value={stats.totalUnits.toLocaleString('en-US')}
            sub="قطعة واردة"
            accent="text-emerald-600 dark:text-emerald-400"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            }
          />
          <StatCard
            label="إجمالي تكلفة الشراء"
            value={fmtEGP(stats.totalCostVal)}
            sub="مدفوع للموردين"
            accent="text-rose-600 dark:text-rose-400"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
          <StatCard
            label="متوسط تكلفة الوحدة (WAC)"
            value={
              stats.wac !== null
                ? fmtEGP(Math.round(stats.wac * 100) / 100)
                : '—'
            }
            sub={
              stats.isSingleProduct
                ? 'WAC المرجح لهذا المنتج'
                : filtered.length === 0
                  ? 'لا توجد بيانات'
                  : 'اختر منتجاً واحداً'
            }
            accent={stats.wac !== null ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500'}
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            }
          />
        </div>

        {/* ── Search bar ───────────────────────────────────────────────── */}
        <div className="relative">
          <div className="absolute inset-y-0 right-0 flex items-center pr-3.5 pointer-events-none">
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0" />
            </svg>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث باسم المنتج أو SKU..."
            className="w-full pr-10 pl-4 py-2.5 rounded-xl text-sm
              bg-white dark:bg-slate-900
              border border-slate-300 dark:border-slate-700
              text-slate-800 dark:text-slate-200
              placeholder-slate-400 dark:placeholder-slate-600
              outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent
              shadow-sm transition"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute inset-y-0 left-0 flex items-center pl-3.5
                text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                  d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* ── Table / states ───────────────────────────────────────────── */}
        {loading ? (
          /* Loading skeleton */
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200
            dark:border-slate-800 text-center py-24 shadow-sm">
            <div className="inline-block w-8 h-8 border-4 border-emerald-200 border-t-emerald-600
              rounded-full animate-spin mb-3" />
            <p className="text-slate-400 dark:text-slate-500 text-sm">جارٍ تحميل سجل الشحنات...</p>
          </div>

        ) : error ? (
          /* Error state */
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-red-200
            dark:border-red-900/50 text-center py-16 shadow-sm px-6">
            <div className="inline-flex items-center justify-center w-12 h-12
              rounded-full bg-red-100 dark:bg-red-900/30 mb-4">
              <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-slate-700 dark:text-slate-300 font-semibold text-sm mb-1">{error}</p>
            <button
              onClick={fetchPurchases}
              className="mt-3 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              إعادة المحاولة
            </button>
          </div>

        ) : filtered.length === 0 ? (
          /* Empty state */
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200
            dark:border-slate-800 text-center py-24 shadow-sm px-6">
            <div className="inline-flex items-center justify-center w-16 h-16
              rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 mb-5">
              <svg className="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            {search ? (
              <>
                <p className="text-slate-700 dark:text-slate-300 font-semibold text-sm">
                  لا توجد نتائج لـ &ldquo;{search}&rdquo;
                </p>
                <button
                  onClick={() => setSearch('')}
                  className="mt-3 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  مسح البحث
                </button>
              </>
            ) : (
              <>
                <p className="text-slate-700 dark:text-slate-300 font-semibold">
                  لا توجد شحنات واردة بعد
                </p>
                <p className="text-slate-400 dark:text-slate-500 text-sm mt-1.5 max-w-xs mx-auto leading-relaxed">
                  استخدم زر &ldquo;إدخال شحنة&rdquo; في صفحة المخزون لتسجيل أول دفعة واردة
                </p>
                <button
                  onClick={() => router.push('/dashboard/inventory')}
                  className="mt-5 inline-flex items-center gap-2 px-5 py-2.5
                    bg-emerald-600 hover:bg-emerald-700 text-white
                    rounded-xl text-sm font-semibold transition"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M12 4v16m8-8H4" />
                  </svg>
                  إدخال شحنة جديدة
                </button>
              </>
            )}
          </div>

        ) : (
          /* Data table */
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200
            dark:border-slate-800 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '820px' }}>

                {/* ── thead ── */}
                <thead className="bg-slate-50 dark:bg-slate-800/60 border-b
                  border-slate-200 dark:border-slate-700">
                  <tr>
                    {[
                      { label: '#',                     cls: 'w-12'  },
                      { label: 'تاريخ الشحنة',           cls: 'w-36'  },
                      { label: 'المنتج',                  cls: ''      },
                      { label: 'رمز الـ SKU',             cls: 'w-32'  },
                      { label: 'الكمية الواردة',           cls: 'w-36'  },
                      { label: 'سعر تكلفة القطعة',        cls: 'w-40'  },
                      { label: 'إجمالي تكلفة الشحنة',     cls: 'w-44'  },
                    ].map(({ label, cls }) => (
                      <th key={label}
                        className={`px-4 py-3.5 text-right text-[11px] font-bold uppercase
                          tracking-wider text-slate-400 dark:text-slate-500
                          whitespace-nowrap ${cls}`}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>

                {/* ── tbody ── */}
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filtered.map((row, i) => {
                    const unitCost   = parseN(row.cost_price);
                    const totalCost  = row.quantity * unitCost;

                    return (
                      <tr
                        key={row.id}
                        onClick={() => setSearch(row.sku || row.product_name)}
                        className="cursor-pointer transition-colors hover:bg-slate-100 dark:hover:bg-slate-800/50"
                      >
                        {/* # */}
                        <td className="px-4 py-3.5 text-slate-400 dark:text-slate-600 text-xs">
                          {i + 1}
                        </td>

                        {/* Purchase date */}
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shrink-0" />
                            <span className="font-medium text-slate-700 dark:text-slate-300 tabular-nums text-xs" dir="ltr">
                              {row.purchase_date.split('T')[0]}
                            </span>
                          </div>
                        </td>

                        {/* Product name */}
                        <td className="px-4 py-3.5">
                          <p className="font-semibold text-slate-800 dark:text-slate-200 leading-snug">
                            {row.product_name}
                          </p>
                        </td>

                        {/* SKU badge */}
                        <td className="px-4 py-3.5">
                          <span className="font-mono text-xs px-2 py-1 rounded-md
                            bg-slate-100 dark:bg-slate-800
                            text-slate-600 dark:text-slate-400
                            border border-slate-200 dark:border-slate-700"
                            dir="ltr">
                            {row.sku}
                          </span>
                        </td>

                        {/* Quantity */}
                        <td className="px-4 py-3.5">
                          <span className="inline-flex items-center gap-1
                            font-bold text-sm text-emerald-600 dark:text-emerald-400"
                            dir="ltr">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                                d="M12 4v16m8-8H4" />
                            </svg>
                            {row.quantity.toLocaleString('en-US')} قطعة
                          </span>
                        </td>

                        {/* Unit cost */}
                        <td className="px-4 py-3.5">
                          <span className="font-medium text-slate-600 dark:text-slate-400
                            tabular-nums" dir="ltr">
                            {fmtEGP(unitCost)}
                          </span>
                        </td>

                        {/* Total batch cost — highlighted */}
                        <td className="px-4 py-3.5">
                          <span className="font-bold text-slate-800 dark:text-slate-100
                            tabular-nums whitespace-nowrap" dir="ltr">
                            {fmtEGP(totalCost)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                {/* ── tfoot totals ── */}
                <tfoot>
                  <tr className="bg-slate-50 dark:bg-slate-800/60
                    border-t-2 border-slate-200 dark:border-slate-700">
                    <td className="px-4 py-3.5 font-bold text-slate-700 dark:text-slate-200 text-sm"
                      colSpan={4}>
                      الإجمالي — {filtered.length !== purchases.length
                        ? `${filtered.length} نتيجة`
                        : `${purchases.length} شحنة`}
                    </td>
                    <td className="px-4 py-3.5 font-bold text-emerald-600 dark:text-emerald-400
                      tabular-nums" dir="ltr">
                      +{filtered.reduce((s, p) => s + p.quantity, 0).toLocaleString('en-US')} قطعة
                    </td>
                    <td />
                    <td className="px-4 py-3.5 font-bold text-slate-800 dark:text-slate-100
                      tabular-nums whitespace-nowrap" dir="ltr">
                      {fmtEGP(
                        filtered.reduce((s, p) => s + p.quantity * parseN(p.cost_price), 0)
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
