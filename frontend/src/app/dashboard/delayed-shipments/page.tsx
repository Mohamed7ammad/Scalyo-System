'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  Delayed Shipments — الشحنات المتأخرة  (Bosta compensation-claim tracker)
 * ════════════════════════════════════════════════════════════════════
 *  Isolates in-transit parcels that are STUCK so ops can grab the AWB and file
 *  a Bosta compensation claim before the claim window closes. An order is
 *  "delayed" when — while still 'تم الشحن' (no final resolution) — EITHER Bosta
 *  flagged it as an exception ("في انتظار متابعتك"), OR it shipped more than
 *  `minDays` days ago. Tenant/role-scoped server-side (GET /api/orders/delayed).
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getDelayedShipments, DelayedOrdersResponse } from '@/lib/api';

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB');
};

/* Severity by days elapsed: ≥7 critical (red), else warning (amber). */
const sev = (days: number) => (days >= 7
  ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
  : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300');

export default function DelayedShipmentsPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!token || !u) { router.replace('/'); return; }
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  const [data,     setData]     = useState<DelayedOrdersResponse | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [copiedAwb, setCopiedAwb] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await getDelayedShipments();
      setData(res.data);
    } catch {
      setError('تعذّر تحميل الشحنات المتأخرة. حاول مرة أخرى.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  const copyAwb = (awb: string | null) => {
    if (!awb) return;
    navigator.clipboard?.writeText(awb).then(() => {
      setCopiedAwb(awb);
      setTimeout(() => setCopiedAwb((c) => (c === awb ? null : c)), 1500);
    });
  };

  if (!allowed) return null;

  return (
    <div className="min-h-full" dir="rtl">
      <div className="max-w-screen-xl mx-auto px-6 pt-8 pb-10 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight flex items-center gap-2">
              <svg className="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              الشحنات المتأخرة
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              شحنات عالقة قيد التوصيل — انسخ رقم الشحنة (AWB) وقدّم مطالبة تعويض لدى بوسطة قبل انتهاء المهلة.
              القائمة تعتمد 100% على تصنيف بوسطة: يظهر الطلب هنا فقط إذا صنّفته بوسطة كـ«في انتظار متابعتك».
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold
              bg-slate-100 text-slate-700 hover:bg-slate-200
              dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 transition disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            تحديث
          </button>
        </div>

        {/* Count card */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-amber-200 dark:border-amber-900/40 p-5 shadow-sm inline-flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center shrink-0">
            <svg className="w-6 h-6 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-xs font-semibold text-amber-500 dark:text-amber-400 uppercase tracking-wide">شحنات متأخرة تحتاج مطالبة</p>
            <p className="text-3xl font-extrabold text-slate-900 dark:text-white mt-1 tabular-nums">
              {loading ? '…' : (data?.count ?? 0)}
            </p>
          </div>
        </div>

        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}

        {/* Table */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-16 px-6 text-slate-400 text-sm">جارٍ التحميل…</div>
          ) : !data || data.orders.length === 0 ? (
            <div className="text-center py-16 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">لا توجد شحنات متأخرة 🎉</p>
              <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">كل الشحنات ضمن المهلة المتوقعة.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">التنبيه</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">رقم الطلب</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">العميل</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الهاتف</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المنطقة</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">رقم الشحنة (AWB)</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">تاريخ الشحن</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الأيام المنقضية</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.orders.map((o) => (
                    <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-bold ${sev(o.days_elapsed)}`}>
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                          بوسطة: متابعة
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400 dark:text-slate-500 whitespace-nowrap tabular-nums text-xs" dir="ltr">#{o.id}</td>
                      <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">{o.customer_name || '—'}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap" dir="ltr">{o.phone || '—'}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">{o.city || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {o.tracking_number ? (
                          <button
                            type="button"
                            onClick={() => copyAwb(o.tracking_number)}
                            className="inline-flex items-center gap-1.5 font-mono text-xs text-sky-700 dark:text-sky-300
                              bg-sky-50 dark:bg-sky-900/30 hover:bg-sky-100 dark:hover:bg-sky-900/50
                              px-2 py-1 rounded-lg transition" dir="ltr" title="انسخ رقم الشحنة"
                          >
                            {copiedAwb === o.tracking_number ? (
                              <><svg className="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>تم النسخ</>
                            ) : (
                              <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>{o.tracking_number}</>
                            )}
                          </button>
                        ) : (
                          <span className="text-slate-400 text-xs">لا يوجد</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap text-xs" dir="ltr">{fmtDate(o.shipped_at)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center justify-center min-w-[3.5rem] px-2 py-1 rounded-lg text-xs font-extrabold tabular-nums ${sev(o.days_elapsed)}`} dir="ltr">
                          {o.days_elapsed} يوم
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
