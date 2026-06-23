'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getTreasury,
  getCommissionsBreakdown,
  addTreasuryEntry,
  updateTreasuryEntry,
  deleteTreasuryEntry,
  getBostaWallet,
  TreasuryTransaction,
  TreasurySummary,
  CommissionBreakdownDay,
  AddTreasuryEntryPayload,
  BostaWallet,
  MANUAL_CATEGORIES,
} from '@/lib/api';

/* ─────────────────────────────────────────────────────────────────────────────
   Spinner
───────────────────────────────────────────────────────────────────────────── */
function Spin({ sm }: { sm?: boolean }) {
  return (
    <div
      className={`inline-block border-2 border-current border-t-transparent rounded-full animate-spin opacity-60
        ${sm ? 'w-4 h-4' : 'w-5 h-5'}`}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Alert banner
───────────────────────────────────────────────────────────────────────────── */
function Alert({ msg, type }: { msg: string; type: 'error' | 'info' }) {
  const cls =
    type === 'error'
      ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/40'
      : 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800/40';
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl text-sm font-medium border ${cls}`}>
      <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {type === 'error' ? (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        )}
      </svg>
      <span>{msg}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Summary card
───────────────────────────────────────────────────────────────────────────── */
type CardColour = 'emerald' | 'teal' | 'amber' | 'red' | 'violet' | 'indigo' | 'slate';

const COLOUR: Record<CardColour, { wrap: string; text: string; iconWrap: string; iconText: string }> = {
  emerald: {
    wrap:     'bg-emerald-50 border-emerald-200/80 dark:bg-emerald-900/15 dark:border-emerald-700/30',
    text:     'text-emerald-700 dark:text-emerald-400',
    iconWrap: 'bg-emerald-100 dark:bg-emerald-800/40',
    iconText: 'text-emerald-600 dark:text-emerald-300',
  },
  teal: {
    wrap:     'bg-teal-50 border-teal-200/80 dark:bg-teal-900/15 dark:border-teal-700/30',
    text:     'text-teal-700 dark:text-teal-400',
    iconWrap: 'bg-teal-100 dark:bg-teal-800/40',
    iconText: 'text-teal-600 dark:text-teal-300',
  },
  amber: {
    wrap:     'bg-amber-50 border-amber-200/80 dark:bg-amber-900/15 dark:border-amber-700/30',
    text:     'text-amber-700 dark:text-amber-400',
    iconWrap: 'bg-amber-100 dark:bg-amber-800/40',
    iconText: 'text-amber-600 dark:text-amber-300',
  },
  red: {
    wrap:     'bg-red-50 border-red-200/80 dark:bg-red-900/15 dark:border-red-700/30',
    text:     'text-red-700 dark:text-red-400',
    iconWrap: 'bg-red-100 dark:bg-red-800/40',
    iconText: 'text-red-600 dark:text-red-300',
  },
  violet: {
    wrap:     'bg-violet-50 border-violet-200/80 dark:bg-violet-900/15 dark:border-violet-700/30',
    text:     'text-violet-700 dark:text-violet-400',
    iconWrap: 'bg-violet-100 dark:bg-violet-800/40',
    iconText: 'text-violet-600 dark:text-violet-300',
  },
  indigo: {
    wrap:     'bg-indigo-50 border-indigo-200/80 dark:bg-indigo-900/15 dark:border-indigo-700/30',
    text:     'text-indigo-700 dark:text-indigo-400',
    iconWrap: 'bg-indigo-100 dark:bg-indigo-800/40',
    iconText: 'text-indigo-600 dark:text-indigo-300',
  },
  slate: {
    wrap:     'bg-slate-50 border-slate-200 dark:bg-slate-800/40 dark:border-slate-700/50',
    text:     'text-slate-700 dark:text-slate-300',
    iconWrap: 'bg-slate-200 dark:bg-slate-700',
    iconText: 'text-slate-600 dark:text-slate-300',
  },
};

interface SummaryCardProps {
  label:    string;
  value:    string;
  sub?:     string;
  colour:   CardColour;
  icon:     React.ReactNode;
  onClick?: () => void;
}

function SummaryCard({ label, value, sub, colour, icon, onClick }: SummaryCardProps) {
  const c = COLOUR[colour];
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-4 p-5 rounded-2xl border shadow-sm ${c.wrap}
        ${onClick ? 'cursor-pointer hover:shadow-md hover:brightness-[0.97] active:scale-[0.99] transition-all duration-150 select-none' : ''}`}
    >
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${c.iconWrap} ${c.iconText}`}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-0.5 truncate">{label}</p>
          {onClick && (
            <svg className="w-3 h-3 text-slate-400 dark:text-slate-500 mb-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
        </div>
        <p className={`text-xl font-bold tabular-nums ${c.text}`}>{value}</p>
        {sub && <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 leading-tight">{sub}</p>}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Source & type badges
───────────────────────────────────────────────────────────────────────────── */
const SOURCE_META: Record<string, { label: string; cls: string }> = {
  bosta_cod: {
    label: 'Bosta COD',
    cls: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700/40',
  },
  deposit: {
    label: 'عربون',
    cls: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/40',
  },
  comm_confirmed: {
    label: 'عمولة تأكيد',
    cls: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700/40',
  },
  comm_delivered: {
    label: 'عمولة توصيل',
    cls: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/40',
  },
  comm_rejected: {
    label: 'عمولة رفض',
    cls: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/40',
  },
  comm_no_answer: {
    label: 'عمولة لا يرد',
    cls: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  },
  OPENING_BALANCE: {
    label: 'رصيد افتتاحي',
    cls: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/40',
  },
  AD_SPEND: {
    label: 'مصاريف إعلانات',
    cls: 'bg-pink-100 text-pink-700 border-pink-200 dark:bg-pink-900/30 dark:text-pink-300 dark:border-pink-700/40',
  },
  PACKAGING_COST: {
    label: 'تغليف',
    cls: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-700/40',
  },
  SHIPPING_PACKAGE_SUBSCRIPTION: {
    label: 'باقة شحن',
    cls: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-900/30 dark:text-fuchsia-300 dark:border-fuchsia-700/40',
  },
  OPERATIONAL_EXPENSE: {
    label: 'مصروفات تشغيلية',
    cls: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/40',
  },
  INVENTORY_PURCHASE: {
    label: 'شراء مخزون',
    cls: 'bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-300 dark:border-cyan-700/40',
  },
};

/* Auto-generated sources (reconciled from orders) — NOT editable/deletable from
   the UI. Mirrors RESERVED_AUTO_SOURCES in backend treasury.js. A manual row is
   identified by order_id === null AND a source outside this set. */
const RESERVED_AUTO_SOURCES = new Set([
  'bosta_cod', 'deposit',
  'comm_confirmed', 'comm_delivered', 'comm_rejected', 'comm_no_answer',
]);
function isEditableTxn(t: TreasuryTransaction): boolean {
  /* Locked when linked to an order (commission/deposit/COD), a reserved auto
     source, OR an inventory supply batch (purchase_order_id) — all system-posted. */
  return t.order_id == null && t.purchase_order_id == null && !RESERVED_AUTO_SOURCES.has(t.source);
}

function SourceBadge({ source }: { source: string }) {
  const meta = SOURCE_META[source] ?? {
    label: source,
    cls: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-lg text-[11px] font-medium border ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  if (type === 'revenue') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
        إيراد
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400" />
      مصروف
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Formatters
───────────────────────────────────────────────────────────────────────────── */
function fmt(n: number) {
  return n.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d: string) {
  try {
    return new Date(d).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return d;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Source filter constants
───────────────────────────────────────────────────────────────────────────── */
const SOURCE_FILTERS = [
  { value: 'all',        label: 'الكل' },
  { value: 'bosta_cod',  label: 'Bosta COD' },
  { value: 'deposit',    label: 'عربونات' },
  { value: 'commission', label: 'عمولات' },
] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number]['value'];

/* ─────────────────────────────────────────────────────────────────────────────
   CommissionsModal
───────────────────────────────────────────────────────────────────────────── */
function CommissionsModal({
  breakdown,
  loading,
  onClose,
}: {
  breakdown: CommissionBreakdownDay[];
  loading:   boolean;
  onClose:   () => void;
}) {
  // Single-day filter — compares the YYYY-MM-DD prefix of each group's date
  // against the picker value; empty = show all days.
  const [filterDate, setFilterDate] = useState('');
  const visibleDays = filterDate
    ? breakdown.filter((d) => String(d.date).slice(0, 10) === filterDate)
    : breakdown;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh]
          flex flex-col border border-slate-200 dark:border-slate-700"
        dir="rtl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
              <svg className="w-5 h-5 text-violet-600 dark:text-violet-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">تفاصيل عمولات الموظفين</h2>
              <p className="text-xs text-slate-400 dark:text-slate-500">مجمَّعة حسب اليوم والموظف</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:text-slate-300 dark:hover:bg-slate-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Single-day filter bar */}
        {!loading && breakdown.length > 0 && (
          <div className="flex items-center gap-2 px-6 py-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap">
              عرض يوم محدد:
            </label>
            <div className="relative">
              <input
                type="date"
                value={filterDate}
                onChange={(e) => setFilterDate(e.target.value)}
                dir="ltr"
                className="pl-3 pr-9 py-1.5 rounded-xl text-sm outline-none cursor-pointer
                  border border-slate-300 dark:border-slate-700
                  bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200
                  focus:ring-2 focus:ring-violet-400 focus:border-violet-400 transition"
              />
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-slate-500 pointer-events-none"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            {filterDate && (
              <button
                onClick={() => setFilterDate('')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold
                  text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200
                  dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 transition"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
                مسح الفلتر
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Spin />
              <p className="text-sm text-slate-400">جارٍ التحميل…</p>
            </div>
          ) : breakdown.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg className="w-10 h-10 text-slate-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-sm text-slate-400">لا توجد عمولات مسجلة بعد</p>
            </div>
          ) : visibleDays.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg className="w-10 h-10 text-slate-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-sm text-slate-400">لا توجد عمولات في هذا اليوم</p>
            </div>
          ) : (
            <div className="space-y-6">
              {visibleDays.map((day) => (
                <div key={day.date}>
                  {/* Date divider */}
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-xs font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-full whitespace-nowrap">
                      {fmtDate(day.date)}
                    </span>
                    <div className="flex-1 h-px bg-slate-100 dark:bg-slate-800" />
                    <span className="text-xs font-semibold text-violet-600 dark:text-violet-400 tabular-nums whitespace-nowrap">
                      {fmt(day.date_total)} ج
                    </span>
                  </div>

                  {/* Per-agent table */}
                  <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
                          {['الموظف', 'تأكيد', 'توصيل', 'رفض', 'لا يرد', 'المجموع'].map((h) => (
                            <th
                              key={h}
                              className="text-right text-[11px] font-semibold text-slate-500 dark:text-slate-400 px-4 py-2.5 whitespace-nowrap"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {day.agents.map((agent) => (
                          <tr key={agent.agent_email} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/30 transition-colors">
                            <td className="px-4 py-2.5">
                              <span className="text-xs font-medium text-slate-700 dark:text-slate-300 block">
                                {agent.agent_email.split('@')[0]}
                              </span>
                              <span className="text-[10px] text-slate-400 dark:text-slate-500 block leading-tight">
                                {agent.agent_email}
                              </span>
                            </td>
                            {[agent.comm_confirmed, agent.comm_delivered, agent.comm_rejected, agent.comm_no_answer].map((val, i) => (
                              <td key={i} className="px-4 py-2.5 tabular-nums whitespace-nowrap">
                                <span className={`text-xs ${val > 0 ? 'text-slate-700 dark:text-slate-300 font-medium' : 'text-slate-300 dark:text-slate-600'}`}>
                                  {val > 0 ? `${fmt(val)} ج` : '—'}
                                </span>
                              </td>
                            ))}
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <span className="text-sm font-bold text-violet-600 dark:text-violet-400 tabular-nums">
                                {fmt(agent.total)} ج
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   AddEntryModal
───────────────────────────────────────────────────────────────────────────── */
/* Category options for the dropdown, in display order. The leading value ''
   is the "choose a category" placeholder. Each known code carries its own
   revenue/expense sign via MANUAL_CATEGORIES — the user never picks the sign. */
const CATEGORY_OPTIONS: { code: string; label: string }[] = [
  { code: 'OPENING_BALANCE',               label: 'رصيد افتتاحي' },
  { code: 'AD_SPEND',                      label: 'مصاريف إعلانات' },
  { code: 'PACKAGING_COST',                label: 'تغليف' },
  { code: 'SHIPPING_PACKAGE_SUBSCRIPTION', label: 'باقة شحن' },
  { code: 'OPERATIONAL_EXPENSE',           label: 'مصروفات تشغيلية' },
  { code: 'INVENTORY_PURCHASE',            label: 'شراء مخزون (لا يُحتسب ضمن مصاريف التشغيل)' },
];

interface AddEntryForm {
  category:    string;   // category code from MANUAL_CATEGORIES, or '' = unset
  amount:      string;
  description: string;
}

function AddEntryModal({
  onClose,
  onSaved,
  editing,
}: {
  onClose: () => void;
  onSaved: (entry: TreasuryTransaction) => void;
  editing?: TreasuryTransaction | null;
}) {
  const [form,   setForm]   = useState<AddEntryForm>({
    category:    editing?.source ?? '',
    amount:      editing ? String(editing.amount) : '',
    description: editing?.description ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState('');

  const handle = (k: keyof AddEntryForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  /* Derived sign of the currently selected category (drives the +/− preview). */
  const selected = form.category ? MANUAL_CATEGORIES[form.category] : null;
  const isIncome = selected?.type === 'revenue';

  /* When editing a row whose source is a custom/free-text code not in the preset
     list, surface it as a selectable option so the dropdown reflects reality. */
  const categoryOptions = editing && !CATEGORY_OPTIONS.some((c) => c.code === editing.source)
    ? [{ code: editing.source, label: editing.source }, ...CATEGORY_OPTIONS]
    : CATEGORY_OPTIONS;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!form.category) {
      return setErr('يرجى اختيار نوع المعاملة');
    }
    const amount = parseFloat(form.amount);
    if (!form.amount || isNaN(amount) || amount <= 0) {
      return setErr('المبلغ مطلوب ويجب أن يكون رقماً موجباً');
    }
    setSaving(true);
    try {
      const known = MANUAL_CATEGORIES[form.category];
      const payload: AddTreasuryEntryPayload = {
        amount,
        source:      form.category,   // server derives revenue/expense from a known category
        description: form.description.trim() || undefined,
        /* Custom (non-preset) source has no implicit sign → carry the explicit type
           (preserve the existing one when editing, else default to expense). */
        ...(known ? {} : { type: (editing?.type === 'revenue' ? 'revenue' : 'expense') as 'revenue' | 'expense' }),
      };
      const res = editing
        ? await updateTreasuryEntry(editing.id, payload)
        : await addTreasuryEntry(payload);
      onSaved(res.data);
    } catch (ex: unknown) {
      const msg = (ex as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setErr(msg || 'فشل حفظ المعاملة');
      setSaving(false);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm rounded-xl border bg-white dark:bg-slate-800 ' +
    'border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 ' +
    'placeholder-slate-400 dark:placeholder-slate-500 ' +
    'focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 dark:border-slate-700"
        dir="rtl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
              <svg className="w-5 h-5 text-indigo-600 dark:text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                {editing ? 'تعديل معاملة يدوية' : 'إضافة معاملة يدوية'}
              </h2>
              <p className="text-xs text-slate-400">تغليف · شحن · إعلانات · غيرها</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:text-slate-300 dark:hover:bg-slate-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={submit} className="p-6 space-y-4">
          {err && <Alert msg={err} type="error" />}

          {/* Transaction category — drives the income/expense sign */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
              نوع المعاملة <span className="text-red-500">*</span>
            </label>
            <select value={form.category} onChange={handle('category')} className={inputCls}>
              <option value="" disabled>— اختر نوع المعاملة —</option>
              {categoryOptions.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>

            {/* Income / expense indicator — auto-flagged from the selection */}
            {selected && (
              <div className="mt-2">
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${
                    isIncome
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/40'
                      : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/40'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${isIncome ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  {isIncome ? 'إيراد (+) — يُضاف إلى رصيد الشركة' : 'مصروف (−) — يُخصم من رصيد الشركة'}
                </span>
              </div>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
              المبلغ (ج.م) <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              placeholder="0.00"
              min="0.01"
              step="0.01"
              value={form.amount}
              onChange={handle('amount')}
              className={inputCls}
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
              ملاحظة (اختياري)
            </label>
            <textarea
              rows={2}
              placeholder="تفاصيل إضافية إن وجدت…"
              value={form.description}
              onChange={handle('description')}
              className={`${inputCls} resize-none`}
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5
                bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl
                text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {saving ? <><Spin sm /> جارٍ الحفظ…</> : (editing ? 'حفظ التعديلات' : 'حفظ المعاملة')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700
                text-sm font-medium text-slate-600 dark:text-slate-400
                hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              إلغاء
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   DeleteConfirmModal — confirm removal of a manual transaction
───────────────────────────────────────────────────────────────────────────── */
function DeleteConfirmModal({
  txn,
  onClose,
  onConfirm,
}: {
  txn:       TreasuryTransaction;
  onClose:   () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState('');

  const confirm = async () => {
    setBusy(true);
    setErr('');
    try {
      await onConfirm();
    } catch (ex: unknown) {
      const msg = (ex as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setErr(msg || 'فشل حذف المعاملة');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm border border-slate-200 dark:border-slate-700"
        dir="rtl"
      >
        <div className="p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-900/40 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-red-600 dark:text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">حذف المعاملة</h2>
              <p className="text-xs text-slate-400">لا يمكن التراجع عن هذا الإجراء</p>
            </div>
          </div>

          <p className="text-sm text-slate-600 dark:text-slate-300 mb-3">
            هل أنت متأكد من حذف هذه المعاملة؟ سيتم تعديل رصيد الخزينة تلقائياً.
          </p>
          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 px-4 py-3 mb-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <SourceBadge source={txn.source} />
              <span className={`font-bold tabular-nums ${txn.type === 'revenue' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {txn.type === 'expense' ? '−' : '+'}{fmt(txn.amount)} ج
              </span>
            </div>
            {txn.description && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 line-clamp-2">{txn.description}</p>
            )}
          </div>

          {err && <div className="mb-3"><Alert msg={err} type="error" /></div>}

          <div className="flex gap-3">
            <button
              onClick={confirm}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl
                bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-semibold
                transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {busy ? <><Spin sm /> جارٍ الحذف…</> : 'نعم، احذف'}
            </button>
            <button
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700
                text-sm font-medium text-slate-600 dark:text-slate-400
                hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              إلغاء
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   WalletTxModal — live Bosta wallet transactions
───────────────────────────────────────────────────────────────────────────── */
function WalletTxModal({
  wallet,
  loading,
  onClose,
}: {
  wallet:  BostaWallet | null;
  loading: boolean;
  onClose: () => void;
}) {
  const txs = wallet?.transactions ?? [];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh]
          flex flex-col border border-slate-200 dark:border-slate-700"
        dir="rtl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-orange-100 dark:bg-orange-900/40 flex items-center justify-center">
              <svg className="w-5 h-5 text-orange-600 dark:text-orange-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">معاملات محفظة شركة الشحن</h2>
              <p className="text-xs text-slate-400 dark:text-slate-500">آخر الحركات المباشرة من Bosta</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:text-slate-300 dark:hover:bg-slate-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Spin />
              <p className="text-sm text-slate-400">جارٍ التحميل من Bosta…</p>
            </div>
          ) : txs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg className="w-10 h-10 text-slate-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-sm text-slate-400">لا توجد معاملات لعرضها</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
                    {['التاريخ', 'النوع', 'المبلغ', 'الوصف', 'الحالة'].map((h) => (
                      <th key={h} className="text-right text-[11px] font-semibold text-slate-500 dark:text-slate-400 px-4 py-2.5 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {txs.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {t.date ? fmtDate(t.date) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{t.type}</td>
                      <td className="px-4 py-2.5 tabular-nums whitespace-nowrap">
                        <span className={`text-sm font-semibold ${t.amount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                          {t.amount >= 0 ? '+' : ''}{fmt(t.amount)} ج
                        </span>
                      </td>
                      <td className="px-4 py-2.5 max-w-[260px]">
                        <span className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2" title={t.description}>
                          {t.description || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">{t.status || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Page
───────────────────────────────────────────────────────────────────────────── */
interface Toast { message: string; type: 'success' | 'error' }

export default function TreasuryPage() {
  const router = useRouter();

  /* ── Data ─────────────────────────────────────────────────────── */
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [summary,      setSummary]      = useState<TreasurySummary | null>(null);
  const [transactions, setTransactions] = useState<TreasuryTransaction[]>([]);

  /* ── Filters ──────────────────────────────────────────────────── */
  const [search,       setSearch]       = useState('');
  const [typeFilter,   setTypeFilter]   = useState<'all' | 'revenue' | 'expense'>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  /* ── Toast ────────────────────────────────────────────────────── */
  const [toast, setToast] = useState<Toast | null>(null);
  const showToast = useCallback((message: string, type: Toast['type'] = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  /* ── Commissions modal state ──────────────────────────────────── */
  const [isCommissionsOpen, setIsCommissionsOpen] = useState(false);
  const [commBreakdown,     setCommBreakdown]     = useState<CommissionBreakdownDay[]>([]);
  const [commLoading,       setCommLoading]       = useState(false);

  /* ── Manual entry modal state ─────────────────────────────────── */
  const [isManualEntryOpen, setIsManualEntryOpen] = useState(false);
  const [editingTxn,  setEditingTxn]  = useState<TreasuryTransaction | null>(null);
  const [deletingTxn, setDeletingTxn] = useState<TreasuryTransaction | null>(null);

  /* ── Live Bosta wallet state ──────────────────────────────────── */
  const [wallet,        setWallet]        = useState<BostaWallet | null>(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletError,   setWalletError]   = useState('');
  const [isWalletTxOpen, setIsWalletTxOpen] = useState(false);

  /* ── Auth guard ───────────────────────────────────────────────── */
  useEffect(() => {
    const token = localStorage.getItem('token');
    const raw   = localStorage.getItem('user');
    if (!token || !raw) { router.push('/'); return; }
    const u = JSON.parse(raw) as { role: string };
    if (u.role !== 'admin') router.push('/dashboard');
  }, [router]);

  /* ── Load treasury data ───────────────────────────────────────── */
  const loadTreasury = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await getTreasury();
      setSummary(res.data.summary);
      setTransactions(res.data.transactions);
    } catch {
      setError('فشل في تحميل بيانات الخزينة — تحقق من الاتصال بالخادم');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { loadTreasury(); }, [loadTreasury]);

  /* ── Load live Bosta wallet (independent of treasury ledger) ──── */
  const loadWallet = useCallback(async () => {
    setWalletLoading(true);
    setWalletError('');
    try {
      const res = await getBostaWallet();
      setWallet(res.data);
    } catch (ex: unknown) {
      const msg = (ex as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setWalletError(msg || 'تعذّر الاتصال بمحفظة شركة الشحن');
      setWallet(null);
    } finally {
      setWalletLoading(false);
    }
  }, []);

  useEffect(() => { loadWallet(); }, [loadWallet]);

  /* ── Open commissions modal ───────────────────────────────────── */
  const openCommissionsModal = async () => {
    setIsCommissionsOpen(true);
    setCommLoading(true);
    setCommBreakdown([]);
    try {
      const res = await getCommissionsBreakdown();
      setCommBreakdown(res.data);
    } catch {
      showToast('فشل تحميل تفاصيل العمولات', 'error');
      setIsCommissionsOpen(false);
    } finally {
      setCommLoading(false);
    }
  };

  /* ── Entry saved callback (add OR edit) ───────────────────────── */
  const handleEntrySaved = (entry: TreasuryTransaction) => {
    const wasEditing = editingTxn != null;
    setIsManualEntryOpen(false);
    setEditingTxn(null);
    showToast(
      `${wasEditing ? 'تم تعديل المعاملة' : 'تم حفظ المعاملة'}: ${entry.source} — ${fmt(entry.amount)} ج`,
      'success',
    );
    loadTreasury(true);
  };

  /* ── Delete callback — throws on failure so the modal can surface it ── */
  const handleDelete = async () => {
    if (!deletingTxn) return;
    await deleteTreasuryEntry(deletingTxn.id);
    showToast('تم حذف المعاملة بنجاح', 'success');
    setDeletingTxn(null);
    loadTreasury(true);
  };

  /* ── Filtered rows ────────────────────────────────────────────── */
  const displayed = transactions.filter((t) => {
    if (typeFilter !== 'all' && t.type !== typeFilter) return false;
    if (sourceFilter === 'commission' && !t.source.startsWith('comm_')) return false;
    if (sourceFilter !== 'all' && sourceFilter !== 'commission' && t.source !== sourceFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      String(t.id).includes(q) ||
      String(t.order_id ?? '').includes(q) ||
      (t.description ?? '').toLowerCase().includes(q) ||
      t.source.toLowerCase().includes(q) ||
      t.transaction_date.includes(q)
    );
  });

  const unloggedDeposits = summary
    ? Math.max(0, summary.deposits_live - summary.deposits_revenue)
    : 0;

  /* ── Render ───────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 p-6" dir="rtl">

      {/* ── Toast notification ──────────────────────────────────── */}
      {toast && (
        <div
          className={`fixed bottom-5 left-5 z-[60] flex items-center gap-2.5 px-4 py-3
            rounded-xl shadow-xl text-sm font-medium text-white
            ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-600'}`}
        >
          {toast.type === 'success' ? (
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          )}
          {toast.message}
        </div>
      )}

      {/* ── Commissions modal ───────────────────────────────────── */}
      {isCommissionsOpen && (
        <CommissionsModal
          breakdown={commBreakdown}
          loading={commLoading}
          onClose={() => setIsCommissionsOpen(false)}
        />
      )}

      {/* ── Manual entry modal (add) ────────────────────────────── */}
      {isManualEntryOpen && (
        <AddEntryModal
          onClose={() => setIsManualEntryOpen(false)}
          onSaved={handleEntrySaved}
        />
      )}

      {/* ── Manual entry modal (edit) ───────────────────────────── */}
      {editingTxn && (
        <AddEntryModal
          editing={editingTxn}
          onClose={() => setEditingTxn(null)}
          onSaved={handleEntrySaved}
        />
      )}

      {/* ── Delete confirmation modal ───────────────────────────── */}
      {deletingTxn && (
        <DeleteConfirmModal
          txn={deletingTxn}
          onClose={() => setDeletingTxn(null)}
          onConfirm={handleDelete}
        />
      )}

      {/* ── Bosta wallet transactions modal ─────────────────────── */}
      {isWalletTxOpen && (
        <WalletTxModal
          wallet={wallet}
          loading={walletLoading}
          onClose={() => setIsWalletTxOpen(false)}
        />
      )}

      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600
            flex items-center justify-center shadow-md shadow-emerald-500/20 shrink-0">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white leading-tight">
              الخزينة والماليات
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Treasury — إيرادات Bosta COD · العربونات · عمولات الموظفين
            </p>
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════
          Live Bosta wallet balance — fetched directly from Bosta
      ════════════════════════════════════════════════════════════ */}
      <div className="mb-6">
        <div className="relative overflow-hidden flex flex-wrap items-center gap-4 px-5 py-4 rounded-2xl
          border border-orange-200/80 dark:border-orange-700/30
          bg-gradient-to-l from-orange-50 to-amber-50 dark:from-orange-900/15 dark:to-amber-900/10 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-orange-100 dark:bg-orange-800/40 flex items-center justify-center shrink-0">
            <svg className="w-6 h-6 text-orange-600 dark:text-orange-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-orange-700/80 dark:text-orange-300/80">
                رصيد محفظة شركة الشحن (Bosta) — مباشر
              </p>
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-semibold
                bg-orange-100 text-orange-600 dark:bg-orange-800/40 dark:text-orange-300">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" /> LIVE
              </span>
            </div>
            {walletLoading ? (
              <div className="flex items-center gap-2 mt-1 text-orange-700 dark:text-orange-300">
                <Spin sm /> <span className="text-sm">جارٍ الجلب من Bosta…</span>
              </div>
            ) : walletError ? (
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{walletError}</p>
            ) : (
              <p className="text-2xl font-bold tabular-nums text-orange-700 dark:text-orange-300 mt-0.5">
                {wallet?.balance != null ? `${fmt(wallet.balance)} ج` : '— غير متاح —'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadWallet()}
              disabled={walletLoading}
              className="p-2 rounded-xl border border-orange-200 dark:border-orange-700/40
                text-orange-600 dark:text-orange-300 hover:bg-orange-100/60 dark:hover:bg-orange-800/30
                transition-colors disabled:opacity-50"
              title="تحديث الرصيد"
            >
              <svg className={`w-4 h-4 ${walletLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={() => setIsWalletTxOpen(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold
                bg-orange-600 hover:bg-orange-700 active:bg-orange-800 text-white shadow-sm shadow-orange-500/20 transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              المعاملات
            </button>
          </div>
        </div>
      </div>

      {/* ── Error banner ────────────────────────────────────────── */}
      {error && <div className="mb-6"><Alert msg={error} type="error" /></div>}

      {/* ── Full-page loading ────────────────────────────────────── */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <Spin />
          <p className="text-sm text-slate-400 dark:text-slate-500">جارٍ تحميل الخزينة…</p>
        </div>
      )}

      {!loading && summary && (
        <>
          {/* ════════════════════════════════════════════════════════
              HERO — Current Company Balance (رصيد الشركة الفعلي)
              The real cash in the corporate vault:
              Σ opening balances + all incomes − all expenses/payouts.
          ════════════════════════════════════════════════════════ */}
          <div className="mb-6">
            <div
              className={`relative overflow-hidden flex flex-wrap items-center gap-5 px-6 py-6 rounded-2xl border shadow-sm
                ${summary.current_total_balance >= 0
                  ? 'border-emerald-200/80 dark:border-emerald-700/30 bg-gradient-to-l from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/10'
                  : 'border-red-200/80 dark:border-red-700/30 bg-gradient-to-l from-red-50 to-rose-50 dark:from-red-900/20 dark:to-rose-900/10'}`}
            >
              <div
                className={`w-14 h-14 rounded-2xl flex items-center justify-center shrink-0
                  ${summary.current_total_balance >= 0
                    ? 'bg-emerald-100 dark:bg-emerald-800/40 text-emerald-600 dark:text-emerald-300'
                    : 'bg-red-100 dark:bg-red-800/40 text-red-600 dark:text-red-300'}`}
              >
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                  رصيد الشركة الفعلي
                </p>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-1">
                  النقد الحقيقي المتاح في الخزينة — الرصيد الافتتاحي + كل الإيرادات − كل المصروفات
                </p>
                <p
                  className={`text-3xl sm:text-4xl font-extrabold tabular-nums
                    ${summary.current_total_balance >= 0
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-red-700 dark:text-red-300'}`}
                >
                  {summary.current_total_balance >= 0 ? '+' : ''}{fmt(summary.current_total_balance)} ج
                </p>
              </div>
              {summary.opening_balance > 0 && (
                <div className="shrink-0 text-left">
                  <p className="text-[11px] text-slate-400 dark:text-slate-500">منها رصيد افتتاحي</p>
                  <p className="text-base font-bold tabular-nums text-slate-600 dark:text-slate-300">
                    {fmt(summary.opening_balance)} ج
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ════════════════════════════════════════════════════════
              ROW 1 — Revenue breakdown
          ════════════════════════════════════════════════════════ */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">

            {/* Total revenue */}
            <SummaryCard
              label="إجمالي الإيرادات"
              value={`${fmt(summary.total_revenue)} ج`}
              sub={`من ${summary.count} معاملة`}
              colour="emerald"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />

            {/* Bosta COD revenue */}
            <SummaryCard
              label="إيرادات Bosta COD"
              value={`${fmt(summary.bosta_cod_revenue)} ج`}
              sub="عند التسليم عبر Bosta"
              colour="teal"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" />
                </svg>
              }
            />

            {/* Deposits */}
            <SummaryCard
              label="العربونات المسجلة"
              value={`${fmt(summary.deposits_revenue)} ج`}
              sub={
                summary.count_with_deposit > 0
                  ? `مسجَّل من ${summary.count_with_deposit} طلب (إجمالي دفتري: ${fmt(summary.deposits_live)} ج)`
                  : 'لا يوجد عربونات مسجلة بعد'
              }
              colour="amber"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              }
            />
          </div>

          {/* ════════════════════════════════════════════════════════
              ROW 2 — Expenses, commissions (clickable), net balance
          ════════════════════════════════════════════════════════ */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">

            {/* Total expenses */}
            <SummaryCard
              label="إجمالي المصروفات"
              value={`${fmt(summary.total_expenses)} ج`}
              colour="red"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
                </svg>
              }
            />

            {/* Commissions — CLICKABLE → opens CommissionsModal */}
            <SummaryCard
              label="عمولات الموظفين"
              value={`${fmt(summary.total_commissions)} ج`}
              sub="انقر لعرض التفاصيل يومياً"
              colour="violet"
              onClick={() => openCommissionsModal()}
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              }
            />

            {/* Net balance */}
            <SummaryCard
              label="صافي الرصيد"
              value={`${summary.net_balance >= 0 ? '+' : ''}${fmt(summary.net_balance)} ج`}
              sub={summary.net_balance >= 0 ? 'رصيد موجب ✓' : 'رصيد سالب — راجع المصروفات'}
              colour={summary.net_balance >= 0 ? 'indigo' : 'slate'}
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              }
            />
          </div>

          {/* ════════════════════════════════════════════════════════
              ROW 3 — Cash in transit (NOT added to net balance)
          ════════════════════════════════════════════════════════ */}
          <div className="mb-8">
            <div className="flex items-center gap-4 px-5 py-4 rounded-2xl
              border-2 border-dashed border-slate-300 dark:border-slate-700
              bg-slate-50 dark:bg-slate-800/30">
              <div className="w-10 h-10 rounded-xl bg-slate-200 dark:bg-slate-700 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-slate-500 dark:text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-baseline gap-3">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    مبالغ لدى شركة الشحن قيد التحصيل
                  </p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md font-semibold
                    bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400 whitespace-nowrap">
                    لا تُضاف للرصيد
                  </span>
                </div>
                <p className="text-2xl font-bold tabular-nums text-slate-600 dark:text-slate-300 mt-0.5">
                  {fmt(summary.pending_bosta_cash)} ج
                </p>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                  تقدير داخلي: إجمالي مبالغ التحصيل للطلبات قيد التوصيل (أكبر من صفر)
                </p>
              </div>
            </div>
          </div>

          {/* ── Unlogged-deposit callout ─────────────────────────── */}
          {unloggedDeposits > 0.01 && (
            <div className="mb-6">
              <Alert
                type="info"
                msg={`${fmt(unloggedDeposits)} ج من العربونات موجودة في الطلبات ولم تُسجَّل بعد في دفتر الخزينة. ستُسجَّل تلقائياً عند تحديث أي طلب بعربون من الآن فصاعداً.`}
              />
            </div>
          )}

          {/* ════════════════════════════════════════════════════════
              Filters row + "إضافة معاملة" button
          ════════════════════════════════════════════════════════ */}
          <div className="flex flex-wrap items-center gap-3 mb-4">

            {/* Search input */}
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="بحث في المعاملات…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pr-9 pl-3 py-2 text-sm rounded-xl border
                  bg-white dark:bg-slate-900
                  border-slate-200 dark:border-slate-700
                  text-slate-800 dark:text-slate-200
                  placeholder-slate-400 dark:placeholder-slate-500
                  focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </div>

            {/* Source filter pills */}
            {SOURCE_FILTERS.map((f) => {
              const active = sourceFilter === f.value;
              return (
                <button
                  key={f.value}
                  onClick={() => setSourceFilter(f.value)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                    active
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-indigo-300'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}

            {/* Type filter pills */}
            {(['all', 'revenue', 'expense'] as const).map((f) => {
              const labels = { all: 'الكل', revenue: 'إيرادات', expense: 'مصروفات' };
              const active = typeFilter === f;
              return (
                <button
                  key={f}
                  onClick={() => setTypeFilter(f)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                    active
                      ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-200 dark:text-slate-900 shadow-sm'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-400'
                  }`}
                >
                  {labels[f]}
                </button>
              );
            })}

            <span className="text-xs text-slate-400 dark:text-slate-500">
              {displayed.length} معاملة
            </span>

            {/* ── "إضافة معاملة" button — opens AddEntryModal ─────── */}
            <button
              onClick={() => setIsManualEntryOpen(true)}
              className="mr-auto flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold
                bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800
                text-white shadow-sm shadow-indigo-500/20 transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              إضافة معاملة
            </button>
          </div>

          {/* ════════════════════════════════════════════════════════
              Transactions table
          ════════════════════════════════════════════════════════ */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
            {displayed.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <svg className="w-10 h-10 text-slate-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <p className="text-sm text-slate-400 dark:text-slate-500">لا توجد معاملات تطابق الفلتر</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 dark:border-slate-800">
                      {['#', 'طلب', 'المبلغ', 'النوع', 'المصدر', 'الوصف', 'التاريخ', 'إجراءات'].map((h) => (
                        <th
                          key={h}
                          className="text-right text-xs font-semibold text-slate-500 dark:text-slate-400 px-4 py-3 whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {displayed.map((t) => (
                      <tr key={t.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="px-4 py-3 text-xs text-slate-400 dark:text-slate-500 tabular-nums">
                          {t.id}
                        </td>
                        <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                          {t.order_id ? (
                            <span className="text-indigo-600 dark:text-indigo-400 font-medium text-xs">
                              #{t.order_id}
                            </span>
                          ) : (
                            <span className="text-slate-300 dark:text-slate-600 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`font-semibold tabular-nums text-sm ${
                            t.type === 'revenue'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400'
                          }`}>
                            {t.type === 'expense' ? '−' : '+'}{fmt(t.amount)} ج
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <TypeBadge type={t.type} />
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <SourceBadge source={t.source} />
                        </td>
                        <td className="px-4 py-3 max-w-[260px]">
                          <span
                            className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed"
                            title={t.description ?? ''}
                          >
                            {t.description || <span className="text-slate-300 dark:text-slate-600">—</span>}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                          {fmtDate(t.transaction_date)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {isEditableTxn(t) ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => setEditingTxn(t)}
                                title="تعديل"
                                className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50
                                  dark:hover:text-indigo-400 dark:hover:bg-indigo-900/30 transition-colors"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                              <button
                                onClick={() => setDeletingTxn(t)}
                                title="حذف"
                                className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50
                                  dark:hover:text-red-400 dark:hover:bg-red-900/30 transition-colors"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-300 dark:text-slate-600 text-xs" title="معاملة تلقائية — تُدار من الطلب">🔒</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ════════════════════════════════════════════════════════
              Color legend — DO NOT REMOVE
          ════════════════════════════════════════════════════════ */}
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1.5">
            {Object.entries(SOURCE_META).map(([key, meta]) => (
              <div key={key} className="flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500">
                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] border ${meta.cls}`}>
                  {meta.label}
                </span>
                <span className="truncate">
                  {key === 'bosta_cod'      && 'كاش عند التسليم عبر Bosta'}
                  {key === 'deposit'        && 'عربون دفعه العميل مسبقاً'}
                  {key === 'comm_confirmed' && 'عمولة تأكيد الطلب'}
                  {key === 'comm_delivered' && 'عمولة توصيل الطلب'}
                  {key === 'comm_rejected'  && 'عمولة رفض الطلب'}
                  {key === 'comm_no_answer' && 'عمولة لا يرد / مؤجل'}
                  {key === 'OPENING_BALANCE'               && 'رأس المال الافتتاحي للشركة'}
                  {key === 'AD_SPEND'                      && 'مصاريف الإعلانات الممولة'}
                  {key === 'PACKAGING_COST'                && 'تكاليف التغليف والتعبئة'}
                  {key === 'SHIPPING_PACKAGE_SUBSCRIPTION' && 'اشتراك باقة الشحن'}
                  {key === 'OPERATIONAL_EXPENSE'           && 'مصروفات تشغيلية عامة'}
                  {key === 'INVENTORY_PURCHASE'            && 'شراء مخزون — يُخصم من النقد ولا يدخل ضمن مصاريف التشغيل'}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
            صافي الرصيد = الإيرادات − المصروفات (Bosta COD + العربونات − عمولات الموظفين)
          </p>
        </>
      )}
    </div>
  );
}