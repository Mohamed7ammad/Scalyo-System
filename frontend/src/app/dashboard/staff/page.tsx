'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getStaff, createStaff, updateStaff, toggleAttendance, deleteStaff,
  getAgentAnalytics, createEmployeePayout,
  StaffMember, CreateStaffPayload, UpdateStaffPayload, AgentAnalytics,
} from '@/lib/api';

/* ── Types ──────────────────────────────────────────────────────── */
type Tab    = 'staff' | 'analytics';
type Preset = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'all' | 'custom';

/* ── Date helpers ───────────────────────────────────────────────── */
const toDS  = (d: Date) => d.toLocaleDateString('en-CA');
const today = () => toDS(new Date());
const yesterday = () => { const d = new Date(); d.setDate(d.getDate()-1); return toDS(d); };
const last7     = () => { const d = new Date(); d.setDate(d.getDate()-6); return toDS(d); };
const monthStart= () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; };

const PRESETS: { key: Preset; label: string }[] = [
  { key:'today',     label:'اليوم' },
  { key:'yesterday', label:'أمس' },
  { key:'last7',     label:'آخر 7 أيام' },
  { key:'thisMonth', label:'هذا الشهر' },
  { key:'all',       label:'الكل' },
  { key:'custom',    label:'مخصص' },
];
function presetDates(p: Preset): { start: string; end: string } {
  const t = today();
  switch (p) {
    case 'today':     return { start: t,           end: t };
    case 'yesterday': return { start: yesterday(),  end: yesterday() };
    case 'last7':     return { start: last7(),      end: t };
    case 'thisMonth': return { start: monthStart(), end: t };
    case 'all':       return { start: '',           end: '' };
    default:          return { start: t,           end: t };
  }
}

/* ── Math helpers ───────────────────────────────────────────────── */
const toN  = (v: string | number | null | undefined) =>
  v === null || v === undefined ? 0 : typeof v === 'string' ? parseFloat(v) || 0 : v;
const pct  = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));
const fmtMoney = (n: number) => n.toLocaleString('ar-EG') + ' ج.م';

/* ── Staff helpers ──────────────────────────────────────────────── */
const initials    = (m: StaffMember) => (m.name?.trim()?.[0] ?? m.email[0]).toUpperCase();
const displayName = (m: StaffMember) => m.name?.trim() || m.email.split('@')[0];

/* ── Toast ──────────────────────────────────────────────────────── */
interface ToastState { message: string; type: 'success'|'error'|'info' }

/* ── Form state ─────────────────────────────────────────────────── */
interface FormState {
  name:            string;
  email:           string;
  password:        string;
  role:            'agent'|'admin'|'media_buyer';
  is_active:       boolean;
  permissions:     string[];
  comm_confirmed:  number;
  comm_delivered:  number;
  comm_rejected:   number;
  comm_no_answer:  number;
}
const ALL_PERMISSIONS = [
  { key:'orders',             label:'تأكيد الطلبات',           description:'عرض وتعديل الطلبات',             alwaysOn:true },
  { key:'analytics',          label:'لوحة التحكم والتحليلات', description:'عرض الإحصاءات والتقارير' },
  { key:'inventory',          label:'إدارة المخزون',           description:'عرض المنتجات ومستويات المخزون' },
  { key:'shipping_followups', label:'متابعات شركة الشحن',     description:'متابعة وتحديث حالات الشحن المتقدمة' },
];
const EMPTY_FORM: FormState = {
  name:'', email:'', password:'', role:'agent', is_active:true, permissions:['orders'],
  comm_confirmed:0, comm_delivered:0, comm_rejected:0, comm_no_answer:0,
};

