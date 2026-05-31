'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getMyPerformance, AgentAnalytics } from '@/lib/api';

/* ── Numeric coercion (pg returns NUMERIC as string) ───────────── */
const toN = (v: string | number | null | undefined): number =>
  v == null ? 0 : parseFloat(String(v)) || 0;

/* ── Date helpers (local wall-clock, never UTC — avoids day-shift) ─── */
function todayStr(): string {
  return new Date().toLocaleDateString('en-CA');
}
function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}
function firstOfMonth(): string {
  const d = new Date();
  d.setDate(1);
  return d.toLocaleDateString('en-CA');
}

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today',     label: 'اليوم' },
  { key: 'yesterday', label: 'أمس' },
  { key: 'week',      label: 'آخر ٧ أيام' },
  { key: 'month',     label: 'هذا الشهر' },
  { key: 'all',       label: 'الكل' },
  { key: 'custom',    label: 'مخصص' },
];

function presetDates(preset: Preset): { start?: string; end?: string } {
  const today = todayStr();
  switch (preset) {
    case 'today':     return { start: today,          end: today };
    case 'yesterday': { const y = offsetDate(-1); return { start: y, end: y }; }
    case 'week':      return { start: offsetDate(-6), end: today };
    case 'month':     return { start: firstOfMonth(), end: today };
    case 'all':       return {};
    default:          return {};
  }
}

