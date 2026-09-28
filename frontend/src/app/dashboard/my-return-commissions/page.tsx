'use client';

/*
 * ════════════════════════════════════════════════════════════════════
 *  My Commissions — عمولاتي  (Returns Reviewer)
 * ════════════════════════════════════════════════════════════════════
 *  The reviewer's personal earnings view. Every number is scoped
 *  server-side to the logged-in user (GET /api/return-collections/my-stats):
 *  returns they marked paid, what they collected, and the 30% commission
 *  booked for them.
 * ════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getMyReturnStats, userHasRole, MyReturnStats } from '@/lib/api';

const fmt = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

function StatCard({ label, value, sub, accent, icon }: {
  label: string; value: string; sub?: string; accent: string; icon: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 px-5 py-5 shadow-sm flex items-start gap-4">
      <div className="w-11 h-11 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 mb-1">{label}</p>
        <p className={`text-2xl font-bold tracking-tight ${accent}`}>{value}</p>
        {sub && <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

export default function MyReturnCommissionsPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [stats,   setStats]   = useState<MyReturnStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  /* Auth guard — Returns Reviewers only (role or the 'return_review' permission). */
  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!token || !u) { router.replace('/'); return; }
      const perms: string[] = Array.isArray(u.permissions) ? u.permissions : [];
      if (!userHasRole(u, 'returns_reviewer') && !perms.includes('return_review')) {
        router.replace('/dashboard'); return;
      }
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await getMyReturnStats();
      setStats(res.data);
    } catch {
      setError('تعذّر تحميل بيانات العمولة');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  if (!allowed) return null;

  const ratePct = Math.round((stats?.commission_rate ?? 0.30) * 100);
  const v = (s: string) => (loading ? '...' : s);

  return (
    <div className="min-h-full" dir="rtl">
      <div className="max-w-screen-lg mx-auto px-6 pt-8 pb-10 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">عمولاتي</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              أداؤك في تحصيل المرتجعات · عمولتك {ratePct}% من كل مبلغ تحصّله
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white
              rounded-xl text-sm font-semibold shadow-sm shadow-indigo-500/30 transition disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            تحديث
          </button>
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 px-4 py-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* KPI cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            label="إجمالي التحويلات"
            value={v(fmt(stats?.paid_count ?? 0))}
            sub="مرتجعات تم تحصيلها بواسطتك"
            accent="text-slate-800 dark:text-white"
            icon={<svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
          />
          <StatCard
            label="إجمالي المبالغ المُحصلة"
            value={v(`${fmt(stats?.total_collected ?? 0)} ج.م`)}
            sub="من العملاء"
            accent="text-indigo-600 dark:text-indigo-400"
            icon={<svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" /></svg>}
          />
          <StatCard
            label="عمولتي المستحقة"
            value={v(`${fmt(stats?.total_commission ?? 0)} ج.م`)}
            sub={`${ratePct}% من المبالغ المُحصلة`}
            accent="text-emerald-600 dark:text-emerald-400"
            icon={<svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
          />
        </div>

        {!loading && stats && stats.paid_count === 0 && (
          <p className="text-center text-sm text-slate-400 dark:text-slate-500 py-6">
            لم تسجّل أي تحصيل بعد — عند الضغط على «تم الدفع» في قائمة المرتجعات ستظهر عمولتك هنا.
          </p>
        )}
      </div>
    </div>
  );
}
