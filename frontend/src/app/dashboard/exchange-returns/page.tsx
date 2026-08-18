'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  Exchange & Returns — الاستبدال والاسترجاع
 * ════════════════════════════════════════════════════════════════════
 *  Formal exchange/return requests logged by any employee on behalf of
 *  a customer, with an evidence video link. Requests open in
 *  «قيد المراجعة» and move through a fixed review workflow.
 *  Open to every employee; hard delete is admin-only.
 *  Backend: /api/exchange-returns (routes/exchangeReturns.js).
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  getExchangeReturnRequests, createExchangeReturnRequest,
  updateExchangeReturnRequest, deleteExchangeReturnRequest,
  getProducts,
  ExchangeReturnRequest, ExchangeReturnType, ExchangeReturnStatus,
  EXCHANGE_RETURN_TYPES, EXCHANGE_RETURN_STATUSES, Product,
  RefundMethod, REFUND_METHOD_LABELS,
} from '@/lib/api';

/* Refund-method badge colours. */
const REFUND_METHOD_BADGE: Record<RefundMethod, string> = {
  vodafone_cash: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  instapay:      'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
};

/* ── Status / type presentation ──────────────────────────────────────────── */
const STATUS_BADGE: Record<ExchangeReturnStatus, string> = {
  'قيد المراجعة':  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  'تمت الموافقة':  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  'مرفوض':         'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  'مكتمل':         'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
};

const TYPE_BADGE: Record<ExchangeReturnType, string> = {
  'استبدال': 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  'استرجاع': 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
};

const ALL_TYPES    = 'كل الأنواع';
const ALL_STATUSES = 'كل الحالات';

interface Toast { message: string; type: 'success' | 'error' }

/* ── Modal wrapper (same pattern as after-sales) ─────────────────────────── */
function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md p-6" dir="rtl">
        {children}
      </div>
    </div>
  );
}

const inputCls = `w-full px-3 py-2.5 rounded-xl text-sm outline-none border border-slate-300 dark:border-slate-700
  bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-indigo-400 focus:border-transparent`;

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB');
};