/* ── Modern analytics progress row ──────────────────────────────── */
function StatBar({
  label, value, total, color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-600 dark:text-slate-300">{label}</span>
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-bold text-gray-900 dark:text-white tabular-nums">{value}</span>
          <span className="w-11 text-left text-xs font-semibold text-gray-400 dark:text-slate-500 tabular-nums">
            {pct}%
          </span>
        </div>
      </div>
      <div className="h-2 w-full bg-gray-100 dark:bg-slate-700/60 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Main Page
══════════════════════════════════════════════════════════════════ */
export default function MyPerformancePage() {
  const router = useRouter();

  /* Auth guard — agent-only */
  const [userRole, setUserRole] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>('');

  useEffect(() => {
    try {
      const stored = localStorage.getItem('user');
      if (stored) {
        const u = JSON.parse(stored);
        setUserRole(u.role);
        setUserName(u.email?.split('@')[0] ?? '');
        if (u.role === 'admin') router.replace('/dashboard/staff');
      } else {
        router.replace('/');
      }
    } catch { router.replace('/'); }
  }, [router]);

  /* Date state */
  const [preset,      setPreset]      = useState<Preset>('month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd,   setCustomEnd]   = useState('');

  /* Analytics state */
  const [data,    setData]    = useState<AgentAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const load = useCallback(async (start?: string, end?: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await getMyPerformance(start, end);
      setData(res.data);
    } catch {
      setError('تعذّر تحميل البيانات. تحقق من الاتصال وأعد المحاولة.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userRole && userRole !== 'admin' && preset !== 'custom') {
      const { start, end } = presetDates(preset);
      load(start, end);
    }
  }, [preset, userRole, load]);

  const handleCustomApply = () => {
    if (customStart && customEnd) load(customStart, customEnd);
  };

  /* ── Derived metrics ─────────────────────────────────────────── */
  const total     = toN(data?.total_assigned);
  const confirmed = toN(data?.status_confirmed);
  const delivered = toN(data?.status_delivered);
  const returned  = toN(data?.status_returned);
  const cancelled = toN(data?.status_cancelled);
  const noAnswer  = toN(data?.status_no_answer);
  const earned    = toN(data?.earned_commission);

  /* Commission rates (per-agent matrix). Default to the business standard
     (4 ج.م / confirmed, 1 ج.م / no-answer) when a rate isn't configured. */
  const rateConfirmed = toN(data?.comm_confirmed) || 4;
  const rateNoAnswer  = toN(data?.comm_no_answer) || 1;

  const ndr         = toN(data?.ndr_pct);
  const confirmRate = total > 0 ? Math.round((confirmed / total) * 100) : 0;

  if (userRole === null || userRole === 'admin') return null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pb-16" dir="rtl">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-8 space-y-6">

        {/* ── Compact header ───────────────────────────────────────── */}
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">أدائي وعمولاتي</h1>
            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
              مرحباً، {userName} 👋 — تتبّع إنجازاتك وعمولتك لحظة بلحظة
            </p>
          </div>

          {/* Date presets */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150
                  ${preset === p.key
                    ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/30'
                    : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-400 border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom date inputs */}
        {preset === 'custom' && (
          <div className="flex items-center gap-2 flex-wrap bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl p-3">
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
              className="text-sm border border-gray-300 dark:border-slate-600 rounded-lg px-2.5 py-1.5
                bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-400/50" />
            <span className="text-gray-400 text-sm">→</span>
            <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
              className="text-sm border border-gray-300 dark:border-slate-600 rounded-lg px-2.5 py-1.5
                bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-400/50" />
            <button onClick={handleCustomApply} disabled={!customStart || !customEnd}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors">
              تطبيق
            </button>
          </div>
        )}

        {/* Loading / error */}
        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {!loading && error && (
          <div className="text-center py-10 text-red-500 dark:text-red-400 text-sm">{error}</div>
        )}

        {!loading && !error && data && (
          <>
            {/* ── Stat cards (commission math integrated) ─────────── */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

              {/* Card 1 — Total commission */}
              <div className="bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700/50 rounded-2xl p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-medium text-gray-500 dark:text-slate-400">إجمالي العمولات المستحقة</p>
                  <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-lg">💰</div>
                </div>
                <p className="text-4xl font-extrabold text-gray-900 dark:text-white tabular-nums leading-none">
                  {earned.toFixed(0)}
                  <span className="text-lg font-bold text-gray-400 dark:text-slate-500 mr-1.5">ج.م</span>
                </p>
                <p className="text-sm text-gray-500 dark:text-slate-400 mt-3 leading-relaxed">
                  (تم التأكيد × {rateConfirmed} ج.م) + (لا يرد × {rateNoAnswer} ج.م)
                </p>
              </div>

              {/* Card 2 — Confirmed orders */}
              <div className="bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700/50 rounded-2xl p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-medium text-gray-500 dark:text-slate-400">طلبات تم تأكيدها</p>
                  <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                    <svg className="w-5 h-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                </div>
                <p className="text-4xl font-extrabold text-gray-900 dark:text-white tabular-nums leading-none">{confirmed}</p>
                <div className="mt-3">
                  <span className="inline-block text-xs font-semibold px-2.5 py-1 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                    العمولة: {rateConfirmed} ج.م / طلب
                  </span>
                </div>
              </div>

              {/* Card 3 — No-answer customers */}
              <div className="bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700/50 rounded-2xl p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-medium text-gray-500 dark:text-slate-400">عملاء لا يرد (٥ محاولات)</p>
                  <div className="w-10 h-10 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                    <svg className="w-5 h-5 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                  </div>
                </div>
                <p className="text-4xl font-extrabold text-gray-900 dark:text-white tabular-nums leading-none">{noAnswer}</p>
                <div className="mt-3">
                  <span className="inline-block text-xs font-semibold px-2.5 py-1 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
                    العمولة: {rateNoAnswer} ج.م / طلب
                  </span>
                </div>
              </div>
            </div>

            {/* ── Status breakdown — analytics widget ──────────────── */}
            <div className="bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700/50 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-bold text-gray-900 dark:text-white">تفاصيل الحالات</h2>
                <span className="text-xs font-medium text-gray-400 dark:text-slate-500">
                  {total} طلب · معدل التأكيد {confirmRate}%
                </span>
              </div>

              {total === 0 ? (
                <div className="text-center py-10">
                  <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gray-100 dark:bg-slate-700/50 flex items-center justify-center text-2xl">📭</div>
                  <p className="text-gray-600 dark:text-slate-400 font-medium text-sm">لا توجد طلبات في هذه الفترة</p>
                  <p className="text-gray-400 dark:text-slate-600 text-xs mt-1">جرّب تغيير نطاق التاريخ</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <StatBar label="تم التأكيد"    value={confirmed} total={total} color="bg-emerald-500" />
                  <StatBar label="تم التوصيل"    value={delivered} total={total} color="bg-teal-500" />
                  <StatBar label="تم الرفض"      value={cancelled} total={total} color="bg-red-500" />
                  <StatBar label="لا يرد / مؤجل" value={noAnswer}  total={total} color="bg-amber-500" />
                  <StatBar label="إرجاع"          value={returned}  total={total} color="bg-orange-500" />
                </div>
              )}
            </div>

            {/* ── NDR widget ───────────────────────────────────────── */}
            {(delivered > 0 || returned > 0) && (
              <div className="bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700/50 rounded-2xl p-6 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">معدل الإرجاع (NDR)</p>
                    <p className={`text-3xl font-extrabold tabular-nums leading-none
                      ${ndr > 25 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>
                      {ndr.toFixed(1)}%
                    </p>
                  </div>
                  <div className="hidden sm:flex flex-col items-end gap-1.5 w-40">
                    <div className="w-full h-2 bg-gray-100 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-700 ${ndr > 25 ? 'bg-red-500' : 'bg-teal-500'}`}
                        style={{ width: `${Math.min(ndr, 100)}%` }} />
                    </div>
                    <span className="text-[10px] text-gray-400 dark:text-slate-500">الحد المقبول ٢٥٪</span>
                  </div>
                </div>
                {ndr > 25 && (
                  <p className="text-red-600 dark:text-red-400 text-xs mt-3">
                    معدل الإرجاع مرتفع — حاول تحسين تأكيد بيانات العميل قبل الشحن.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
