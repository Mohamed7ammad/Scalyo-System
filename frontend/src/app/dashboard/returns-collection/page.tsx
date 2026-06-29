'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  Return Collection Management — إدارة تحصيل المرتجعات
 * ════════════════════════════════════════════════════════════════════
 *  Agents work a 4-state queue of returned parcels, collect the return
 *  fee, and accrue a 40% commission. Admins settle (pay out) those
 *  commissions. Backend: /api/return-collections (returnCollections.js).
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  getReturnCollections, updateReturnCollection, payReturnCollection,
  syncReturnCollections, getReturnAnalytics, settleAgentCommission,
  ReturnCollection, ReturnCollectionStatus, ReturnAnalytics, ReturnAnalyticsRow,
} from '@/lib/api';

/* ── Constants & helpers ─────────────────────────────────────────────────── */
const COMMISSION_RATE = 0.40;

const TABS: { key: ReturnCollectionStatus; label: string; accent: string }[] = [
  { key: 'pending',   label: 'بانتظار المتابعة', accent: 'amber'   },
  { key: 'no_answer', label: 'لا يرد',           accent: 'slate'   },
  { key: 'follow_up', label: 'المتابعات',        accent: 'indigo'  },
  { key: 'paid',      label: 'تم الدفع',         accent: 'emerald' },
];

