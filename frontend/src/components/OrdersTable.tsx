'use client';

import { useState, memo } from 'react';
import { Order, logNoAnswerAttempt } from '@/lib/api';

/* NOTE — no windowing / virtualization / infinite scroll in here, on purpose.
   The parent page uses strict page-replacement pagination (PAGE_SIZE rows per
   page, Next/Prev REPLACE the array), so this component never receives more
   than one page of rows and can simply render all of them. An earlier
   IntersectionObserver-sentinel design chain-loaded the entire tenant history
   when the user sat at the list bottom and OOM-crashed iOS Safari — do not
   reintroduce unbounded row accumulation here.                               */

const NO_ANSWER_REQUIRED = 5;

/* Normalise a status string for comparison. Statuses set via the UI dropdown are
   clean literals, but statuses arriving from imports / Taager sync / webhooks can
   differ in Unicode form (NFC vs NFD) or carry stray whitespace. Comparing the
   normalised form makes status checks (e.g. the inline no-answer button) reliable
   for ALL orders regardless of source — and therefore for admins too. */
const normStatus = (s?: string | null) => (s ?? '').normalize('NFC').trim();

/* Normalise any date value to YYYY-MM-DD for <input type="date"> and badges.
   A DATE column comes back from pg as an ISO timestamp ("2026-06-02T00:00:00Z");
   a plain "2026-06-02" passes through unchanged. */
const toDateInput = (v?: string | null) => (v ? String(v).slice(0, 10) : '');

// All possible statuses — used in the admin full-edit modal only.
// INVARIANT: this list must contain EVERY status the system can ever write
// (including the webhook-set return states). A <select> whose value is missing
// from its options silently displays the first option ('جديد') — that exact
// fallback made returned orders masquerade as new ones and invited admins to
// overwrite 'تم الإرجاع' with 'جديد' in the DB.
const STATUS_OPTIONS = ['جديد', 'تم التأكيد', 'تم الرفض', 'مؤجل', 'لا يرد', 'معلق حتي الدفع', 'تم الشحن', 'تم التوصيل', 'جاري الإعادة', 'تم الإرجاع'];

// Statuses agents AND admins may set from the inline table dropdown.
// Everything from 'تم الشحن' onward is COURIER-OWNED (set by the shipping API /
// Bosta webhook) and renders as a locked badge in the table for everyone —
// admin overrides go through the full edit modal only.
const MANUAL_STATUS_OPTIONS = ['جديد', 'تم التأكيد', 'تم الرفض', 'مؤجل', 'لا يرد', 'معلق حتي الدفع'];

const STATUS_STYLES: Record<string, string> = {
  'جديد':       'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  'تم التأكيد': 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  'تم الرفض':   'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  'مؤجل':       'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  'لا يرد':     'bg-gray-100 text-gray-700 dark:bg-slate-800 dark:text-slate-400',
  // Pending until the customer pays a deposit (low delivery-success customers)
  'معلق حتي الدفع': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
  'تم الشحن':    'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  // Set automatically by Bosta webhook — never selectable in the inline dropdown
  'تم التوصيل':  'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  'جاري الإعادة': 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  'تم الإرجاع':  'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
};

const DELIVERY_RATE_OPTIONS = ['بدون', 'جديد', 'ضعيف', 'متوسط', 'ممتاز'];

const REJECTION_REASONS = [
  'العميل غير رأيه',
  'السعر غالي',
  'اشترى من منافس',
  'تأخير في الرد',
  'رقم غير صحيح/لا يرد',
];

const DELIVERY_RATE_STYLES: Record<string, string> = {
  'بدون':  'bg-gray-100 text-gray-500 dark:bg-slate-800 dark:text-slate-400',
  'جديد':  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'ضعيف':  'bg-red-200 text-red-900 dark:bg-red-900/40 dark:text-red-300',
  'متوسط': 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  'ممتاز': 'bg-green-200 text-green-900 dark:bg-green-900/40 dark:text-green-300',
};

/* ── Financial helpers ───────────────────────────────────────── */

/**
 * Coerce a value coming from the DB to a plain JS number.
 * pg returns NUMERIC columns as strings like "150.00"; this handles both that
 * and real JS numbers safely.
 */
function asNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : v;
}

/**
 * Format a price as a whole-number string with thousands commas.
 * Always strips decimals (100.00 → "100", 1500 → "1,500").
 */
function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

interface Props {
  orders:           Order[];
  role:             'admin' | 'agent';
  onUpdate:         (id: number, data: Partial<Order>) => Promise<void>;
  onDelete:         (id: number) => Promise<void>;
  /* Bulk-selection props — admin only ───────────────────────────── */
  selectedIds?:     number[];                     // controlled from parent
  onToggleSelect?:  (id: number) => void;         // toggle one row
  onSelectAll?:     (visibleIds: number[]) => void; // toggle all visible rows
  agents?:          string[];
  showProduct?:     boolean;   // true when viewing "كل المنتجات" — renders product badge per row
  emptyMessage?:    string;    // override for the no-results state (e.g. when a search is active)
  onToast?:         (message: string, type?: 'success' | 'error') => void; // optional parent toast
}

