'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  Order Verification — التحقق من الطلبات  (After-Sales, READ-ONLY)
 * ════════════════════════════════════════════════════════════════════
 *  Lets the after-sales customer-service role verify a customer's orders
 *  by phone number. STRICTLY read-only and financial-free: shows only
 *  customer name, phone, status, product(s) and date — never price, COD,
 *  cost or profit. No edit affordances. Backed by GET /api/orders/lookup,
 *  which returns exactly this minimal projection.
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { lookupOrders, OrderLookupRow } from '@/lib/api';

/* Status → badge colour (mirrors the orders table palette). */
const STATUS_BADGE: Record<string, string> = {
  'جديد':          'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'تم التأكيد':    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'تم الشحن':      'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  'تم التوصيل':    'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  'تم الرفض':      'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  'مؤجل':          'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  'لا يرد':        'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'جاري الإعادة':  'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  'تم الإرجاع':    'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
};
const badgeFor = (s: string) => STATUS_BADGE[s?.trim()] ?? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB');
};

export default function OrderLookupPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  /* Auth guard — admins and holders of the 'order_lookup' permission (the
     after-sales role) only. Everyone else is bounced. */
  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!token || !u) { router.replace('/'); return; }
      const perms: string[] = u.permissions ?? [];
      const ok = u.role === 'admin' || u.role === 'after_sales' || perms.includes('order_lookup');
      if (!ok) { router.replace('/dashboard'); return; }
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  const [phone,    setPhone]    = useState('');
  const [rows,     setRows]     = useState<OrderLookupRow[] | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 3) { setError('أدخل 3 أرقام على الأقل من رقم الهاتف.'); return; }
    setLoading(true); setError('');
    try {
      const res = await lookupOrders(phone.trim());
      setRows(res.data);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر البحث عن الطلبات.';
      setError(msg); setRows(null);
    } finally { setLoading(false); }
  };

  if (!allowed) return null;

  return (
    <div className="min-h-full" dir="rtl">
      <div className="max-w-screen-lg mx-auto px-6 pt-8 pb-10 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">التحقق من الطلبات</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            ابحث برقم هاتف العميل للتحقق من طلباته وحالتها — عرض فقط، بدون أي بيانات مالية.
          </p>
        </div>

        {/* Search bar */}
        <form onSubmit={search}
          className="flex flex-wrap items-center gap-3 bg-white dark:bg-slate-900 rounded-2xl
            border border-slate-200 dark:border-slate-800 px-4 py-3.5 shadow-sm">
          <div className="relative flex-1 min-w-[220px]">
            <svg className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="tel" inputMode="numeric" dir="ltr"
              value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="01xxxxxxxxx"
              className="w-full pr-9 pl-3 py-2.5 rounded-xl text-sm text-left bg-slate-50 dark:bg-slate-800
                border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200
                outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
            />
          </div>
          <button type="submit" disabled={loading}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white
              rounded-xl text-sm font-semibold shadow-sm transition disabled:opacity-50">
            {loading ? 'جارٍ البحث…' : 'بحث'}
          </button>
        </form>

        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}

        {/* Results */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          {rows === null ? (
            <div className="text-center py-16 px-6 text-slate-400 text-sm">
              أدخل رقم الهاتف واضغط «بحث» لعرض طلبات العميل.
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">لا توجد طلبات مطابقة</p>
              <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">تحقّق من الرقم وحاول مرة أخرى.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">العميل</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الهاتف</th>
                    <th className="text-right font-semibold px-4 py-3">المنتج</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الحالة</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">التاريخ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">{r.customer_name || '—'}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap" dir="ltr">{r.phone || '—'}</td>
                      <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-[18rem]">
                        <span className="line-clamp-2" title={r.product_name ?? ''}>{r.product_name || '—'}</span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${badgeFor(r.status)}`}>
                          {r.status || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap text-xs" dir="ltr">{fmtDate(r.created_at)}</td>
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
