'use client';

/* ════════════════════════════════════════════════════════════════════════════
   التقرير الشهري — Monthly statement (2026-11-04)
   ════════════════════════════════════════════════════════════════════════════
   The month-level half of the P&L:

       ربح الطلبات            ← EXACTLY the dashboard's «ربح الطلبات» for the same
                                 dates (same two endpoints, same formula)
     − المصاريف الثابتة        ← salaries, subscriptions, other fixed costs that
                                 BELONG to the month («يخص شهر»)
     = صافي الربح التشغيلي
     − توزيع أرباح
     = المتبقي في الشركة

   Daily «ربح الطلبات» never includes fixed costs or distributions (backend
   services/pnl.js), so nothing is counted twice. Admin only.
   ════════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  getMonthlyStatement,
  getDashboardStats,
  getProductsProfitability,
  MonthlyStatement,
  MonthlyStatementEntry,
  DashboardStats,
  ProductProfitability,
} from '@/lib/api';

/* ── Formatting ────────────────────────────────────────────────────────────── */
const fmtEGP = (n: number) => {
  const safe = Number.isFinite(n) ? Math.round(n) : 0;
  return `${safe < 0 ? '-' : ''}${Math.abs(safe).toLocaleString('en-US')} ج.م`;
};
const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
const cairoToday = () => CAIRO_DAY.format(new Date());   // YYYY-MM-DD
function shiftMonth(ym: string, n: number) {
  const [y, m] = ym.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}
