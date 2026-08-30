'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  My Orders & Commission — طلباتي والعمولة   (Chat Moderator home)
 * ════════════════════════════════════════════════════════════════════
 *  The moderator (chat data-entry) role's ONLY workspace. It shows:
 *    • A header with their personal performance — Total orders they added
 *      → how many reached تم التوصيل (the commission driver) + delivery %.
 *    • An "add order" action (the same manual-create modal agents use),
 *      so a moderator can log a new order straight from here.
 *    • A table of ONLY the orders THEY created, with customer details and
 *      the live status of each — so they can track their own commission.
 *
 *  Every fetch here is fenced server-side to `created_by = <this user>`
 *  (see buildOrderScope + /stats + /orders in backend/src/routes/orders.js),
 *  so a moderator can never see another user's orders, financials or the
 *  company-wide analytics. This page is gated to the moderator role (admins
 *  may preview it); the sidebar hides it for everyone else.
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getOrders, getOrderStats, createOrder, getProducts,
  Order, Product, ChatSource, CHAT_SOURCES, CHAT_SOURCE_LABELS,
} from '@/lib/api';

/* The single status that pays a delivery commission. */
const DELIVERED_STATUS = 'تم التوصيل';

const EGYPT_GOVERNORATES = [
  'القاهرة', 'الجيزة', 'الإسكندرية', 'القليوبية', 'الشرقية', 'الدقهلية', 'البحيرة',
  'الغربية', 'المنوفية', 'كفر الشيخ', 'دمياط', 'بورسعيد', 'الإسماعيلية', 'السويس',
  'الفيوم', 'بني سويف', 'المنيا', 'أسيوط', 'سوهاج', 'قنا', 'الأقصر', 'أسوان',
  'البحر الأحمر', 'الوادي الجديد', 'مطروح', 'شمال سيناء', 'جنوب سيناء',
];

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

const fmtDate = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB');
};

const PAGE_SIZE = 50;

const EMPTY_ADD_FORM = {
  FullName: '', Phone: '', City: '', Address: '',
  productId: '', ProductName: '', sku: '', ProductPrice: '', quantity: '1',
  chat_source: '', ShippingNotes: '',
};