function OrdersTable({
  orders, role, onUpdate, onDelete,
  selectedIds = [], onToggleSelect, onSelectAll,
  agents = [],
  emptyMessage = 'لا توجد طلبات لعرضها',
  onToast,
}: Props) {
  const [savingId,        setSavingId]        = useState<number | null>(null);
  const [editModal,       setEditModal]       = useState<Order | null>(null);
  const [editForm,        setEditForm]        = useState<Partial<Order>>({});
  const [deleteConfirm,   setDeleteConfirm]   = useState<number | null>(null);
  const [pendingRejection, setPendingRejection] = useState<{ id: number; reason: string } | null>(null);
  const [pendingPostpone,  setPendingPostpone]  = useState<{ id: number; date: string } | null>(null);

  /* ─── Quick-edit (customer/shipping details) modal ─────────── */
  const [quickEdit, setQuickEdit] = useState<Order | null>(null);
  const [quickForm, setQuickForm] = useState<{
    FullName: string; Phone: string; City: string; Address: string;
    quantity: string; hasDeposit: boolean; depositAmount: string;
  }>({ FullName: '', Phone: '', City: '', Address: '', quantity: '1', hasDeposit: false, depositAmount: '' });
  const [quickSaving, setQuickSaving] = useState(false);
  /* No-answer call-attempt log (shown in quick-edit when status is 'لا يرد') */
  const [noAnswerLogs,  setNoAnswerLogs]  = useState<string[]>([]);
  const [loggingAttempt, setLoggingAttempt] = useState(false);
  const [attemptMsg,    setAttemptMsg]    = useState<string>('');
  /* Inline (in-table) no-answer button: per-order optimistic override of the
     attempt log + which row is mid-request, so the row updates without a modal. */
  const [attemptOverrides, setAttemptOverrides] = useState<Record<number, string[]>>({});
  const [inlineLoggingId,  setInlineLoggingId]  = useState<number | null>(null);

  const openQuickEdit = (order: Order) => {
    setQuickForm({
      FullName: order.FullName ?? '',
      Phone:    order.Phone    ?? '',
      City:     order.City     ?? '',
      Address:  order.Address  ?? '',
      quantity: String(order.quantity ?? 1),
      hasDeposit:    order.hasDeposit ?? false,
      depositAmount: order.depositAmount != null && order.depositAmount !== 0
        ? String(order.depositAmount) : '',
    });
    setNoAnswerLogs(Array.isArray(order.no_answer_logs) ? order.no_answer_logs : []);
    setAttemptMsg('');
    setQuickEdit(order);
  };

  const handleLogAttempt = async (orderId: number) => {
    if (!orderId || loggingAttempt) return;
    setLoggingAttempt(true);
    setAttemptMsg('');
    try {
      const { data } = await logNoAnswerAttempt(orderId);
      setNoAnswerLogs(data.no_answer_logs);
      if (data.commissionAwarded) {
        setAttemptMsg(`🎉 تم الوصول إلى ${data.required} محاولات — تم منح عمولة "لا يرد"`);
      } else if (data.count < data.required) {
        setAttemptMsg(`تبقّى ${data.required - data.count} محاولة لاستحقاق العمولة`);
      } else {
        setAttemptMsg(`تم تسجيل المحاولة (${data.count}) — العمولة مُحتسبة بالفعل`);
      }
    } catch {
      setAttemptMsg('تعذّر تسجيل المحاولة، حاول مرة أخرى');
    } finally {
      setLoggingAttempt(false);
    }
  };

  /* Inline one-click attempt logger used directly from a table row (no modal).
     Updates the row counter optimistically and toasts the result. */
  const handleInlineAttempt = async (orderId: number) => {
    if (!orderId || inlineLoggingId === orderId) return;
    setInlineLoggingId(orderId);
    try {
      const { data } = await logNoAnswerAttempt(orderId);
      setAttemptOverrides((prev) => ({ ...prev, [orderId]: data.no_answer_logs }));
      if (data.commissionAwarded) {
        onToast?.(`🎉 ${data.count}/${data.required} محاولات — تم منح عمولة "لا يرد"`, 'success');
      } else if (data.count < data.required) {
        onToast?.(`تم تسجيل المحاولة (${data.count}/${data.required}) — تبقّى ${data.required - data.count}`, 'success');
      } else {
        onToast?.(`تم تسجيل المحاولة (${data.count}) — العمولة مُحتسبة بالفعل`, 'success');
      }
    } catch {
      onToast?.('تعذّر تسجيل المحاولة، حاول مرة أخرى', 'error');
    } finally {
      setInlineLoggingId(null);
    }
  };

  const saveQuickEdit = async () => {
    if (!quickEdit) return;
    if (!quickForm.FullName.trim() || !quickForm.Phone.trim()) return; // name + phone required
    setQuickSaving(true);
    try {
      /* Deposit: when the toggle is on, send the entered amount; when off, send 0
         so the backend treasury hook clears any existing deposit entry. */
      const depositOn  = quickForm.hasDeposit;
      const depositAmt = depositOn ? (parseFloat(quickForm.depositAmount) || 0) : 0;
      await onUpdate(quickEdit.id, {
        FullName: quickForm.FullName.trim(),
        Phone:    quickForm.Phone.trim(),
        City:     quickForm.City.trim(),
        Address:  quickForm.Address.trim(),
        quantity: Math.max(1, parseInt(quickForm.quantity, 10) || 1),
        hasDeposit:    depositOn,
        depositAmount: depositAmt,
      });
      setQuickEdit(null);
    } finally {
      setQuickSaving(false);
    }
  };


  /* ─── Status dropdown ─────────────────────────────────────────
     Strict optimistic: fire-and-forget — NO savingId / transparent state. The
     parent (handleUpdate) mutates local state synchronously before awaiting the
     API and rolls back only on failure, so the row updates instantly.          */
  const handleStatusChange = (order: Order, Status: string) => {
    // Intercept "تم الرفض" to collect a rejection reason before saving
    if (Status === 'تم الرفض') {
      setPendingRejection({ id: order.id, reason: '' });
      return;
    }
    // Intercept "مؤجل" to collect the follow-up date before saving
    if (Status === 'مؤجل') {
      setPendingPostpone({ id: order.id, date: toDateInput(order.PostponedDate) });
      return;
    }
    onUpdate(order.id, { Status });   // optimistic, non-blocking
  };

  /* ─── Delivery Rate dropdown — optimistic, non-blocking ───── */
  const handleDeliveryRateChange = (id: number, DeliveryRate: string) => {
    onUpdate(id, { DeliveryRate });
  };

  /* ─── AssignedTo dropdown (admin only) — optimistic ───────── */
  const handleAssignedToChange = (id: number, AssignedTo: string) => {
    onUpdate(id, { AssignedTo });
  };

  /* ─── Note inline edit (save on blur) — optimistic ────────── */
  const handleNoteBlur = (order: Order, Note: string) => {
    if (Note === (order.Note ?? '')) return;
    onUpdate(order.id, { Note });
  };

  /* ─── Address inline edit (save on blur) — all roles ──────── */
  const handleAddressBlur = async (order: Order, Address: string) => {
    if (Address === (order.Address ?? '')) return;
    setSavingId(order.id);
    await onUpdate(order.id, { Address });
    setSavingId(null);
  };

  /* ─── Shipping-notes inline edit (save on blur) — all roles ── */
  const handleShippingNotesBlur = async (order: Order, ShippingNotes: string) => {
    if (ShippingNotes === (order.ShippingNotes ?? '')) return;
    setSavingId(order.id);
    await onUpdate(order.id, { ShippingNotes });
    setSavingId(null);
  };

  /* ─── Admin full-edit modal ────────────────────────────────── */
  const openEditModal = (order: Order) => {
    setEditForm({ ...order });
    setNoAnswerLogs(Array.isArray(order.no_answer_logs) ? order.no_answer_logs : []);
    setAttemptMsg('');
    setEditModal(order);
  };

  const saveEditModal = async () => {
    if (!editModal) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, createdAt, ...fields } = editForm as Order;
    setSavingId(editModal.id);
    await onUpdate(editModal.id, fields);
    setEditModal(null);
    setSavingId(null);
  };

  /* ─── Delete confirmation ──────────────────────────────────── */
  const confirmDelete = async () => {
    if (deleteConfirm === null) return;
    await onDelete(deleteConfirm);
    setDeleteConfirm(null);
  };

  /* Live, trimmed status of the order open in each modal — read from the current
     `orders` prop (not the stale snapshot) so the no-answer section always
     reflects the order's real status. */
  const quickLiveStatus = quickEdit
    ? String(orders.find((o) => o.id === quickEdit.id)?.Status ?? quickEdit.Status ?? '').trim()
    : '';
  const editLiveStatus = editModal
    ? String(orders.find((o) => o.id === editModal.id)?.Status ?? editModal.Status ?? '').trim()
    : '';

  /* ─── Empty state ──────────────────────────────────────────── */
  if (!orders.length) {
    const isSearch = emptyMessage.includes('نتائج مطابقة');
    return (
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-800 text-center py-20 px-6">
        {isSearch ? (
          <>
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-gray-100 dark:bg-slate-800 mb-4">
              <svg className="w-7 h-7 text-gray-400 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0" />
              </svg>
            </div>
            <p className="text-gray-700 dark:text-slate-300 font-semibold text-sm">{emptyMessage}</p>
            <p className="text-gray-400 dark:text-slate-500 text-xs mt-1">جرّب كلمة مختلفة أو تحقق من التهجئة</p>
          </>
        ) : (
          <>
            <svg className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <p className="text-gray-400 dark:text-slate-500 text-sm">{emptyMessage}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      {/* ── Main Table ─────────────────────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-800/50 border-b border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400">
              <tr>
                {/* Select-all checkbox — admin only */}
                {role === 'admin' && onToggleSelect && (
                  <th className="px-4 py-3 w-10 text-right">
                    <input
                      type="checkbox"
                      aria-label="تحديد الكل"
                      ref={(el) => {
                        if (!el) return;
                        const all  = orders.every((o) => selectedIds.includes(o.id));
                        const some = orders.some((o)  => selectedIds.includes(o.id));
                        el.checked       = orders.length > 0 && all;
                        el.indeterminate = some && !all;
                      }}
                      onChange={() => onSelectAll?.(orders.map((o) => o.id))}
                      className="w-4 h-4 rounded accent-indigo-600 cursor-pointer"
                    />
                  </th>
                )}
                <Th>#</Th>
                {role === 'admin' && <Th>الموظف المسؤول</Th>}
                <Th>الاسم الكامل</Th>
                <Th>الهاتف</Th>
                <Th>حالة الاستلام</Th>
                <Th>المدينة</Th>
                <Th>العنوان</Th>
                <Th>الحالة</Th>
                <Th>الدفع</Th>
                <Th>ملاحظات شركة الشحن</Th>
                <Th>الملاحظة</Th>
                <Th>إجراءات</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
              {orders.map((order, i) => (
                <OrderRow
                  key={order.id}
                  order={order}
                  index={i}
                  role={role}
                  selected={selectedIds.includes(order.id)}
                  saving={savingId === order.id}
                  agents={agents}
                  attemptLogs={attemptOverrides[order.id]}
                  inlineLogging={inlineLoggingId === order.id}
                  onToggleSelect={onToggleSelect}
                  onStatusChange={handleStatusChange}
                  onDeliveryRateChange={handleDeliveryRateChange}
                  onAssignedToChange={handleAssignedToChange}
                  onNoteBlur={handleNoteBlur}
                  onAddressBlur={handleAddressBlur}
                  onShippingNotesBlur={handleShippingNotesBlur}
                  onInlineAttempt={handleInlineAttempt}
                  onQuickEdit={openQuickEdit}
                  onEditModal={openEditModal}
                  onDelete={setDeleteConfirm}
                />
              ))}
            </tbody>
          </table>
        </div>

        {/* Row count footer */}
        <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800/50 border-t border-gray-100 dark:border-slate-800 text-xs text-gray-400 dark:text-slate-500">
          إجمالي الطلبات المعروضة: <span className="font-semibold text-gray-600 dark:text-slate-300">{orders.length}</span>
        </div>
      </div>

      {/* ── Quick-edit customer details modal (all roles) ────────── */}
      {quickEdit && (
        <Modal onClose={() => !quickSaving && setQuickEdit(null)}>
          <h2 className="text-lg font-bold mb-1 text-gray-800 dark:text-slate-100">
            تعديل بيانات العميل
            <span className="text-indigo-500 dark:text-indigo-400 mr-2">#{quickEdit.id}</span>
          </h2>
          <p className="text-xs text-gray-400 dark:text-slate-500 mb-5">
            تصحيح الاسم أو رقم الهاتف أو العنوان قبل الشحن
          </p>

          <div className="space-y-4" dir="rtl">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">الاسم</label>
              <input
                type="text"
                value={quickForm.FullName}
                onChange={(e) => setQuickForm((p) => ({ ...p, FullName: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm
                  bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 outline-none
                  focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">الهاتف</label>
              <input
                type="text"
                value={quickForm.Phone}
                onChange={(e) => setQuickForm((p) => ({ ...p, Phone: e.target.value }))}
                dir="ltr"
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm text-left
                  bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 outline-none
                  focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">المدينة / المحافظة</label>
              <input
                type="text"
                value={quickForm.City}
                onChange={(e) => setQuickForm((p) => ({ ...p, City: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm
                  bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 outline-none
                  focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">العنوان التفصيلي</label>
              <textarea
                value={quickForm.Address}
                onChange={(e) => setQuickForm((p) => ({ ...p, Address: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm
                  bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 outline-none resize-none
                  focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">الكمية</label>
              <input
                type="number"
                min="1"
                step="1"
                value={quickForm.quantity}
                onChange={(e) => setQuickForm((p) => ({ ...p, quantity: e.target.value }))}
                dir="ltr"
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm text-left
                  bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 outline-none
                  focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
              />
            </div>

            {/* Deposit (العربون) — toggle + amount */}
            <div className="pt-1 border-t border-gray-100 dark:border-slate-700/60">
              <div className="flex items-center justify-between mt-3">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-300">تم دفع عربون / ديبوزت</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={quickForm.hasDeposit}
                  onClick={() => setQuickForm((p) => ({
                    ...p,
                    hasDeposit: !p.hasDeposit,
                    depositAmount: !p.hasDeposit ? p.depositAmount : '',  // clear amount when turning off
                  }))}
                  className={`relative w-11 h-6 rounded-full transition-colors duration-150 shrink-0
                    ${quickForm.hasDeposit ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-slate-600'}`}
                >
                  <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-150
                    ${quickForm.hasDeposit ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {quickForm.hasDeposit && (
                <div className="mt-3">
                  <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">مبلغ العربون (ج.م)</label>
                  <input
                    type="number"
                    min="0"
                    value={quickForm.depositAmount}
                    onChange={(e) => setQuickForm((p) => ({ ...p, depositAmount: e.target.value }))}
                    placeholder="0"
                    dir="ltr"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm text-left
                      bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 outline-none
                      focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                  />
                  {asNum(quickEdit?.ProductPrice) > 0 && (
                    <p className="text-xs text-gray-400 dark:text-slate-500 mt-1.5">
                      المتبقي للتحصيل (COD):{' '}
                      <span className="font-semibold text-gray-600 dark:text-slate-300" dir="ltr">
                        {fmtNum(Math.max(0, asNum(quickEdit?.ProductPrice) - (parseFloat(quickForm.depositAmount) || 0)))} ج.م
                      </span>
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── No-answer call attempts (only for 'لا يرد') ─────────────── */}
          {quickLiveStatus === 'لا يرد' && (
            <div className="mt-4 pt-4 border-t border-gray-100 dark:border-slate-700/60">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-300">محاولات الاتصال</span>
                <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full
                  ${noAnswerLogs.length >= NO_ANSWER_REQUIRED
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'}`}>
                  محاولة {noAnswerLogs.length} من {NO_ANSWER_REQUIRED}
                </span>
              </div>

              {noAnswerLogs.length > 0 && (
                <ul className="mb-3 max-h-28 overflow-y-auto space-y-1 text-xs text-gray-500 dark:text-slate-400 pr-1">
                  {noAnswerLogs.map((ts, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-5 text-gray-400 dark:text-slate-600 shrink-0">{i + 1}.</span>
                      <span dir="ltr">
                        {(() => { const d = new Date(ts); return isNaN(d.getTime()) ? String(ts)
                          : d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }); })()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <button
                type="button"
                onClick={() => handleLogAttempt(quickEdit.id)}
                disabled={loggingAttempt}
                className="w-full inline-flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-semibold
                  bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white
                  disabled:opacity-50 disabled:cursor-not-allowed transition active:scale-[0.98]"
              >
                {loggingAttempt ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                )}
                تسجيل محاولة اتصال
              </button>

              {attemptMsg && (
                <p className="text-xs text-center mt-2 text-gray-600 dark:text-slate-400">{attemptMsg}</p>
              )}
            </div>
          )}

          <div className="flex gap-3 mt-6">
            <button
              onClick={saveQuickEdit}
              disabled={quickSaving || !quickForm.FullName.trim() || !quickForm.Phone.trim()}
              className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold
                bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white
                disabled:opacity-50 disabled:cursor-not-allowed transition active:scale-[0.98]"
            >
              {quickSaving ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  جارٍ الحفظ…
                </>
              ) : 'حفظ'}
            </button>
            <button
              onClick={() => setQuickEdit(null)}
              disabled={quickSaving}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold
                bg-gray-100 hover:bg-gray-200 text-gray-700
                dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300
                disabled:opacity-50 transition"
            >
              إلغاء
            </button>
          </div>
        </Modal>
      )}

      {/* ── Admin Edit Modal ────────────────────────────────────── */}
      {editModal && (
        <Modal onClose={() => setEditModal(null)}>
          <h2 className="text-lg font-bold mb-5 text-gray-800 dark:text-slate-100">
            تعديل الطلب
            <span className="text-indigo-500 dark:text-indigo-400 mr-2">#{editModal.id}</span>
          </h2>

          <div className="space-y-4 max-h-[60vh] overflow-y-auto pl-1">
            {(
              [
                { key: 'FullName', label: 'الاسم الكامل', dir: 'rtl' },
                { key: 'Phone',    label: 'الهاتف',        dir: 'ltr' },
                { key: 'City',     label: 'المدينة',       dir: 'rtl' },
                { key: 'Address',  label: 'العنوان',       dir: 'rtl' },
              ] as { key: keyof Order; label: string; dir: string }[]
            ).map(({ key, label, dir }) => (
              <div key={key}>
                <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">{label}</label>
                <input
                  type="text"
                  value={String(editForm[key] ?? '')}
                  onChange={(e) => setEditForm((p) => ({ ...p, [key]: e.target.value }))}
                  dir={dir}
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none
                    border border-gray-300 dark:border-slate-700
                    bg-white dark:bg-slate-800
                    text-gray-900 dark:text-slate-200
                    focus:ring-2 focus:ring-indigo-400"
                />
              </div>
            ))}

            {/* ── Product ────────────────────────────────────────────────
                Editable by ADMINS (e.g. to fix legacy/mismatched names so they
                merge in the UI); LOCKED read-only for agents. ProductName is in
                the backend PATCH whitelist, and agents are separately restricted
                to Status + Note, so this is safe both ways. */}
            {(editForm.ProductName || role === 'admin') && (
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">
                  المنتج
                </label>
                {role === 'admin' ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      dir="rtl"
                      value={editForm.ProductName ?? ''}
                      onChange={(e) => setEditForm((p) => ({ ...p, ProductName: e.target.value }))}
                      placeholder="اسم المنتج"
                      className="flex-1 px-3 py-2 rounded-xl text-sm outline-none
                        border border-gray-300 dark:border-slate-700
                        bg-white dark:bg-slate-800
                        text-gray-900 dark:text-slate-200
                        focus:ring-2 focus:ring-indigo-400"
                    />
                    {editForm.sku && (
                      <span className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded
                        bg-indigo-50 text-indigo-600 border border-indigo-100
                        dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800/50">
                        {editForm.sku}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl
                    border border-gray-200 dark:border-slate-700
                    bg-gray-50 dark:bg-slate-800/60 select-none">
                    <svg className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-slate-500"
                      fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    <span className="flex-1 text-sm text-gray-700 dark:text-slate-300 truncate">
                      {editForm.ProductName}
                    </span>
                    {editForm.sku && (
                      <span className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded
                        bg-indigo-50 text-indigo-600 border border-indigo-100
                        dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800/50">
                        {editForm.sku}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">الكمية</label>
              <input
                type="number"
                min="1"
                step="1"
                value={editForm.quantity ?? 1}
                onChange={(e) => setEditForm((p) => ({ ...p, quantity: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                dir="ltr"
                className="w-full px-3 py-2 rounded-xl text-sm outline-none
                  border border-gray-300 dark:border-slate-700
                  bg-white dark:bg-slate-800
                  text-gray-900 dark:text-slate-200
                  focus:ring-2 focus:ring-indigo-400"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">حالة الاستلام</label>
              <select
                value={editForm.DeliveryRate ?? 'بدون'}
                onChange={(e) => setEditForm((p) => ({ ...p, DeliveryRate: e.target.value }))}
                className="w-full px-3 py-2 rounded-xl text-sm outline-none
                  border border-gray-300 dark:border-slate-700
                  bg-white dark:bg-slate-800
                  text-gray-900 dark:text-slate-200
                  focus:ring-2 focus:ring-indigo-400"
              >
                {DELIVERY_RATE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">الحالة</label>
              <select
                value={editForm.Status ?? ''}
                onChange={(e) => setEditForm((p) => ({ ...p, Status: e.target.value }))}
                className="w-full px-3 py-2 rounded-xl text-sm outline-none
                  border border-gray-300 dark:border-slate-700
                  bg-white dark:bg-slate-800
                  text-gray-900 dark:text-slate-200
                  focus:ring-2 focus:ring-indigo-400"
              >
                {/* Belt-and-braces: if the order somehow carries a status outside
                    the list, render it as a real option instead of letting the
                    <select> silently display 'جديد'. */}
                {(STATUS_OPTIONS.includes(normStatus(editForm.Status ?? ''))
                  ? STATUS_OPTIONS
                  : [normStatus(editForm.Status ?? ''), ...STATUS_OPTIONS].filter(Boolean)
                ).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* No-answer call attempts — shown only when status is لا يرد.
                NOTE: works on the SAVED status (editModal.Status). Change the
                status to لا يرد and save first, then reopen to log attempts. */}
            {editLiveStatus === 'لا يرد' && (
              <div className="rounded-xl border border-amber-200 dark:border-amber-700/50 p-4 bg-amber-50/50 dark:bg-amber-900/10">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-700 dark:text-slate-300">محاولات الاتصال (لا يرد)</span>
                  <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full
                    ${noAnswerLogs.length >= NO_ANSWER_REQUIRED
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'}`}>
                    محاولة {noAnswerLogs.length} من {NO_ANSWER_REQUIRED}
                  </span>
                </div>

                {noAnswerLogs.length > 0 && (
                  <ul className="mb-3 max-h-28 overflow-y-auto space-y-1 text-xs text-gray-500 dark:text-slate-400 pr-1">
                    {noAnswerLogs.map((ts, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className="w-5 text-gray-400 dark:text-slate-600 shrink-0">{i + 1}.</span>
                        <span dir="ltr">
                          {(() => { const d = new Date(ts); return isNaN(d.getTime()) ? String(ts)
                            : d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }); })()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <button
                  type="button"
                  onClick={() => handleLogAttempt(editModal.id)}
                  disabled={loggingAttempt}
                  className="w-full inline-flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-semibold
                    bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white
                    disabled:opacity-50 disabled:cursor-not-allowed transition active:scale-[0.98]"
                >
                  {loggingAttempt ? (
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                  )}
                  تسجيل محاولة اتصال
                </button>

                {attemptMsg && (
                  <p className="text-xs text-center mt-2 text-gray-600 dark:text-slate-400">{attemptMsg}</p>
                )}
              </div>
            )}

            {/* Rejection reason — shown only when status is تم الرفض */}
            {editForm.Status === 'تم الرفض' && (
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">
                  سبب الرفض
                </label>
                <select
                  value={editForm.rejectionReason ?? ''}
                  onChange={(e) => setEditForm((p) => ({ ...p, rejectionReason: e.target.value || undefined }))}
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none
                    border border-red-300 dark:border-red-700/50
                    bg-red-50 dark:bg-red-900/20
                    text-red-800 dark:text-red-300
                    focus:ring-2 focus:ring-red-400"
                >
                  <option value="">— اختر سبب الرفض (اختياري) —</option>
                  {REJECTION_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            )}

            {/* Postponed date — shown only when status is مؤجل */}
            {editForm.Status === 'مؤجل' && (
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">تاريخ التأجيل</label>
                <input
                  type="date"
                  dir="ltr"
                  value={toDateInput(editForm.PostponedDate)}
                  onChange={(e) => setEditForm((p) => ({ ...p, PostponedDate: e.target.value }))}
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none
                    border border-amber-300 dark:border-amber-700/50
                    bg-amber-50 dark:bg-amber-900/20
                    text-amber-800 dark:text-amber-300
                    focus:ring-2 focus:ring-amber-400"
                />
              </div>
            )}

            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300 block mb-1">الملاحظة</label>
              <textarea
                value={editForm.Note ?? ''}
                onChange={(e) => setEditForm((p) => ({ ...p, Note: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 rounded-xl text-sm outline-none resize-none
                  border border-gray-300 dark:border-slate-700
                  bg-white dark:bg-slate-800
                  text-gray-900 dark:text-slate-200
                  focus:ring-2 focus:ring-indigo-400"
              />
            </div>

            {/* ── Deposit / Down-payment ─────────────────────────────── */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">

              {/* Toggle row */}
              <div className="flex items-center justify-between px-4 py-3
                bg-slate-50 dark:bg-slate-800/60">
                <span className="text-sm font-semibold text-gray-700 dark:text-slate-300 flex items-center gap-2">
                  <span>💰</span>
                  تم دفع عربون / ديبوزت
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setEditForm((p) => ({
                      ...p,
                      hasDeposit: !p.hasDeposit,
                      ...(!p.hasDeposit ? {} : { depositAmount: 0 }),
                    }))
                  }
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer
                    items-center rounded-full transition-colors duration-200
                    focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-1
                    dark:focus:ring-offset-slate-800
                    ${editForm.hasDeposit ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-slate-600'}`}
                  role="switch"
                  aria-checked={editForm.hasDeposit ?? false}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm
                      transition-transform duration-200
                      ${editForm.hasDeposit ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                </button>
              </div>

              {/* Amount input + live COD breakdown — visible only when deposit is ON */}
              {editForm.hasDeposit && (
                <div className="px-4 py-3 space-y-3 border-t border-slate-200 dark:border-slate-700
                  bg-white dark:bg-slate-900">

                  {/* Amount input */}
                  <div>
                    <label className="text-xs font-medium text-gray-500 dark:text-slate-400 block mb-1.5">
                      مبلغ العربون المدفوع (ج.م)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={editForm.depositAmount ?? ''}
                      onChange={(e) =>
                        setEditForm((p) => ({ ...p, depositAmount: parseFloat(e.target.value) || 0 }))
                      }
                      placeholder="0"
                      className="w-full px-3 py-2 rounded-xl text-sm outline-none
                        border border-emerald-300 dark:border-emerald-700/50
                        bg-emerald-50 dark:bg-emerald-900/20
                        text-emerald-900 dark:text-emerald-300
                        focus:ring-2 focus:ring-emerald-400"
                    />
                  </div>

                  {/* Live COD breakdown */}
                  {(() => {
                    const productPrice = (parseFloat(editForm.ProductPrice ?? '0') || 0);
                    const deposit      = editForm.depositAmount ?? 0;
                    const remaining    = Math.max(0, productPrice - deposit);
                    return (
                      <div className="rounded-lg border border-slate-200 dark:border-slate-700
                        bg-slate-50 dark:bg-slate-800/60 p-3 space-y-2 text-xs">
                        <div className="flex items-center justify-between text-gray-500 dark:text-slate-400">
                          <span>سعر المنتج</span>
                          <span dir="ltr" className="font-medium text-gray-700 dark:text-slate-300">
                            {productPrice > 0 ? `${productPrice.toLocaleString()} ج.م` : 'غير محدد'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                          <span>المدفوع (عربون)</span>
                          <span dir="ltr" className="font-semibold">
                            − {deposit.toLocaleString()} ج.م
                          </span>
                        </div>
                        <div className="flex items-center justify-between pt-2
                          border-t border-slate-200 dark:border-slate-700">
                          <span className="font-bold text-gray-700 dark:text-slate-300">
                            المتبقي للبوليصة (COD)
                          </span>
                          <span dir="ltr"
                            className="text-base font-extrabold text-rose-600 dark:text-rose-400 tracking-tight">
                            {remaining.toLocaleString()} ج.م
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={saveEditModal}
              disabled={savingId !== null}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl
                text-sm font-semibold transition disabled:opacity-50"
            >
              حفظ التغييرات
            </button>
            <button
              onClick={() => setEditModal(null)}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition
                bg-gray-100 hover:bg-gray-200 text-gray-700
                dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300"
            >
              إلغاء
            </button>
          </div>
        </Modal>
      )}

      {/* ── Rejection Reason Picker ─────────────────────────────── */}
      {pendingRejection !== null && (
        <Modal onClose={() => setPendingRejection(null)}>
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center
              bg-red-100 dark:bg-red-900/30">
              <svg className="w-5 h-5 text-red-600 dark:text-red-400"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h2 className="font-bold text-gray-800 dark:text-slate-100 leading-tight">
                سبب رفض الطلب
              </h2>
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                اختر سبب الرفض لتسجيله في تقارير الإحصاءات
              </p>
            </div>
          </div>

          <select
            value={pendingRejection.reason}
            onChange={(e) => setPendingRejection((p) => p ? { ...p, reason: e.target.value } : null)}
            className="w-full px-3 py-2.5 rounded-xl text-sm outline-none mb-5
              border border-red-300 dark:border-red-700/50
              bg-red-50 dark:bg-red-900/20
              text-red-800 dark:text-red-300
              focus:ring-2 focus:ring-red-400"
          >
            <option value="">— اختر سبب الرفض —</option>
            {REJECTION_REASONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>

          <div className="flex gap-3">
            <button
              onClick={async () => {
                if (!pendingRejection) return;
                setSavingId(pendingRejection.id);
                await onUpdate(pendingRejection.id, {
                  Status: 'تم الرفض',
                  ...(pendingRejection.reason ? { rejectionReason: pendingRejection.reason } : {}),
                });
                setSavingId(null);
                setPendingRejection(null);
              }}
              disabled={savingId !== null}
              className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-xl
                text-sm font-semibold transition disabled:opacity-50"
            >
              {pendingRejection.reason ? 'تأكيد الرفض' : 'رفض بدون سبب'}
            </button>
            <button
              onClick={() => setPendingRejection(null)}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition
                bg-gray-100 hover:bg-gray-200 text-gray-700
                dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300"
            >
              إلغاء
            </button>
          </div>
        </Modal>
      )}

      {/* ── Postpone Date Picker ────────────────────────────────── */}
      {pendingPostpone !== null && (
        <Modal onClose={() => setPendingPostpone(null)}>
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center
              bg-amber-100 dark:bg-amber-900/30">
              <svg className="w-5 h-5 text-amber-600 dark:text-amber-400"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h2 className="font-bold text-gray-800 dark:text-slate-100 leading-tight">
                تأجيل الطلب
              </h2>
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                اختر التاريخ الذي طلب العميل التواصل فيه
              </p>
            </div>
          </div>

          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
            تاريخ المتابعة
          </label>
          <input
            type="date"
            dir="ltr"
            value={pendingPostpone.date}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setPendingPostpone((p) => p ? { ...p, date: e.target.value } : null)}
            className="w-full px-3 py-2.5 rounded-xl text-sm outline-none mb-5
              border border-amber-300 dark:border-amber-700/50
              bg-amber-50 dark:bg-amber-900/20
              text-amber-800 dark:text-amber-300
              focus:ring-2 focus:ring-amber-400"
          />

          <div className="flex gap-3">
            <button
              onClick={async () => {
                if (!pendingPostpone || !pendingPostpone.date) return;
                setSavingId(pendingPostpone.id);
                await onUpdate(pendingPostpone.id, {
                  Status: 'مؤجل',
                  PostponedDate: pendingPostpone.date,
                });
                setSavingId(null);
                setPendingPostpone(null);
              }}
              disabled={savingId !== null || !pendingPostpone.date}
              className="flex-1 bg-amber-600 hover:bg-amber-700 text-white py-2.5 rounded-xl
                text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              تأكيد التأجيل
            </button>
            <button
              onClick={() => setPendingPostpone(null)}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition
                bg-gray-100 hover:bg-gray-200 text-gray-700
                dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300"
            >
              إلغاء
            </button>
          </div>
        </Modal>
      )}

      {/* ── Delete Confirmation ─────────────────────────────────── */}
      {deleteConfirm !== null && (
        <Modal onClose={() => setDeleteConfirm(null)}>
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-4
              bg-red-100 dark:bg-red-900/30">
              <svg className="w-7 h-7 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <h2 className="text-lg font-bold mb-2 text-gray-800 dark:text-slate-100">تأكيد الحذف</h2>
            <p className="text-gray-500 dark:text-slate-400 text-sm mb-6">
              هل أنت متأكد من حذف هذا الطلب؟<br />لا يمكن التراجع عن هذا الإجراء.
            </p>
            <div className="flex gap-3">
              <button
                onClick={confirmDelete}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-xl
                  text-sm font-semibold transition"
              >
                نعم، احذف
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition
                  bg-gray-100 hover:bg-gray-200 text-gray-700
                  dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300"
              >
                إلغاء
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   CustomerFrequencyBadge — local-DB customer history under the customer name.
   ═══════════════════════════════════════════════════════════════════════════
   Counts come pre-aggregated from GET /api/orders (per-phone, tenant-scoped,
   zero Bosta calls). First order → subtle "عميل جديد"; returning customer →
   prominent 3-way breakdown. Cancellations (تم الرفض, free — caught on the
   confirmation call) are shown separately from shipping returns
   (تم الإرجاع / جاري الإعادة — parcel shipped & bounced, real fees lost),
   because the latter is the critical red flag. Zero counters are hidden to
   keep the name column tight. Numbers pass through Number() because node-pg
   can return bigint aggregates as strings.                                   */
function CustomerFrequencyBadge({ order }: { order: Order }) {
  const total     = Number(order.total_orders_count ?? 1);
  const delivered = Number(order.delivered_orders_count ?? 0);
  const canceled  = Number(order.canceled_orders_count ?? 0);
  const returned  = Number(order.returned_orders_count ?? 0);

  if (total <= 1) {
    return (
      <span className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md
        text-xs font-medium bg-emerald-50 border border-emerald-100 text-emerald-600
        dark:bg-emerald-900/20 dark:border-emerald-800/40 dark:text-emerald-400">
        🆕 عميل جديد
      </span>
    );
  }

  return (
    <span
      dir="rtl"
      className="mt-1 inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 max-w-[220px]
        px-2 py-0.5 rounded-md text-xs font-semibold
        bg-violet-50 border border-violet-200 text-violet-700
        dark:bg-violet-900/30 dark:border-violet-700/50 dark:text-violet-300"
    >
      <span className="whitespace-nowrap">🔁 عميل متكرر ({total} طلبات)</span>
      {delivered > 0 && (
        <span className="whitespace-nowrap text-emerald-600 dark:text-emerald-400">✅ مستلم: {delivered}</span>
      )}
      {canceled > 0 && (
        <span className="whitespace-nowrap text-amber-600 dark:text-amber-400">⚠️ إلغاء: {canceled}</span>
      )}
      {returned > 0 && (
        <span className="whitespace-nowrap text-red-600 dark:text-red-400">❌ مرتجع: {returned}</span>
      )}
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   OrderRow — one table row, strictly memoised.
   ═══════════════════════════════════════════════════════════════════════════
   The parent OrdersTable still re-renders & re-maps the array on a status edit,
   but React.memo here means only the ONE row whose `order` reference changed
   actually re-renders its (heavy) cell subtree. Every other row is skipped.
   Callback props are passed raw (page handlers use updater-form setstate + the
   row's own `order`, so identity drift causes no stale-closure bug) and the
   comparator ignores them — it compares only what the row DISPLAYS.            */
interface OrderRowProps {
  order:                Order;
  index:                number;
  role:                 'admin' | 'agent';
  selected:             boolean;
  saving:               boolean;
  agents:               string[];
  attemptLogs?:         string[];
  inlineLogging:        boolean;
  onToggleSelect?:      (id: number) => void;
  onStatusChange:       (order: Order, status: string) => void;
  onDeliveryRateChange: (id: number, rate: string) => void;
  onAssignedToChange:   (id: number, email: string) => void;
  onNoteBlur:           (order: Order, note: string) => void;
  onAddressBlur:        (order: Order, addr: string) => void;
  onShippingNotesBlur:  (order: Order, notes: string) => void;
  onInlineAttempt:      (id: number) => void;
  onQuickEdit:          (order: Order) => void;
  onEditModal:          (order: Order) => void;
  onDelete:             (id: number) => void;
}

function areRowPropsEqual(prev: OrderRowProps, next: OrderRowProps) {
  return (
    prev.order === next.order &&          // immutable update → new ref only for the edited row
    prev.index === next.index &&
    prev.role === next.role &&
    prev.selected === next.selected &&
    prev.saving === next.saving &&
    prev.inlineLogging === next.inlineLogging &&
    prev.attemptLogs === next.attemptLogs &&
    sameRefArray(prev.agents, next.agents)   // string[] → value compare
  );
}

const OrderRow = memo(function OrderRow({
  order, index, role, selected, saving, agents, attemptLogs, inlineLogging,
  onToggleSelect, onStatusChange, onDeliveryRateChange, onAssignedToChange,
  onNoteBlur, onAddressBlur, onShippingNotesBlur, onInlineAttempt,
  onQuickEdit, onEditModal, onDelete,
}: OrderRowProps) {
  return (
    <tr
      className={`hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors ${saving ? 'opacity-60 pointer-events-none' : ''}`}
    >
      {/* Row checkbox — admin only */}
      {role === 'admin' && onToggleSelect && (
        <td className="px-4 py-3 w-10" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`تحديد طلب ${order.id}`}
            checked={selected}
            onChange={() => onToggleSelect(order.id)}
            className="w-4 h-4 rounded accent-indigo-600 cursor-pointer"
          />
        </td>
      )}
      <td className="px-4 py-3 text-gray-400 dark:text-slate-600 text-xs">{index + 1}</td>

      {role === 'admin' && (
        <td className="px-4 py-3">
          {agents.length > 0 ? (
            <select
              value={order.AssignedTo ?? ''}
              onChange={(e) => onAssignedToChange(order.id, e.target.value)}
              className="px-2 py-1 rounded-lg text-xs font-medium
                text-violet-700 bg-violet-50 border border-violet-200
                dark:text-violet-300 dark:bg-violet-900/30 dark:border-violet-700/50
                outline-none focus:ring-2 focus:ring-violet-400 cursor-pointer"
            >
              <option value="">— غير محدد —</option>
              {agents.map((a) => (
                <option key={a} value={a}>{a.split('@')[0]}</option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-violet-600 dark:text-violet-400 whitespace-nowrap font-medium">
              {order.AssignedTo
                ? order.AssignedTo.split('@')[0]
                : <span className="text-gray-300 dark:text-slate-700">—</span>}
            </span>
          )}
        </td>
      )}

      <td className="px-4 py-3">
        {/* Customer name — truncated so a long value can't stretch the column. */}
        <p
          title={order.FullName}
          className="font-semibold text-gray-800 dark:text-slate-200 max-w-[200px] truncate leading-snug"
        >
          {order.FullName}
        </p>

        {/* Customer frequency — local delivery-history breakdown (see component) */}
        <CustomerFrequencyBadge order={order} />

        {/* Product badge */}
        {order.ProductName && (
          <span
            title={order.ProductName}
            className="mt-1 inline-flex items-center gap-1 max-w-[200px]
              px-2 py-0.5 rounded-md text-xs font-medium
              bg-indigo-50 border border-indigo-100 text-indigo-700
              dark:bg-indigo-900/30 dark:border-indigo-800/50 dark:text-indigo-300"
          >
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <span className="truncate">{order.ProductName}</span>
          </span>
        )}

        {/* Quantity badge — shown whenever quantity > 1 */}
        {order.quantity != null && order.quantity > 1 && (
          <span className="mt-1 inline-flex items-center gap-1
            px-2 py-0.5 rounded-md text-xs
            bg-gray-100 text-gray-500 dark:bg-slate-800 dark:text-slate-400 mr-1">
            الكمية:&nbsp;<strong className="text-gray-700 dark:text-slate-300">{order.quantity}</strong>&nbsp;قطعة
          </span>
        )}
      </td>

      <td className="px-4 py-3 text-gray-600 dark:text-slate-400 whitespace-nowrap" dir="ltr">
        {order.Phone}
      </td>

      {/* Delivery Rate dropdown — all roles */}
      <td className="px-4 py-3">
        <select
          value={order.DeliveryRate ?? 'بدون'}
          onChange={(e) => onDeliveryRateChange(order.id, e.target.value)}
          className={`px-2.5 py-1 rounded-full text-xs font-semibold cursor-pointer
            outline-none focus:ring-2 focus:ring-indigo-400 border-0
            [&>option]:bg-white [&>option]:text-slate-900
            dark:[&>option]:bg-slate-800 dark:[&>option]:text-slate-100
            ${DELIVERY_RATE_STYLES[order.DeliveryRate ?? 'بدون'] ?? 'bg-gray-100 text-gray-500 dark:bg-slate-800 dark:text-slate-400'}`}
        >
          {DELIVERY_RATE_OPTIONS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        {order.DeliveryRate === 'ضعيف' && (
          <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5
            rounded bg-red-100 border border-red-300 text-red-700 text-xs font-bold
            dark:bg-red-900/30 dark:border-red-700/50 dark:text-red-400 whitespace-nowrap">
            <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213
                  2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11
                  13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1
                  1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            طلب عربون
          </div>
        )}
      </td>

      <td className="px-4 py-3 text-gray-600 dark:text-slate-400 whitespace-nowrap">
        {order.City}
      </td>

      {/* Address — inline editable (all roles) */}
      <td className="px-4 py-3">
        <input
          key={`${order.id}-addr-${order.Address}`}
          type="text"
          defaultValue={order.Address ?? ''}
          onBlur={(e) => onAddressBlur(order, e.target.value)}
          title={order.Address}
          placeholder="أضف العنوان..."
          className="w-full min-w-[160px] max-w-[220px] px-2 py-1 text-sm rounded-lg
            border border-transparent outline-none bg-transparent
            hover:border-gray-300 dark:hover:border-slate-700
            focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400
            focus:bg-white dark:focus:bg-slate-800
            text-gray-600 dark:text-slate-400
            placeholder-gray-300 dark:placeholder-slate-600 transition"
        />
      </td>

      {/* Status cell — courier-owned statuses ('تم الشحن' onward) are a locked
          badge for EVERYONE, admins included. The inline dropdown previously
          rendered for admins on ANY status, and since the return states were
          missing from its options the <select> displayed 'جديد' — making
          returned orders look new and letting one click overwrite the real
          status in the DB. Admin overrides now live in the edit modal only. */}
      <td className="px-4 py-3">
        {MANUAL_STATUS_OPTIONS.includes(normStatus(order.Status)) ? (
          <select
            /* normalized so a stray space / RTL mark in the DB value can never
               unmatch the options and fall back to displaying 'جديد' */
            value={normStatus(order.Status)}
            onChange={(e) => onStatusChange(order, e.target.value)}
            className={`px-2.5 py-1 rounded-full text-xs font-semibold cursor-pointer outline-none
              focus:ring-2 focus:ring-indigo-400 border-0
              [&>option]:bg-white [&>option]:text-slate-900
              dark:[&>option]:bg-slate-800 dark:[&>option]:text-slate-100
              ${STATUS_STYLES[order.Status] ?? 'bg-gray-100 text-gray-700 dark:bg-slate-800 dark:text-slate-400'}`}
          >
            {MANUAL_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        ) : (
          <span
            title="هذه الحالة تُضبط تلقائياً عبر شركة الشحن"
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold select-none
              ${STATUS_STYLES[order.Status] ?? 'bg-gray-100 text-gray-700 dark:bg-slate-800 dark:text-slate-400'}`}
          >
            <svg className="w-3 h-3 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            {order.Status}
          </span>
        )}

        {order.Status === 'تم الرفض' && order.rejectionReason && (
          <div
            title={order.rejectionReason}
            className="mt-1.5 px-2 py-1 text-xs text-center text-red-600 dark:text-red-400
              bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800/40
              rounded max-w-[180px] mx-auto leading-snug"
          >
            {order.rejectionReason}
          </div>
        )}

        {normStatus(order.Status) === 'مؤجل' && toDateInput(order.PostponedDate) && (
          <div
            title="تاريخ المتابعة"
            className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 text-xs
              text-amber-700 dark:text-amber-300
              bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40
              rounded-md mx-auto leading-snug"
            dir="ltr"
          >
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            {toDateInput(order.PostponedDate)}
          </div>
        )}

        {normStatus(order.Status) === 'لا يرد' && (() => {
          const logs  = attemptLogs ?? (Array.isArray(order.no_answer_logs) ? order.no_answer_logs : []);
          const count = logs.length;
          const done  = count >= NO_ANSWER_REQUIRED;
          return (
            <button
              type="button"
              onClick={() => onInlineAttempt(order.id)}
              disabled={inlineLogging}
              title="تسجيل محاولة اتصال"
              className={`mt-1.5 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold
                transition-all duration-150 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed
                ${done
                  ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300'}`}
            >
              <span>📞</span>
              <span>
                {inlineLogging ? 'جارٍ…' : 'تسجيل محاولة'}
                {' '}({count}/{NO_ANSWER_REQUIRED})
              </span>
            </button>
          );
        })()}
      </td>

      {/* Financials / Payment column */}
      <td className="px-4 py-3">
        <div className="flex flex-col items-center justify-center gap-1.5">
          {order.hasDeposit ? (
            <>
              <div className="inline-flex items-center justify-center
                rounded-md px-2 py-1 border
                border-rose-200 bg-rose-50
                dark:bg-rose-900/30 dark:border-rose-800/50
                text-rose-700 dark:text-rose-400
                text-xs font-bold whitespace-nowrap">
                COD: {fmtNum(Math.max(0, asNum(order.ProductPrice) - asNum(order.depositAmount)))} ج.م
              </div>
              <div className="flex items-center gap-1 text-[11px] font-medium
                text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                <span>عربون:</span>
                <span dir="ltr">{fmtNum(asNum(order.depositAmount))} ج.م</span>
                <span>💰</span>
              </div>
            </>
          ) : order.ProductPrice ? (
            <span className="text-gray-500 dark:text-gray-400 text-sm whitespace-nowrap">
              {fmtNum(asNum(order.ProductPrice))} ج.م
            </span>
          ) : (
            <span className="text-gray-300 dark:text-slate-700 text-xs">—</span>
          )}
        </div>
      </td>

      {/* Shipping notes — inline editable; printed on the Bosta AWB */}
      <td className="px-4 py-3">
        <input
          key={`${order.id}-ship-${order.ShippingNotes}`}
          type="text"
          defaultValue={order.ShippingNotes ?? ''}
          onBlur={(e) => onShippingNotesBlur(order, e.target.value)}
          placeholder="ملاحظة للشحن..."
          title="تُطبع على بوليصة الشحن"
          className="w-full min-w-[150px] px-2 py-1 text-sm rounded-lg
            border border-transparent outline-none bg-transparent
            hover:border-gray-300 dark:hover:border-slate-700
            focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400
            focus:bg-white dark:focus:bg-slate-800
            text-gray-700 dark:text-slate-300
            placeholder-gray-300 dark:placeholder-slate-600 transition"
        />
      </td>

      {/* Note inline edit — all roles */}
      <td className="px-4 py-3">
        <input
          key={`${order.id}-${order.Note}`}
          type="text"
          defaultValue={order.Note ?? ''}
          onBlur={(e) => onNoteBlur(order, e.target.value)}
          placeholder="أضف ملاحظة..."
          className="w-full min-w-[150px] px-2 py-1 text-sm rounded-lg
            border border-transparent outline-none bg-transparent
            hover:border-gray-300 dark:hover:border-slate-700
            focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400
            focus:bg-white dark:focus:bg-slate-800
            text-gray-700 dark:text-slate-300
            placeholder-gray-300 dark:placeholder-slate-600 transition"
        />
      </td>

      {/* Actions — all roles */}
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          {role === 'admin' ? (
            <>
              <button
                onClick={() => onEditModal(order)}
                className="px-2.5 py-1 text-xs rounded-lg font-medium transition
                  bg-indigo-50 text-indigo-700 hover:bg-indigo-100
                  dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/60"
              >
                تعديل
              </button>
              <button
                onClick={() => onDelete(order.id)}
                className="px-2.5 py-1 text-xs rounded-lg font-medium transition
                  bg-red-50 text-red-700 hover:bg-red-100
                  dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/60"
              >
                حذف
              </button>
            </>
          ) : (
            <button
              onClick={() => onQuickEdit(order)}
              title="تعديل بيانات العميل"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg font-medium transition
                bg-indigo-50 text-indigo-700 hover:bg-indigo-100
                dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/60"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
              </svg>
              تعديل
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}, areRowPropsEqual);

/* ── Memoisation ─────────────────────────────────────────────────────────────
   The dashboard re-renders on many unrelated state changes (background product /
   inventory refetches, search, modals, polls). Without this, the whole 100s-row
   table re-renders every time → the ~3s freeze after a status change.

   We only re-render when the DISPLAYED data actually changes. Callback props
   (onUpdate/onDelete/onToast/onToggleSelect/onSelectAll) are intentionally
   ignored — they're behaviourally stable and refreshed whenever a prop we DO
   compare (orders/selectedIds/agents/…) changes, so no stale-closure risk.    */
/* Shallow element-by-element comparison. `displayOrders` is a fresh array each
   render, but the page mutates orders IMMUTABLY (replaces only the changed order
   object), so unchanged rows keep their reference. Comparing element refs lets us
   skip re-render when nothing the table shows changed (e.g. a background product
   refetch), while still re-rendering on a real status edit. O(n) ref checks. */
function sameRefArray<T>(a: T[] = [], b: T[] = []) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function arePropsEqual(prev: Props, next: Props) {
  return (
    sameRefArray(prev.orders, next.orders) &&    // per-row ref compare
    prev.role === next.role &&
    prev.showProduct === next.showProduct &&
    prev.emptyMessage === next.emptyMessage &&
    sameRefArray(prev.selectedIds, next.selectedIds) &&
    sameRefArray(prev.agents, next.agents)
  );
}

export default memo(OrdersTable, arePropsEqual);

/* ── Helpers ─────────────────────────────────────────────────── */

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-right font-semibold whitespace-nowrap text-xs uppercase tracking-wide">
      {children}
    </th>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg p-6" dir="rtl">
        {children}
      </div>
    </div>
  );
}
