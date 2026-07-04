'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  After-Sales Service — خدمة ما بعد البيع
 * ════════════════════════════════════════════════════════════════════
 *  Post-delivery issue tracker. The Confirmation team opens issues
 *  (المشكلة), the After-Sales team resolves them (ملاحظات خدمة ما بعد
 *  البيع + الحالة). Open to every employee; hard delete is admin-only.
 *  Backend: /api/after-sales (routes/afterSales.js).
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  getAfterSalesIssues, createAfterSalesIssue, updateAfterSalesIssue, deleteAfterSalesIssue,
  getProducts,
  AfterSalesIssue, AfterSalesStatus, AFTER_SALES_STATUSES, Product,
} from '@/lib/api';

/* ── Status presentation ─────────────────────────────────────────────────── */
const STATUS_BADGE: Record<AfterSalesStatus, string> = {
  'جاري العمل':       'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  'تم حل المشكلة':    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  'استبدال':          'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  'استرجاع':          'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  'العميل لم يرد':    'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  'المشكلة من العميل': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const ALL_PRODUCTS = 'كل الأجهزة';
const ALL_STATUSES = 'كل الحالات';

interface Toast { message: string; type: 'success' | 'error' }

/* ── Modal wrapper (same pattern as returns-collection) ──────────────────── */
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
export default function AfterSalesPage() {
  const router = useRouter();

  const [allowed,  setAllowed]  = useState(false);
  const [isAdmin,  setIsAdmin]  = useState(false);
  const [issues,   setIssues]   = useState<AfterSalesIssue[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [toast,    setToast]    = useState<Toast | null>(null);

  /* Top-bar filters */
  const [productFilter, setProductFilter] = useState<string>(ALL_PRODUCTS); // product id or sentinel
  const [statusFilter,  setStatusFilter]  = useState<string>(ALL_STATUSES);
  const [search,        setSearch]        = useState('');

  /* Create modal */
  const [showCreate,  setShowCreate]  = useState(false);
  const [newName,     setNewName]     = useState('');
  const [newPhone,    setNewPhone]    = useState('');
  const [newProduct,  setNewProduct]  = useState('');   // product id ('' = none)
  const [newIssue,    setNewIssue]    = useState('');
  const [createSaving, setCreateSaving] = useState(false);

  /* Edit modal */
  const [editTarget, setEditTarget] = useState<AfterSalesIssue | null>(null);
  const [editStatus, setEditStatus] = useState<AfterSalesStatus>('جاري العمل');
  const [editNotes,  setEditNotes]  = useState('');
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
      const [issuesRes, productsRes] = await Promise.all([getAfterSalesIssues(), getProducts()]);
      setIssues(issuesRes.data);
      setProducts(productsRes.data);
    } catch {
      showToast('تعذّر تحميل بيانات خدمة ما بعد البيع', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (allowed) fetchAll(); }, [allowed, fetchAll]);

  /* ── Derived: filter chain (product → status → search) ───────────────────── */
  const visibleRows = useMemo(() => {
    let rows = issues;
    if (productFilter !== ALL_PRODUCTS) rows = rows.filter((r) => r.product_id === productFilter);
    if (statusFilter  !== ALL_STATUSES) rows = rows.filter((r) => r.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        r.customer_name.toLowerCase().includes(q) ||
        r.customer_phone.toLowerCase().includes(q) ||
        (r.product_name ?? '').toLowerCase().includes(q));
    }
    return rows;
  }, [issues, productFilter, statusFilter, search]);

  /* Status counts respect the product filter so the pills always sum to the
     visible product scope (mirrors the orders-dashboard behaviour). */
  const statusCounts = useMemo(() => {
    const scoped = productFilter === ALL_PRODUCTS
      ? issues
      : issues.filter((r) => r.product_id === productFilter);
    const c: Record<string, number> = { [ALL_STATUSES]: scoped.length };
    for (const s of AFTER_SALES_STATUSES) c[s] = 0;
    for (const r of scoped) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [issues, productFilter]);

  /* ── Actions ─────────────────────────────────────────────────────────────── */
  const openCreate = () => {
    setNewName(''); setNewPhone(''); setNewProduct(''); setNewIssue('');
    setShowCreate(true);
  };

  const handleCreate = async () => {
    if (!newName.trim())  { showToast('اسم العميل مطلوب', 'error'); return; }
    if (!newPhone.trim()) { showToast('رقم الهاتف مطلوب', 'error'); return; }
    if (!newIssue.trim()) { showToast('وصف المشكلة مطلوب', 'error'); return; }
    setCreateSaving(true);
    try {
      const res = await createAfterSalesIssue({
        customer_name:     newName.trim(),
        customer_phone:    newPhone.trim(),
        product_id:        newProduct || null,
        issue_description: newIssue.trim(),
      });
      setIssues((prev) => [res.data, ...prev]);
      setShowCreate(false);
      showToast('تم فتح المشكلة ✓', 'success');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر حفظ المشكلة';
      showToast(msg, 'error');
    } finally {
      setCreateSaving(false);
    }
  };

  const openEdit = (row: AfterSalesIssue) => {
    setEditTarget(row);
    setEditStatus(row.status);
    setEditNotes(row.after_sales_notes ?? '');
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    setEditSaving(true);
    try {
      const res = await updateAfterSalesIssue(editTarget.id, {
        status:            editStatus,
        after_sales_notes: editNotes,
      });
      setIssues((prev) => prev.map((r) => (r.id === editTarget.id ? { ...r, ...res.data } : r)));
      setEditTarget(null);
      showToast('تم تحديث المشكلة ✓', 'success');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر تحديث المشكلة';
      showToast(msg, 'error');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (row: AfterSalesIssue) => {
    if (!window.confirm(`هل أنت متأكد من حذف مشكلة "${row.customer_name}" نهائياً؟`)) return;
    setBusyRow(row.id);
    try {
      await deleteAfterSalesIssue(row.id);
      setIssues((prev) => prev.filter((r) => r.id !== row.id));
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
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">خدمة ما بعد البيع</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              متابعة مشاكل العملاء بعد الاستلام · ملاحظات الكونفرميشن · حلول فريق ما بعد البيع
            </p>
          </div>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white
              rounded-xl text-sm font-semibold shadow-sm shadow-indigo-500/30 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            إضافة مشكلة
          </button>
        </div>

        {/* Top bar: product filter + search */}
        <div className="flex flex-wrap items-center gap-3
          bg-white dark:bg-slate-900 rounded-2xl
          border border-slate-200 dark:border-slate-800 px-4 py-3.5 shadow-sm">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400 whitespace-nowrap">
            <span className="font-semibold">فلترة بالأجهزة:</span>
            <select
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
              className="border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2 text-sm outline-none
                bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300
                focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition min-w-[180px]"
            >
              <option value={ALL_PRODUCTS}>{ALL_PRODUCTS}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
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
          {[ALL_STATUSES, ...AFTER_SALES_STATUSES].map((s) => (
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

        {/* Issues table */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-20">
              <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-3" />
              <p className="text-slate-400 text-sm">جارٍ التحميل…</p>
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="text-center py-20 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">لا توجد مشاكل مسجلة</p>
              <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">اضغط «إضافة مشكلة» لتسجيل شكوى عميل بعد الاستلام</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">العميل</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الهاتف</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الجهاز</th>
                    <th className="text-right font-semibold px-4 py-3">المشكلة (الكونفرميشن)</th>
                    <th className="text-right font-semibold px-4 py-3">ملاحظات خدمة ما بعد البيع</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الحالة</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">أضيفت بواسطة</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">التاريخ</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الإجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {visibleRows.map((r) => {
                    const busy = busyRow === r.id;
                    return (
                      <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 align-top">
                        <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">{r.customer_name}</td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap" dir="ltr">{r.customer_phone}</td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-[12rem]">
                          <span className="line-clamp-2" title={r.product_name ?? ''}>{r.product_name || '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300 max-w-[18rem]">
                          <span className="line-clamp-3 whitespace-pre-wrap" title={r.issue_description ?? ''}>{r.issue_description || '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300 max-w-[18rem]">
                          <span className="line-clamp-3 whitespace-pre-wrap" title={r.after_sales_notes ?? ''}>{r.after_sales_notes || '—'}</span>
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
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-1">إضافة مشكلة جديدة</h2>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-5">تُفتح المشكلة بحالة «جاري العمل»</p>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">اسم العميل</label>
          <input type="text" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="الاسم الكامل" className={inputCls} />

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">رقم الهاتف</label>
          <input type="text" dir="ltr" value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
            placeholder="01xxxxxxxxx" className={inputCls} />

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">الجهاز / المنتج</label>
          <select value={newProduct} onChange={(e) => setNewProduct(e.target.value)} className={inputCls}>
            <option value="">— بدون تحديد —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">المشكلة (ملاحظات الكونفرميشن)</label>
          <textarea rows={4} value={newIssue} onChange={(e) => setNewIssue(e.target.value)}
            placeholder="اكتب شكوى العميل بالتفصيل…" className={`${inputCls} resize-y`} />

          <div className="flex gap-3 mt-6">
            <button onClick={handleCreate} disabled={createSaving}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50">
              {createSaving ? 'جارٍ الحفظ…' : 'فتح المشكلة'}
            </button>
            <button onClick={() => setShowCreate(false)} disabled={createSaving}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </Modal>
      )}

      {/* ══ Edit / resolve modal ═══════════════════════════════════════════ */}
      {editTarget && (
        <Modal onClose={() => !editSaving && setEditTarget(null)}>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-1">تحديث المشكلة</h2>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-1">
            {editTarget.customer_name} · <span dir="ltr">{editTarget.customer_phone}</span>
            {editTarget.product_name ? ` · ${editTarget.product_name}` : ''}
          </p>
          {editTarget.issue_description && (
            <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700
              rounded-xl px-3 py-2 mb-4 mt-3 whitespace-pre-wrap max-h-28 overflow-y-auto">
              {editTarget.issue_description}
            </p>
          )}

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">الحالة</label>
          <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as AfterSalesStatus)} className={inputCls}>
            {AFTER_SALES_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">ملاحظات خدمة ما بعد البيع</label>
          <textarea rows={4} value={editNotes} onChange={(e) => setEditNotes(e.target.value)}
            placeholder="تفاصيل الحل / التواصل مع العميل…" className={`${inputCls} resize-y`} />

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