export default function MyOrdersPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  /* Auth guard — moderators only (admins may preview). Everyone else bounced. */
  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!token || !u) { router.replace('/'); return; }
      if (u.role !== 'moderator' && u.role !== 'admin') { router.replace('/dashboard'); return; }
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  /* ── Data ──────────────────────────────────────────────────────── */
  const [orders,    setOrders]    = useState<Order[]>([]);
  const [cursor,    setCursor]    = useState<string | null>(null);
  const [hasMore,   setHasMore]   = useState(false);
  const [total,     setTotal]     = useState(0);
  const [delivered, setDelivered] = useState(0);
  const [loading,   setLoading]   = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error,     setError]     = useState('');
  const [products,  setProducts]  = useState<Product[]>([]);

  const loadStats = useCallback(async () => {
    try {
      const res = await getOrderStats({});
      setTotal(res.data.total ?? 0);
      setDelivered(res.data.byStatus?.[DELIVERED_STATUS] ?? 0);
    } catch { /* header stats are best-effort */ }
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await getOrders({ limit: PAGE_SIZE });
      setOrders(res.data.orders);
      setCursor(res.data.nextCursor);
      setHasMore(res.data.hasMore);
    } catch {
      setError('تعذّر تحميل طلباتك. حاول مرة أخرى.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    loadStats();
    loadFirstPage();
    getProducts().then((r) => setProducts(r.data)).catch(() => setProducts([]));
  }, [allowed, loadStats, loadFirstPage]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getOrders({ limit: PAGE_SIZE, cursor });
      setOrders((prev) => [...prev, ...res.data.orders]);
      setCursor(res.data.nextCursor);
      setHasMore(res.data.hasMore);
    } catch {
      setError('تعذّر تحميل المزيد من الطلبات.');
    } finally { setLoadingMore(false); }
  };

  /* ── Add-order modal ───────────────────────────────────────────── */
  const [showAdd,  setShowAdd]  = useState(false);
  const [addForm,  setAddForm]  = useState({ ...EMPTY_ADD_FORM });
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState('');

  const openAdd = () => { setAddForm({ ...EMPTY_ADD_FORM }); setAddError(''); setShowAdd(true); };

  const handleCreate = async () => {
    if (!addForm.FullName.trim() || !addForm.Phone.trim()) {
      setAddError('اسم العميل ورقم الهاتف مطلوبان.');
      return;
    }
    setAddSaving(true); setAddError('');
    try {
      await createOrder({
        FullName:     addForm.FullName.trim(),
        Phone:        addForm.Phone.trim(),
        City:         addForm.City.trim() || undefined,
        Address:      addForm.Address.trim() || undefined,
        ProductName:  addForm.ProductName.trim() || undefined,
        sku:          addForm.sku.trim() || undefined,
        ProductPrice: addForm.ProductPrice.trim() || undefined,
        quantity:     Math.max(1, parseInt(addForm.quantity, 10) || 1),
        chat_source:  (addForm.chat_source || null) as ChatSource | null,
        ShippingNotes: addForm.ShippingNotes.trim() || null,
      });
      setShowAdd(false);
      /* Refresh the header + list so the new order + updated total appear. */
      await Promise.all([loadStats(), loadFirstPage()]);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّرت إضافة الطلب.';
      setAddError(msg);
    } finally { setAddSaving(false); }
  };

  const deliveryRate = total > 0 ? Math.round((delivered / total) * 100) : 0;

  if (!allowed) return null;

  return (
    <div className="min-h-full" dir="rtl">
      <div className="max-w-screen-xl mx-auto px-6 pt-8 pb-10 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">طلباتي والعمولة</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              كل الطلبات التي سجّلتها أنت، وحالتها الحالية — لمتابعة أدائك وعمولتك على التوصيلات الناجحة.
            </p>
          </div>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white
              rounded-xl text-sm font-semibold shadow-sm shadow-indigo-600/20 transition active:scale-[0.98]"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            إضافة طلب
          </button>
        </div>

        {/* Performance cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">إجمالي الطلبات المُسجّلة</p>
            <p className="text-3xl font-extrabold text-slate-900 dark:text-white mt-2 tabular-nums">{total}</p>
          </div>
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-teal-200 dark:border-teal-900/40 p-5 shadow-sm">
            <p className="text-xs font-semibold text-teal-500 dark:text-teal-400 uppercase tracking-wide">تم التسليم (عمولة)</p>
            <p className="text-3xl font-extrabold text-teal-600 dark:text-teal-300 mt-2 tabular-nums">{delivered}</p>
          </div>
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">نسبة التوصيل</p>
            <p className="text-3xl font-extrabold text-slate-900 dark:text-white mt-2 tabular-nums" dir="ltr">{deliveryRate}%</p>
          </div>
        </div>

        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}

        {/* Orders table */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-16 px-6 text-slate-400 text-sm">جارٍ تحميل طلباتك…</div>
          ) : orders.length === 0 ? (
            <div className="text-center py-16 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">لم تُسجّل أي طلبات بعد</p>
              <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">اضغط «إضافة طلب» لتسجيل أول طلب.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">#</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">العميل</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الهاتف</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المحافظة</th>
                      <th className="text-right font-semibold px-4 py-3">المنتج</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الكمية</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المصدر</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الحالة</th>
                      <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">التاريخ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {orders.map((o) => {
                      const src = (o as { chat_source?: string }).chat_source;
                      const srcLabel = src && CHAT_SOURCES.includes(src as ChatSource)
                        ? CHAT_SOURCE_LABELS[src as ChatSource] : null;
                      return (
                        <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-4 py-3 text-slate-400 dark:text-slate-500 whitespace-nowrap tabular-nums text-xs" dir="ltr">{o.id}</td>
                          <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">{o.FullName || '—'}</td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap" dir="ltr">{o.Phone || '—'}</td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">{o.City || '—'}</td>
                          <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-[16rem]">
                            <span className="line-clamp-2" title={o.ProductName ?? ''}>{o.ProductName || '—'}</span>
                          </td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap tabular-nums" dir="ltr">{o.quantity ?? 1}</td>
                          <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap text-xs">{srcLabel ?? '—'}</td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${badgeFor(o.Status)}`}>
                              {o.Status || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap text-xs" dir="ltr">{fmtDate(o.createdAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {hasMore && (
                <div className="px-4 py-4 border-t border-slate-100 dark:border-slate-800 text-center">
                  <button onClick={loadMore} disabled={loadingMore}
                    className="px-5 py-2 rounded-xl text-sm font-semibold bg-slate-100 text-slate-700
                      hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700
                      transition disabled:opacity-50">
                    {loadingMore ? 'جارٍ التحميل…' : 'تحميل المزيد'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Add-order modal */}
      {showAdd && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={(e) => e.target === e.currentTarget && !addSaving && setShowAdd(false)}
        >
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl
            border border-slate-200 dark:border-slate-700/60 w-full max-w-md flex flex-col max-h-[90dvh]" dir="rtl">

            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white leading-tight">إضافة طلب يدوي</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">طلب خارجي (واتساب / فيسبوك) — يبدأ بحالة «جديد»</p>
              </div>
              <button onClick={() => setShowAdd(false)} disabled={addSaving}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
                  hover:bg-slate-100 dark:hover:bg-slate-800 transition disabled:opacity-40" aria-label="إغلاق">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-4 space-y-3.5 overflow-y-auto">
              {([
                { key: 'FullName', label: 'اسم العميل *', dir: 'rtl', ph: 'الاسم الكامل' },
                { key: 'Phone',    label: 'رقم الهاتف *', dir: 'ltr', ph: '01XXXXXXXXX' },
              ] as { key: keyof typeof addForm; label: string; dir: string; ph: string }[]).map((f) => (
                <div key={f.key}>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">{f.label}</label>
                  <input
                    type="text"
                    value={addForm[f.key]}
                    onChange={(e) => setAddForm((p) => ({ ...p, [f.key]: e.target.value }))}
                    placeholder={f.ph}
                    dir={f.dir}
                    className="w-full px-3 py-2 rounded-xl text-sm outline-none
                      bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                      text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                      focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                  />
                </div>
              ))}

              {/* Governorate */}
              <div>
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">المحافظة</label>
                <select
                  value={addForm.City}
                  onChange={(e) => setAddForm((p) => ({ ...p, City: e.target.value }))}
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none cursor-pointer
                    bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                    text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                >
                  <option value="">— اختر المحافظة —</option>
                  {EGYPT_GOVERNORATES.map((g) => (<option key={g} value={g}>{g}</option>))}
                </select>
              </div>

              {/* Address */}
              <div>
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">العنوان التفصيلي</label>
                <input
                  type="text"
                  value={addForm.Address}
                  onChange={(e) => setAddForm((p) => ({ ...p, Address: e.target.value }))}
                  placeholder="الشارع، المبنى، علامة مميزة"
                  dir="rtl"
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none
                    bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                    text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                    focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                />
              </div>

              {/* Product */}
              <div>
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">المنتج (اختياري)</label>
                <select
                  value={addForm.productId}
                  onChange={(e) => {
                    const prod = products.find((p) => p.id === e.target.value);
                    setAddForm((p) => ({
                      ...p,
                      productId:    e.target.value,
                      ProductName:  prod ? prod.name : '',
                      sku:          prod ? (prod.sku ?? '') : '',
                      ProductPrice: prod ? String(prod.selling_price ?? '') : p.ProductPrice,
                    }));
                  }}
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none cursor-pointer
                    bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                    text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                >
                  <option value="">— اختر منتجاً —</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</option>
                  ))}
                </select>
                {products.length === 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">لا توجد منتجات مُسجّلة بعد.</p>
                )}
              </div>

              {/* Quantity + Total */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">الكمية</label>
                  <input
                    type="number" min="1" step="1"
                    value={addForm.quantity}
                    onChange={(e) => setAddForm((p) => ({ ...p, quantity: e.target.value }))}
                    placeholder="1" dir="ltr"
                    className="w-full px-3 py-2 rounded-xl text-sm outline-none
                      bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                      text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                      focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">الإجمالي / المبلغ (COD)</label>
                  <input
                    type="number" min="0"
                    value={addForm.ProductPrice}
                    onChange={(e) => setAddForm((p) => ({ ...p, ProductPrice: e.target.value }))}
                    placeholder="0" dir="ltr"
                    className="w-full px-3 py-2 rounded-xl text-sm outline-none
                      bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                      text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                      focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                  />
                </div>
              </div>

              {/* Order source */}
              <div>
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">مصدر الطلب</label>
                <select
                  value={addForm.chat_source}
                  onChange={(e) => setAddForm((p) => ({ ...p, chat_source: e.target.value }))}
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none
                    bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                    text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                >
                  <option value="">— اختر مصدر الطلب —</option>
                  {CHAT_SOURCES.map((s) => (<option key={s} value={s}>{CHAT_SOURCE_LABELS[s]}</option>))}
                </select>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">القناة التي جاء منها الطلب.</p>
              </div>

              {/* Shipping note */}
              <div>
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">ملاحظة لشركة الشحن (اختياري)</label>
                <textarea
                  rows={2}
                  value={addForm.ShippingNotes}
                  onChange={(e) => setAddForm((p) => ({ ...p, ShippingNotes: e.target.value }))}
                  placeholder="تعليمات للمندوب — تُطبع على بوليصة الشحن"
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none resize-y
                    bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700
                    text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600
                    focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                />
              </div>

              {addError && <p className="text-sm text-red-500 dark:text-red-400">{addError}</p>}
            </div>

            {/* Footer */}
            <div className="px-6 pb-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex gap-3">
              <button
                onClick={handleCreate}
                disabled={addSaving || !addForm.FullName.trim() || !addForm.Phone.trim()}
                className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl
                  text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white
                  shadow-md shadow-indigo-600/20 disabled:opacity-50 disabled:cursor-not-allowed
                  transition-all duration-150 active:scale-[0.98]"
              >
                {addSaving ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    جارٍ الإضافة…
                  </>
                ) : 'إضافة الطلب'}
              </button>
              <button onClick={() => setShowAdd(false)} disabled={addSaving}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold text-slate-600 dark:text-slate-300
                  bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 transition disabled:opacity-40">
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
