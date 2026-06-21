'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getMetaConfig,
  saveMetaConfig,
  syncMetaSpend,
  getMetaAccounts,
  createMetaAccount,
  updateMetaAccount,
  deleteMetaAccount,
  getStaff,
} from '@/lib/api';
import type { MetaConfig, MetaSyncResult, MetaAccount, StaffMember } from '@/lib/api';

/* ══════════════════════════════════════════════════════════════════════════
   Tiny helpers
   ══════════════════════════════════════════════════════════════════════════ */
function egp(n: number) {
  return new Intl.NumberFormat('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    .format(n) + ' ج.م';
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
}

/** Returns today's date as YYYY-MM-DD in local time (for date input defaults). */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ══════════════════════════════════════════════════════════════════════════
   Status badge
   ══════════════════════════════════════════════════════════════════════════ */
function StatusBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
      bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200
      dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-800/60">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      متصل
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
      bg-amber-100 text-amber-700 ring-1 ring-amber-200
      dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-800/60">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      غير مكتمل
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Dismiss-able inline alert
   ══════════════════════════════════════════════════════════════════════════ */
interface AlertProps {
  type:     'success' | 'error' | 'info';
  children: React.ReactNode;
  onDismiss?: () => void;
}
function Alert({ type, children, onDismiss }: AlertProps) {
  const s = {
    success: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-300',
    error:   'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800/50 text-rose-700 dark:text-rose-300',
    info:    'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800/50 text-blue-700 dark:text-blue-300',
  }[type];

  const Icon = {
    success: () => (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    error: () => (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    info: () => (
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  }[type];

  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${s}`}>
      <Icon />
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100 transition-opacity">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Spinner
   ══════════════════════════════════════════════════════════════════════════ */
function Spin({ cls = 'w-4 h-4' }: { cls?: string }) {
  return (
    <svg className={`${cls} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Page
   ══════════════════════════════════════════════════════════════════════════ */
export default function MetaIntegrationPage() {
  const router = useRouter();

  /* ── State ──────────────────────────────────────────────────────────── */
  const [config,       setConfig]      = useState<MetaConfig | null>(null);
  const [loadingCfg,   setLoadingCfg]  = useState(true);

  /* Config form */
  const [adAccountId,  setAdAccountId] = useState('');
  const [accessToken,  setAccessToken] = useState('');
  const [showToken,    setShowToken]   = useState(false);
  const [saving,       setSaving]      = useState(false);
  const [saveMsg,      setSaveMsg]     = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  /* Sync — no date pickers; dates are calculated automatically */
  const [syncing,      setSyncing]     = useState(false);
  const [syncResult,   setSyncResult]  = useState<MetaSyncResult | null>(null);
  const [syncError,    setSyncError]   = useState<string | null>(null);

  /* ── Multi-account state (agency mode) ──────────────────────────────── */
  const [accounts,      setAccounts]      = useState<MetaAccount[]>([]);
  const [mediaBuyers,   setMediaBuyers]   = useState<StaffMember[]>([]);
  const [editingId,     setEditingId]     = useState<number | null>(null);
  const [acctSaving,    setAcctSaving]    = useState(false);
  const [acctMsg,       setAcctMsg]       = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [acctShowToken, setAcctShowToken] = useState(false);
  /* Account form */
  const [fName,   setFName]   = useState('');
  const [fAcctId, setFAcctId] = useState('');
  const [fToken,  setFToken]  = useState('');
  const [fUserId, setFUserId] = useState<string>('');   // '' = unassigned (admin)

  const resetAcctForm = useCallback(() => {
    setEditingId(null);
    setFName(''); setFAcctId(''); setFToken(''); setFUserId('');
    setAcctShowToken(false);
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const { data } = await getMetaAccounts();
      setAccounts(data);
    } catch { /* non-admin / not ready — leave empty */ }
  }, []);

  const loadMediaBuyers = useCallback(async () => {
    try {
      const { data } = await getStaff();
      /* Accounts can only be assigned to media buyers or admins (matches the
         backend validateAssignedUser allow-list). */
      setMediaBuyers(data.filter((u) => u.role === 'media_buyer' || u.role === 'admin'));
    } catch { /* swallow */ }
  }, []);

  useEffect(() => { loadAccounts(); loadMediaBuyers(); }, [loadAccounts, loadMediaBuyers]);

  const startEditAccount = (a: MetaAccount) => {
    setEditingId(a.id);
    setFName(a.account_name);
    setFAcctId(a.ad_account_id);
    setFToken('');   // blank = keep existing token
    setFUserId(a.assigned_user_id != null ? String(a.assigned_user_id) : '');
    setAcctShowToken(false);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAcctMsg(null);
    if (!fName.trim())   { setAcctMsg({ type: 'error', text: 'اسم الحساب مطلوب' }); return; }
    if (!fAcctId.trim()) { setAcctMsg({ type: 'error', text: 'معرف حساب الإعلانات مطلوب' }); return; }
    if (editingId === null && !fToken.trim()) {
      setAcctMsg({ type: 'error', text: 'Access Token مطلوب لإضافة حساب جديد' }); return;
    }

    const assigned = fUserId === '' ? null : parseInt(fUserId, 10);
    setAcctSaving(true);
    try {
      if (editingId === null) {
        await createMetaAccount({
          account_name:     fName.trim(),
          ad_account_id:    fAcctId.trim(),
          access_token:     fToken.trim(),
          assigned_user_id: assigned,
        });
        setAcctMsg({ type: 'success', text: 'تم إضافة الحساب الإعلاني بنجاح ✓' });
      } else {
        await updateMetaAccount(editingId, {
          account_name:     fName.trim(),
          ad_account_id:    fAcctId.trim(),
          assigned_user_id: assigned,
          ...(fToken.trim() ? { access_token: fToken.trim() } : {}),   // only send if changed
        });
        setAcctMsg({ type: 'success', text: 'تم تحديث الحساب الإعلاني بنجاح ✓' });
      }
      resetAcctForm();
      await loadAccounts();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setAcctMsg({ type: 'error', text: msg || 'فشلت العملية. حاول مجدداً.' });
    } finally {
      setAcctSaving(false);
    }
  };

  const handleToggleActive = async (a: MetaAccount) => {
    try {
      await updateMetaAccount(a.id, { is_active: !a.is_active });
      await loadAccounts();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setAcctMsg({ type: 'error', text: msg || 'تعذّر تغيير حالة الحساب.' });
    }
  };

  const handleDeleteAccount = async (a: MetaAccount) => {
    if (typeof window !== 'undefined' &&
        !window.confirm(`حذف الحساب الإعلاني "${a.account_name}"؟ لن يتم حذف المصروفات المسجّلة.`)) return;
    try {
      await deleteMetaAccount(a.id);
      if (editingId === a.id) resetAcctForm();
      await loadAccounts();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setAcctMsg({ type: 'error', text: msg || 'تعذّر حذف الحساب.' });
    }
  };

  /* ── Admin guard ─────────────────────────────────────────────────── */
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || '{}');
      if (u.role !== 'admin') router.replace('/dashboard');
    } catch { router.replace('/dashboard'); }
  }, [router]);

  /* ── Load existing config ────────────────────────────────────────── */
  const loadConfig = useCallback(async () => {
    setLoadingCfg(true);
    try {
      const { data } = await getMetaConfig();
      setConfig(data);
      /* Pre-fill account ID; leave token blank (user must re-enter to change) */
      setAdAccountId(data.adAccountId || '');
    } catch {
      /* Non-fatal — page still usable without pre-fill */
    } finally {
      setLoadingCfg(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  /* ── Save config ─────────────────────────────────────────────────── */
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adAccountId.trim()) { setSaveMsg({ type: 'error', text: 'معرف حساب الإعلانات مطلوب' }); return; }
    if (!accessToken.trim()) { setSaveMsg({ type: 'error', text: 'Access Token مطلوب' }); return; }

    setSaving(true);
    setSaveMsg(null);
    try {
      await saveMetaConfig({ adAccountId: adAccountId.trim(), accessToken: accessToken.trim() });
      setSaveMsg({ type: 'success', text: 'تم حفظ بيانات Meta بنجاح ✓' });
      setAccessToken(''); // clear after save — treat like a password field
      await loadConfig(); // refresh masked preview
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveMsg({ type: 'error', text: msg || 'فشل الحفظ. حاول مجدداً.' });
    } finally {
      setSaving(false);
    }
  };

  /* ── Historical sync — covers the last 30 days to backfill meta_purchases ─
     Why 30 days?  Rows written by earlier cron runs had meta_purchases = 0
     because the purchase-extraction logic was not yet live.  Re-syncing the
     full window overwrites those rows with the correct counts.
     The sync route does a DELETE + INSERT for each (date, campaign) pair so
     running it multiple times is safe and idempotent.                         */
  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);

    /* Compute today and 30 days ago in local time (YYYY-MM-DD) */
    const now            = new Date();
    const today          = todayISO();
    const thirtyDaysAgo  = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startDate = `${thirtyDaysAgo.getFullYear()}-${String(thirtyDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(thirtyDaysAgo.getDate()).padStart(2, '0')}`;

    try {
      const { data } = await syncMetaSpend(startDate, today);
      setSyncResult(data);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSyncError(msg || 'حدث خطأ غير متوقع. تحقق من البيانات وحاول مجدداً.');
    } finally {
      setSyncing(false);
    }
  };

  /* ══════════════════════════════════════════════════════════════════
     Render
     ══════════════════════════════════════════════════════════════════ */
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 p-4 sm:p-6 lg:p-8" dir="rtl">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* ── Page header ────────────────────────────────────────────── */}
        <div className="flex items-start gap-4">
          {/* Meta-style gradient icon */}
          <div className="w-12 h-12 rounded-2xl shrink-0 flex items-center justify-center shadow-lg
            bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600
            shadow-blue-500/25 dark:shadow-blue-900/40">
            <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
              {/* Meta infinity-style mark */}
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
              الربط مع Meta Ads
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-500 mt-0.5">
              مزامنة مصروفات الإعلانات تلقائياً مع لوحة الحسابات والماليات
            </p>
          </div>
          {!loadingCfg && config && (
            <div className="mr-auto pt-1">
              <StatusBadge configured={config.isConfigured} />
            </div>
          )}
        </div>

        {/* ── Multi-account management card (agency mode) ──────────────── */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white dark:bg-slate-900 overflow-hidden">
          {/* Card header */}
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-200/60 dark:border-slate-700/40 bg-slate-50/60 dark:bg-slate-800/40">
            <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
              <svg className="w-4 h-4 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-slate-800 dark:text-slate-200">حسابات Meta الإعلانية</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-500">
                أضف عدة حسابات إعلانية واربط كل حساب بميديا باير محدد
              </p>
            </div>
            <span className="shrink-0 text-[11px] font-bold px-2.5 py-1 rounded-full
              bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
              {accounts.length} حساب
            </span>
          </div>

          {/* Accounts list */}
          <div className="px-6 py-5 space-y-3">
            {accounts.length === 0 ? (
              <p className="text-center text-xs text-slate-400 dark:text-slate-600 py-4">
                لا توجد حسابات إعلانية بعد — أضف أول حساب من النموذج أدناه.
              </p>
            ) : accounts.map((a) => (
              <div key={a.id} className={`flex items-center gap-3 p-3 rounded-xl border transition-colors
                ${a.is_active
                  ? 'border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30'
                  : 'border-slate-200/60 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-900 opacity-60'}`}>
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600
                  flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {(a.account_name || '?').trim().charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{a.account_name}</p>
                    {!a.is_active && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-500
                        dark:bg-slate-800 dark:text-slate-500">معطّل</span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-500 font-mono" dir="ltr">act_{a.ad_account_id}</p>
                  <p className="text-[11px] mt-0.5">
                    {a.assigned_user_id ? (
                      <span className="text-amber-600 dark:text-amber-400 font-semibold">
                        ⬅ {a.assigned_user_name || a.assigned_user_email || `#${a.assigned_user_id}`}
                      </span>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-600">غير مُخصَّص (المدير)</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleToggleActive(a)}
                    title={a.is_active ? 'تعطيل' : 'تفعيل'}
                    className="px-2 py-1 rounded-lg text-[11px] font-semibold
                      bg-slate-100 hover:bg-slate-200 text-slate-600
                      dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 transition">
                    {a.is_active ? 'تعطيل' : 'تفعيل'}
                  </button>
                  <button
                    onClick={() => startEditAccount(a)}
                    title="تعديل"
                    className="px-2 py-1 rounded-lg text-[11px] font-semibold
                      bg-blue-100 hover:bg-blue-200 text-blue-700
                      dark:bg-blue-900/40 dark:hover:bg-blue-900/60 dark:text-blue-300 transition">
                    تعديل
                  </button>
                  <button
                    onClick={() => handleDeleteAccount(a)}
                    title="حذف"
                    className="px-2 py-1 rounded-lg text-[11px] font-semibold
                      bg-rose-100 hover:bg-rose-200 text-rose-700
                      dark:bg-rose-900/40 dark:hover:bg-rose-900/60 dark:text-rose-300 transition">
                    حذف
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Add / edit account form */}
          <form onSubmit={handleAccountSubmit}
            className="px-6 py-5 border-t border-slate-200/60 dark:border-slate-700/40 bg-slate-50/40 dark:bg-slate-800/20 space-y-4">
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
              {editingId === null ? 'إضافة حساب إعلاني جديد' : 'تعديل الحساب الإعلاني'}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  اسم الحساب <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text" value={fName} onChange={(e) => setFName(e.target.value)}
                  placeholder="مثال: حساب أحمد الإعلاني"
                  autoComplete="off"
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-600
                    bg-white dark:bg-slate-800 text-slate-900 dark:text-white px-3 py-2 text-sm
                    focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  معرف حساب الإعلانات <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text" value={fAcctId} onChange={(e) => setFAcctId(e.target.value)}
                  placeholder="123456789012345" dir="ltr"
                  autoComplete="off" name="meta_ad_account_id" inputMode="numeric"
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-600
                    bg-white dark:bg-slate-800 text-slate-900 dark:text-white px-3 py-2 text-sm font-mono
                    focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Access Token {editingId === null && <span className="text-rose-500">*</span>}
                </label>
                <div className="relative">
                  <input
                    type={acctShowToken ? 'text' : 'password'}
                    value={fToken} onChange={(e) => setFToken(e.target.value)}
                    placeholder={editingId !== null ? 'اتركه فارغاً للإبقاء على التوكن الحالي' : 'EAAxxxxx...'}
                    dir="ltr" autoComplete="off" name="meta_access_token"
                    className="w-full rounded-xl border border-slate-200 dark:border-slate-600
                      bg-white dark:bg-slate-800 text-slate-900 dark:text-white px-3 py-2 pl-9 text-sm font-mono
                      focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                  />
                  <button type="button" onClick={() => setAcctShowToken((v) => !v)}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                    {acctShowToken ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    )}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  ربط بـ (ميديا باير)
                </label>
                <select
                  value={fUserId} onChange={(e) => setFUserId(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-600
                    bg-white dark:bg-slate-800 text-slate-900 dark:text-white px-3 py-2 text-sm
                    focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                  <option value="">— غير مُخصَّص (المدير) —</option>
                  {mediaBuyers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email}{u.role === 'admin' ? ' (مدير)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {acctMsg && (
              <Alert type={acctMsg.type} onDismiss={() => setAcctMsg(null)}>{acctMsg.text}</Alert>
            )}

            <div className="flex items-center gap-2">
              <button type="submit" disabled={acctSaving}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
                  bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm shadow-indigo-500/25
                  disabled:opacity-60 disabled:cursor-not-allowed transition">
                {acctSaving ? <Spin /> : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d={editingId === null ? 'M12 4v16m8-8H4' : 'M5 13l4 4L19 7'} />
                  </svg>
                )}
                {acctSaving ? 'جارٍ الحفظ…' : editingId === null ? 'إضافة الحساب' : 'حفظ التعديلات'}
              </button>
              {editingId !== null && (
                <button type="button" onClick={resetAcctForm}
                  className="px-4 py-2.5 rounded-xl text-sm font-semibold
                    bg-slate-100 hover:bg-slate-200 text-slate-600
                    dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 transition">
                  إلغاء
                </button>
              )}
            </div>
          </form>
        </div>

        {/* ── Configuration card (legacy single-account / migration) ───── */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white dark:bg-slate-900 overflow-hidden">
          {/* Card header */}
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-200/60 dark:border-slate-700/40 bg-slate-50/60 dark:bg-slate-800/40">
            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
              <svg className="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800 dark:text-slate-200">إعداد بيانات الاتصال</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-500">
                {config?.isConfigured
                  ? `تم الإعداد — التوكن: ${config.tokenPreview || '—'}`
                  : 'لم يتم الإعداد بعد'}
              </p>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSave} className="px-6 py-5 space-y-5">
            {/* Ad Account ID */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                معرف حساب الإعلانات
                <span className="text-rose-500 mr-0.5">*</span>
              </label>
              <input
                type="text"
                placeholder="مثال: 123456789012345"
                value={adAccountId}
                onChange={(e) => setAdAccountId(e.target.value)}
                dir="ltr"
                autoComplete="off" name="meta_ad_account_id" inputMode="numeric"
                className="w-full rounded-xl border border-slate-200 dark:border-slate-600
                  bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white
                  px-4 py-2.5 text-sm font-mono
                  focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400
                  placeholder:text-slate-400 dark:placeholder:text-slate-600"
              />
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-600">
                أدخل الرقم فقط بدون البادئة{' '}
                <code className="bg-slate-100 dark:bg-slate-700 px-1 py-0.5 rounded text-[10px]">act_</code>
              </p>
            </div>

            {/* Access Token */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                System User Access Token
                <span className="text-rose-500 mr-0.5">*</span>
              </label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  placeholder={
                    config?.isConfigured && !accessToken
                      ? `التوكن المحفوظ: ${config.tokenPreview}`
                      : 'EAAxxxxx...'
                  }
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  dir="ltr"
                  autoComplete="off" name="meta_access_token"
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-600
                    bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white
                    px-4 py-2.5 pl-12 text-sm font-mono
                    focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400
                    placeholder:text-slate-400 dark:placeholder:text-slate-600"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="absolute left-3 top-1/2 -translate-y-1/2
                    text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                  title={showToken ? 'إخفاء' : 'إظهار'}
                >
                  {showToken ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-600">
                لا تشارك هذا التوكن مع أحد. اتركه فارغاً إذا لم تريد تغيير التوكن المحفوظ.
              </p>
            </div>

            {/* Save message */}
            {saveMsg && (
              <Alert type={saveMsg.type} onDismiss={() => setSaveMsg(null)}>
                {saveMsg.text}
              </Alert>
            )}

            {/* Save button */}
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
                bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-500/25
                disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-150"
            >
              {saving ? <Spin /> : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
              {saving ? 'جاري الحفظ…' : 'حفظ الإعدادات'}
            </button>
          </form>
        </div>

        {/* ── Auto-sync status card ──────────────────────────────────── */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white dark:bg-slate-900 overflow-hidden">
          {/* Card header */}
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-200/60 dark:border-slate-700/40 bg-slate-50/60 dark:bg-slate-800/40">
            <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
              {/* Clock / cron icon */}
              <svg className="w-4 h-4 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-slate-800 dark:text-slate-200">
                المزامنة التلقائية مفعلة
              </p>
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
                تعمل تلقائياً كل 30 دقيقة — لا تحتاج إلى تدخل يدوي
              </p>
            </div>
            {/* Live cron badge */}
            <span className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full
              bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200
              dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-800/60">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Cron Job نشط
            </span>
          </div>

          <div className="px-6 py-5 space-y-4">

            {/* Cron schedule info */}
            <div className="flex items-start gap-3 p-4 rounded-xl
              bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-800/30">
              <svg className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-xs text-emerald-700 dark:text-emerald-300 leading-relaxed space-y-1">
                <p className="font-semibold">الجدول الزمني للمزامنة التلقائية</p>
                <p className="opacity-80">
                  كل مزامنة تلقائية تسحب بيانات <strong>اليوم والأمس</strong> من Meta Ads API.
                  زر المزامنة اليدوية يغطي <strong>آخر 30 يوم</strong> لاستعادة بيانات الطلبات التاريخية.
                </p>
                <p className="opacity-80">
                  المزامنة آمنة للتكرار — يتم حذف القيود القديمة للفترة واستبدالها بالأرقام الحديثة.
                </p>
              </div>
            </div>

            {/* Result alerts */}
            {syncResult && (
              <Alert type="success" onDismiss={() => setSyncResult(null)}>
                <p className="font-bold">{syncResult.message}</p>
                <p className="text-xs mt-1 opacity-80 space-y-0.5">
                  <span className="block">
                    الفترة: {syncResult.startDate} ← {syncResult.endDate}
                  </span>
                  <span className="block">
                    أيام مُدرجة: {syncResult.daysInserted} من أصل {syncResult.daysReceived} يوم مستلم
                    {' '}— إجمالي الإنفاق: {egp(syncResult.totalSpend)}
                  </span>
                  <span className="block opacity-70">
                    آخر مزامنة في {fmtTime(syncResult.synced_at)}
                  </span>
                </p>
              </Alert>
            )}
            {syncError && (
              <Alert type="error" onDismiss={() => setSyncError(null)}>
                {syncError}
              </Alert>
            )}

            {/* Single instant-sync button */}
            <button
              onClick={handleSync}
              disabled={syncing || !config?.isConfigured}
              className={`w-full flex items-center justify-center gap-3 px-6 py-3.5 rounded-xl
                text-sm font-bold transition-all duration-200
                ${config?.isConfigured
                  ? 'bg-gradient-to-l from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 text-white shadow-md shadow-indigo-500/20 dark:shadow-indigo-900/30 hover:shadow-lg hover:scale-[1.01]'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'
                }
                disabled:opacity-60 disabled:cursor-not-allowed disabled:scale-100 disabled:shadow-none`}
            >
              {syncing ? (
                <><Spin cls="w-4 h-4" /> جاري سحب البيانات من Meta…</>
              ) : (
                <>
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  مزامنة تاريخية (آخر 30 يوم)
                </>
              )}
            </button>

            {!config?.isConfigured && !loadingCfg && (
              <p className="text-center text-xs text-slate-400 dark:text-slate-600">
                أكمل إعدادات الاتصال أعلاه لتفعيل المزامنة
              </p>
            )}
          </div>
        </div>

        {/* ── Instructions card ──────────────────────────────────────── */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-200/60 dark:border-slate-700/40 bg-slate-50/60 dark:bg-slate-800/40">
            <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center">
              <svg className="w-4 h-4 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800 dark:text-slate-200">كيفية الحصول على بيانات Meta</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-500">دليل إعداد System User Token من Meta Business Manager</p>
            </div>
          </div>

          <div className="px-6 py-5">
            <ol className="space-y-4">
              {[
                {
                  step: '١',
                  title: 'افتح Meta Business Manager',
                  desc: (
                    <>
                      اذهب إلى{' '}
                      <a
                        href="https://business.facebook.com/settings"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 underline underline-offset-2 hover:no-underline"
                      >
                        business.facebook.com/settings
                      </a>
                      {' '}وقم بتسجيل الدخول بحساب المدير.
                    </>
                  ),
                },
                {
                  step: '٢',
                  title: 'أنشئ System User',
                  desc: 'من القائمة الجانبية: Users → System Users → Add. اختر دور "Admin" أو "Employee". ثم اضغط "Generate New Token".',
                },
                {
                  step: '٣',
                  title: 'اختر الصلاحيات',
                  desc: 'عند إنشاء التوكن، فعّل الصلاحية التالية على الأقل: ads_read. هذه الصلاحية تُتيح قراءة بيانات الإنفاق فقط (للقراءة فقط).',
                },
                {
                  step: '٤',
                  title: 'احصل على معرف حساب الإعلانات',
                  desc: 'من Business Manager: Ad Accounts → اختر الحساب → انسخ الرقم من الـ URL أو من صفحة الإعدادات. الرقم يبدأ بـ act_ لكن أدخله هنا بدونها.',
                },
                {
                  step: '٥',
                  title: 'أدخل البيانات وانقر "حفظ الإعدادات"',
                  desc: 'بعد الحفظ، اضغط "سحب مصروفات اليوم" للتحقق من صحة الاتصال وجلب أول بيانات.',
                },
              ].map(({ step, title, desc }) => (
                <li key={step} className="flex gap-4">
                  <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-blue-700 dark:text-blue-400 text-xs font-bold shrink-0 mt-0.5">
                    {step}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{title}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 leading-relaxed">{desc}</p>
                  </div>
                </li>
              ))}
            </ol>

            {/* Security note */}
            <div className="mt-5 flex items-start gap-3 p-4 rounded-xl
              bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30">
              <svg className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <div>
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">تنبيه أمني</p>
                <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-0.5 leading-relaxed">
                  لا تشارك System User Token مع أحد. استخدم دائماً توكناً خاصاً بهذا التطبيق بصلاحية
                  {' '}<code className="bg-amber-100 dark:bg-amber-900/50 px-1 rounded">ads_read</code>{' '}
                  فقط — تجنب استخدام التوكن الشخصي الخاص بحسابك.
                </p>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