/* ══════════════════════════════════════════════════════════════════════════ */
export default function ExchangeReturnsPage() {
  const router = useRouter();

  const [allowed,  setAllowed]  = useState(false);
  const [isAdmin,  setIsAdmin]  = useState(false);
  const [requests, setRequests] = useState<ExchangeReturnRequest[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [toast,    setToast]    = useState<Toast | null>(null);

  /* Top-bar filters */
  const [typeFilter,   setTypeFilter]   = useState<string>(ALL_TYPES);
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUSES);
  const [search,       setSearch]       = useState('');

  /* Create modal */
  const [showCreate,   setShowCreate]   = useState(false);
  const [newName,      setNewName]      = useState('');
  const [newPhone,     setNewPhone]     = useState('');
  const [newType,      setNewType]      = useState<ExchangeReturnType>('استبدال');
  const [newProduct,   setNewProduct]   = useState('');   // product id ('' = not chosen)
  const [newReason,    setNewReason]    = useState('');
  const [newVideo,     setNewVideo]     = useState('');
  /* Deposit / insurance (200 EGP) */
  const [newDepositUrl,   setNewDepositUrl]   = useState('');
  const [newRefundPhone,  setNewRefundPhone]  = useState('');
  const [newRefundMethod, setNewRefundMethod] = useState<RefundMethod | ''>('');
  const [createSaving, setCreateSaving] = useState(false);

  /* Edit / review modal */
  const [editTarget, setEditTarget] = useState<ExchangeReturnRequest | null>(null);
  const [editStatus, setEditStatus] = useState<ExchangeReturnStatus>('قيد المراجعة');
  const [editNotes,  setEditNotes]  = useState('');
  const [editDepositUrl,   setEditDepositUrl]   = useState('');
  const [editRefundPhone,  setEditRefundPhone]  = useState('');
  const [editRefundMethod, setEditRefundMethod] = useState<RefundMethod | ''>('');
  const [editSaving, setEditSaving] = useState(false);

  const [busyRow, setBusyRow] = useState<number | null>(null);

  const showToast = (message: string, type: Toast['type']) => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  /* ── Auth guard — any logged-in employee ─────────────────────────────────── */
  useEffect(() => {
    try {
      const token  = localStorage.getItem('token');
      const stored = localStorage.getItem('user');
      if (!token || !stored) { router.replace('/'); return; }
      const u = JSON.parse(stored);
      setIsAdmin(u.role === 'admin');
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  /* ── Fetch ───────────────────────────────────────────────────────────────── */
  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      const [requestsRes, productsRes] = await Promise.all([getExchangeReturnRequests(), getProducts()]);
      setRequests(requestsRes.data);
      setProducts(productsRes.data);
    } catch {
      showToast('تعذّر تحميل طلبات الاستبدال والاسترجاع', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (allowed) fetchAll(); }, [allowed, fetchAll]);

  /* ── Derived: filter chain (type → status → search) ──────────────────────── */
  const visibleRows = useMemo(() => {
    let rows = requests;
    if (typeFilter   !== ALL_TYPES)    rows = rows.filter((r) => r.request_type === typeFilter);
    if (statusFilter !== ALL_STATUSES) rows = rows.filter((r) => r.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        r.customer_name.toLowerCase().includes(q) ||
        r.customer_phone.toLowerCase().includes(q) ||
        (r.product_name ?? '').toLowerCase().includes(q) ||
        (r.reason ?? '').toLowerCase().includes(q));
    }
    return rows;
  }, [requests, typeFilter, statusFilter, search]);

  /* Status counts respect the type filter so the pills always sum to the
     visible type scope (mirrors the after-sales page behaviour). */
  const statusCounts = useMemo(() => {
    const scoped = typeFilter === ALL_TYPES
      ? requests
      : requests.filter((r) => r.request_type === typeFilter);
    const c: Record<string, number> = { [ALL_STATUSES]: scoped.length };
    for (const s of EXCHANGE_RETURN_STATUSES) c[s] = 0;
    for (const r of scoped) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [requests, typeFilter]);

  /* ── Actions ─────────────────────────────────────────────────────────────── */
  const openCreate = () => {
    setNewName(''); setNewPhone(''); setNewType('استبدال');
    setNewProduct(''); setNewReason(''); setNewVideo('');
    setNewDepositUrl(''); setNewRefundPhone(''); setNewRefundMethod('');
    setShowCreate(true);
  };

  const handleCreate = async () => {
    if (!newName.trim())   { showToast('اسم العميل مطلوب', 'error'); return; }
    if (!newPhone.trim())  { showToast('رقم التليفون مطلوب', 'error'); return; }
    if (!newProduct)       { showToast('المنتج مطلوب', 'error'); return; }
    if (!newReason.trim()) { showToast('سبب الطلب مطلوب', 'error'); return; }
    setCreateSaving(true);
    try {
      const res = await createExchangeReturnRequest({
        customer_name:  newName.trim(),
        customer_phone: newPhone.trim(),
        request_type:   newType,
        product_id:     newProduct,
        reason:         newReason.trim(),
        video_link:     newVideo.trim() || null,
        deposit_screenshot_url: newDepositUrl.trim() || null,
        refund_phone_number:    newRefundPhone.trim() || null,
        refund_method:          newRefundMethod || null,
      });
      setRequests((prev) => [res.data, ...prev]);
      setShowCreate(false);
      showToast('تم تسجيل الطلب ✓', 'success');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر حفظ الطلب';
      showToast(msg, 'error');
    } finally {
      setCreateSaving(false);
    }
  };

  const openEdit = (row: ExchangeReturnRequest) => {
    setEditTarget(row);
    setEditStatus(row.status);
    setEditNotes(row.notes ?? '');
    setEditDepositUrl(row.deposit_screenshot_url ?? '');
    setEditRefundPhone(row.refund_phone_number ?? '');
    setEditRefundMethod(row.refund_method ?? '');
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    setEditSaving(true);
    try {
      /* Approval (status change) is admin-only — the backend rejects it for
         everyone else, so non-admins send ONLY their notes. */
      const res = await updateExchangeReturnRequest(editTarget.id, {
        ...(isAdmin ? { status: editStatus } : {}),
        notes: editNotes.trim() || null,
        deposit_screenshot_url: editDepositUrl.trim() || null,
        refund_phone_number:    editRefundPhone.trim() || null,
        refund_method:          editRefundMethod || null,
      });
      setRequests((prev) => prev.map((r) => (r.id === editTarget.id ? { ...r, ...res.data } : r)));
      setEditTarget(null);
      showToast('تم تحديث الطلب ✓', 'success');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر تحديث الطلب';
      showToast(msg, 'error');
    } finally {
      setEditSaving(false);
    }
  };

  /* ── Copy phone numbers of the CURRENTLY filtered view ───────────────────── */
  const handleCopyPhones = async () => {
    const phones = visibleRows
      .map((r) => (r.customer_phone ?? '').trim())
      .filter(Boolean);
    if (phones.length === 0) {
      showToast('لا توجد أرقام لنسخها', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(phones.join('\n'));
      showToast(`تم نسخ ${phones.length} رقم بنجاح`, 'success');
    } catch {
      showToast('تعذّر نسخ الأرقام', 'error');
    }
  };

  const handleDelete = async (row: ExchangeReturnRequest) => {
    if (!window.confirm(`هل أنت متأكد من حذف طلب "${row.customer_name}" نهائياً؟`)) return;
    setBusyRow(row.id);
    try {
      await deleteExchangeReturnRequest(row.id);
      setRequests((prev) => prev.filter((r) => r.id !== row.id));
      showToast('تم حذف السجل', 'success');
    } catch {
      showToast('تعذّر حذف السجل', 'error');
    } finally {
      setBusyRow(null);
    }
  };

  if (!allowed) return null;

  /* ── Render ──────────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-full" dir="rtl">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-[60] px-6 py-3 rounded-xl shadow-lg
          text-white text-sm font-medium ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-600'}`}>
          {toast.message}
        </div>
      )}

      <div className="max-w-screen-2xl mx-auto px-6 pt-8 pb-10 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">الاستبدال والاسترجاع</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              تسجيل ومتابعة طلبات استبدال أو استرجاع المنتجات بعد الاستلام
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Copy all phone numbers in the currently filtered view */}
            <button
              onClick={handleCopyPhones}
              title="نسخ أرقام هواتف الطلبات المعروضة"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition
                bg-slate-100 hover:bg-slate-200 text-slate-700
                dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              نسخ الأرقام
            </button>
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white
                rounded-xl text-sm font-semibold shadow-sm shadow-indigo-500/30 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              إضافة طلب
            </button>
          </div>
        </div>

        {/* Top bar: type filter + search */}
        <div className="flex flex-wrap items-center gap-3
          bg-white dark:bg-slate-900 rounded-2xl
          border border-slate-200 dark:border-slate-800 px-4 py-3.5 shadow-sm">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400 whitespace-nowrap">
            <span className="font-semibold">نوع الطلب:</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2 text-sm outline-none
                bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300
                focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition min-w-[140px]"
            >
              <option value={ALL_TYPES}>{ALL_TYPES}</option>
              {EXCHANGE_RETURN_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>

          <div className="relative flex-1 min-w-[200px] max-w-md">
            <svg className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث بالاسم أو رقم الهاتف..."
              className="w-full pr-9 pl-3 py-2 rounded-xl text-sm bg-slate-50 dark:bg-slate-800
                border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200
                outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
            />
          </div>
        </div>

        {/* Status filter pills */}
        <div className="flex flex-wrap items-center gap-2">
          {[ALL_STATUSES, ...EXCHANGE_RETURN_STATUSES].map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-150
                ${statusFilter === s
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700'}`}
            >
              {s}
              <span className={`mr-1.5 text-xs ${statusFilter === s ? 'text-indigo-200' : 'text-gray-400'}`}>
                ({statusCounts[s] ?? 0})
              </span>
            </button>
          ))}
        </div>

        {/* Requests table */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-20">
              <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-3" />
              <p className="text-slate-400 text-sm">جارٍ التحميل…</p>
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="text-center py-20 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">لا توجد طلبات مسجلة</p>
              <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">اضغط «إضافة طلب» لتسجيل طلب استبدال أو استرجاع</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">العميل</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">نوع الطلب</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المنتج</th>
                    <th className="text-right font-semibold px-4 py-3">السبب</th>
                    <th className="text-right font-semibold px-4 py-3">الملاحظات</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">بيانات التأمين</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">فيديو توضيحي</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الحالة</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">أضيف بواسطة</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">التاريخ</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الإجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {visibleRows.map((r) => {
                    const busy = busyRow === r.id;
                    return (
                      <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 align-top">
                        {/* Customer: name + phone together — «الاسم (01xxxxxxxxx)» */}
                        <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                          {r.customer_name}{' '}
                          <span className="font-normal text-slate-500 dark:text-slate-400">
                            (<span dir="ltr">{r.customer_phone}</span>)
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${TYPE_BADGE[r.request_type]}`}>
                            {r.request_type}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-[12rem]">
                          <span className="line-clamp-2" title={r.product_name ?? ''}>{r.product_name || '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300 max-w-[20rem]">
                          <span className="line-clamp-3 whitespace-pre-wrap" title={r.reason ?? ''}>{r.reason || '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300 max-w-[18rem]">
                          {r.notes ? (
                            <span className="line-clamp-3 whitespace-pre-wrap" title={r.notes}>{r.notes}</span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        {/* ── Deposit / insurance details ── */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          {(r.refund_phone_number || r.refund_method || r.deposit_screenshot_url) ? (
                            <div className="flex flex-col items-start gap-1">
                              {r.refund_phone_number && (
                                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200" dir="ltr">{r.refund_phone_number}</span>
                              )}
                              {r.refund_method && (
                                <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${REFUND_METHOD_BADGE[r.refund_method]}`}>
                                  {REFUND_METHOD_LABELS[r.refund_method]}
                                </span>
                              )}
                              {r.deposit_screenshot_url && (
                                <a href={r.deposit_screenshot_url} target="_blank" rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline text-[11px] font-medium">
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                  </svg>
                                  مشاهدة الإيصال
                                </a>
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {r.video_link ? (
                            <a href={r.video_link} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400 hover:underline text-xs font-medium">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                              مشاهدة الفيديو
                            </a>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_BADGE[r.status]}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap text-xs">
                          {r.created_by_name ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap text-xs" dir="ltr">
                          {fmtDate(r.created_at)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => openEdit(r)} disabled={busy}
                              className="px-3 py-1.5 text-xs rounded-lg font-medium transition
                                bg-indigo-50 text-indigo-700 hover:bg-indigo-100
                                dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/60 disabled:opacity-50">
                              تحديث
                            </button>
                            {isAdmin && (
                              <button onClick={() => handleDelete(r)} disabled={busy} title="حذف نهائي" aria-label="حذف"
                                className="p-1.5 text-xs rounded-lg transition text-red-500 hover:text-white hover:bg-red-500
                                  dark:text-red-400 dark:hover:bg-red-600 disabled:opacity-50">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ══ Create modal ═══════════════════════════════════════════════════ */}
      {showCreate && (
        <Modal onClose={() => !createSaving && setShowCreate(false)}>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-1">إضافة طلب جديد</h2>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-5">يُفتح الطلب بحالة «قيد المراجعة»</p>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">اسم العميل</label>
          <input type="text" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="الاسم الكامل" className={inputCls} />

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">رقم التليفون</label>
          <input type="text" dir="ltr" value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
            placeholder="01xxxxxxxxx" className={inputCls} />

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">نوع الطلب</label>
          <select value={newType} onChange={(e) => setNewType(e.target.value as ExchangeReturnType)} className={inputCls}>
            {EXCHANGE_RETURN_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">المنتج</label>
          <select value={newProduct} onChange={(e) => setNewProduct(e.target.value)} className={inputCls}>
            <option value="">— اختر المنتج —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">السبب</label>
          <textarea rows={4} value={newReason} onChange={(e) => setNewReason(e.target.value)}
            placeholder="اكتب سبب طلب الاستبدال أو الاسترجاع…" className={`${inputCls} resize-y`} />

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">لينك فيديو توضيحي</label>
          <input type="url" dir="ltr" value={newVideo} onChange={(e) => setNewVideo(e.target.value)}
            placeholder="https://…" className={inputCls} />

          {/* ── Deposit / insurance (200 ج.م) ── */}
          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700 space-y-3">
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400">بيانات تأمين الاستبدال/الاسترجاع (200 ج.م)</p>

            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">سكرين تحويل التأمين</label>
              <input type="url" dir="ltr" value={newDepositUrl} onChange={(e) => setNewDepositUrl(e.target.value)}
                placeholder="https://… (رابط صورة إيصال التحويل)" className={inputCls} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">رقم العميل للتحويل</label>
                <input type="text" dir="ltr" value={newRefundPhone} onChange={(e) => setNewRefundPhone(e.target.value)}
                  placeholder="01xxxxxxxxx" className={inputCls} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">طريقة التحويل</label>
                <select value={newRefundMethod} onChange={(e) => setNewRefundMethod(e.target.value as RefundMethod | '')} className={inputCls}>
                  <option value="">— اختر —</option>
                  <option value="vodafone_cash">فودافون كاش</option>
                  <option value="instapay">إنستاباي</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button onClick={handleCreate} disabled={createSaving}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50">
              {createSaving ? 'جارٍ الحفظ…' : 'تسجيل الطلب'}
            </button>
            <button onClick={() => setShowCreate(false)} disabled={createSaving}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </Modal>
      )}

      {/* ══ Review / status modal ══════════════════════════════════════════ */}
      {editTarget && (
        <Modal onClose={() => !editSaving && setEditTarget(null)}>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-1">تحديث الطلب</h2>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-1">
            {editTarget.customer_name} (<span dir="ltr">{editTarget.customer_phone}</span>)
            {' · '}{editTarget.request_type}
            {editTarget.product_name ? ` · ${editTarget.product_name}` : ''}
          </p>
          {editTarget.reason && (
            <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700
              rounded-xl px-3 py-2 mb-4 mt-3 whitespace-pre-wrap max-h-28 overflow-y-auto">
              {editTarget.reason}
            </p>
          )}

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">الحالة</label>
          {isAdmin ? (
            <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as ExchangeReturnStatus)} className={inputCls}>
              {EXCHANGE_RETURN_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          ) : (
            /* Approval is admin-only — non-admins see the current status read-only
               and can still add notes below. */
            <div className={`${inputCls} flex items-center justify-between cursor-not-allowed opacity-90`}>
              <span>{editStatus}</span>
              <span className="text-[11px] text-slate-400">الموافقة من صلاحيات المدير</span>
            </div>
          )}

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">الملاحظات</label>
          <textarea rows={4} value={editNotes} onChange={(e) => setEditNotes(e.target.value)}
            placeholder="سجّل الإجراءات المتخذة أو المتابعات (مثال: تم الاتصال بالعميل ولم يرد)…"
            className={`${inputCls} resize-y`} />

          {/* ── Deposit / insurance (200 ج.م) ── */}
          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700 space-y-3">
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400">بيانات التأمين (200 ج.م)</p>

            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">سكرين تحويل التأمين</label>
              <input type="url" dir="ltr" value={editDepositUrl} onChange={(e) => setEditDepositUrl(e.target.value)}
                placeholder="https://… (رابط صورة إيصال التحويل)" className={inputCls} />
              {editDepositUrl.trim() && (
                <a href={editDepositUrl.trim()} target="_blank" rel="noopener noreferrer"
                  className="inline-block mt-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline">مشاهدة الإيصال ↗</a>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">رقم العميل للتحويل</label>
                <input type="text" dir="ltr" value={editRefundPhone} onChange={(e) => setEditRefundPhone(e.target.value)}
                  placeholder="01xxxxxxxxx" className={inputCls} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">طريقة التحويل</label>
                <select value={editRefundMethod} onChange={(e) => setEditRefundMethod(e.target.value as RefundMethod | '')} className={inputCls}>
                  <option value="">— اختر —</option>
                  <option value="vodafone_cash">فودافون كاش</option>
                  <option value="instapay">إنستاباي</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button onClick={handleEdit} disabled={editSaving}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50">
              {editSaving ? 'جارٍ الحفظ…' : 'حفظ التحديث'}
            </button>
            <button onClick={() => setEditTarget(null)} disabled={editSaving}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