/* ── Analytics sub-components ──────────────────────────────────── */
function Bar({ value, color='indigo' }: { value:number; color?:'indigo'|'emerald'|'amber'|'red'|'slate' }) {
  const cls: Record<string,string> = {
    indigo:'bg-indigo-500', emerald:'bg-emerald-500', amber:'bg-amber-500',
    red:'bg-red-500', slate:'bg-slate-400 dark:bg-slate-600',
  };
  return (
    <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mt-1">
      <div className={`h-full rounded-full transition-all duration-500 ${cls[color]}`}
        style={{ width:`${Math.min(value,100)}%` }} />
    </div>
  );
}
function Rank({ n }: { n:number }) {
  if (n===1) return <span className="text-base leading-none">🥇</span>;
  if (n===2) return <span className="text-base leading-none">🥈</span>;
  if (n===3) return <span className="text-base leading-none">🥉</span>;
  return (
    <span className="inline-flex items-center justify-center w-6 h-6 text-[11px] font-bold
      text-slate-400 dark:text-slate-600 bg-slate-100 dark:bg-slate-800 rounded-full">
      {n}
    </span>
  );
}
function KpiCard({ label, value, sub, icon, accent='slate' }: {
  label:string; value:string|number; sub?:string; icon:React.ReactNode;
  accent?:'slate'|'emerald'|'amber'|'red'|'indigo';
}) {
  const ring:Record<string,string> = {
    slate:'ring-slate-200 dark:ring-slate-700/60', emerald:'ring-emerald-200 dark:ring-emerald-800/60',
    amber:'ring-amber-200 dark:ring-amber-700/60', red:'ring-red-200 dark:ring-red-800/60',
    indigo:'ring-indigo-200 dark:ring-indigo-800/60',
  };
  const txt:Record<string,string> = {
    slate:'text-slate-800 dark:text-white', emerald:'text-emerald-600 dark:text-emerald-400',
    amber:'text-amber-600 dark:text-amber-400', red:'text-red-600 dark:text-red-400',
    indigo:'text-indigo-600 dark:text-indigo-400',
  };
  const iconBg:Record<string,string> = {
    slate:'bg-slate-100 dark:bg-slate-800', emerald:'bg-emerald-50 dark:bg-emerald-900/40',
    amber:'bg-amber-50 dark:bg-amber-900/40', red:'bg-red-50 dark:bg-red-900/40',
    indigo:'bg-indigo-50 dark:bg-indigo-900/40',
  };
  return (
    <div className={`bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 ring-1 ${ring[accent]} px-4 py-4 shadow-sm flex items-start gap-3`}>
      <div className={`w-10 h-10 rounded-xl ${iconBg[accent]} flex items-center justify-center shrink-0 mt-0.5`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium leading-tight truncate">{label}</p>
        <p className={`text-2xl font-bold leading-tight mt-0.5 ${txt[accent]}`}>{value}</p>
        {sub && <p className="text-[11px] text-slate-400 dark:text-slate-600 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

/* A user is "online" if their heartbeat landed within this window. */
const ONLINE_WINDOW_MS = 4 * 60 * 1000; // 4 minutes
function isOnline(lastActiveAt?: string | null): boolean {
  if (!lastActiveAt) return false;
  const t = new Date(lastActiveAt).getTime();
  return Number.isFinite(t) && Date.now() - t <= ONLINE_WINDOW_MS;
}

/* ════════════════════════════════════════════════════════════════════
   Main Page
   ════════════════════════════════════════════════════════════════════ */
export default function StaffPage() {
  const router = useRouter();

  /* ── Auth guard ─────────────────────────────────────────────── */
  const [currentUserId, setCurrentUserId] = useState<string | number | null>(null);
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!u || u.role !== 'admin') { router.replace('/dashboard'); return; }
      setCurrentUserId(u.id ?? null);
    } catch { router.replace('/dashboard'); }
  }, [router]);

  /* ── Tab ────────────────────────────────────────────────────── */
  const [activeTab, setActiveTab] = useState<Tab>('staff');

  /* ── Toast ──────────────────────────────────────────────────── */
  const [toast, setToast] = useState<ToastState | null>(null);
  const showToast = (message: string, type: ToastState['type'] = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4500);
  };

  /* ══════════════════════════════════════════════════════════════
     STAFF TAB state
     ══════════════════════════════════════════════════════════════ */
  const [staff,   setStaff]   = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  /* The tenant's founding admin (earliest-created admin) — protected from deletion,
     mirrors the server-side guard so the button is disabled for that row too. */
  const ownerAdminId = useMemo(() => {
    const admins = staff.filter((s) => s.role === 'admin');
    if (admins.length === 0) return null;
    return [...admins].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )[0].id;
  }, [staff]);

  const loadStaff = useCallback(async () => {
    try { setLoading(true); setError(null); const r = await getStaff(); setStaff(r.data); }
    catch { setError('تعذّر تحميل بيانات الفريق'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadStaff(); }, [loadStaff]);

  /* Silent presence refresh — re-fetch the staff list every 60s (no spinner)
     so the Online/Offline badges stay current without a manual reload. */
  useEffect(() => {
    const id = setInterval(() => {
      getStaff().then((r) => setStaff(r.data)).catch(() => { /* silent */ });
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter(m => m.email.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [staff, search]);

  const stats = useMemo(() => ({
    total:  staff.length,
    // "Online now" — counts members whose heartbeat is within the live window,
    // not just enabled accounts.
    active: staff.filter(m => isOnline(m.last_active_at)).length,
    absent: staff.filter(m => m.is_absent && m.is_active).length,
    agents: staff.filter(m => m.role === 'agent').length,
  }), [staff]);

  const [togglingId, setTogglingId] = useState<number | null>(null);
  const handleToggleAttendance = async (member: StaffMember) => {
    const nextAbsent = !member.is_absent;
    setTogglingId(member.id);
    try {
      const res = await toggleAttendance(member.id, nextAbsent);
      const { redistributed, presentAgentsCount, user: updated } = res.data;
      setStaff(prev => prev.map(m => m.id === member.id ? updated : m));
      if (nextAbsent) {
        if (redistributed > 0) showToast(`تم تسجيل الغياب — توزيع ${redistributed} طلب على ${presentAgentsCount} موظف`, 'info');
        else if (presentAgentsCount === 0) showToast('تم تسجيل الغياب — لا يوجد موظفون آخرون', 'info');
        else showToast('تم تسجيل الغياب بنجاح');
      } else {
        showToast(`تم تسجيل حضور ${displayName(updated)} بنجاح`);
      }
    } catch (err: unknown) {
      showToast((err as {response?:{data?:{error?:string}}})?.response?.data?.error || 'حدث خطأ', 'error');
    } finally { setTogglingId(null); }
  };

  /* ── Delete staff member ───────────────────────────────────── */
  const handleDelete = async (member: StaffMember) => {
    if (deletingId) return;
    if (!window.confirm('هل أنت متأكد من حذف هذا الموظف نهائياً؟')) return;
    setDeletingId(member.id);
    try {
      await deleteStaff(member.id);
      showToast(`تم حذف ${displayName(member)} بنجاح`);
      await loadStaff();   // re-fetch so the table updates immediately
    } catch (err: unknown) {
      showToast((err as {response?:{data?:{error?:string}}})?.response?.data?.error || 'تعذّر حذف الموظف', 'error');
    } finally { setDeletingId(null); }
  };

  /* ── Add / Edit modal ──────────────────────────────────────── */
  const [showModal,  setShowModal]  = useState(false);
  const [editTarget, setEditTarget] = useState<StaffMember | null>(null);
  const [form,       setForm]       = useState<FormState>(EMPTY_FORM);
  const [saving,     setSaving]     = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const openAdd  = () => { setEditTarget(null); setForm(EMPTY_FORM); setModalError(null); setShowModal(true); };
  const openEdit = (m: StaffMember) => {
    setEditTarget(m);
    setForm({
      name: m.name, email: m.email, password: '', role: m.role,
      is_active: m.is_active,
      permissions: m.permissions?.length ? m.permissions : ['orders'],
      comm_confirmed: toN(m.comm_confirmed),
      comm_delivered: toN(m.comm_delivered),
      comm_rejected:  toN(m.comm_rejected),
      comm_no_answer: toN(m.comm_no_answer),
    });
    setModalError(null);
    setShowModal(true);
  };
  const closeModal = () => { setShowModal(false); setEditTarget(null); };

  const handleSave = async () => {
    setModalError(null); setSaving(true);
    try {
      if (editTarget) {
        const payload: UpdateStaffPayload = {
          name: form.name, email: form.email, role: form.role,
          is_active: form.is_active, permissions: form.permissions,
          comm_confirmed: form.comm_confirmed,
          comm_delivered: form.comm_delivered,
          comm_rejected:  form.comm_rejected,
          comm_no_answer: form.comm_no_answer,
        };
        if (form.password.trim()) payload.password = form.password;
        const res = await updateStaff(editTarget.id, payload);
        setStaff(prev => prev.map(m => m.id === editTarget.id ? res.data : m));
        showToast('تم تحديث بيانات الموظف بنجاح');
      } else {
        const payload: CreateStaffPayload = {
          name: form.name, email: form.email, password: form.password,
          role: form.role, permissions: form.permissions,
          comm_confirmed: form.comm_confirmed,
          comm_delivered: form.comm_delivered,
          comm_rejected:  form.comm_rejected,
          comm_no_answer: form.comm_no_answer,
        };
        const res = await createStaff(payload);
        setStaff(prev => [...prev, res.data]);
        showToast('تم إضافة الموظف بنجاح');
      }
      closeModal();
    } catch (err: unknown) {
      setModalError((err as {response?:{data?:{error?:string}}})?.response?.data?.error || 'حدث خطأ أثناء الحفظ');
    } finally { setSaving(false); }
  };

  /* ══════════════════════════════════════════════════════════════
     ANALYTICS TAB state
     ══════════════════════════════════════════════════════════════ */
  const [aRows,         setARows]         = useState<AgentAnalytics[]>([]);
  const [aLoading,      setALoading]      = useState(false);
  const [aPreset,       setAPreset]       = useState<Preset>('today');
  const [aCustomStart,  setACustomStart]  = useState('');
  const [aCustomEnd,    setACustomEnd]    = useState('');
  const [aLoaded,       setALoaded]       = useState(false);

  /* accordion row */
  const [expandedAgentId, setExpandedAgentId] = useState<number|null>(null);

  /* commission-settings modal */
  interface CommModal { agent: AgentAnalytics; confirmed: number; delivered: number; rejected: number; no_answer: number; saving: boolean; }
  const [commModal, setCommModal] = useState<CommModal|null>(null);
  const openCommModal = (agent: AgentAnalytics) => setCommModal({
    agent,
    confirmed: toN(agent.comm_confirmed),
    delivered: toN(agent.comm_delivered),
    rejected:  toN(agent.comm_rejected),
    no_answer: toN(agent.comm_no_answer),
    saving:    false,
  });
  const saveCommModal = async () => {
    if (!commModal) return;
    setCommModal(m => m ? {...m, saving:true} : null);
    try {
      await updateStaff(commModal.agent.agent_id, {
        comm_confirmed: commModal.confirmed,
        comm_delivered: commModal.delivered,
        comm_rejected:  commModal.rejected,
        comm_no_answer: commModal.no_answer,
      });
      const { start, end } = aPreset !== 'custom' ? presetDates(aPreset) : { start: aCustomStart, end: aCustomEnd };
      await loadAnalytics(start, end);
      showToast('تم حفظ إعدادات العمولة بنجاح');
      setCommModal(null);
    } catch {
      showToast('فشل حفظ إعدادات العمولة', 'error');
      setCommModal(m => m ? {...m, saving:false} : null);
    }
  };

  /* ── Payout (تسديد) modal — Employee Ledger settlement ──────────────────────
     amount defaults to the employee's GLOBAL outstanding balance so the admin
     can settle in full with one click, or edit it down for a partial payment. */
  interface PayoutModal { agent: AgentAnalytics; outstanding: number; amount: string; note: string; saving: boolean; }
  const [payoutModal, setPayoutModal] = useState<PayoutModal|null>(null);
  const openPayoutModal = (agent: AgentAnalytics) => {
    const outstanding = Math.max(0, toN(agent.outstanding_balance));
    setPayoutModal({
      agent,
      outstanding,
      amount: outstanding > 0 ? String(outstanding) : '',  // default = full balance
      note:   '',
      saving: false,
    });
  };
  const savePayoutModal = async () => {
    if (!payoutModal) return;
    const amt = parseFloat(payoutModal.amount);
    if (isNaN(amt) || amt <= 0) { showToast('أدخل مبلغاً صحيحاً أكبر من صفر', 'error'); return; }
    if (amt > payoutModal.outstanding + 0.01) { showToast('المبلغ يتجاوز الرصيد المتبقي', 'error'); return; }
    setPayoutModal(m => m ? {...m, saving:true} : null);
    try {
      const res = await createEmployeePayout(payoutModal.agent.agent_id, amt, payoutModal.note.trim() || undefined);
      const { start, end } = aPreset !== 'custom' ? presetDates(aPreset) : { start: aCustomStart, end: aCustomEnd };
      await loadAnalytics(start, end);
      showToast(res.data?.message || 'تم تسجيل التسديد بنجاح');
      setPayoutModal(null);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      showToast(msg || 'فشل تسجيل التسديد', 'error');
      setPayoutModal(m => m ? {...m, saving:false} : null);
    }
  };

  const loadAnalytics = useCallback(async (start: string, end: string) => {
    setALoading(true);
    try { const r = await getAgentAnalytics(start||undefined, end||undefined); setARows(r.data); setALoaded(true); }
    catch { setARows([]); }
    finally { setALoading(false); }
  }, []);

  useEffect(() => {
    if (activeTab === 'analytics' && !aLoaded && aPreset !== 'custom') {
      const { start, end } = presetDates(aPreset);
      loadAnalytics(start, end);
    }
  }, [activeTab, aLoaded, aPreset, loadAnalytics]);

  const handleAPreset = (p: Preset) => {
    setAPreset(p); setALoaded(false);
    if (p !== 'custom') {
      const { start, end } = presetDates(p);
      loadAnalytics(start, end);
    }
  };

  const ranked = [...aRows].sort((a,b) => toN(b.status_confirmed) - toN(a.status_confirmed));
  const aTotals = ranked.reduce(
    (acc,a) => ({ assigned: acc.assigned+toN(a.total_assigned), confirmed: acc.confirmed+toN(a.status_confirmed),
                  delivered: acc.delivered+toN(a.status_delivered), commission: acc.commission+toN(a.earned_commission) }),
    { assigned:0, confirmed:0, delivered:0, commission:0 }
  );
  const avgConfirmRate = pct(aTotals.confirmed, aTotals.assigned);
  const flagged        = ranked.filter(a => toN(a.ndr_pct) > 25).length;

  /* ─────────────────────────────────────────────────────────────
     Render
     ───────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 p-6" dir="rtl">

      {/* ── Toast ─────────────────────────────────────────── */}
      {toast && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-[100]
          flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-2xl text-sm font-medium max-w-md w-full
          ${toast.type==='success'?'bg-emerald-600':toast.type==='error'?'bg-red-600':'bg-indigo-600'} text-white`}>
          {toast.type==='success' && <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>}
          {toast.type==='error'   && <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/></svg>}
          {toast.type==='info'    && <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>}
          <span>{toast.message}</span>
        </div>
      )}

      {/* ── Page header ───────────────────────────────────── */}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">إدارة الموظفين</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            إدارة فريق التأكيد وتتبع الأداء والعمولات
          </p>
        </div>
        {activeTab === 'staff' && (
          <button onClick={openAdd}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700
              text-white text-sm font-semibold rounded-xl shadow-md shadow-indigo-500/25 transition-all active:scale-95">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/>
            </svg>
            إضافة موظف
          </button>
        )}
      </div>

      {/* ── Tabs ──────────────────────────────────────────── */}
      <div className="flex items-center gap-1 mb-6 bg-white dark:bg-slate-900
        border border-slate-200 dark:border-slate-800 rounded-2xl p-1 w-fit shadow-sm">
        {([
          { key:'staff',     label:'قائمة الموظفين',  icon:'👥' },
          { key:'analytics', label:'تحليلات الأداء',  icon:'📊' },
        ] as const).map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium transition-all duration-150
              ${activeTab===t.key
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
            <span className="text-base">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          TAB 1 — STAFF LIST
          ══════════════════════════════════════════════════════ */}
      {activeTab === 'staff' && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-7">
            {[
              { label:'إجمالي الفريق',      value:stats.total,  color:'indigo',  icon:<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg> },
              { label:'الموظفون النشطون الآن', value:stats.active, color:'emerald', live:true, icon:<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> },
              { label:'الغائبون اليوم',     value:stats.absent, color:'amber',   icon:<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg> },
              { label:'وكلاء التأكيد',      value:stats.agents, color:'violet',  icon:<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg> },
            ].map(({ label, value, color, icon, live }) => (
              <div key={label} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700/60 shadow-sm p-5 flex items-center gap-4">
                <div className={`relative w-11 h-11 rounded-xl flex items-center justify-center shrink-0
                  ${color==='indigo'  ? 'bg-indigo-50  text-indigo-600  dark:bg-indigo-900/30  dark:text-indigo-400'  : ''}
                  ${color==='emerald' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' : ''}
                  ${color==='amber'   ? 'bg-amber-50   text-amber-600   dark:bg-amber-900/30   dark:text-amber-400'   : ''}
                  ${color==='violet'  ? 'bg-violet-50  text-violet-600  dark:bg-violet-900/30  dark:text-violet-400'  : ''}`}>
                  {icon}
                  {/* Live "online now" indicator on the icon */}
                  {live && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500 ring-2 ring-white dark:ring-slate-900" />
                    </span>
                  )}
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900 dark:text-white leading-none flex items-center gap-2">
                    {value}
                    {live && (
                      <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" title="مباشر الآن" />
                    )}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{label}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Search */}
          <div className="mb-4">
            <div className="relative max-w-sm">
              <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="بحث بالاسم أو البريد…"
                className="w-full pr-9 pl-4 py-2.5 text-sm rounded-xl bg-white dark:bg-slate-900
                  border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100
                  placeholder:text-slate-400 dark:placeholder:text-slate-600
                  focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition" />
            </div>
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700/60 shadow-sm overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-24 text-slate-400 text-sm gap-2">
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                جارٍ التحميل…
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-24 gap-3">
                <p className="text-red-500 text-sm">{error}</p>
                <button onClick={loadStaff} className="text-xs px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 transition">إعادة المحاولة</button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700/60">
                      {['#','الموظف','البريد الإلكتروني','الدور','الحالة','الحضور','العمولة','الإجراءات'].map(h => (
                        <th key={h} className="text-right text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide px-5 py-4 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filtered.length === 0 ? (
                      <tr><td colSpan={8} className="text-center py-16 text-slate-400 text-sm">{search?'لا توجد نتائج مطابقة':'لا يوجد موظفون — أضف أول موظف'}</td></tr>
                    ) : filtered.map((m, idx) => (
                      <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="px-5 py-4 text-slate-400 dark:text-slate-600 tabular-nums">{idx+1}</td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-indigo-100 dark:bg-indigo-900/60 flex items-center justify-center shrink-0 text-indigo-700 dark:text-indigo-300 text-sm font-bold">{initials(m)}</div>
                            <span className="font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">{displayName(m)}</span>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-slate-500 dark:text-slate-400 whitespace-nowrap">{m.email}</td>
                        <td className="px-5 py-4">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold
                            ${m.role==='admin'?'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
                              :m.role==='media_buyer'?'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                              :'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'}`}>
                            {m.role==='admin'?'مدير':m.role==='media_buyer'?'ميديا باير':'وكيل'}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          {(() => {
                            const online = isOnline(m.last_active_at);
                            const title = m.last_active_at
                              ? `آخر نشاط: ${new Date(m.last_active_at).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}`
                              : 'لم يسجّل دخوله بعد';
                            return (
                              <span
                                title={title}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold
                                  ${online
                                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                    : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-500 animate-pulse' : 'bg-red-400'}`}/>
                                {online ? 'نشط' : 'غير نشط'}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-5 py-4">
                          {m.role==='agent' ? (
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold
                              ${m.is_absent?'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300':'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${m.is_absent?'bg-red-500':'bg-emerald-500 animate-pulse'}`}/>
                              {m.is_absent?'غائب':'حاضر'}
                            </span>
                          ) : <span className="text-xs text-slate-300 dark:text-slate-700">—</span>}
                        </td>
                        <td className="px-5 py-4">
                          {m.role === 'agent' && (toN(m.comm_confirmed) > 0 || toN(m.comm_delivered) > 0 || toN(m.comm_rejected) > 0 || toN(m.comm_no_answer) > 0) ? (
                            <div className="flex flex-col gap-0.5">
                              {toN(m.comm_confirmed)  > 0 && <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400">تأكيد: {toN(m.comm_confirmed)} ج.م</span>}
                              {toN(m.comm_delivered)  > 0 && <span className="text-[10px] font-bold text-teal-700 dark:text-teal-400">توصيل: +{toN(m.comm_delivered)} ج.م</span>}
                              {toN(m.comm_rejected)   > 0 && <span className="text-[10px] font-bold text-red-600 dark:text-red-400">رفض: {toN(m.comm_rejected)} ج.م</span>}
                              {toN(m.comm_no_answer)  > 0 && <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400">لا يرد: {toN(m.comm_no_answer)} ج.م</span>}
                            </div>
                          ) : <span className="text-xs text-slate-300 dark:text-slate-700">—</span>}
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2">
                            {m.role==='agent' && (
                              <button onClick={() => handleToggleAttendance(m)} disabled={togglingId===m.id}
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 disabled:opacity-60
                                  ${m.is_absent?'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm':'bg-red-100 hover:bg-red-200 text-red-700 dark:bg-red-900/40 dark:hover:bg-red-900/60 dark:text-red-300'}`}>
                                {togglingId===m.id ? <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                                  : m.is_absent ? <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
                                  : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/></svg>}
                                {m.is_absent?'تسجيل حضور':'تسجيل غياب'}
                              </button>
                            )}
                            <button onClick={() => openEdit(m)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 dark:hover:text-indigo-400 transition-all">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                              </svg>
                            </button>

                            {/* Delete — hidden for the current user and the founding admin (the system owner) */}
                            {String(m.id) !== String(currentUserId) && String(m.id) !== String(ownerAdminId) && (
                              <button
                                onClick={() => handleDelete(m)}
                                disabled={deletingId === m.id}
                                title="حذف الموظف"
                                className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 dark:hover:text-red-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                                {deletingId === m.id ? (
                                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                                  </svg>
                                ) : (
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                                  </svg>
                                )}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!loading && !error && filtered.length > 0 && (
              <div className="border-t border-slate-100 dark:border-slate-800 px-5 py-3 text-xs text-slate-400 dark:text-slate-600">
                عرض {filtered.length} من {staff.length} موظف
              </div>
            )}
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB 2 — ANALYTICS
          ══════════════════════════════════════════════════════ */}
      {activeTab === 'analytics' && (
        <div className="space-y-6">

          {/* Date preset pills + inline custom pickers */}
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map(p => (
              <button key={p.key} onClick={() => handleAPreset(p.key)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-150
                  ${aPreset===p.key?'bg-indigo-600 text-white shadow-sm':'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}`}>
                {p.label}
              </button>
            ))}
            {aPreset === 'custom' && (
              <>
                <span className="text-slate-300 dark:text-slate-600 text-sm select-none">|</span>
                <input type="date" value={aCustomStart} dir="ltr"
                  onChange={e => {
                    const v = e.target.value;
                    setACustomStart(v);
                    if (v && aCustomEnd) loadAnalytics(v, aCustomEnd);
                  }}
                  className="border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-sm outline-none bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-indigo-400 transition"/>
                <span className="text-xs text-slate-400 dark:text-slate-500 select-none">→</span>
                <input type="date" value={aCustomEnd} dir="ltr"
                  onChange={e => {
                    const v = e.target.value;
                    setACustomEnd(v);
                    if (aCustomStart && v) loadAnalytics(aCustomStart, v);
                  }}
                  className="border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-sm outline-none bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-indigo-400 transition"/>
              </>
            )}
          </div>

          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard label="إجمالي الطلبات" value={aTotals.assigned.toLocaleString()} sub={`من ${ranked.length} موظف`} accent="indigo"
              icon={<svg className="w-5 h-5 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>}/>
            <KpiCard label="متوسط معدل التأكيد" value={`${avgConfirmRate}%`} sub={`${aTotals.confirmed.toLocaleString()} طلب مؤكد`} accent="emerald"
              icon={<svg className="w-5 h-5 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>}/>
            <KpiCard label="إجمالي العمولات" value={fmtMoney(aTotals.commission)} sub={`${aTotals.delivered.toLocaleString()} توصيل مكتمل`} accent="amber"
              icon={<svg className="w-5 h-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>}/>
            <KpiCard label="تحت المراقبة (NDR>25%)" value={flagged===0?'لا أحد ✓':`${flagged} موظف`} sub={flagged>0?'يستوجب المراجعة الفورية':'جميع المعدلات طبيعية'} accent={flagged>0?'red':'slate'}
              icon={<svg className={`w-5 h-5 ${flagged>0?'text-red-600 dark:text-red-400':'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>}/>
          </div>

          {/* Leaderboard table */}
          {aLoading ? (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 flex items-center justify-center py-20">
              <svg className="w-8 h-8 animate-spin text-indigo-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
              {flagged > 0 && (
                <div className="flex items-center gap-2.5 px-5 py-3 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-400 text-xs font-medium">
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                  تنبيه: {flagged} موظف يتخطى معدل المرتجعات نسبة 25% — مؤشر محتمل لتأكيد طلبات وهمية. راجع السجلات فوراً.
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                    <tr>
                      {['#','الموظف','إجمالي','معدل التأكيد','عدم الرد','الرفض','تم التوصيل','المرتجعات','قيمة العمولة','عمولة الفترة','الرصيد المتبقي الإجمالي'].map(h => (
                        <th key={h} className="px-4 py-3.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {ranked.length === 0 ? (
                      <tr><td colSpan={11} className="text-center py-12 text-slate-400 text-sm">لا توجد بيانات للفترة المحددة</td></tr>
                    ) : ranked.map((agent, i) => {
                      const total = toN(agent.total_assigned), confirmed = toN(agent.status_confirmed);
                      const noAns     = toN(agent.status_no_answer);   // لا يرد only
                      const postponed = toN(agent.status_postponed);   // مؤجل only
                      const cancelled = toN(agent.status_cancelled);
                      const delivered = toN(agent.status_delivered), returned = toN(agent.status_returned);
                      const newOrd = toN(agent.status_new);
                      const ndr = agent.ndr_pct !== null ? parseFloat(agent.ndr_pct as string) : null;
                      const commission = toN(agent.earned_commission);
                      const ndrFlagged = ndr !== null && ndr > 25;
                      const cPct = pct(confirmed, total), nPct = pct(noAns + postponed, total), xPct = pct(cancelled, total);
                      // Deliveries/Returns % are measured against CONFIRMED orders
                      // (the only ones sent to shipping), NOT total assigned.
                      // pct() returns 0 when the denominator is 0 (confirm === 0).
                      const dPct = pct(delivered, confirmed), rPct = pct(returned, confirmed);
                      const isExpanded = expandedAgentId === agent.agent_id;
                      // Synthetic "غير محدد" bucket (orphaned / admin-assigned orders)
                      // — a summary row, not a real person: no commission/payout actions.
                      const isUnassigned = agent.agent_email === 'unassigned@system';

                      /* ── accordion content helpers ── */
                      const cc = toN(agent.comm_confirmed), cd = toN(agent.comm_delivered);
                      const cr = toN(agent.comm_rejected),  cn = toN(agent.comm_no_answer);
                      const hasMatrix = cc > 0 || cd > 0 || cr > 0 || cn > 0;
                      const inTransit = Math.max(confirmed - delivered - returned, 0);
                      const segments = [
                        { label:'مؤكد (قيد التوصيل)', count:inTransit, color:'bg-emerald-500',                  dot:'bg-emerald-500' },
                        { label:'تم التوصيل',          count:delivered, color:'bg-teal-500',                    dot:'bg-teal-500' },
                        { label:'تم الرفض',            count:cancelled, color:'bg-red-500',                     dot:'bg-red-500' },
                        { label:'لا يرد',              count:noAns,     color:'bg-amber-500',                   dot:'bg-amber-500' },
                        { label:'مؤجل',                count:postponed, color:'bg-yellow-400',                  dot:'bg-yellow-400' },
                        { label:'مرتجع',               count:returned,  color:'bg-orange-500',                  dot:'bg-orange-500' },
                        { label:'جديد',                count:newOrd,    color:'bg-slate-300 dark:bg-slate-600', dot:'bg-slate-400' },
                      ].filter(s => s.count > 0);

                      return (
                        <React.Fragment key={agent.agent_id}>
                        <tr
                          className={`transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40 ${ndrFlagged?'bg-red-50/60 dark:bg-red-950/20':''} ${isExpanded?'border-b-0':''}`}>
                          <td className="px-4 py-3.5"><div className="flex justify-center">{isUnassigned ? <span className="text-slate-300 dark:text-slate-700 text-base leading-none">•</span> : <Rank n={i+1}/>}</div></td>
                          <td
                            className="px-4 py-3.5 cursor-pointer group/nameCell hover:bg-indigo-50/60 dark:hover:bg-indigo-950/20 transition-colors select-none"
                            onClick={() => setExpandedAgentId(isExpanded ? null : agent.agent_id)}
                            title={isExpanded ? 'إخفاء التفاصيل' : 'عرض التفاصيل'}
                          >
                            <div className="flex items-center gap-2.5">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold
                                ${isUnassigned?'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
                                :i===0?'bg-amber-100 text-amber-700 ring-2 ring-amber-300 dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-700'
                                :i===1?'bg-slate-200 text-slate-600 ring-2 ring-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:ring-slate-600'
                                :i===2?'bg-orange-100 text-orange-700 ring-2 ring-orange-300 dark:bg-orange-900/40 dark:text-orange-400 dark:ring-orange-700'
                                :'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400'}`}>
                                {(agent.agent_name?.[0]??'A').toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate max-w-[130px]
                                    group-hover/nameCell:text-indigo-600 dark:group-hover/nameCell:text-indigo-400 transition-colors">
                                    {agent.agent_name}
                                  </p>
                                  {!agent.is_active && <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-600">غير نشط</span>}
                                </div>
                                <p className="text-[11px] text-slate-400 dark:text-slate-600 truncate max-w-[160px] flex items-center gap-1">
                                  {isUnassigned ? 'طلبات غير مُسندة لموظف' : agent.agent_email}
                                  <svg className={`w-2.5 h-2.5 shrink-0 transition-transform duration-200 ${isExpanded?'rotate-180 opacity-60':'opacity-0 group-hover/nameCell:opacity-40'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                                  </svg>
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3.5"><span className="text-base font-bold text-slate-800 dark:text-slate-200">{total.toLocaleString()}</span></td>
                          <td className="px-4 py-3.5 min-w-[130px]">
                            <div className="flex items-center justify-between gap-1 text-xs font-bold">
                              <span className={cPct>=60?'text-emerald-600 dark:text-emerald-400':cPct>=40?'text-amber-600 dark:text-amber-400':total===0?'text-slate-300 dark:text-slate-700':'text-red-500 dark:text-red-400'}>{total===0?'—':`${cPct}%`}</span>
                              <span className="text-[10px] text-slate-400 font-normal">{confirmed}</span>
                            </div>
                            {total>0 && <Bar value={cPct} color={cPct>=60?'emerald':cPct>=40?'amber':'red'}/>}
                          </td>
                          <td className="px-4 py-3.5 min-w-[110px]">
                            <div className="flex items-center justify-between gap-1 text-xs font-semibold">
                              <span className={nPct>40?'text-amber-600 dark:text-amber-400':'text-slate-600 dark:text-slate-400'}>{total===0?'—':`${nPct}%`}</span>
                              <span className="text-[10px] text-slate-400 font-normal">{noAns + postponed}</span>
                            </div>
                            {total>0 && <Bar value={nPct} color={nPct>40?'amber':'slate'}/>}
                          </td>
                          <td className="px-4 py-3.5 min-w-[110px]">
                            <div className="flex items-center justify-between gap-1 text-xs font-semibold">
                              <span className={xPct>30?'text-red-500 dark:text-red-400':'text-slate-600 dark:text-slate-400'}>{total===0?'—':`${xPct}%`}</span>
                              <span className="text-[10px] text-slate-400 font-normal">{cancelled}</span>
                            </div>
                            {total>0 && <Bar value={xPct} color={xPct>30?'red':'slate'}/>}
                          </td>
                          {/* ── Deliveries (تم التوصيل) — count + % of cohort ── */}
                          <td className="px-4 py-3.5 min-w-[120px]">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-sm font-bold text-slate-800 dark:text-slate-200 tabular-nums whitespace-nowrap">
                                {delivered.toLocaleString()}<span className="text-[10px] font-normal text-slate-400 mr-0.5">طلب</span>
                              </span>
                              <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-md tabular-nums shrink-0
                                ${delivered>0?'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400':'text-slate-300 dark:text-slate-700'}`}>
                                {confirmed===0?'—':`${dPct}%`}
                              </span>
                            </div>
                            {confirmed>0 && <Bar value={dPct} color="emerald"/>}
                            {confirmed>0 && inTransit>0 && (
                              <span className="block text-[9px] text-slate-400 dark:text-slate-600 mt-1 tabular-nums">
                                {inTransit} قيد التوصيل
                              </span>
                            )}
                          </td>

                          {/* ── Returns (المرتجعات) — count + % of confirmed ── */}
                          <td className="px-4 py-3.5 min-w-[120px]">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-sm font-bold text-slate-800 dark:text-slate-200 tabular-nums whitespace-nowrap flex items-center gap-1">
                                {returned.toLocaleString()}<span className="text-[10px] font-normal text-slate-400 mr-0.5">طلب</span>
                                {ndrFlagged && <span className="text-xs animate-pulse" title={ndr!==null?`NDR ${ndr}% — مرتفع`:'NDR مرتفع'}>🚩</span>}
                              </span>
                              <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-md tabular-nums shrink-0
                                ${ndrFlagged?'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                                  :returned>0?'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                                  :'text-slate-300 dark:text-slate-700'}`}>
                                {confirmed===0?'—':`${rPct}%`}
                              </span>
                            </div>
                            {confirmed>0 && <Bar value={rPct} color={ndrFlagged?'red':'amber'}/>}
                          </td>

                          {/* ── Commission settings button (not for the synthetic row) ── */}
                          <td className="px-4 py-3.5" onClick={e => e.stopPropagation()}>
                            {isUnassigned ? (
                              <span className="text-xs text-slate-300 dark:text-slate-700">—</span>
                            ) : (
                              <button
                                onClick={() => openCommModal(agent)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium
                                  text-amber-700 dark:text-amber-400
                                  bg-amber-50 dark:bg-amber-900/20
                                  border border-amber-200 dark:border-amber-700/50
                                  hover:bg-amber-100 dark:hover:bg-amber-900/40
                                  transition-all whitespace-nowrap"
                              >
                                <span>⚙️</span>
                                إعدادات العمولة
                              </button>
                            )}
                          </td>

                          {/* ── Commission earned (matrix math) ── */}
                          <td className="px-4 py-3.5">
                            {(() => {
                              const parts: string[] = [];
                              if (cc > 0) parts.push(`(${confirmed} تأكيد × ${cc})`);
                              if (cd > 0) parts.push(`(${delivered} توصيل × ${cd})`);
                              if (cr > 0) parts.push(`(${cancelled} رفض × ${cr})`);
                              if (cn > 0) parts.push(`(${noAns + postponed} لا يرد/مؤجل × ${cn})`);
                              return commission > 0 ? (
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-xs font-bold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700/50 px-2.5 py-1 rounded-xl whitespace-nowrap">
                                    {fmtMoney(commission)}
                                  </span>
                                  {parts.length > 0 && (
                                    <span className="text-[10px] text-slate-400 dark:text-slate-600 pr-1 leading-snug">
                                      {parts.join(' + ')}
                                    </span>
                                  )}
                                </div>
                              ) : <span className="text-xs text-slate-300 dark:text-slate-700">—</span>;
                            })()}
                          </td>

                          {/* ── Global Outstanding Balance + Payout (Employee Ledger) ── */}
                          <td className="px-4 py-3.5" onClick={e => e.stopPropagation()}>
                            {isUnassigned ? (
                              <span className="text-xs text-slate-300 dark:text-slate-700">—</span>
                            ) : (() => {
                              const lifetime    = toN(agent.lifetime_commission);
                              const paid        = toN(agent.total_paid);
                              const outstanding = toN(agent.outstanding_balance);
                              const settled     = outstanding <= 0.009;
                              return (
                                <div className="flex flex-col gap-1.5 min-w-[150px]">
                                  <span className={`text-sm font-black tabular-nums ${settled?'text-emerald-600 dark:text-emerald-400':'text-rose-600 dark:text-rose-400'}`}>
                                    {fmtMoney(outstanding)}
                                  </span>
                                  <span className="text-[10px] text-slate-400 dark:text-slate-600 leading-snug whitespace-nowrap">
                                    إجمالي {fmtMoney(lifetime)} − مدفوع {fmtMoney(paid)}
                                  </span>
                                  <button
                                    onClick={() => openPayoutModal(agent)}
                                    disabled={settled}
                                    className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap
                                      ${settled
                                        ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'
                                        : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm'}`}
                                  >
                                    💸 {settled ? 'مُسدَّد بالكامل' : 'تسديد'}
                                  </button>
                                </div>
                              );
                            })()}
                          </td>
                        </tr>

                        {/* ── Accordion detail row ── */}
                        {isExpanded && (
                          <tr key={`${agent.agent_id}-detail`} className="bg-slate-50/60 dark:bg-slate-800/30 border-b border-slate-100 dark:border-slate-800/60">
                            <td colSpan={11} className="px-6 py-5">

                              {/* ── Stacked distribution bar (top) ── */}
                              {total > 0 ? (
                                <div className="mb-5 space-y-2">
                                  <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 tracking-wide">توزيع الطلبات</p>
                                  <div className="h-3 w-full rounded-full overflow-hidden flex bg-slate-200 dark:bg-slate-700">
                                    {segments.map(s => (
                                      <div key={s.label} className={`h-full transition-all duration-700 ${s.color}`}
                                        style={{ width:`${(s.count/total)*100}%` }}
                                        title={`${s.label}: ${s.count} (${Math.round((s.count/total)*100)}%)`}/>
                                    ))}
                                  </div>
                                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                                    {segments.map(s => (
                                      <div key={s.label} className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                                        <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`}/>
                                        <span>{s.label}</span>
                                        <span className="font-bold text-slate-700 dark:text-slate-300 tabular-nums">{s.count}</span>
                                        <span className="text-slate-400 dark:text-slate-600">({Math.round((s.count/total)*100)}%)</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <p className="text-center text-sm text-slate-400 dark:text-slate-600 py-2 mb-4">لا توجد طلبات في هذه الفترة</p>
                              )}

                              {/* ── 3-card metrics grid ── */}
                              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">

                                {/* ── Card 1: مسار النجاح ── */}
                                <div className="bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200/70 dark:border-emerald-800/40 rounded-xl p-4 space-y-3.5">
                                  <div className="flex items-center gap-2 pb-2.5 border-b border-emerald-200/60 dark:border-emerald-800/30">
                                    <span className="text-sm">✅</span>
                                    <div>
                                      <p className="text-xs font-bold text-emerald-800 dark:text-emerald-300">مسار النجاح</p>
                                      <p className="text-[10px] text-emerald-600/80 dark:text-emerald-500/60">إحصائيات الإنجاز</p>
                                    </div>
                                  </div>
                                  {/* المستلم */}
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-slate-600 dark:text-slate-300 font-medium">المستلم (إجمالي)</span>
                                    <span className="text-xl font-black text-indigo-600 dark:text-indigo-400 tabular-nums">{total.toLocaleString()}</span>
                                  </div>
                                  {/* التأكيد */}
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-slate-600 dark:text-slate-300 font-medium">التأكيد</span>
                                      <div className="flex items-center gap-2">
                                        <span className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{confirmed}</span>
                                        <span className="text-[11px] font-black text-emerald-600 dark:text-emerald-400 tabular-nums w-9 text-right">{pct(confirmed,total)}%</span>
                                      </div>
                                    </div>
                                    <div className="h-2 w-full bg-emerald-100 dark:bg-emerald-900/40 rounded-full overflow-hidden">
                                      <div className="h-full bg-emerald-500 rounded-full transition-all duration-700" style={{ width:`${Math.min(pct(confirmed,total),100)}%` }}/>
                                    </div>
                                  </div>
                                  {/* تم التوصيل */}
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-slate-600 dark:text-slate-300 font-medium">تم التوصيل</span>
                                      <div className="flex items-center gap-2">
                                        <span className="font-bold text-teal-600 dark:text-teal-400 tabular-nums">{delivered}</span>
                                        <span className="text-[11px] font-black text-teal-600 dark:text-teal-400 tabular-nums w-9 text-right">{pct(delivered,total)}%</span>
                                      </div>
                                    </div>
                                    <div className="h-2 w-full bg-teal-100 dark:bg-teal-900/40 rounded-full overflow-hidden">
                                      <div className="h-full bg-teal-500 rounded-full transition-all duration-700" style={{ width:`${Math.min(pct(delivered,total),100)}%` }}/>
                                    </div>
                                  </div>
                                </div>

                                {/* ── Card 2: قيد المتابعة ── */}
                                <div className="bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/50 rounded-xl p-4 space-y-3.5">
                                  <div className="flex items-center gap-2 pb-2.5 border-b border-slate-200/60 dark:border-slate-700/40">
                                    <span className="text-sm">🔄</span>
                                    <div>
                                      <p className="text-xs font-bold text-slate-700 dark:text-slate-300">قيد المتابعة</p>
                                      <p className="text-[10px] text-slate-500/80 dark:text-slate-500/60">حالات تحتاج إعادة اتصال</p>
                                    </div>
                                  </div>
                                  {/* جديد */}
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-slate-600 dark:text-slate-300 font-medium">جديد</span>
                                      <div className="flex items-center gap-2">
                                        <span className="font-bold text-indigo-500 dark:text-indigo-400 tabular-nums">{newOrd}</span>
                                        <span className="text-[11px] font-black text-indigo-500 dark:text-indigo-400 tabular-nums w-9 text-right">{pct(newOrd,total)}%</span>
                                      </div>
                                    </div>
                                    <div className="h-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                                      <div className="h-full bg-slate-400 dark:bg-slate-500 rounded-full transition-all duration-700" style={{ width:`${Math.min(pct(newOrd,total),100)}%` }}/>
                                    </div>
                                  </div>
                                  {/* لا يرد */}
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-slate-600 dark:text-slate-300 font-medium">لا يرد</span>
                                      <div className="flex items-center gap-2">
                                        <span className="font-bold text-amber-600 dark:text-amber-400 tabular-nums">{noAns}</span>
                                        <span className="text-[11px] font-black text-amber-600 dark:text-amber-400 tabular-nums w-9 text-right">{pct(noAns,total)}%</span>
                                      </div>
                                    </div>
                                    <div className="h-2 w-full bg-amber-100 dark:bg-amber-900/40 rounded-full overflow-hidden">
                                      <div className="h-full bg-amber-400 rounded-full transition-all duration-700" style={{ width:`${Math.min(pct(noAns,total),100)}%` }}/>
                                    </div>
                                  </div>
                                  {/* مؤجل */}
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-slate-600 dark:text-slate-300 font-medium">مؤجل</span>
                                      <div className="flex items-center gap-2">
                                        <span className="font-bold text-yellow-600 dark:text-yellow-400 tabular-nums">{postponed}</span>
                                        <span className="text-[11px] font-black text-yellow-600 dark:text-yellow-400 tabular-nums w-9 text-right">{pct(postponed,total)}%</span>
                                      </div>
                                    </div>
                                    <div className="h-2 w-full bg-yellow-100 dark:bg-yellow-900/30 rounded-full overflow-hidden">
                                      <div className="h-full bg-yellow-400 rounded-full transition-all duration-700" style={{ width:`${Math.min(pct(postponed,total),100)}%` }}/>
                                    </div>
                                  </div>
                                </div>

                                {/* ── Card 3: مؤشرات الخطر ── */}
                                <div className={`border rounded-xl p-4 space-y-3.5 ${ndrFlagged
                                  ? 'bg-red-50/80 dark:bg-red-950/25 border-red-200/70 dark:border-red-800/40'
                                  : 'bg-orange-50/60 dark:bg-orange-950/20 border-orange-200/60 dark:border-orange-800/30'}`}>
                                  <div className={`flex items-center gap-2 pb-2.5 border-b ${ndrFlagged ? 'border-red-200/60 dark:border-red-800/30' : 'border-orange-200/50 dark:border-orange-800/20'}`}>
                                    <span className="text-sm">{ndrFlagged ? '🚩' : '⚠️'}</span>
                                    <div>
                                      <p className={`text-xs font-bold ${ndrFlagged ? 'text-red-800 dark:text-red-300' : 'text-orange-800 dark:text-orange-300'}`}>مؤشرات الخطر</p>
                                      <p className={`text-[10px] ${ndrFlagged ? 'text-red-600/80 dark:text-red-500/60' : 'text-orange-600/80 dark:text-orange-500/60'}`}>الرفض والمرتجعات</p>
                                    </div>
                                  </div>
                                  {/* الرفض */}
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-slate-600 dark:text-slate-300 font-medium">الرفض</span>
                                      <div className="flex items-center gap-2">
                                        <span className="font-bold text-red-600 dark:text-red-400 tabular-nums">{cancelled}</span>
                                        <span className="text-[11px] font-black text-red-600 dark:text-red-400 tabular-nums w-9 text-right">{pct(cancelled,total)}%</span>
                                      </div>
                                    </div>
                                    <div className="h-2 w-full bg-red-100 dark:bg-red-900/40 rounded-full overflow-hidden">
                                      <div className="h-full bg-red-500 rounded-full transition-all duration-700" style={{ width:`${Math.min(pct(cancelled,total),100)}%` }}/>
                                    </div>
                                  </div>
                                  {/* المرتجعات */}
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-slate-600 dark:text-slate-300 font-medium">المرتجعات</span>
                                      <div className="flex items-center gap-2">
                                        <span className={`font-bold tabular-nums ${ndrFlagged ? 'text-red-600 dark:text-red-400' : 'text-orange-600 dark:text-orange-400'}`}>{returned}</span>
                                        {ndr !== null && (
                                          <span className={`text-[11px] font-black tabular-nums w-10 text-right ${ndrFlagged ? 'text-red-600 dark:text-red-400' : 'text-orange-600 dark:text-orange-400'}`}>{ndr.toFixed(1)}%</span>
                                        )}
                                      </div>
                                    </div>
                                    <div className="h-2 w-full bg-orange-100 dark:bg-orange-900/40 rounded-full overflow-hidden">
                                      <div className={`h-full rounded-full transition-all duration-700 ${ndrFlagged ? 'bg-red-500' : 'bg-orange-400'}`}
                                        style={{ width:`${Math.min(ndr ?? 0, 100)}%` }}/>
                                    </div>
                                    {ndrFlagged && (
                                      <p className="text-[10px] text-red-600 dark:text-red-400 flex items-center gap-1 mt-0.5">
                                        <span>⚡</span> معدل مرتجعات مرتفع — يستوجب المراجعة الفورية
                                      </p>
                                    )}
                                  </div>
                                </div>

                                {/* ── Card 4: الفاتورة ── */}
                                {hasMatrix ? (
                                  <div className="bg-amber-50/80 dark:bg-amber-950/25 border border-amber-200/70 dark:border-amber-700/40 rounded-xl p-4 flex flex-col">
                                    <div className="flex items-center gap-2 pb-2.5 border-b border-amber-200/60 dark:border-amber-700/30 mb-3.5">
                                      <span className="text-sm">💰</span>
                                      <div>
                                        <p className="text-xs font-bold text-amber-800 dark:text-amber-300">الفاتورة</p>
                                        <p className="text-[10px] text-amber-600/80 dark:text-amber-500/60">تفصيل العمولة المستحقة</p>
                                      </div>
                                    </div>
                                    <div className="flex-1 space-y-1.5">
                                      {cc > 0 && (
                                        <div className="flex justify-between items-baseline text-xs py-1.5 border-b border-amber-100 dark:border-amber-800/20">
                                          <span className="text-slate-600 dark:text-slate-300">
                                            تأكيد <span className="font-bold text-emerald-600 dark:text-emerald-400">{confirmed}</span>
                                            <span className="text-slate-400 dark:text-slate-500"> × {cc} ج.م</span>
                                          </span>
                                          <span className="font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{(confirmed * cc).toFixed(0)} ج.م</span>
                                        </div>
                                      )}
                                      {cd > 0 && (
                                        <div className="flex justify-between items-baseline text-xs py-1.5 border-b border-amber-100 dark:border-amber-800/20">
                                          <span className="text-slate-600 dark:text-slate-300">
                                            توصيل <span className="font-bold text-teal-600 dark:text-teal-400">{delivered}</span>
                                            <span className="text-slate-400 dark:text-slate-500"> × {cd} ج.م</span>
                                          </span>
                                          <span className="font-bold text-teal-700 dark:text-teal-400 tabular-nums">+{(delivered * cd).toFixed(0)} ج.م</span>
                                        </div>
                                      )}
                                      {cr > 0 && (
                                        <div className="flex justify-between items-baseline text-xs py-1.5 border-b border-amber-100 dark:border-amber-800/20">
                                          <span className="text-slate-600 dark:text-slate-300">
                                            رفض <span className="font-bold text-red-600 dark:text-red-400">{cancelled}</span>
                                            <span className="text-slate-400 dark:text-slate-500"> × {cr} ج.م</span>
                                          </span>
                                          <span className="font-bold text-red-600 dark:text-red-400 tabular-nums">{(cancelled * cr).toFixed(0)} ج.م</span>
                                        </div>
                                      )}
                                      {cn > 0 && (
                                        <div className="flex justify-between items-baseline text-xs py-1.5 border-b border-amber-100 dark:border-amber-800/20">
                                          <span className="text-slate-600 dark:text-slate-300">
                                            متابعة <span className="font-bold text-amber-700 dark:text-amber-400">{noAns + postponed}</span>
                                            <span className="text-slate-400 dark:text-slate-500"> × {cn} ج.م</span>
                                          </span>
                                          <span className="font-bold text-amber-700 dark:text-amber-400 tabular-nums">{((noAns + postponed) * cn).toFixed(0)} ج.م</span>
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex justify-between items-center pt-3 mt-2 border-t-2 border-amber-300/60 dark:border-amber-600/40">
                                      <span className="text-xs font-bold text-amber-900 dark:text-amber-300">الإجمالي المستحق</span>
                                      <span className="text-lg font-black text-amber-700 dark:text-amber-300 tabular-nums">
                                        {commission.toFixed(0)} <span className="text-xs font-semibold">ج.م</span>
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="bg-slate-100/80 dark:bg-slate-800/50 border border-slate-200/70 dark:border-slate-700/50 rounded-xl p-4 flex flex-col items-center justify-center gap-2 text-center">
                                    <span className="text-2xl">⚙️</span>
                                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">لم يُحدَّد هيكل عمولات</p>
                                    <p className="text-[10px] text-slate-400 dark:text-slate-600">افتح «إعدادات العمولة» لتفعيل الفاتورة</p>
                                  </div>
                                )}

                              </div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {ranked.length > 0 && (
                <div className="border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                  <span className="font-bold text-slate-600 dark:text-slate-400">المجاميع:</span>
                  <span className="text-slate-700 dark:text-slate-300"><span className="font-bold text-slate-900 dark:text-white">{aTotals.assigned.toLocaleString()}</span> طلب</span>
                  <span className="text-emerald-700 dark:text-emerald-400"><span className="font-bold">{avgConfirmRate}%</span> متوسط التأكيد</span>
                  <span className="text-amber-700 dark:text-amber-400 font-bold">{fmtMoney(aTotals.commission)} إجمالي العمولات</span>
                  {flagged>0 && <span className="text-red-600 dark:text-red-400 font-bold flex items-center gap-1">🚩 {flagged} تحت المراقبة</span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          ADD / EDIT MODAL
          ══════════════════════════════════════════════════════ */}
      {/* ── Commission Settings Modal ────────────────────────── */}
      {commModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          onClick={e => { if (e.target===e.currentTarget && !commModal.saving) setCommModal(null); }}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"/>
          <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/60 w-full max-w-sm p-6 space-y-5" dir="rtl">

            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">إعدادات العمولة</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{commModal.agent.agent_name}</p>
              </div>
              <button onClick={() => !commModal.saving && setCommModal(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {/* Inputs */}
            <div className="space-y-4">
              {([
                { key:'confirmed' as const, label:'عمولة التأكيد',    desc:'تُدفع عند تأكيد الطلب',      color:'emerald', val:commModal.confirmed },
                { key:'delivered' as const, label:'بونص التوصيل',     desc:'إضافي عند وصول الطلب',       color:'teal',    val:commModal.delivered },
                { key:'rejected'  as const, label:'عمولة الرفض',      desc:'تُدفع عند رفض العميل',        color:'red',     val:commModal.rejected },
                { key:'no_answer' as const, label:'عمولة عدم الرد',   desc:'تُدفع عند لا يرد / مؤجل',    color:'amber',   val:commModal.no_answer },
              ] as const).map(f => (
                <div key={f.key}>
                  <label className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    <span>{f.label}</span>
                    <span className={`text-[10px] font-normal ${
                      f.color==='emerald'?'text-emerald-600 dark:text-emerald-500':
                      f.color==='teal'?'text-teal-600 dark:text-teal-500':
                      f.color==='amber'?'text-amber-600 dark:text-amber-500':
                      'text-red-500 dark:text-red-400'}`}>
                      {f.desc}
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number" min="0" step="0.5"
                      value={f.val}
                      onChange={e => setCommModal(m => m ? {...m, [f.key]: parseFloat(e.target.value)||0} : null)}
                      disabled={commModal.saving}
                      className={`w-full px-4 py-2.5 rounded-xl text-sm font-bold
                        bg-slate-50 dark:bg-slate-800
                        border border-slate-200 dark:border-slate-700
                        text-slate-900 dark:text-slate-100
                        outline-none disabled:opacity-60 transition
                        focus:ring-2 focus:border-transparent
                        ${f.color==='emerald'?'focus:ring-emerald-400/50':f.color==='teal'?'focus:ring-teal-400/50':f.color==='amber'?'focus:ring-amber-400/50':'focus:ring-red-400/50'}
                        [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                    />
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 dark:text-slate-500 pointer-events-none">ج.م</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Preview */}
            {(commModal.confirmed > 0 || commModal.delivered > 0 || commModal.rejected > 0 || commModal.no_answer > 0) && (
              <div className="bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-700/40 rounded-xl px-4 py-3 text-xs space-y-1">
                <p className="font-semibold text-amber-700 dark:text-amber-400 mb-1.5">مثال: 10 تأكيد · 5 توصيل · 2 رفض · 3 لا يرد</p>
                {commModal.confirmed  > 0 && <div className="flex justify-between text-slate-600 dark:text-slate-300"><span>10 تأكيد × {commModal.confirmed} ج.م</span><span className="font-bold">{(10*commModal.confirmed).toFixed(0)} ج.م</span></div>}
                {commModal.delivered  > 0 && <div className="flex justify-between text-slate-600 dark:text-slate-300"><span>5 توصيل × {commModal.delivered} ج.م</span><span className="font-bold">+{(5*commModal.delivered).toFixed(0)} ج.م</span></div>}
                {commModal.rejected   > 0 && <div className="flex justify-between text-slate-600 dark:text-slate-300"><span>2 رفض × {commModal.rejected} ج.م</span><span className="font-bold">{(2*commModal.rejected).toFixed(0)} ج.م</span></div>}
                {commModal.no_answer  > 0 && <div className="flex justify-between text-slate-600 dark:text-slate-300"><span>3 لا يرد × {commModal.no_answer} ج.م</span><span className="font-bold">{(3*commModal.no_answer).toFixed(0)} ج.م</span></div>}
                <div className="flex justify-between pt-1.5 border-t border-amber-200 dark:border-amber-700/40 font-bold text-amber-700 dark:text-amber-400">
                  <span>الإجمالي التقديري</span>
                  <span>{(10*commModal.confirmed + 5*commModal.delivered + 2*commModal.rejected + 3*commModal.no_answer).toFixed(0)} ج.م</span>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button onClick={saveCommModal} disabled={commModal.saving}
                className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold
                  bg-indigo-600 hover:bg-indigo-700 text-white shadow-md shadow-indigo-500/25
                  disabled:opacity-60 transition-all active:scale-95">
                {commModal.saving && <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>}
                {commModal.saving ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}
              </button>
              <button onClick={() => setCommModal(null)} disabled={commModal.saving}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 transition-all disabled:opacity-60">
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Payout (تسديد) modal — Employee Ledger settlement ── */}
      {payoutModal && (() => {
        const amt = parseFloat(payoutModal.amount);
        const validAmt = !isNaN(amt) && amt > 0 && amt <= payoutModal.outstanding + 0.01;
        const remainingAfter = !isNaN(amt) && amt > 0
          ? Math.max(0, payoutModal.outstanding - amt)
          : payoutModal.outstanding;
        const isPartial = validAmt && amt < payoutModal.outstanding - 0.009;
        return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          onClick={e => { if (e.target===e.currentTarget && !payoutModal.saving) setPayoutModal(null); }}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"/>
          <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/60 w-full max-w-sm p-6 space-y-5" dir="rtl">

            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">💸 تسديد عمولة</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{payoutModal.agent.agent_name}</p>
              </div>
              <button onClick={() => !payoutModal.saving && setPayoutModal(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {/* Balance summary */}
            <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/60 rounded-xl px-4 py-3 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-600 dark:text-slate-300">
                <span>إجمالي العمولات (كل الفترات)</span>
                <span className="font-bold tabular-nums">{fmtMoney(toN(payoutModal.agent.lifetime_commission))}</span>
              </div>
              <div className="flex justify-between text-slate-600 dark:text-slate-300">
                <span>إجمالي المدفوع سابقاً</span>
                <span className="font-bold tabular-nums">{fmtMoney(toN(payoutModal.agent.total_paid))}</span>
              </div>
              <div className="flex justify-between pt-1.5 border-t border-slate-200 dark:border-slate-700/60 font-bold text-rose-600 dark:text-rose-400">
                <span>الرصيد المتبقي المستحق</span>
                <span className="tabular-nums">{fmtMoney(payoutModal.outstanding)}</span>
              </div>
            </div>

            {/* Amount input — defaults to the full outstanding balance */}
            <div>
              <label className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                <span>مبلغ التسديد</span>
                <button
                  type="button"
                  onClick={() => setPayoutModal(m => m ? {...m, amount: String(m.outstanding)} : null)}
                  disabled={payoutModal.saving}
                  className="text-[10px] font-normal text-indigo-600 dark:text-indigo-400 hover:underline">
                  تسديد كامل المبلغ
                </button>
              </label>
              <div className="relative">
                <input
                  type="number" min="0" step="0.01" max={payoutModal.outstanding}
                  autoFocus
                  value={payoutModal.amount}
                  onChange={e => setPayoutModal(m => m ? {...m, amount: e.target.value} : null)}
                  disabled={payoutModal.saving}
                  className={`w-full px-4 py-2.5 rounded-xl text-base font-black
                    bg-slate-50 dark:bg-slate-800
                    border text-slate-900 dark:text-slate-100
                    outline-none disabled:opacity-60 transition
                    focus:ring-2 focus:border-transparent
                    ${validAmt || payoutModal.amount===''
                      ? 'border-slate-200 dark:border-slate-700 focus:ring-indigo-400/50'
                      : 'border-red-300 dark:border-red-700 focus:ring-red-400/50'}
                    [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 dark:text-slate-500 pointer-events-none">ج.م</span>
              </div>
              {!validAmt && payoutModal.amount !== '' && (
                <p className="text-[10px] text-red-500 dark:text-red-400 mt-1">
                  أدخل مبلغاً بين 0 و {fmtMoney(payoutModal.outstanding)}
                </p>
              )}
              {validAmt && (
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                  {isPartial
                    ? `تسديد جزئي — سيتبقّى ${fmtMoney(remainingAfter)} مستحقاً`
                    : 'تسديد كامل — سيصبح الرصيد المتبقي صفراً ✓'}
                </p>
              )}
            </div>

            {/* Optional note */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">ملاحظة (اختياري)</label>
              <input
                type="text"
                value={payoutModal.note}
                onChange={e => setPayoutModal(m => m ? {...m, note: e.target.value} : null)}
                disabled={payoutModal.saving}
                placeholder="مثال: تسديد نقدي — يونيو"
                className="w-full px-4 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-indigo-400/50 focus:border-transparent disabled:opacity-60 transition"
              />
            </div>

            {/* Actions */}
            <div className="flex gap-3">
              <button onClick={savePayoutModal} disabled={payoutModal.saving || !validAmt}
                className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold
                  bg-indigo-600 hover:bg-indigo-700 text-white shadow-md shadow-indigo-500/25
                  disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-95">
                {payoutModal.saving && <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>}
                {payoutModal.saving ? 'جارٍ التسجيل…' : `تأكيد تسديد ${validAmt ? fmtMoney(amt) : ''}`}
              </button>
              <button onClick={() => setPayoutModal(null)} disabled={payoutModal.saving}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 transition-all disabled:opacity-60">
                إلغاء
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target===e.currentTarget) closeModal(); }}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"/>
          <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/60 w-full max-w-md p-6 flex flex-col gap-5 max-h-[90vh] overflow-y-auto">

            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                {editTarget?'تعديل بيانات الموظف':'إضافة موظف جديد'}
              </h2>
              <button onClick={closeModal} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>

            {modalError && (
              <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-400 text-sm">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                {modalError}
              </div>
            )}

            <div className="flex flex-col gap-4">
              {/* Name */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">الاسم <span className="text-slate-400 font-normal">(اختياري)</span></label>
                <input type="text" value={form.name} onChange={e => setForm(f => ({...f,name:e.target.value}))} placeholder="اسم الموظف"
                  className="w-full px-4 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition"/>
              </div>
              {/* Email */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">البريد الإلكتروني <span className="text-red-500">*</span></label>
                <input type="email" value={form.email} onChange={e => setForm(f => ({...f,email:e.target.value}))} placeholder="example@domain.com" dir="ltr"
                  className="w-full px-4 py-2.5 rounded-xl text-sm text-left bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition"/>
              </div>
              {/* Password */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                  كلمة المرور {editTarget?<span className="text-slate-400 font-normal">(اتركها فارغة للإبقاء على الحالية)</span>:<span className="text-red-500">*</span>}
                </label>
                <input type="password" value={form.password} onChange={e => setForm(f => ({...f,password:e.target.value}))} placeholder={editTarget?'••••••••':'كلمة مرور (6 أحرف على الأقل)'} dir="ltr"
                  className="w-full px-4 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition"/>
              </div>
              {/* Role + Active */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">الدور</label>
                  <select value={form.role} onChange={e => setForm(f => ({...f,role:e.target.value as 'agent'|'admin'|'media_buyer'}))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition">
                    <option value="agent">وكيل تأكيد</option>
                    <option value="media_buyer">ميديا باير</option>
                    <option value="admin">مدير النظام</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">الحالة</label>
                  <select value={form.is_active?'active':'inactive'} onChange={e => setForm(f => ({...f,is_active:e.target.value==='active'}))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition">
                    <option value="active">نشط</option>
                    <option value="inactive">غير نشط</option>
                  </select>
                </div>
              </div>

              {/* Commission matrix — agents only */}
              {form.role === 'agent' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">
                    هيكل العمولات <span className="text-slate-400 font-normal">(0 = بدون عمولة)</span>
                  </label>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
                    {([
                      { key:'comm_confirmed'  as const, label:'عمولة التأكيد',  desc:'عند تأكيد الطلب',         ring:'focus:ring-emerald-400/50', val:form.comm_confirmed },
                      { key:'comm_delivered'  as const, label:'بونص التوصيل',   desc:'إضافي عند التوصيل',       ring:'focus:ring-teal-400/50',    val:form.comm_delivered },
                      { key:'comm_rejected'   as const, label:'عمولة الرفض',    desc:'عند رفض العميل',          ring:'focus:ring-red-400/50',     val:form.comm_rejected },
                      { key:'comm_no_answer'  as const, label:'عمولة عدم الرد', desc:'عند لا يرد / مؤجل',       ring:'focus:ring-amber-400/50',   val:form.comm_no_answer },
                    ] as const).map(f => (
                      <div key={f.key} className="flex items-center gap-3 px-3.5 py-2.5 bg-slate-50 dark:bg-slate-800/60">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-slate-800 dark:text-slate-200">{f.label}</p>
                          <p className="text-[10px] text-slate-400 dark:text-slate-600">{f.desc}</p>
                        </div>
                        <div className="relative w-28 shrink-0">
                          <input type="number" min="0" step="0.5" value={f.val}
                            onChange={e => setForm(frm => ({...frm, [f.key]: parseFloat(e.target.value)||0}))}
                            className={`w-full pl-8 pr-3 py-1.5 rounded-lg text-sm font-bold text-right
                              bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700
                              text-slate-900 dark:text-slate-100 outline-none focus:ring-2 ${f.ring}
                              [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                          />
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 pointer-events-none">ج.م</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Permissions — agents only */}
              {form.role === 'agent' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">صلاحيات الوصول</label>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
                    {ALL_PERMISSIONS.map(perm => {
                      const checked = form.permissions.includes(perm.key);
                      return (
                        <label key={perm.key}
                          className={`flex items-center gap-3 px-3.5 py-3 ${perm.alwaysOn?'cursor-not-allowed bg-slate-50 dark:bg-slate-800/60':'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50'} transition-colors`}>
                          <input type="checkbox" checked={checked} disabled={perm.alwaysOn}
                            onChange={e => {
                              if (perm.alwaysOn) return;
                              setForm(f => ({...f, permissions: e.target.checked ? [...f.permissions,perm.key] : f.permissions.filter(p=>p!==perm.key)}));
                            }}
                            className="w-4 h-4 rounded accent-indigo-600 shrink-0 disabled:cursor-not-allowed disabled:opacity-60"/>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className={`text-sm font-medium ${perm.alwaysOn?'text-slate-500 dark:text-slate-500':'text-slate-800 dark:text-slate-200'}`}>{perm.label}</span>
                              {perm.alwaysOn && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-medium">افتراضي</span>}
                            </div>
                            <p className="text-xs text-slate-400 dark:text-slate-600 mt-0.5">{perm.description}</p>
                          </div>
                          <div className={`w-2 h-2 rounded-full shrink-0 ${checked?'bg-indigo-500 dark:bg-indigo-400':'bg-slate-200 dark:bg-slate-700'}`}/>
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-xs text-slate-400 dark:text-slate-600 mt-1.5 pr-1">المديرون يملكون وصولاً كاملاً بغض النظر عن هذه الإعدادات.</p>
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-1">
              <button onClick={handleSave} disabled={saving}
                className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-md shadow-indigo-500/25 disabled:opacity-60 transition-all active:scale-95">
                {saving && <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>}
                {saving?'جارٍ الحفظ…':editTarget?'حفظ التعديلات':'إضافة الموظف'}
              </button>
              <button onClick={closeModal} disabled={saving}
                className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 transition-all disabled:opacity-60">
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
