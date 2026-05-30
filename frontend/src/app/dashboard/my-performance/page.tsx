'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getMyPerformance, AgentAnalytics } from '@/lib/api';

/* ── Numeric coercion (pg returns NUMERIC as string) ───────────── */
const toN = (v: string | number | null | undefined): number =>
  v == null ? 0 : parseFloat(String(v)) || 0;

/* ── Date helpers ────────────────────────────────────────────────────
   IMPORTANT: always derive dates from local wall-clock time, NOT from
   toISOString() which returns the UTC date and will shift by one day
   for users east of UTC (e.g. Egypt UTC+2/+3).
   toLocaleDateString('en-CA') reliably returns YYYY-MM-DD in the
   browser's local timezone on all modern engines.                    */
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
    case 'today':     return { start: today,         end: today };
    case 'yesterday': { const y = offsetDate(-1); return { start: y, end: y }; }
    case 'week':      return { start: offsetDate(-6), end: today };
    case 'month':     return { start: firstOfMonth(), end: today };
    case 'all':       return {};
    default:          return {};
  }
}

/* ── Progress bar sub-component ─────────────────────────────────── */
function StatBar({
  label, value, total, color, sublabel,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
  sublabel?: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-600 dark:text-slate-300 font-medium">{label}</span>
        <div className="flex items-center gap-2">
          {sublabel && (
            <span className="text-slate-400 dark:text-slate-500 text-[11px]">{sublabel}</span>
          )}
          <span className="font-bold text-slate-800 dark:text-white tabular-nums">
            {value}
            <span className="text-slate-400 dark:text-slate-500 font-normal mr-1">({pct}%)</span>
          </span>
        </div>
      </div>
      <div className="h-2 w-full bg-slate-100 dark:bg-slate-700/60 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ── KPI Card ────────────────────────────────────────────────────── */
function KpiCard({
  label, value, unit, icon, accent,
}: {
  label: string;
  value: string | number;
  unit?: string;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <div className={`
      relative overflow-hidden rounded-2xl
      bg-white dark:bg-slate-800/70
      border border-slate-200/80 dark:border-slate-700/50
      shadow-sm shadow-slate-200/60 dark:shadow-none
      p-5 flex flex-col gap-3
    `}>
      {/* Glow blob */}
      <div className={`absolute -top-6 -left-6 w-24 h-24 rounded-full opacity-10 blur-2xl ${accent}`} />
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${accent} bg-opacity-15 dark:bg-opacity-20`}>
        {icon}
      </div>
      <div>
        <p className="text-slate-500 dark:text-slate-400 text-xs font-medium leading-snug mb-1">{label}</p>
        <p className="text-2xl font-black text-slate-900 dark:text-white tabular-nums leading-none">
          {value}
          {unit && <span className="text-sm font-semibold text-slate-500 dark:text-slate-400 mr-1">{unit}</span>}
        </p>
      </div>
    </div>
  );
}

/* ── Motivational message ────────────────────────────────────────── */
function MotivationalBadge({ confirmRate }: { confirmRate: number }) {
  if (confirmRate >= 80) return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700/40 text-emerald-700 dark:text-emerald-300 text-sm font-medium">
      <span className="text-lg">🏆</span>
      <span>أداء رائع! أنت في القمة. استمر على هذا المستوى المتميز</span>
    </div>
  );
  if (confirmRate >= 60) return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700/40 text-blue-700 dark:text-blue-300 text-sm font-medium">
      <span className="text-lg">💪</span>
      <span>أداء جيد! قليل من الجهد الإضافي سيضعك في المقدمة</span>
    </div>
  );
  if (confirmRate >= 40) return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 text-amber-700 dark:text-amber-300 text-sm font-medium">
      <span className="text-lg">⚡</span>
      <span>في المنتصف! لديك القدرة على التطور — ركز على نسبة التأكيد</span>
    </div>
  );
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/40 text-red-700 dark:text-red-300 text-sm font-medium">
      <span className="text-lg">🎯</span>
      <span>هيا بنا! كل طلب تؤكده هو خطوة نحو عمولة أكبر</span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Main Page
══════════════════════════════════════════════════════════════════ */
export default function MyPerformancePage() {
  const router = useRouter();

  /* Auth guard — this page is agent-only */
  const [userRole, setUserRole] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>('');

  useEffect(() => {
    try {
      const stored = localStorage.getItem('user');
      if (stored) {
        const u = JSON.parse(stored);
        setUserRole(u.role);
        setUserName(u.email?.split('@')[0] ?? '');
        if (u.role === 'admin') {
          router.replace('/dashboard/staff'); // admins see staff page instead
        }
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

  /* Load on preset change */
  useEffect(() => {
    if (userRole && userRole !== 'admin') {
      if (preset !== 'custom') {
        const { start, end } = presetDates(preset);
        load(start, end);
      }
    }
  }, [preset, userRole, load]);

  const handleCustomApply = () => {
    if (customStart && customEnd) load(customStart, customEnd);
  };

  /* Derived metrics */
  const total     = toN(data?.total_assigned);
  const confirmed = toN(data?.status_confirmed);
  const delivered = toN(data?.status_delivered);
  const returned  = toN(data?.status_returned);
  const cancelled = toN(data?.status_cancelled);
  const noAnswer  = toN(data?.status_no_answer);
  const earned = toN(data?.earned_commission);
  const cc     = toN(data?.comm_confirmed);
  const cd     = toN(data?.comm_delivered);
  const cr     = toN(data?.comm_rejected);
  const hasMatrix = cc > 0 || cd > 0 || cr > 0;
  const ndr    = toN(data?.ndr_pct);

  const confirmRate = total > 0 ? Math.round((confirmed / total) * 100) : 0;

  /* Don't render until role is confirmed */
  if (userRole === null) return null;
  if (userRole === 'admin') return null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pb-16" dir="rtl">

      {/* ── Hero header ──────────────────────────────────────────── */}
      <div className="relative overflow-hidden bg-gradient-to-bl from-indigo-600 via-violet-600 to-purple-700 px-6 pt-8 pb-10">
        {/* Decorative blobs */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2 blur-3xl" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-white/5 rounded-full translate-y-1/2 -translate-x-1/4 blur-3xl" />

        <div className="relative max-w-5xl mx-auto">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <p className="text-indigo-200 text-sm font-medium mb-1">مرحباً، {userName} 👋</p>
              <h1 className="text-white text-2xl font-black tracking-tight">أدائي وعمولاتي</h1>
              <p className="text-indigo-200/80 text-sm mt-1">تتبع إنجازاتك واحسب عمولتك في الوقت الفعلي</p>
            </div>

            {/* Commission matrix badge */}
            {hasMatrix && (
              <div className="bg-white/15 backdrop-blur-sm border border-white/20 rounded-2xl px-4 py-3 space-y-1 shrink-0">
                {cc > 0 && <p className="text-white text-xs font-semibold whitespace-nowrap">تأكيد: <span className="text-emerald-300 font-black">{cc} ج.م</span></p>}
                {cd > 0 && <p className="text-white text-xs font-semibold whitespace-nowrap">توصيل: <span className="text-teal-300 font-black">+{cd} ج.م</span></p>}
                {cr > 0 && <p className="text-white text-xs font-semibold whitespace-nowrap">رفض: <span className="text-red-300 font-black">{cr} ج.م</span></p>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Date presets ─────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 -mt-5">
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-md shadow-slate-200/80 dark:shadow-none border border-slate-200/60 dark:border-slate-700/50 p-3 flex items-center gap-2 flex-wrap">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={`
                px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-150
                ${preset === p.key
                  ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/30'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'}
              `}
            >
              {p.label}
            </button>
          ))}

          {/* Custom date inputs */}
          {preset === 'custom' && (
            <div className="flex items-center gap-2 mr-2 flex-wrap">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="text-xs border border-slate-300 dark:border-slate-600 rounded-lg px-2 py-1.5
                  bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 outline-none
                  focus:ring-2 focus:ring-indigo-400/50"
              />
              <span className="text-slate-400 text-xs">→</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="text-xs border border-slate-300 dark:border-slate-600 rounded-lg px-2 py-1.5
                  bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 outline-none
                  focus:ring-2 focus:ring-indigo-400/50"
              />
              <button
                onClick={handleCustomApply}
                disabled={!customStart || !customEnd}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40
                  text-white text-xs font-semibold rounded-xl transition-colors"
              >
                تطبيق
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Main content ─────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 mt-6 space-y-6">

        {/* Loading / error */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {!loading && error && (
          <div className="text-center py-10 text-red-500 dark:text-red-400 text-sm">{error}</div>
        )}

        {!loading && !error && data && (
          <>
            {/* ── KPI cards ─────────────────────────────────────── */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <KpiCard
                label="إجمالي الطلبات المستلمة"
                value={total}
                unit="طلب"
                accent="bg-indigo-500"
                icon={
                  <svg className="w-5 h-5 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                }
              />
              <KpiCard
                label="معدل التأكيد"
                value={`${confirmRate}%`}
                accent="bg-emerald-500"
                icon={
                  <svg className="w-5 h-5 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                }
              />
              <KpiCard
                label="إجمالي العمولات المستحقة"
                value={earned.toFixed(0)}
                unit="ج.م"
                accent="bg-amber-500"
                icon={
                  <svg className="w-5 h-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                }
              />
            </div>

            {/* ── Motivational message ──────────────────────────── */}
            {total > 0 && <MotivationalBadge confirmRate={confirmRate} />}

            {/* ── Stats breakdown ───────────────────────────────── */}
            <div className="bg-white dark:bg-slate-800/70 rounded-2xl border border-slate-200/80 dark:border-slate-700/50 shadow-sm p-6 space-y-5">
              <h2 className="text-slate-800 dark:text-white font-bold text-sm flex items-center gap-2">
                <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                تفاصيل الحالات
              </h2>

              <StatBar label="تم التأكيد"   value={confirmed} total={total} color="bg-emerald-500" />
              <StatBar label="تم التوصيل"   value={delivered} total={total} color="bg-teal-500" />
              <StatBar label="تم الرفض"      value={cancelled} total={total} color="bg-red-500" />
              <StatBar label="لا يرد / مؤجل" value={noAnswer}  total={total} color="bg-amber-500" />
              <StatBar label="إرجاع"          value={returned}  total={total} color="bg-orange-500" />
            </div>

            {/* ── NDR indicator ─────────────────────────────────── */}
            {(delivered > 0 || returned > 0) && (
              <div className={`
                rounded-2xl border p-5 flex items-start gap-4
                ${ndr > 25
                  ? 'bg-red-50 dark:bg-red-900/15 border-red-200 dark:border-red-700/40'
                  : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700/50'}
              `}>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-lg
                  ${ndr > 25 ? 'bg-red-100 dark:bg-red-900/30' : 'bg-slate-100 dark:bg-slate-700/60'}`}>
                  {ndr > 25 ? '⚠️' : '📦'}
                </div>
                <div className="flex-1">
                  <p className={`text-sm font-bold mb-0.5 ${ndr > 25 ? 'text-red-700 dark:text-red-300' : 'text-slate-700 dark:text-slate-300'}`}>
                    معدل الإرجاع (NDR)
                  </p>
                  <p className={`text-2xl font-black tabular-nums ${ndr > 25 ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-white'}`}>
                    {toN(data.ndr_pct).toFixed(1)}%
                  </p>
                  {ndr > 25 && (
                    <p className="text-red-600 dark:text-red-400 text-xs mt-1">
                      معدل الإرجاع مرتفع. حاول تحسين تأكيد بيانات العميل قبل الشحن.
                    </p>
                  )}
                </div>

                {/* Mini progress bar */}
                <div className="hidden sm:flex flex-col items-end gap-1 shrink-0">
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">الحد الأقصى المقبول</span>
                  <div className="w-32 h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${ndr > 25 ? 'bg-red-500' : 'bg-teal-500'}`}
                      style={{ width: `${Math.min(ndr, 100)}%` }}
                    />
                  </div>
                  <div className="w-32 flex justify-end">
                    <div className="w-px h-3 bg-slate-400 dark:bg-slate-500"
                      style={{ marginRight: '25%', position: 'relative' }} />
                  </div>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">25% ← الهدف</span>
                </div>
              </div>
            )}

            {/* ── Commission matrix breakdown ───────────────────── */}
            {hasMatrix && (
              <div className="bg-gradient-to-bl from-amber-50 to-yellow-50 dark:from-amber-900/15 dark:to-yellow-900/10 rounded-2xl border border-amber-200 dark:border-amber-700/40 p-5 space-y-3">
                <h2 className="text-amber-800 dark:text-amber-300 font-bold text-sm flex items-center gap-2">
                  <span className="text-base">💰</span>
                  تفاصيل العمولة
                </h2>
                {cc > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-600 dark:text-slate-300">{confirmed} تأكيد × {cc} ج.م</span>
                    <span className="font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{(confirmed * cc).toFixed(0)} ج.م</span>
                  </div>
                )}
                {cd > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-600 dark:text-slate-300">{delivered} توصيل × {cd} ج.م (بونص)</span>
                    <span className="font-bold text-teal-700 dark:text-teal-400 tabular-nums">+{(delivered * cd).toFixed(0)} ج.م</span>
                  </div>
                )}
                {cr > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-600 dark:text-slate-300">{cancelled} رفض × {cr} ج.م</span>
                    <span className="font-bold text-red-600 dark:text-red-400 tabular-nums">{(cancelled * cr).toFixed(0)} ج.م</span>
                  </div>
                )}
                <div className="pt-3 border-t border-amber-200 dark:border-amber-700/40 flex items-center justify-between">
                  <span className="text-amber-700 dark:text-amber-400 text-sm font-semibold">إجمالي عمولتك</span>
                  <span className="text-2xl font-black text-amber-800 dark:text-amber-200 tabular-nums">
                    {earned.toFixed(0)} <span className="text-sm font-semibold">ج.م</span>
                  </span>
                </div>
              </div>
            )}

            {/* Zero state */}
            {total === 0 && (
              <div className="text-center py-12">
                <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-100 dark:bg-slate-700/50 flex items-center justify-center text-3xl">
                  📭
                </div>
                <p className="text-slate-600 dark:text-slate-400 font-medium">لا توجد طلبات في هذه الفترة</p>
                <p className="text-slate-400 dark:text-slate-600 text-sm mt-1">جرّب تغيير نطاق التاريخ</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
