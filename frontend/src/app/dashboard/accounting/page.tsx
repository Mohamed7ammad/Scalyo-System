'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getAccountingOverview,
  getExpenses,
  addExpense,
} from '@/lib/api';
import type { AccountingOverview, Expense, ExpensePayload } from '@/lib/api';

/* ══════════════════════════════════════════════════════════════════════════
   Formatters
   ══════════════════════════════════════════════════════════════════════════ */
function egp(n: number): string {
  return (
    new Intl.NumberFormat('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
      .format(Math.round(n)) + ' ج.م'
  );
}

function fmtDate(dateStr: string): string {
  // Split to avoid timezone shifting (YYYY-MM-DD → local midnight)
  const [y, m, d] = dateStr.split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ar-EG', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function todayISO(): string {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local date
}

/* ══════════════════════════════════════════════════════════════════════════
   Constants
   ══════════════════════════════════════════════════════════════════════════ */
const EXPENSE_CATEGORIES = [
  'إعلانات ميتا وتيك توك',
  'تغليف ومطبوعات',
  'اشتراكات برامج',
  'مصاريف شحن',
  'أخرى',
] as const;

const CATEGORY_STYLE: Record<string, { bg: string; text: string; dot: string }> = {
  'إعلانات ميتا وتيك توك': {
    bg:   'bg-purple-100 dark:bg-purple-900/30',
    text: 'text-purple-700 dark:text-purple-300',
    dot:  'bg-purple-400',
  },
  'تغليف ومطبوعات': {
    bg:   'bg-slate-100 dark:bg-slate-700/60',
    text: 'text-slate-600 dark:text-slate-300',
    dot:  'bg-slate-400',
  },
  'اشتراكات برامج': {
    bg:   'bg-blue-100 dark:bg-blue-900/30',
    text: 'text-blue-700 dark:text-blue-300',
    dot:  'bg-blue-400',
  },
  'مصاريف شحن': {
    bg:   'bg-amber-100 dark:bg-amber-900/30',
    text: 'text-amber-700 dark:text-amber-300',
    dot:  'bg-amber-400',
  },
  'أخرى': {
    bg:   'bg-gray-100 dark:bg-gray-700/50',
    text: 'text-gray-600 dark:text-gray-300',
    dot:  'bg-gray-400',
  },
};

function catStyle(cat: string) {
  return CATEGORY_STYLE[cat] ?? CATEGORY_STYLE['أخرى'];
}

/* ══════════════════════════════════════════════════════════════════════════
   Skeleton pulse
   ══════════════════════════════════════════════════════════════════════════ */
function Pulse({ w = 'w-3/4', h = 'h-8' }: { w?: string; h?: string }) {
  return <div className={`${w} ${h} rounded-lg bg-slate-200 dark:bg-slate-700 animate-pulse`} />;
}

/* ══════════════════════════════════════════════════════════════════════════
   Net Profit Banner
   ══════════════════════════════════════════════════════════════════════════ */
interface BannerProps { data: AccountingOverview; loading: boolean }

function NetProfitBanner({ data, loading }: BannerProps) {
  const netProfit  = data.total_sales_delivered - data.total_expenses;
  const isProfit   = netProfit >= 0;
  const margin     = data.total_sales_delivered > 0
    ? ((netProfit / data.total_sales_delivered) * 100).toFixed(1)
    : '0.0';

  return (
    <div className={`relative rounded-2xl overflow-hidden border mb-6 transition-colors duration-300 ${
      isProfit
        ? 'bg-gradient-to-l from-emerald-50/80 via-teal-50/40 to-amber-50/60 dark:from-emerald-950/50 dark:via-slate-900/80 dark:to-amber-950/30 border-emerald-200/70 dark:border-emerald-800/40'
        : 'bg-gradient-to-l from-rose-50/80 via-red-50/40 to-orange-50/60 dark:from-rose-950/50 dark:via-slate-900/80 dark:to-orange-950/30 border-rose-200/70 dark:border-rose-800/40'
    }`}>
      {/* Decorative background orb */}
      <div className={`absolute -left-16 -top-16 w-48 h-48 rounded-full opacity-10 blur-3xl ${
        isProfit ? 'bg-emerald-400' : 'bg-rose-400'
      }`} />

      <div className="relative p-6">
        {/* Top row: title + margin badge */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shadow-sm ${
            isProfit
              ? 'bg-emerald-100 dark:bg-emerald-900/60'
              : 'bg-rose-100 dark:bg-rose-900/60'
          }`}>
            {isProfit ? (
              <svg className="w-5 h-5 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-rose-600 dark:text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17H5m0 0V9m0 8l8-8 4 4 6-6" />
              </svg>
            )}
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 leading-none">
              صافي الربح المبدئي
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-500 mt-0.5">
              المبيعات الموصلة − إجمالي المصروفات المسجلة
            </p>
          </div>
          <span className={`mr-auto text-[10px] font-bold px-2.5 py-1 rounded-full ring-1 ${
            isProfit
              ? 'bg-emerald-100 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/50 dark:text-emerald-400 dark:ring-emerald-800/60'
              : 'bg-rose-100 text-rose-700 ring-rose-200 dark:bg-rose-900/50 dark:text-rose-400 dark:ring-rose-800/60'
          }`}>
            تقدير مبدئي
          </span>
        </div>

        {/* Main number */}
        {loading ? (
          <div className="space-y-2 mb-5">
            <Pulse w="w-1/3" h="h-12" />
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3 mb-5">
            <p
              className={`text-5xl font-black tabular-nums leading-none tracking-tight ${
                isProfit
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-rose-600 dark:text-rose-400'
              }`}
              dir="ltr"
            >
              {isProfit ? '+' : ''}{egp(netProfit)}
            </p>
            {data.total_sales_delivered > 0 && (
              <span className={`text-sm font-semibold mb-1 tabular-nums ${
                isProfit ? 'text-emerald-500 dark:text-emerald-500' : 'text-rose-500 dark:text-rose-500'
              }`}>
                هامش {margin}%
              </span>
            )}
          </div>
        )}

        {/* Formula breakdown */}
        <div className="grid grid-cols-3 gap-2 pt-4 border-t border-slate-200/50 dark:border-slate-700/40">
          {/* Revenue */}
          <div>
            <p className="text-[10px] text-slate-500 dark:text-slate-500 mb-1 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" />
              إجمالي المبيعات
            </p>
            {loading ? <Pulse w="w-full" h="h-5" /> : (
              <p className="text-sm font-bold tabular-nums text-purple-600 dark:text-purple-400" dir="ltr">
                {egp(data.total_sales_delivered)}
              </p>
            )}
          </div>

          {/* Operator */}
          <div className="flex items-end justify-center pb-0.5">
            <span className="text-slate-300 dark:text-slate-600 text-2xl font-thin select-none">−</span>
          </div>

          {/* Expenses */}
          <div>
            <p className="text-[10px] text-slate-500 dark:text-slate-500 mb-1 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
              إجمالي المصروفات
            </p>
            {loading ? <Pulse w="w-full" h="h-5" /> : (
              <p className="text-sm font-bold tabular-nums text-rose-600 dark:text-rose-400" dir="ltr">
                {egp(data.total_expenses)}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Metric cards
   ══════════════════════════════════════════════════════════════════════════ */
type Accent = 'emerald' | 'blue' | 'amber' | 'purple';

interface CardConfig {
  accent: Accent; icon: React.ReactNode; title: string;
  subtitle: string; amount: number; count: number; note: string; loading: boolean;
}

const ACCENT: Record<Accent, Record<string, string>> = {
  emerald: {
    card:    'border-emerald-200/70 dark:border-emerald-800/40 bg-emerald-50/40 dark:bg-emerald-950/20 hover:border-emerald-300 dark:hover:border-emerald-700/60',
    top:     'bg-emerald-400/80',
    iconWrap:'bg-emerald-100 dark:bg-emerald-900/60',
    icon:    'text-emerald-600 dark:text-emerald-400',
    amount:  'text-emerald-700 dark:text-emerald-300',
    badge:   'bg-emerald-100 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-800/60',
  },
  blue: {
    card:    'border-blue-200/70 dark:border-blue-800/40 bg-blue-50/40 dark:bg-blue-950/20 hover:border-blue-300 dark:hover:border-blue-700/60',
    top:     'bg-blue-400/80',
    iconWrap:'bg-blue-100 dark:bg-blue-900/60',
    icon:    'text-blue-600 dark:text-blue-400',
    amount:  'text-blue-700 dark:text-blue-300',
    badge:   'bg-blue-100 text-blue-700 ring-blue-200 dark:bg-blue-900/40 dark:text-blue-400 dark:ring-blue-800/60',
  },
  amber: {
    card:    'border-amber-200/70 dark:border-amber-800/40 bg-amber-50/40 dark:bg-amber-950/20 hover:border-amber-300 dark:hover:border-amber-700/60',
    top:     'bg-amber-400/80',
    iconWrap:'bg-amber-100 dark:bg-amber-900/60',
    icon:    'text-amber-600 dark:text-amber-400',
    amount:  'text-amber-700 dark:text-amber-300',
    badge:   'bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-800/60',
  },
  purple: {
    card:    'border-purple-200/70 dark:border-purple-800/40 bg-purple-50/40 dark:bg-purple-950/20 hover:border-purple-300 dark:hover:border-purple-700/60',
    top:     'bg-purple-400/80',
    iconWrap:'bg-purple-100 dark:bg-purple-900/60',
    icon:    'text-purple-600 dark:text-purple-400',
    amount:  'text-purple-700 dark:text-purple-300',
    badge:   'bg-purple-100 text-purple-700 ring-purple-200 dark:bg-purple-900/40 dark:text-purple-400 dark:ring-purple-800/60',
  },
};

function MetricCard({ accent, icon, title, subtitle, amount, count, note, loading }: CardConfig) {
  const s = ACCENT[accent];
  return (
    <div className={`relative rounded-2xl border overflow-hidden transition-all duration-200 ${s.card}`}>
      <div className={`h-1 w-full ${s.top}`} />
      <div className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${s.iconWrap}`}>
            <span className={s.icon}>{icon}</span>
          </div>
          <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ring-1 ${s.badge}`}>
            {count === 0 ? 'لا توجد طلبات' : `${count} طلب`}
          </span>
        </div>
        {loading ? (
          <div className="space-y-2 mt-1"><Pulse w="w-4/5" h="h-8" /><Pulse w="w-2/5" h="h-3.5" /></div>
        ) : (
          <>
            <p className={`text-[1.65rem] font-bold tabular-nums leading-none mb-1.5 ${s.amount}`} dir="ltr">
              {egp(amount)}
            </p>
            <p className="text-[13px] font-medium text-slate-700 dark:text-slate-300 leading-snug">{title}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-500 mt-0.5">{subtitle}</p>
          </>
        )}
        <p className="mt-4 pt-3 border-t border-slate-200/60 dark:border-slate-700/40 text-[11px] text-slate-400 dark:text-slate-600 leading-relaxed">
          {note}
        </p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Cash-flow summary strip
   ══════════════════════════════════════════════════════════════════════════ */
function SummaryStrip({ data, loading }: { data: AccountingOverview; loading: boolean }) {
  const totalOutstanding = data.bosta_receivables + data.cash_in_transit;
  const totalLiquid      = data.total_deposits + data.bosta_receivables;

  const items = [
    { label: 'نقد في اليد (عربون)', value: data.total_deposits,    color: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-400' },
    { label: 'مستحق من بوسطة',      value: data.bosta_receivables, color: 'text-blue-600 dark:text-blue-400',       dot: 'bg-blue-400' },
    { label: 'قيد التحصيل',          value: data.cash_in_transit,   color: 'text-amber-600 dark:text-amber-400',     dot: 'bg-amber-400' },
    { label: 'إجمالي المستحق',        value: totalOutstanding,       color: 'text-slate-700 dark:text-slate-100',     dot: 'bg-slate-400', bold: true },
  ];

  return (
    <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white/60 dark:bg-slate-800/40 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200/60 dark:border-slate-700/40">
        <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700/60 flex items-center justify-center">
          <svg className="w-4 h-4 text-slate-500 dark:text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
              d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 11h.01M12 11h.01M15 11h.01M4 19h16a2 2 0 002-2V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">ملخص التدفق النقدي</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-500">تجميع شامل للمركز المالي الحالي</p>
        </div>
        {!loading && (
          <div className="mr-auto flex items-center gap-2 bg-slate-100 dark:bg-slate-700/60 rounded-xl px-4 py-2">
            <span className="text-[11px] text-slate-500 dark:text-slate-400">إجمالي المتاح والمستحق</span>
            <span className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100" dir="ltr">
              {egp(totalLiquid)}
            </span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-x-reverse divide-slate-200/60 dark:divide-slate-700/40">
        {items.map((item) => (
          <div key={item.label} className="px-5 py-4">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className={`w-2 h-2 rounded-full shrink-0 ${item.dot}`} />
              <span className="text-[11px] text-slate-500 dark:text-slate-500 truncate">{item.label}</span>
            </div>
            {loading ? <Pulse w="w-3/4" h="h-5" /> : (
              <p className={`text-[15px] tabular-nums ${item.bold ? 'font-extrabold' : 'font-bold'} ${item.color}`} dir="ltr">
                {egp(item.value)}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Add Expense Modal
   ══════════════════════════════════════════════════════════════════════════ */
interface ModalProps {
  onClose:  () => void;
  onSaved:  () => void;
}

function AddExpenseModal({ onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState<ExpensePayload>({
    amount:       0,
    category:     EXPENSE_CATEGORIES[0],
    description:  '',
    expense_date: todayISO(),
  });
  const [submitting, setSubmitting] = useState(false);
  const [err,        setErr]        = useState<string | null>(null);

  const set = (key: keyof ExpensePayload, val: string | number) =>
    setForm((f) => ({ ...f, [key]: val }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.amount || Number(form.amount) <= 0) {
      setErr('أدخل مبلغاً موجباً');
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      await addExpense({
        amount:       Number(form.amount),
        category:     form.category,
        description:  form.description || undefined,
        expense_date: form.expense_date || undefined,
      });
      onSaved();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setErr(msg || 'حدث خطأ أثناء الحفظ. حاول مجدداً.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" dir="rtl">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm"
        onClick={() => !submitting && onClose()}
      />

      {/* Sheet */}
      <div className="relative bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl shadow-black/20 dark:shadow-black/60 w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 dark:border-slate-700">
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-white">إضافة مصروف جديد</h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-500 mt-0.5">سيتم خصمه من صافي الربح تلقائياً</p>
          </div>
          <button
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-slate-200 dark:hover:bg-slate-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Amount */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              المبلغ <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={form.amount || ''}
                onChange={(e) => set('amount', e.target.value)}
                required
                className="w-full rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800
                  text-slate-900 dark:text-white px-4 py-2.5 pl-14 text-sm
                  focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400
                  placeholder:text-slate-400 dark:placeholder:text-slate-600"
                dir="ltr"
              />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-xs text-slate-400 dark:text-slate-500 font-medium pointer-events-none">
                ج.م
              </span>
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              التصنيف <span className="text-rose-500">*</span>
            </label>
            <select
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              required
              className="w-full rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800
                text-slate-900 dark:text-white px-4 py-2.5 text-sm
                focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400"
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              البيان <span className="text-slate-400 font-normal">(اختياري)</span>
            </label>
            <input
              type="text"
              placeholder="مثال: حملة ميتا — أغسطس، اشتراك Easy Order…"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              className="w-full rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800
                text-slate-900 dark:text-white px-4 py-2.5 text-sm
                focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400
                placeholder:text-slate-400 dark:placeholder:text-slate-600"
            />
          </div>

          {/* Date */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              التاريخ
            </label>
            <input
              type="date"
              value={form.expense_date}
              onChange={(e) => set('expense_date', e.target.value)}
              className="w-full rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800
                text-slate-900 dark:text-white px-4 py-2.5 text-sm
                focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400"
              dir="ltr"
            />
          </div>

          {/* Error */}
          {err && (
            <p className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/50 rounded-xl px-4 py-2.5">
              {err}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold
                bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm shadow-indigo-500/25
                disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-150"
            >
              {submitting ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
              {submitting ? 'جاري الحفظ…' : 'حفظ المصروف'}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400
                bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
                disabled:opacity-50 transition-all duration-150"
            >
              إلغاء
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Expenses Ledger
   ══════════════════════════════════════════════════════════════════════════ */
interface LedgerProps {
  expenses:    Expense[];
  totalExp:    number;
  loading:     boolean;
  onAdd:       () => void;
}

function ExpenseLedger({ expenses, totalExp, loading, onAdd }: LedgerProps) {
  return (
    <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white/60 dark:bg-slate-800/40 overflow-hidden">
      {/* Section header */}
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-slate-200/60 dark:border-slate-700/40">
        <div className="w-8 h-8 rounded-lg bg-rose-100 dark:bg-rose-900/40 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-rose-500 dark:text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
              d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-bold text-slate-800 dark:text-slate-200">سجل المصروفات التشغيلية</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-500">
            {expenses.length > 0 ? `${expenses.length} قيد مسجل` : 'لا توجد مصروفات مسجلة بعد'}
          </p>
        </div>

        {/* Total expenses pill */}
        {!loading && expenses.length > 0 && (
          <div className="flex items-center gap-2 bg-rose-50 dark:bg-rose-950/30 border border-rose-200/60 dark:border-rose-800/40 rounded-xl px-4 py-2">
            <span className="text-[11px] text-rose-500 dark:text-rose-400">إجمالي المصروفات</span>
            <span className="text-sm font-bold tabular-nums text-rose-700 dark:text-rose-300" dir="ltr">
              {egp(totalExp)}
            </span>
          </div>
        )}

        {/* Add button */}
        <button
          onClick={onAdd}
          className="mr-auto flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold
            bg-indigo-600 hover:bg-indigo-700 text-white
            shadow-sm shadow-indigo-500/20 transition-all duration-150"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          إضافة مصروف
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200/60 dark:border-slate-700/40 bg-slate-50/60 dark:bg-slate-900/40">
              <th className="text-right px-5 py-3 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">التاريخ</th>
              <th className="text-right px-5 py-3 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">التصنيف</th>
              <th className="text-right px-5 py-3 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">البيان</th>
              <th className="text-left px-5 py-3 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">المبلغ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-700/40">
            {loading ? (
              [...Array(3)].map((_, i) => (
                <tr key={i}>
                  {[...Array(4)].map((_, j) => (
                    <td key={j} className="px-5 py-3.5">
                      <Pulse w="w-full" h="h-4" />
                    </td>
                  ))}
                </tr>
              ))
            ) : expenses.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-5 py-14 text-center">
                  <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-700/50 flex items-center justify-center mx-auto mb-3">
                    <svg className="w-5 h-5 text-slate-400 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                        d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">لا توجد مصروفات مسجلة بعد</p>
                  <p className="text-xs text-slate-400 dark:text-slate-600 mt-1">
                    أضف مصروفاً باستخدام زر <span className="font-medium">إضافة مصروف</span> أعلاه
                  </p>
                </td>
              </tr>
            ) : (
              expenses.map((exp) => {
                const cs = catStyle(exp.category);
                return (
                  <tr key={exp.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-700/20 transition-colors duration-100">
                    <td className="px-5 py-3.5 text-sm text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {fmtDate(exp.expense_date)}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full ${cs.bg} ${cs.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${cs.dot}`} />
                        {exp.category}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-sm text-slate-600 dark:text-slate-400 max-w-[240px] truncate">
                      {exp.description || <span className="text-slate-300 dark:text-slate-600">—</span>}
                    </td>
                    <td className="px-5 py-3.5 text-sm font-bold tabular-nums text-rose-600 dark:text-rose-400 text-left whitespace-nowrap" dir="ltr">
                      {egp(parseFloat(String(exp.amount)))}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>

          {/* Footer total row */}
          {!loading && expenses.length > 1 && (
            <tfoot>
              <tr className="border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/50">
                <td colSpan={3} className="px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 text-right">
                  الإجمالي ({expenses.length} قيد)
                </td>
                <td className="px-5 py-3 text-sm font-black tabular-nums text-rose-700 dark:text-rose-300 text-left" dir="ltr">
                  {egp(totalExp)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Page
   ══════════════════════════════════════════════════════════════════════════ */
export default function AccountingPage() {
  const router = useRouter();

  const [overview,  setOverview]  = useState<AccountingOverview | null>(null);
  const [expenses,  setExpenses]  = useState<Expense[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [lastAt,    setLastAt]    = useState<Date | null>(null);
  const [spinning,  setSpinning]  = useState(false);
  const [showModal, setShowModal] = useState(false);

  /* Admin guard */
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || '{}');
      if (u.role !== 'admin') router.replace('/dashboard');
    } catch { router.replace('/dashboard'); }
  }, [router]);

  const load = useCallback(async (manual = false) => {
    if (manual) setSpinning(true);
    else        setLoading(true);
    setError(null);
    try {
      const [ovRes, expRes] = await Promise.all([
        getAccountingOverview(),
        getExpenses(),
      ]);
      setOverview(ovRes.data);
      setExpenses(expRes.data);
      setLastAt(new Date());
    } catch {
      setError('فشل تحميل البيانات المالية. تحقق من الاتصال وحاول مجدداً.');
    } finally {
      setLoading(false);
      setSpinning(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /* Metric card definitions */
  const cards: Omit<CardConfig, 'loading'>[] = [
    {
      accent:  'emerald', amount: overview?.total_deposits        ?? 0,
      count:   overview?.count_with_deposit  ?? 0,
      title:   'إجمالي العربون المحصل',  subtitle: 'نقد في يد التاجر الآن',
      note:    'مجموع الدفعات المقدمة (عربون / ديبوزيت) المحصلة من العملاء عند تأكيد الطلب.',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" /></svg>,
    },
    {
      accent:  'blue', amount: overview?.bosta_receivables    ?? 0,
      count:   overview?.count_delivered     ?? 0,
      title:   'مستحقات لدى شركة الشحن', subtitle: 'محصلة من العميل — لم تُحوَّل بعد',
      note:    'مبالغ الكاش أون ديليفري التي حصّلها المندوب من العملاء على طلبات تم توصيلها وتنتظر تسوية من بوسطة.',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z" /></svg>,
    },
    {
      accent:  'amber', amount: overview?.cash_in_transit      ?? 0,
      count:   overview?.count_in_transit    ?? 0,
      title:   'نقدية قيد التحصيل',       subtitle: 'طلبات مشحونة — المندوب في الطريق',
      note:    'مبالغ الكاش أون ديليفري المتوقعة على الطلبات التي خرجت للشحن ولم يتم توصيلها بعد.',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" /></svg>,
    },
    {
      accent:  'purple', amount: overview?.total_sales_delivered ?? 0,
      count:   overview?.count_delivered     ?? 0,
      title:   'إجمالي المبيعات الناجحة',  subtitle: 'إجمالي قيمة الطلبات الموصلة',
      note:    'القيمة الإجمالية لسعر البيع (قبل خصم العربون) لكل الطلبات التي وصلت للعميل بنجاح.',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 p-4 sm:p-6 lg:p-8" dir="rtl">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25 dark:shadow-indigo-900/40">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">الخزينة والماليات</h1>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-500 mr-[52px]">
            نظرة شاملة على الأرباح والتدفق النقدي والمصروفات
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastAt && (
            <span className="text-[11px] text-slate-400 dark:text-slate-600">
              آخر تحديث:{' '}
              {lastAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => load(true)}
            disabled={loading || spinning}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
              bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700
              text-slate-600 dark:text-slate-300
              hover:bg-slate-50 dark:hover:bg-slate-700/80 hover:border-slate-300 dark:hover:border-slate-600
              disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition-all duration-150"
          >
            <svg className={`w-4 h-4 ${spinning ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            تحديث
          </button>
        </div>
      </div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {error && (
        <div className="mb-6 flex items-center gap-3 px-4 py-3 rounded-xl
          bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50
          text-red-700 dark:text-red-400 text-sm"
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {error}
          <button onClick={() => load(true)} className="mr-auto text-xs underline underline-offset-2 opacity-75 hover:opacity-100">
            إعادة المحاولة
          </button>
        </div>
      )}

      {/* ── ① Net Profit Banner ──────────────────────────────────────────── */}
      {overview ? (
        <NetProfitBanner data={overview} loading={loading} />
      ) : loading ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-800/40 p-6 mb-6 space-y-3">
          <Pulse w="w-1/4" h="h-5" />
          <Pulse w="w-1/3" h="h-12" />
          <div className="grid grid-cols-3 gap-4 pt-4 border-t border-slate-100 dark:border-slate-700">
            {[...Array(3)].map((_, i) => <Pulse key={i} w="w-full" h="h-5" />)}
          </div>
        </div>
      ) : null}

      {/* ── ② 4 Metric Cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {cards.map((card) => (
          <MetricCard key={card.title} {...card} loading={loading} />
        ))}
      </div>

      {/* ── ③ Cash-flow summary strip ─────────────────────────────────────── */}
      {overview ? (
        <SummaryStrip data={overview} loading={loading} />
      ) : loading ? (
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-700/50 bg-white/60 dark:bg-slate-800/40 p-6 mb-6 space-y-3">
          <Pulse w="w-1/4" h="h-5" />
          <div className="grid grid-cols-4 gap-4 mt-4">{[...Array(4)].map((_, i) => <Pulse key={i} w="w-full" h="h-10" />)}</div>
        </div>
      ) : null}

      {/* ── ④ Confirmed pending dispatch hint ────────────────────────────── */}
      {!loading && overview && overview.count_confirmed > 0 && (
        <div className="mt-4 flex items-center gap-3 px-5 py-3.5 rounded-xl
          bg-indigo-50/60 dark:bg-indigo-950/20 border border-indigo-200/60 dark:border-indigo-800/40"
        >
          <svg className="w-4 h-4 text-indigo-500 dark:text-indigo-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-indigo-700 dark:text-indigo-300">
            <span className="font-bold">{overview.count_confirmed} طلب</span> مؤكد بانتظار الشحن —
            قيمة الكاش أون ديليفري المتوقعة:{' '}
            <span className="font-bold tabular-nums" dir="ltr">{egp(overview.confirmed_pending_ship)}</span>
          </p>
        </div>
      )}

      {/* ── ⑤ Expenses Ledger ────────────────────────────────────────────── */}
      <div className="mt-6">
        <ExpenseLedger
          expenses={expenses}
          totalExp={overview?.total_expenses ?? 0}
          loading={loading}
          onAdd={() => setShowModal(true)}
        />
      </div>

      {/* ── Add Expense Modal ─────────────────────────────────────────────── */}
      {showModal && (
        <AddExpenseModal
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false);
            load(true);
          }}
        />
      )}
    </div>
  );
}
