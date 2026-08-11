'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  In-Transit Orders — البضاعة قيد التنفيذ   (Admin only)
 * ════════════════════════════════════════════════════════════════════
 *  Standalone page listing every order currently floating with Bosta in
 *  the 'قيد التنفيذ' state, fetched LIVE from Bosta (mirrors the dashboard
 *  1:1). Top: the per-product summary banner (total + breakdown). Below:
 *  the full order table (id, customer, phone, product, qty, tracking).
 *  Backend: GET /api/inventory/in-transit(/details) — Bosta-cached.
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getInTransitInventory, getInTransitDetails,
  InTransitSummary, InTransitOrderRow,
} from '@/lib/api';

const STATUS_BADGE: Record<string, string> = {
  'تم الشحن':      'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  'تم التأكيد':    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'جاري الإعادة':  'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  'تم الإرجاع':    'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  'تم التوصيل':    'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
};
const badgeFor = (s: string) => STATUS_BADGE[(s || '').trim()] ?? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
const fmtDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB'); };

export default function InTransitOrdersPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  /* Auth guard — strictly admin. */
  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!token || !u) { router.replace('/'); return; }
      if (u.role !== 'admin') { router.replace('/dashboard'); return; }
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  const [summary, setSummary] = useState<InTransitSummary | null>(null);
  const [orders,  setOrders]  = useState<InTransitOrderRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [sumRes, detRes] = await Promise.all([getInTransitInventory(), getInTransitDetails()]);
      setSummary(sumRes.data);
      setOrders(detRes.data.orders);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'تعذّر تحميل الطلبات قيد التنفيذ من Bosta.';
      setError(msg); setSummary(null); setOrders(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  if (!allowed) return null;

  return (
    <div className="min-h-full" dir="rtl">
      <div className="max-w-screen-2xl mx-auto px-6 pt-8 pb-10 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">البضاعة قيد التنفيذ</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              كل الطلبات المشحونة والمتحركة حالياً لدى شركة الشحن (Bosta) — مباشرة من نظام بوسطة.
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
              text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800
              border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700
              transition disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            تحديث
          </button>
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 px-4 py-3 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        {/* ── Summary banner (total + per-product breakdown) ── */}
        {summary && summary.total_orders > 0 && (
          <div className="rounded-2xl border border-indigo-200 dark:border-indigo-800/50
            bg-gradient-to-l from-indigo-50 to-white dark:from-indigo-950/40 dark:to-slate-900
            px-5 py-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-3 shrink-0">
                <div className="w-11 h-11 rounded-xl bg-indigo-100 dark:bg-indigo-900/50
                  flex items-center justify-center text-indigo-600 dark:text-indigo-300 shrink-0">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                      d="M9 17a2 2 0 11-4 0 2 2 0 014 0zm10 0a2 2 0 11-4 0 2 2 0 014 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                      d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1" />
                  </svg>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-indigo-500 dark:text-indigo-400 uppercase tracking-wide">
                    بضاعة لدى شركة الشحن (قيد التنفيذ)
                  </p>
                  <p className="text-2xl font-extrabold text-slate-900 dark:text-white leading-none tabular-nums mt-0.5">
                    {summary.total_orders.toLocaleString('en-US')}
                    <span className="text-sm font-semibold text-slate-400 dark:text-slate-500 mr-1.5">طلب قيد التنفيذ</span>
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[200px]">
                {summary.breakdown.map((b) => (
                  <span key={b.product}
                    title={`${b.product} — ${b.count} قطعة في ${b.orders} طلب`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold
                      bg-white dark:bg-slate-800 border border-indigo-100 dark:border-slate-700
                      text-slate-700 dark:text-slate-200">
                    <span className="truncate max-w-[150px]">{b.product}</span>
                    <span className="tabular-nums text-indigo-600 dark:text-indigo-300 font-bold">{b.count}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Details table ── */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-20">
              <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-3" />
              <p className="text-slate-400 text-sm">جارٍ الجلب من Bosta…</p>
            </div>
          ) : !orders || orders.length === 0 ? (
            <div className="text-center py-20 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">لا توجد طلبات قيد التنفيذ</p>
              <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">لا توجد شحنات نشطة لدى شركة الشحن حالياً.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                <span>عرض <span className="font-bold text-slate-700 dark:text-slate-200">{orders.length}</span> طلب مطابق محلياً
                  {summary && summary.total_orders > orders.length &&
                    <span className="text-slate-400"> (من إجمالي {summary.total_orders} لدى بوسطة)</span>}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">#</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">العميل</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الهاتف</th>
                      <th className="text-right font-semibold px-4 py-3">المنتج</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الكمية</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">رقم التتبع</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الحالة المحلية</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">التاريخ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {orders.map((o) => (
                      <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-4 py-3 text-slate-400 dark:text-slate-500 tabular-nums text-xs" dir="ltr">{o.id}</td>
                        <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">{o.customer_name || '—'}</td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap" dir="ltr">{o.phone || '—'}</td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-[18rem]">
                          <span className="line-clamp-2" title={o.product_name ?? ''}>{o.product_name || '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-200 tabular-nums font-semibold text-center">{o.quantity}</td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap font-mono text-xs" dir="ltr">{o.tracking_number || '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${badgeFor(o.status)}`}>{o.status || '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap text-xs" dir="ltr">{fmtDate(o.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
