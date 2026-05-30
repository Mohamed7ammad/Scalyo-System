'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getDailyReturns, postManualReturn,
  getProducts, Product, DailyReturn,
} from '@/lib/api';

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const todayISO = () => new Date().toISOString().slice(0, 10);

function fmtDateAr(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function ReturnsPage() {
  const router = useRouter();

  /* ── View state ──────────────────────────────────────────────────────── */
  const [date,    setDate]    = useState<string>(todayISO());
  const [rows,    setRows]    = useState<DailyReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  /* ── Manual return modal state ───────────────────────────────────────── */
  const [modalOpen,   setModalOpen]   = useState(false);
  const [products,    setProducts]    = useState<Product[]>([]);
  const [prodLoading, setProdLoading] = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [form, setForm] = useState({
    productId:  '',
    quantity:   1,
    returnDate: todayISO(),
  });

  /* ── Auth guard ──────────────────────────────────────────────────────── */
  useEffect(() => {
    if (typeof window !== 'undefined' && !localStorage.getItem('token')) {
      router.push('/');
    }
  }, [router]);

  /* ── Fetch returns list ──────────────────────────────────────────────── */
  const fetchReturns = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await getDailyReturns(d);
      setRows(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'خطأ في جلب البيانات');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchReturns(date); }, [date, fetchReturns]);

  /* ── Open modal — fetch products on first open ───────────────────────── */
  const openModal = useCallback(async () => {
    setForm({ productId: '', quantity: 1, returnDate: date });
    setSubmitError(null);
    setModalOpen(true);
    if (products.length === 0) {
      setProdLoading(true);
      try {
        const { data } = await getProducts();
        setProducts(data);
      } catch {
        /* non-fatal — user will see an empty select */
      } finally {
        setProdLoading(false);
      }
    }
  }, [date, products.length]);

  /* ── Submit manual return ────────────────────────────────────────────── */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.productId) { setSubmitError('الرجاء اختيار منتج'); return; }
    if (form.quantity < 1) { setSubmitError('الكمية يجب أن تكون 1 على الأقل'); return; }

    setSubmitting(true);
    setSubmitError(null);
    try {
      await postManualReturn({
        productId:  form.productId,
        quantity:   form.quantity,
        returnDate: form.returnDate,
      });
      setModalOpen(false);
      // If the submitted date matches the current view, refresh
      if (form.returnDate === date) fetchReturns(date);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? (err instanceof Error ? err.message : 'خطأ في الخادم');
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  /* ── Derived totals ──────────────────────────────────────────────────── */
  const totalUnits = rows.reduce((s, r) => s + r.quantity, 0);
  const isToday    = date === todayISO();

  /* ─────────────────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 p-6" dir="rtl">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="mb-8">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500 mb-3">
          <span>إدارة المخزون</span>
          <svg className="w-3 h-3 rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-gray-600 dark:text-slate-300 font-medium">سجل المرتجعات</span>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          {/* Title block */}
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-purple-100 dark:bg-purple-900/40
              flex items-center justify-center shrink-0 shadow-sm">
              <svg className="w-5 h-5 text-purple-600 dark:text-purple-400"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-slate-100 leading-tight">
                سجل المرتجعات اليومية
              </h1>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
                المنتجات التي استُلمت فعلياً من شركة الشحن وأُعيدت للمخزن
              </p>
            </div>
          </div>

          {/* Controls row: today badge + date picker + manual return button */}
          <div className="flex items-center gap-3 flex-wrap">
            {isToday && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold
                bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300
                border border-emerald-200 dark:border-emerald-700/50">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                اليوم
              </span>
            )}

            {/* Date picker */}
            <div className="relative">
              <input
                type="date"
                value={date}
                max={todayISO()}
                onChange={(e) => setDate(e.target.value)}
                dir="ltr"
                className="pl-3 pr-9 py-2 rounded-xl text-sm outline-none cursor-pointer
                  border border-gray-300 dark:border-slate-700
                  bg-white dark:bg-slate-800
                  text-gray-700 dark:text-slate-200
                  focus:ring-2 focus:ring-purple-400 focus:border-purple-400 transition"
              />
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4
                text-gray-400 dark:text-slate-500 pointer-events-none"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>

            {/* Manual return button */}
            <button
              onClick={openModal}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold
                bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white
                dark:bg-purple-600 dark:hover:bg-purple-500
                shadow-sm shadow-purple-500/30 dark:shadow-purple-900/50
                transition-all duration-150 whitespace-nowrap"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 4v16m8-8H4" />
              </svg>
              تسجيل مرتجع يدوي
            </button>
          </div>
        </div>
      </div>

      {/* ── Summary cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
        <StatCard
          label="إجمالي المرتجعات"
          value={loading ? '…' : String(totalUnits)}
          sub="وحدة مُستردة"
          color="purple"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          }
        />
        <StatCard
          label="منتجات مختلفة"
          value={loading ? '…' : String(rows.length)}
          sub="نوع منتج"
          color="indigo"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          }
        />
        <StatCard
          label="تاريخ السجل"
          value={fmtDateAr(date)}
          sub={isToday ? 'اليوم الحالي' : 'يوم سابق'}
          color="slate"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          }
        />
      </div>

      {/* ── Table card ────────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200
        dark:border-slate-800 shadow-sm overflow-hidden">

        {/* Card header */}
        <div className="flex items-center justify-between px-5 py-4
          border-b border-gray-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">
              مرتجعات {fmtDateAr(date)}
            </h2>
          </div>
          {!loading && rows.length > 0 && (
            <span className="text-xs text-gray-400 dark:text-slate-500">
              {rows.length} {rows.length === 1 ? 'منتج' : 'منتجات'}
            </span>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
            <p className="text-sm text-gray-400 dark:text-slate-500">جاري تحميل البيانات…</p>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 px-6">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-red-600 dark:text-red-400">فشل تحميل البيانات</p>
            <p className="text-xs text-gray-400 dark:text-slate-500 text-center">{error}</p>
            <button
              onClick={() => fetchReturns(date)}
              className="mt-1 px-4 py-2 text-xs font-semibold rounded-xl
                bg-red-50 text-red-600 hover:bg-red-100
                dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/60 transition"
            >
              إعادة المحاولة
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 px-6">
            <div className="w-14 h-14 rounded-2xl bg-gray-100 dark:bg-slate-800 flex items-center justify-center">
              <svg className="w-7 h-7 text-gray-400 dark:text-slate-500"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-gray-600 dark:text-slate-300">
              لا توجد مرتجعات مسجلة في هذا اليوم
            </p>
            <p className="text-xs text-gray-400 dark:text-slate-500 text-center max-w-xs">
              سيظهر هنا سجل المنتجات التي استُلمت فعلياً، أو يمكنك إضافة مرتجع يدوي بالضغط على الزر أعلاه.
            </p>
          </div>
        )}

        {/* Data table */}
        {!loading && !error && rows.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-slate-800/50 border-b border-gray-100 dark:border-slate-700">
                  <tr>
                    <Th>#</Th>
                    <Th>المنتج</Th>
                    <Th>رمز الـ SKU</Th>
                    <Th>الكمية المرتجعة</Th>
                    <Th>حالة المخزن</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                  {rows.map((row, i) => (
                    <tr key={`${row.product_name}-${i}`}
                      className="hover:bg-gray-50 dark:hover:bg-slate-800/40 transition-colors">
                      <td className="px-5 py-3.5 text-gray-400 dark:text-slate-600 text-xs w-10">{i + 1}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-900/40
                            flex items-center justify-center shrink-0">
                            <svg className="w-4 h-4 text-purple-600 dark:text-purple-400"
                              fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                            </svg>
                          </div>
                          <span className="font-medium text-gray-800 dark:text-slate-200">
                            {row.product_name}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="font-mono text-xs px-2 py-1 rounded-md
                          bg-gray-100 text-gray-600 dark:bg-slate-800 dark:text-slate-400
                          border border-gray-200 dark:border-slate-700" dir="ltr">
                          {row.sku}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg font-bold text-purple-700 dark:text-purple-300">
                            {row.quantity}
                          </span>
                          <span className="text-xs text-gray-400 dark:text-slate-500">وحدة</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                          text-xs font-semibold
                          bg-emerald-100 text-emerald-700
                          dark:bg-emerald-900/40 dark:text-emerald-300
                          border border-emerald-200 dark:border-emerald-700/50">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                              d="M5 13l4 4L19 7" />
                          </svg>
                          تمت الإعادة للمخزن
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-3 bg-gray-50 dark:bg-slate-800/50
              border-t border-gray-100 dark:border-slate-800
              flex items-center justify-between text-xs text-gray-400 dark:text-slate-500">
              <span>
                إجمالي المنتجات:{' '}
                <span className="font-semibold text-gray-600 dark:text-slate-300">{rows.length}</span>
              </span>
              <span>
                إجمالي الوحدات المُستردة:{' '}
                <span className="font-semibold text-purple-600 dark:text-purple-400">{totalUnits}</span>
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Info note ─────────────────────────────────────────────────────── */}
      <p className="mt-5 text-center text-xs text-gray-400 dark:text-slate-600 leading-relaxed max-w-lg mx-auto">
        يتم تسجيل المرتجعات تلقائياً عبر Webhook من شركة الشحن عند استلام المنتج فعلياً في المستودع.
        يمكن إضافة مرتجعات يدوية لتعويض السجلات الغائبة أو الطلبات التي وصلت خارج المنظومة.
      </p>

      {/* ════════════════════════════════════════════════════════════════════
          Manual Return Modal
          ════════════════════════════════════════════════════════════════ */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4
            bg-black/60 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && setModalOpen(false)}
        >
          <div
            className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl
              border border-gray-200 dark:border-slate-700
              overflow-hidden"
            dir="rtl"
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4
              border-b border-gray-100 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-purple-100 dark:bg-purple-900/40
                  flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-purple-600 dark:text-purple-400"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-sm font-bold text-gray-900 dark:text-slate-100 leading-tight">
                    تسجيل مرتجع يدوي
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                    يُضاف مباشرةً للمخزن وسجل المرتجعات
                  </p>
                </div>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="p-1.5 rounded-lg text-gray-400 dark:text-slate-500
                  hover:text-gray-700 hover:bg-gray-100
                  dark:hover:text-slate-300 dark:hover:bg-slate-800 transition"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal form */}
            <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">

              {/* Date field */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 dark:text-slate-400 mb-1.5">
                  التاريخ
                </label>
                <div className="relative">
                  <input
                    type="date"
                    value={form.returnDate}
                    max={todayISO()}
                    onChange={(e) => setForm((p) => ({ ...p, returnDate: e.target.value }))}
                    dir="ltr"
                    required
                    className="w-full pl-3 pr-10 py-2.5 rounded-xl text-sm outline-none
                      border border-gray-300 dark:border-slate-700
                      bg-gray-50 dark:bg-slate-800
                      text-gray-800 dark:text-slate-200
                      focus:ring-2 focus:ring-purple-400 focus:border-purple-400
                      focus:bg-white dark:focus:bg-slate-700/60 transition"
                  />
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4
                    text-gray-400 dark:text-slate-500 pointer-events-none"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
              </div>

              {/* Product select */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 dark:text-slate-400 mb-1.5">
                  المنتج
                </label>
                {prodLoading ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl
                    border border-gray-200 dark:border-slate-700
                    bg-gray-50 dark:bg-slate-800 text-sm text-gray-400 dark:text-slate-500">
                    <div className="w-4 h-4 rounded-full border-2 border-purple-400 border-t-transparent animate-spin shrink-0" />
                    جاري تحميل المنتجات…
                  </div>
                ) : (
                  <select
                    value={form.productId}
                    onChange={(e) => setForm((p) => ({ ...p, productId: e.target.value }))}
                    required
                    className="w-full px-3 py-2.5 rounded-xl text-sm outline-none
                      border border-gray-300 dark:border-slate-700
                      bg-gray-50 dark:bg-slate-800
                      text-gray-800 dark:text-slate-200
                      [&>option]:bg-white [&>option]:text-slate-900
                      dark:[&>option]:bg-slate-800 dark:[&>option]:text-slate-100
                      focus:ring-2 focus:ring-purple-400 focus:border-purple-400
                      focus:bg-white dark:focus:bg-slate-700/60 transition"
                  >
                    <option value="">— اختر المنتج —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.sku ? ` — ${p.sku}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Quantity field */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 dark:text-slate-400 mb-1.5">
                  الكمية المرتجعة
                </label>
                <div className="flex items-center gap-2">
                  {/* Decrement */}
                  <button
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, quantity: Math.max(1, p.quantity - 1) }))}
                    className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0
                      border border-gray-300 dark:border-slate-700
                      bg-gray-50 dark:bg-slate-800
                      text-gray-600 dark:text-slate-400
                      hover:bg-gray-100 dark:hover:bg-slate-700
                      hover:text-gray-900 dark:hover:text-slate-200 transition"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                    </svg>
                  </button>
                  <input
                    type="number"
                    min={1}
                    value={form.quantity}
                    onChange={(e) => setForm((p) => ({ ...p, quantity: Math.max(1, parseInt(e.target.value) || 1) }))}
                    required
                    dir="ltr"
                    className="flex-1 px-3 py-2.5 rounded-xl text-sm text-center font-semibold outline-none
                      border border-gray-300 dark:border-slate-700
                      bg-gray-50 dark:bg-slate-800
                      text-gray-800 dark:text-slate-200
                      focus:ring-2 focus:ring-purple-400 focus:border-purple-400
                      focus:bg-white dark:focus:bg-slate-700/60 transition"
                  />
                  {/* Increment */}
                  <button
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, quantity: p.quantity + 1 }))}
                    className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0
                      border border-gray-300 dark:border-slate-700
                      bg-gray-50 dark:bg-slate-800
                      text-gray-600 dark:text-slate-400
                      hover:bg-gray-100 dark:hover:bg-slate-700
                      hover:text-gray-900 dark:hover:text-slate-200 transition"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-gray-400 dark:text-slate-600">
                  سيُضاف هذا العدد مباشرةً لرصيد المخزن
                </p>
              </div>

              {/* Submit error */}
              {submitError && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl
                  bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50
                  text-red-600 dark:text-red-400 text-xs">
                  <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {submitError}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-3 pt-1">
                <button
                  type="submit"
                  disabled={submitting || prodLoading}
                  className="flex-1 flex items-center justify-center gap-2
                    py-2.5 rounded-xl text-sm font-semibold transition-all duration-150
                    bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white
                    dark:bg-purple-600 dark:hover:bg-purple-500
                    shadow-sm shadow-purple-500/30
                    disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <>
                      <div className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      جاري الحفظ…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M5 13l4 4L19 7" />
                      </svg>
                      تأكيد وحفظ
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={submitting}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition
                    bg-gray-100 hover:bg-gray-200 text-gray-700
                    dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300
                    disabled:opacity-50"
                >
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────────────── */

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide
      text-gray-500 dark:text-slate-400 whitespace-nowrap">
      {children}
    </th>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  sub:   string;
  color: 'purple' | 'indigo' | 'slate';
  icon:  React.ReactNode;
}

const COLOR_MAP = {
  purple: {
    wrap:  'bg-purple-100 dark:bg-purple-900/40',
    icon:  'text-purple-600 dark:text-purple-400',
    value: 'text-purple-700 dark:text-purple-300',
  },
  indigo: {
    wrap:  'bg-indigo-100 dark:bg-indigo-900/40',
    icon:  'text-indigo-600 dark:text-indigo-400',
    value: 'text-indigo-700 dark:text-indigo-300',
  },
  slate: {
    wrap:  'bg-slate-100 dark:bg-slate-800',
    icon:  'text-slate-500 dark:text-slate-400',
    value: 'text-slate-700 dark:text-slate-300',
  },
};

function StatCard({ label, value, sub, color, icon }: StatCardProps) {
  const c = COLOR_MAP[color];
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200
      dark:border-slate-800 shadow-sm p-4 flex items-center gap-4">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${c.wrap}`}>
        <span className={c.icon}>{icon}</span>
      </div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{label}</p>
        <p className={`text-xl font-bold leading-tight ${c.value}`}>{value}</p>
        <p className="text-xs text-gray-400 dark:text-slate-600 mt-0.5">{sub}</p>
      </div>
    </div>
  );
}