const parseN = (v: string | number | null | undefined): number => parseFloat(String(v ?? 0)) || 0;
const fmt = (v: string | number | null | undefined): string =>
  parseN(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

interface Toast { message: string; type: 'success' | 'error' }

/* ── Modal wrapper ───────────────────────────────────────────────────────── */
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

function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 px-5 py-4 shadow-sm">
      <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold tracking-tight ${accent}`}>{value}</p>
    </div>
  );
}

const STATUS_BADGE: Record<ReturnCollectionStatus, string> = {
  pending:   'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  no_answer: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  follow_up: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  paid:      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
};
const STATUS_LABEL: Record<ReturnCollectionStatus, string> = {
  pending: 'بانتظار المتابعة', no_answer: 'لا يرد', follow_up: 'متابعة', paid: 'تم الدفع',
};

/* ══════════════════════════════════════════════════════════════════════════ */
export default function ReturnsCollectionPage() {
  const router = useRouter();

  const [allowed,  setAllowed]  = useState(false);
  const [isAdmin,  setIsAdmin]  = useState(false);
  const [records,  setRecords]  = useState<ReturnCollection[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [activeTab, setActiveTab] = useState<ReturnCollectionStatus>('pending');
  const [analytics, setAnalytics] = useState<ReturnAnalytics | null>(null);
  const [syncing,  setSyncing]  = useState(false);
  const [toast,    setToast]    = useState<Toast | null>(null);
  const [busyRow,  setBusyRow]  = useState<number | null>(null);

  /* Pay modal */
  const [payTarget, setPayTarget] = useState<ReturnCollection | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [paySaving, setPaySaving] = useState(false);

  /* Settle modal (admin) */
  const [settleTarget, setSettleTarget] = useState<ReturnAnalyticsRow | null>(null);
  const [settleAmount, setSettleAmount] = useState('');
  const [settleNotes,  setSettleNotes]  = useState('');
  const [settleSaving, setSettleSaving] = useState(false);
  const [settleError,  setSettleError]  = useState('');

  const showToast = (message: string, type: Toast['type']) => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  /* ── Auth guard — admin or shipping_followups permission ─────────────────── */
  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      const stored = localStorage.getItem('user');
      if (!token || !stored) { router.replace('/'); return; }
      const u = JSON.parse(stored);
      const admin = u.role === 'admin';
      const ok = admin || (Array.isArray(u.permissions) && u.permissions.includes('shipping_followups'));
      if (!ok) { router.replace('/dashboard'); return; }
      setIsAdmin(admin);
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  /* ── Fetch ───────────────────────────────────────────────────────────────── */
  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      const [recRes, anaRes] = await Promise.all([getReturnCollections(), getReturnAnalytics()]);
      setRecords(recRes.data);
      setAnalytics(anaRes.data);
    } catch {
      showToast('تعذّر تحميل بيانات المرتجعات', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (allowed) fetchAll(); }, [allowed, fetchAll]);

  /* ── Derived: bucket records by status for tab counts ────────────────────── */
  const counts = useMemo(() => {
    const c: Record<ReturnCollectionStatus, number> = { pending: 0, no_answer: 0, follow_up: 0, paid: 0 };
    for (const r of records) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [records]);

  const visibleRows = useMemo(
    () => records.filter((r) => r.status === activeTab),
    [records, activeTab],
  );

  /* ── Actions ─────────────────────────────────────────────────────────────── */
  const handleStatus = async (row: ReturnCollection, status: Exclude<ReturnCollectionStatus, 'paid'>) => {
    setBusyRow(row.id);
    try {
      const res = await updateReturnCollection(row.id, { status });
      setRecords((prev) => prev.map((r) => (r.id === row.id ? res.data : r)));
    } catch {
      showToast('تعذّر تحديث الحالة', 'error');
    } finally {
      setBusyRow(null);
    }
  };

  const handleNotesBlur = async (row: ReturnCollection, notes: string) => {
    if (notes === (row.notes ?? '')) return;
    try {
      const res = await updateReturnCollection(row.id, { notes });
      setRecords((prev) => prev.map((r) => (r.id === row.id ? res.data : r)));
    } catch {
      showToast('تعذّر حفظ الملاحظة', 'error');
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await syncReturnCollections();
      await fetchAll();
      showToast(`تم تحديث المرتجعات (${res.data.synced} سجل)`, 'success');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر تحديث المرتجعات';
      showToast(msg, 'error');
    } finally {
      setSyncing(false);
    }
  };

  /* Pay modal */
  const openPay = (row: ReturnCollection) => {
    setPayTarget(row);
    setPayAmount(row.collected_amount && parseN(row.collected_amount) > 0 ? String(parseN(row.collected_amount)) : '');
  };
  const handlePay = async () => {
    if (!payTarget) return;
    const amount = parseN(payAmount);
    if (!(amount > 0)) { showToast('أدخل مبلغاً صحيحاً', 'error'); return; }
    setPaySaving(true);
    try {
      const res = await payReturnCollection(payTarget.id, amount);
      setRecords((prev) => prev.map((r) => (r.id === payTarget.id ? res.data : r)));
      setPayTarget(null);
      // commission accrual changed → refresh analytics
      getReturnAnalytics().then((a) => setAnalytics(a.data)).catch(() => {});
      showToast('تم تسجيل التحصيل ✓', 'success');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر تسجيل التحصيل';
      showToast(msg, 'error');
    } finally {
      setPaySaving(false);
    }
  };

  /* Settle modal (admin) */
  const openSettle = (agent: ReturnAnalyticsRow) => {
    setSettleTarget(agent);
    setSettleAmount(agent.remaining_balance > 0 ? String(agent.remaining_balance) : '');
    setSettleNotes('');
    setSettleError('');
  };
  const handleSettle = async () => {
    if (!settleTarget) return;
    setSettleError('');
    const amount = parseN(settleAmount);
    if (!(amount > 0)) { setSettleError('أدخل مبلغاً صحيحاً'); return; }
    if (amount > settleTarget.remaining_balance + 0.001) {
      setSettleError(`المبلغ يتجاوز الرصيد المتبقي (${fmt(settleTarget.remaining_balance)} ج.م)`); return;
    }
    setSettleSaving(true);
    try {
      await settleAgentCommission({ agent_user_id: settleTarget.agent_user_id, amount, notes: settleNotes || undefined });
      const a = await getReturnAnalytics();
      setAnalytics(a.data);
      setSettleTarget(null);
      showToast('تم تسجيل التسديد ✓', 'success');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'تعذّر تسجيل التسديد';
      setSettleError(msg);
    } finally {
      setSettleSaving(false);
    }
  };

  const payPreviewCommission = parseN(payAmount) * COMMISSION_RATE;
  const totals = analytics?.totals;

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
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">إدارة تحصيل المرتجعات</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              متابعة الشحنات العائدة · تحصيل رسوم المرتجع · عمولات الموظفين
            </p>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white
              rounded-xl text-sm font-semibold shadow-sm shadow-indigo-500/30 transition disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {syncing ? 'جارٍ التحديث…' : 'تحديث المرتجعات'}
          </button>
        </div>

        {/* Analytics cards */}
        {totals && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="إجمالي التحصيلات" value={`${fmt(totals.total_collected)} ج.م`} accent="text-slate-800 dark:text-white" />
            <StatCard label="إجمالي العمولات المستحقة" value={`${fmt(totals.total_commission_earned)} ج.م`} accent="text-indigo-600 dark:text-indigo-400" />
            <StatCard label="إجمالي المسدد للموظف" value={`${fmt(totals.total_paid)} ج.م`} accent="text-emerald-600 dark:text-emerald-400" />
            <StatCard label="الرصيد المتبقي" value={`${fmt(totals.remaining_balance)} ج.م`} accent={totals.remaining_balance > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500'} />
          </div>
        )}

        {/* Admin: per-agent settlement table */}
        {isAdmin && analytics && analytics.agents.length > 0 && (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800">
              <h2 className="text-sm font-bold text-slate-700 dark:text-slate-200">تحليلات الأداء وتسديد العمولات</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-right font-semibold px-4 py-3">الموظف</th>
                    <th className="text-right font-semibold px-4 py-3">التحصيلات</th>
                    <th className="text-right font-semibold px-4 py-3">العمولة المستحقة</th>
                    <th className="text-right font-semibold px-4 py-3">المسدد</th>
                    <th className="text-right font-semibold px-4 py-3">المتبقي</th>
                    <th className="text-right font-semibold px-4 py-3">الإجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {analytics.agents.map((a) => (
                    <tr key={a.agent_user_id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-200">{a.agent_name ?? a.agent_email ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300" dir="ltr">{fmt(a.total_collected)} ج.م</td>
                      <td className="px-4 py-3 text-indigo-600 dark:text-indigo-400 font-semibold" dir="ltr">{fmt(a.total_commission_earned)} ج.م</td>
                      <td className="px-4 py-3 text-emerald-600 dark:text-emerald-400" dir="ltr">{fmt(a.total_paid)} ج.م</td>
                      <td className="px-4 py-3 font-bold" dir="ltr">{fmt(a.remaining_balance)} ج.م</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => openSettle(a)}
                          disabled={a.remaining_balance <= 0}
                          className="px-3 py-1.5 text-xs rounded-lg font-medium transition
                            bg-emerald-50 text-emerald-700 hover:bg-emerald-100
                            dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/60
                            disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          تسديد
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Queue tabs */}
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition
                ${activeTab === t.key
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'}`}
            >
              {t.label}
              <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold
                ${activeTab === t.key ? 'bg-white/25 text-white' : 'bg-slate-300/60 text-slate-700 dark:bg-slate-700 dark:text-slate-200'}`}>
                {counts[t.key]}
              </span>
            </button>
          ))}
        </div>

        {/* Queue table */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-20">
              <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-3" />
              <p className="text-slate-400 text-sm">جارٍ التحميل…</p>
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="text-center py-20 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">لا توجد سجلات في هذه القائمة</p>
              <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">اضغط «تحديث المرتجعات» لجلب الشحنات العائدة من شركة الشحن</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">رقم التتبع</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">العميل</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الهاتف</th>
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المنتج</th>
                    <th className="text-right font-semibold px-4 py-3">ملاحظات</th>
                    {activeTab === 'paid' && <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">المُحصّل</th>}
                    {activeTab === 'paid' && <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">العمولة (40%)</th>}
                    <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">الإجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {visibleRows.map((r) => {
                    const busy = busyRow === r.id;
                    return (
                      <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 align-top">
                        <td className="px-4 py-3 font-mono text-xs text-indigo-600 dark:text-indigo-400 whitespace-nowrap" dir="ltr">{r.tracking_number || '—'}</td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-200 whitespace-nowrap">{r.customer_name || '—'}</td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap" dir="ltr">{r.phone || '—'}</td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-[14rem]">
                          <span className="line-clamp-2" title={r.product_name ?? ''}>{r.product_name || '—'}</span>
                        </td>
                        <td className="px-4 py-3">
                          {r.status === 'paid' ? (
                            <span className="text-xs text-slate-500 dark:text-slate-400">{r.notes || '—'}</span>
                          ) : (
                            <input
                              type="text"
                              defaultValue={r.notes ?? ''}
                              placeholder="أضف ملاحظة…"
                              onBlur={(e) => handleNotesBlur(r, e.target.value)}
                              className="w-40 px-2 py-1 rounded-lg text-xs bg-slate-50 dark:bg-slate-800
                                border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200
                                outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
                            />
                          )}
                        </td>
                        {activeTab === 'paid' && <td className="px-4 py-3 font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap" dir="ltr">{fmt(r.collected_amount)} ج.م</td>}
                        {activeTab === 'paid' && <td className="px-4 py-3 font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap" dir="ltr">{fmt(r.employee_commission)} ج.م</td>}
                        <td className="px-4 py-3">
                          {r.status === 'paid' ? (
                            <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_BADGE.paid}`}>{STATUS_LABEL.paid}</span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {r.status !== 'no_answer' && (
                                <button onClick={() => handleStatus(r, 'no_answer')} disabled={busy}
                                  className="px-2.5 py-1.5 text-xs rounded-lg font-medium transition bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 disabled:opacity-50">
                                  لا يرد
                                </button>
                              )}
                              {r.status !== 'follow_up' && (
                                <button onClick={() => handleStatus(r, 'follow_up')} disabled={busy}
                                  className="px-2.5 py-1.5 text-xs rounded-lg font-medium transition bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300 disabled:opacity-50">
                                  متابعة
                                </button>
                              )}
                              <button onClick={() => openPay(r)} disabled={busy}
                                className="px-2.5 py-1.5 text-xs rounded-lg font-semibold transition bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                                تم الدفع
                              </button>
                            </div>
                          )}
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

      {/* ══ Pay modal ══════════════════════════════════════════════════════ */}
      {payTarget && (
        <Modal onClose={() => !paySaving && setPayTarget(null)}>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-1">تسجيل تحصيل المرتجع</h2>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-5">
            {payTarget.customer_name || '—'}{payTarget.tracking_number ? ` · ${payTarget.tracking_number}` : ''}
          </p>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">المبلغ المُحصّل (ج.م)</label>
          <input
            type="number" min="0" step="0.01" dir="ltr" autoFocus
            value={payAmount}
            onChange={(e) => setPayAmount(e.target.value)}
            placeholder="100"
            className="w-full px-3 py-2.5 rounded-xl text-sm outline-none border border-slate-300 dark:border-slate-700
              bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
          />

          <div className="mt-4 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/50 p-3 space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">يُضاف للخزينة (100%)</span>
              <span className="font-bold text-emerald-600 dark:text-emerald-400" dir="ltr">{fmt(parseN(payAmount))} ج.م</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">عمولة الموظف المستحقة (40%)</span>
              <span className="font-bold text-indigo-600 dark:text-indigo-400" dir="ltr">{fmt(payPreviewCommission)} ج.م</span>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button onClick={handlePay} disabled={paySaving}
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50">
              {paySaving ? 'جارٍ التسجيل…' : 'تأكيد التحصيل'}
            </button>
            <button onClick={() => setPayTarget(null)} disabled={paySaving}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </Modal>
      )}

      {/* ══ Settle modal (admin) ═══════════════════════════════════════════ */}
      {settleTarget && (
        <Modal onClose={() => !settleSaving && setSettleTarget(null)}>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-1">تسديد عمولة</h2>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-1">{settleTarget.agent_name ?? settleTarget.agent_email}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-5">
            الرصيد المتبقي: <span className="font-bold text-amber-600 dark:text-amber-400" dir="ltr">{fmt(settleTarget.remaining_balance)} ج.م</span>
          </p>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">مبلغ التسديد (ج.م) — يسمح بالدفع الجزئي</label>
          <input
            type="number" min="0" step="0.01" dir="ltr" autoFocus
            value={settleAmount}
            onChange={(e) => setSettleAmount(e.target.value)}
            placeholder="0"
            className="w-full px-3 py-2.5 rounded-xl text-sm outline-none border border-slate-300 dark:border-slate-700
              bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-emerald-400 focus:border-transparent"
          />

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 mt-3">ملاحظات (اختياري)</label>
          <input
            type="text"
            value={settleNotes}
            onChange={(e) => setSettleNotes(e.target.value)}
            placeholder="طريقة الدفع / مرجع…"
            className="w-full px-3 py-2.5 rounded-xl text-sm outline-none border border-slate-300 dark:border-slate-700
              bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-emerald-400 focus:border-transparent"
          />

          {settleError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 px-3 py-2 rounded-xl">
              {settleError}
            </p>
          )}

          <div className="flex gap-3 mt-6">
            <button onClick={handleSettle} disabled={settleSaving}
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50">
              {settleSaving ? 'جارٍ التسديد…' : 'تأكيد التسديد'}
            </button>
            <button onClick={() => setSettleTarget(null)} disabled={settleSaving}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
