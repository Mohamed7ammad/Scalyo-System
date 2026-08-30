'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  Order Sources — تحليل مصادر الطلبات   (Admin / analytics)
 * ════════════════════════════════════════════════════════════════════
 *  Per chat-source funnel (received → confirmed → delivered) with a date
 *  range, so chat-moderator commissions can be computed at month end from
 *  DELIVERED orders. Backed by GET /api/analytics/order-sources.
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getOrderSourceAnalytics, OrderSourceAnalytics, CHAT_SOURCE_LABELS, ChatSource } from '@/lib/api';

const todayStr  = () => new Date().toLocaleDateString('en-CA');
const monthStart = () => { const d = new Date(); d.setDate(1); return d.toLocaleDateString('en-CA'); };
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const sourceLabel = (s: string) => CHAT_SOURCE_LABELS[s as ChatSource] ?? (s === 'unset' ? 'غير محدد' : s);

export default function OrderSourcesPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  /* Auth guard — admin OR the 'analytics' permission. */
  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!token || !u) { router.replace('/'); return; }
      const perms: string[] = u.permissions ?? [];
      if (u.role !== 'admin' && !perms.includes('analytics')) { router.replace('/dashboard'); return; }
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  const [start, setStart] = useState(monthStart());
  const [end,   setEnd]   = useState(todayStr());
  const [data,  setData]  = useState<OrderSourceAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (s: string, e: string) => {
    setLoading(true); setError('');
    try {
      const res = await getOrderSourceAnalytics(s || undefined, e || undefined);
      setData(res.data);
    } catch (err: unknown) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر تحميل تحليل المصادر.');
      setData(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (allowed) load(monthStart(), todayStr()); }, [allowed, load]);

  if (!allowed) return null;

  const t = data?.totals ?? { total: 0, confirmed: 0, delivered: 0 };

  const KPI = ({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent: string }) => (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 px-5 py-4 shadow-sm">
      <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">{label}</p>
      <p className={`text-3xl font-extrabold mt-1 tabular-nums ${accent}`}>{value.toLocaleString('en-US')}</p>
      {sub && <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );

  return (
    <div className="min-h-full" dir="rtl">
      <div className="max-w-screen-xl mx-auto px-6 pt-8 pb-10 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">تحليل مصادر الطلبات</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            قمع كل مصدر (المستلمة → المؤكدة → المسلّمة) لحساب عمولات مشرفي الشات على الطلبات المسلّمة.
          </p>
        </div>

        {/* Date range */}
        <div className="flex flex-wrap items-end gap-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 px-4 py-3.5 shadow-sm">
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 mb-1">من تاريخ</label>
            <input type="date" value={start} dir="ltr" onChange={(e) => setStart(e.target.value)}
              className="border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-sm outline-none bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-indigo-400" />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 mb-1">إلى تاريخ</label>
            <input type="date" value={end} dir="ltr" onChange={(e) => setEnd(e.target.value)}
              className="border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-sm outline-none bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-indigo-400" />
          </div>
          <button onClick={() => load(start, end)} disabled={loading}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl transition disabled:opacity-50">
            {loading ? 'جارٍ…' : 'عرض'}
          </button>
          <button onClick={() => { setStart(monthStart()); setEnd(todayStr()); load(monthStart(), todayStr()); }}
            className="px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition">
            هذا الشهر
          </button>
        </div>

        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}

        {/* KPI totals */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <KPI label="إجمالي الطلبات المستلمة" value={t.total} accent="text-slate-900 dark:text-white" />
          <KPI label="المؤكدة" value={t.confirmed} sub={`${pct(t.confirmed, t.total)}% من المستلمة`} accent="text-emerald-600 dark:text-emerald-400" />
          <KPI label="المسلّمة (أساس العمولة)" value={t.delivered} sub={`${pct(t.delivered, t.confirmed)}% من المؤكدة`} accent="text-teal-600 dark:text-teal-400" />
        </div>

        {/* Per-source funnel table */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-20">
              <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-3" />
              <p className="text-slate-400 text-sm">جارٍ التحميل…</p>
            </div>
          ) : !data || data.sources.length === 0 ? (
            <div className="text-center py-16 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">لا توجد طلبات بمصدر محدد في هذه الفترة</p>
              <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">اختر «مصدر الطلب» عند إضافة الطلبات لتظهر هنا.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المصدر</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المستلمة</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المؤكدة</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المسلّمة</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">نسبة التسليم</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.sources.map((r) => (
                    <tr key={r.source} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">{sourceLabel(r.source)}</td>
                      <td className="px-4 py-3 text-slate-700 dark:text-slate-300 tabular-nums">{r.total.toLocaleString('en-US')}</td>
                      <td className="px-4 py-3 tabular-nums">
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400">{r.confirmed.toLocaleString('en-US')}</span>
                        <span className="text-[11px] text-slate-400 mr-1">({pct(r.confirmed, r.total)}%)</span>
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        <span className="font-bold text-teal-600 dark:text-teal-400 text-base">{r.delivered.toLocaleString('en-US')}</span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                          {pct(r.delivered, r.confirmed)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700 font-bold">
                  <tr>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200">الإجمالي</td>
                    <td className="px-4 py-3 tabular-nums text-slate-800 dark:text-slate-100">{t.total.toLocaleString('en-US')}</td>
                    <td className="px-4 py-3 tabular-nums text-emerald-700 dark:text-emerald-400">{t.confirmed.toLocaleString('en-US')}</td>
                    <td className="px-4 py-3 tabular-nums text-teal-700 dark:text-teal-400">{t.delivered.toLocaleString('en-US')}</td>
                    <td className="px-4 py-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