function fmtMonth(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('ar-EG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function fmtDay(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
const lastDayOf = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
/* Early in a month the owner is closing LAST month; later, the running one. */
const defaultMonth = () => {
  const t = cairoToday();
  return Number(t.slice(8, 10)) < 15 ? shiftMonth(t.slice(0, 7), -1) : t.slice(0, 7);
};

/* ── Statement row ─────────────────────────────────────────────────────────── */
function Row({ sign, label, sub, amount, strong, tone }: {
  sign?: '+' | '−' | '=';
  label: string;
  sub?: string;
  amount: number;
  strong?: boolean;
  tone?: 'pos' | 'neg' | 'auto';
}) {
  const t = tone === 'auto' ? (amount < 0 ? 'neg' : 'pos') : tone;
  const amountCls = t === 'neg'
    ? 'text-rose-600 dark:text-rose-400'
    : t === 'pos' ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <div className={`flex items-start justify-between gap-3 py-2.5 ${strong ? 'border-t border-slate-200 dark:border-slate-700' : ''}`}>
      <div className="min-w-0">
        <p className={`${strong ? 'font-bold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'} text-sm`}>
          {sign && <span className={`inline-block w-4 font-bold ${sign === '+' ? 'text-emerald-600' : sign === '−' ? 'text-rose-500' : 'text-slate-400'}`}>{sign}</span>}
          {label}
        </p>
        {sub && <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-snug mr-4">{sub}</p>}
      </div>
      <span className={`whitespace-nowrap tabular-nums text-sm ${strong ? 'font-extrabold' : 'font-semibold'} ${amountCls}`} dir="ltr">
        {fmtEGP(amount)}
      </span>
    </div>
  );
}

/* Entries behind a fixed-cost / distribution line. */
function Entries({ month, entries }: { month: string; entries: MonthlyStatementEntry[] }) {
  return (
    <ul className="mt-1 mb-2 mr-4 space-y-1 border-r-2 border-slate-100 dark:border-slate-800 pr-3">
      {entries.map((e) => {
        const paidOther = e.transaction_date.slice(0, 7) !== month;
        return (
          <li key={e.id} className="flex items-start justify-between gap-3 text-xs">
            <span className="min-w-0 text-slate-600 dark:text-slate-400">
              <span className="block truncate" title={e.description ?? ''}>{e.description || '—'}</span>
              <span className={`text-[10px] ${paidOther ? 'text-sky-700 dark:text-sky-300 font-semibold' : 'text-slate-400 dark:text-slate-500'}`}>
                اتدفع {fmtDay(e.transaction_date)}{paidOther ? ` — ${fmtMonth(e.transaction_date.slice(0, 7))}` : ''}
                {e.period_defaulted ? ' · الشهر افتراضي (شهر الدفع)' : ''}
              </span>
            </span>
            <span className="whitespace-nowrap tabular-nums text-slate-700 dark:text-slate-300" dir="ltr">{fmtEGP(e.amount)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function MonthlyStatementPage() {
  const router = useRouter();
  const [month,   setMonth]   = useState<string>(defaultMonth);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [st,      setSt]      = useState<MonthlyStatement | null>(null);
  const [dash,    setDash]    = useState<DashboardStats | null>(null);
  const [prof,    setProf]    = useState<ProductProfitability[]>([]);

  /* Admin only (the API 403s everyone else anyway). */
  useEffect(() => {
    const token = localStorage.getItem('token');
    const raw   = localStorage.getItem('user');
    if (!token || !raw) { router.push('/'); return; }
    try {
      const u = JSON.parse(raw) as { role?: string; roles?: string[] };
      const isAdmin = u.role === 'admin' || (Array.isArray(u.roles) && u.roles.includes('admin'));
      if (!isAdmin) router.push('/dashboard');
    } catch { router.push('/'); }
  }, [router]);

  /* ?month=YYYY-MM deep link. */
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('month');
    if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) setMonth(m);
  }, []);

  useEffect(() => {
    let alive = true;
    const start = `${month}-01`;
    const end   = lastDayOf(month);
    setLoading(true);
    setError('');
    Promise.all([
      getMonthlyStatement(month),
      getDashboardStats(start, end),
      getProductsProfitability(start, end),
    ])
      .then(([s, d, p]) => {
        if (!alive) return;
        setSt(s.data);
        setDash(d.data);
        setProf(Array.isArray(p.data) ? p.data : []);
      })
      .catch(() => { if (alive) setError('فشل تحميل التقرير الشهري — تحقق من الاتصال بالخادم'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month]);

  /* «ربح الطلبات» — the dashboard's own formula for "all products". */
  const n = useMemo(() => {
    const ov = dash?.overview;
    const revenue  = ov?.total_revenue ?? 0;
    const ads      = ov?.total_expenses ?? 0;
    const opex     = ov?.operating_expenses ?? 0;
    const delivered = ov?.total_delivered ?? 0;
    const cogs     = prof.reduce((s, p) => s + (Number.isFinite(p.cogs) ? p.cogs : 0), 0);
    const shipping = prof.reduce((s, p) => s + (Number.isFinite(p.shipping_cost) ? (p.shipping_cost as number) : 0), 0);
    const ordersProfit = revenue - cogs - ads - shipping - opex;
    const fixed = st?.fixed.total ?? 0;
    const dist  = st?.distributions.total ?? 0;
    const operating = ordersProfit - fixed;
    const retained  = operating - dist;
    const perOrder  = delivered > 0 ? ordersProfit / delivered : 0;
    const breakEven = perOrder > 0 ? Math.ceil(fixed / perOrder) : null;
    return { revenue, ads, opex, delivered, cogs, shipping, ordersProfit, fixed, dist, operating, retained, perOrder, breakEven };
  }, [dash, prof, st]);

  const thisMonth = cairoToday().slice(0, 7);
  const tile = (label: string, value: number, sub: string) => (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${value < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`} dir="ltr">
        {loading ? '...' : fmtEGP(value)}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500 leading-snug">{sub}</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 p-4 sm:p-6" dir="rtl">
      <div className="max-w-3xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md shadow-indigo-500/20 shrink-0">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white leading-tight">التقرير الشهري</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">ربح الطلبات − المصاريف الثابتة − توزيع الأرباح</p>
          </div>
        </div>

        {/* Month picker */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-indigo-300"
          >
            → الشهر اللي فات
          </button>
          <input
            type="month"
            value={month}
            max={thisMonth}
            onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value); }}
            className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-100"
            dir="ltr"
          />
          <button
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            disabled={month >= thisMonth}
            className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-indigo-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            الشهر الجاي ←
          </button>
          {st && (
            st.provisional ? (
              <span className="mr-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-700/40"
                title="فيه طلبات من الشهر ده لسه في الشحن، ومصاريف ممكن تتسجل متأخر">
                مبدئي — الأرقام بتثبت يوم {fmtDay(st.final_from)}
              </span>
            ) : (
              <span className="mr-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-700/40">
                نهائي
              </span>
            )
          )}
        </div>

        {error && (
          <div className="px-4 py-3 rounded-xl text-sm font-medium border bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/40">
            {error}
          </div>
        )}

        {/* Headline tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {tile('ربح الطلبات', n.ordersProfit, 'نفس رقم لوحة التحكم للشهر ده')}
          {tile('صافي الربح التشغيلي', n.operating, 'بعد الرواتب والمصاريف الثابتة')}
          {tile('المتبقي في الشركة', n.retained, 'بعد توزيع الأرباح')}
        </div>

        {/* Review nudge — fixed costs still filed as daily */}
        {st && st.review.count > 0 && (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl border text-sm bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-700/40">
            <span className="flex-1 min-w-[200px] leading-snug">
              {st.review.count} مصروف ({fmtEGP(st.review.amount)}) اتدفعوا الشهر ده وشكلهم مصاريف ثابتة، لكن متسجلين
              «تشغيل يومية» — فهم جوه ربح الطلبات ومش في المصاريف الثابتة تحت.
            </span>
            <button
              onClick={() => router.push('/dashboard/treasury')}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white"
            >
              مراجعة في الخزينة
            </button>
          </div>
        )}

        {/* The statement */}
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm px-4 sm:px-5 py-3">
          <p className="text-xs font-bold text-slate-400 dark:text-slate-500 py-1">{fmtMonth(month)}</p>
          {loading && !st ? (
            <p className="py-10 text-center text-sm text-slate-400">جارٍ التحميل…</p>
          ) : (
            <>
              <Row sign="+" label="الإيرادات" sub="طلبات اتعملت الشهر ده واتسلّمت" amount={n.revenue} />
              <Row sign="−" label="تكلفة البضاعة" amount={-n.cogs} />
              <Row sign="−" label="الشحن (Bosta)" amount={-n.shipping} />
              <Row sign="−" label="الإعلانات (Meta)" amount={-n.ads} />
              <Row sign="−" label="المصاريف اليومية" sub="عمولات، تغليف، مصاريف تشغيل يومية" amount={-n.opex} />
              <Row sign="=" label="ربح الطلبات" amount={n.ordersProfit} strong tone="auto" />

              {(st?.fixed.lines ?? []).length === 0 ? (
                <Row sign="−" label="المصاريف الثابتة" sub="مفيش مصاريف ثابتة متسجلة للشهر ده" amount={0} />
              ) : (
                <>
                  <Row sign="−" label="المصاريف الثابتة" amount={-n.fixed} />
                  {st!.fixed.lines.map((l) => (
                    <details key={l.source} className="group mr-4">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-1.5 text-xs text-slate-600 dark:text-slate-400">
                        <span>
                          <span className="inline-block w-3 text-slate-400 transition-transform group-open:rotate-90">‹</span>
                          {l.label} <span className="text-slate-400">({l.count})</span>
                        </span>
                        <span className="tabular-nums whitespace-nowrap" dir="ltr">{fmtEGP(-l.amount)}</span>
                      </summary>
                      <Entries month={month} entries={l.entries} />
                    </details>
                  ))}
                </>
              )}
              <Row sign="=" label="صافي الربح التشغيلي" amount={n.operating} strong tone="auto" />

              <Row sign="−" label="توزيع أرباح" sub={(st?.distributions.count ?? 0) === 0 ? 'مفيش توزيع أرباح متسجل للشهر ده' : 'أرباح الإدارة والشركاء'} amount={-n.dist} />
              {st && st.distributions.count > 0 && (
                <details className="group mr-4">
                  <summary className="cursor-pointer list-none py-1 text-xs text-slate-500 dark:text-slate-400">
                    <span className="inline-block w-3 text-slate-400 transition-transform group-open:rotate-90">‹</span>
                    التفاصيل ({st.distributions.count})
                  </summary>
                  <Entries month={month} entries={st.distributions.entries} />
                </details>
              )}
              <Row sign="=" label="المتبقي في الشركة" amount={n.retained} strong tone="auto" />
            </>
          )}
        </div>

        {/* Break-even */}
        {!loading && n.fixed > 0 && (
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-4 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
            {n.breakEven !== null ? (
              <>
                الطلب المُسلَّم كسب في المتوسط <b dir="ltr">{fmtEGP(n.perOrder)}</b> بعد كل التكاليف اليومية — يعني الشهر ده كان محتاج
                {' '}<b>{n.breakEven.toLocaleString('en-US')}</b> طلب مُسلَّم عشان يغطي المصاريف الثابتة،
                {' '}واتسلّم فعلاً <b>{n.delivered.toLocaleString('en-US')}</b>.
              </>
            ) : (
              <>ربح الطلبات الشهر ده مش موجب، فمفيش عدد طلبات يغطي المصاريف الثابتة بالأسعار والتكاليف دي.</>
            )}
          </div>
        )}

        {/* How it is computed */}
        <div className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed space-y-1">
          <p>• الإيرادات وتكلفة البضاعة والشحن محسوبين على يوم عمل الطلب — زي لوحة التحكم بالظبط.</p>
          <p>• الإعلانات والمصاريف اليومية على يوم الدفع. الرواتب والاشتراكات والمصاريف الثابتة وتوزيع الأرباح على «يخص شهر» — وبتظهر هنا بس.</p>
          <p>• رصيد الخزينة مش بيتأثر بأي حاجة في التقرير ده.</p>
        </div>
      </div>
    </div>
  );
}
