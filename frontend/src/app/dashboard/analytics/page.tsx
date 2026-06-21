'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

import { getProducts, getDashboardStats, getProductsProfitability, getBusinessProfile, getDeliveredOrders, getMediaBuyers } from '@/lib/api';
import type { DeliveredOrdersResponse, MediaBuyer } from '@/lib/api';
import type {
  Product,
  DashboardStats,
  ProductProfitability,
  BusinessProfile,
  ExternalNetworkStat,
} from '@/lib/api';

/* ═══════════════════════════════════════════════════════════════════
   STATIC UI CONSTANTS  (no mock business data)
   ═══════════════════════════════════════════════════════════════════ */

const DATE_RANGES = [
  { label: 'اليوم',      value: 'today'     },
  { label: 'أمس',        value: 'yesterday' },
  { label: 'آخر 7 أيام', value: '7d'        },
  { label: 'هذا الشهر',  value: 'month'     },
];

const STATUSES = ['كل الحالات', 'جديد', 'تم التأكيد', 'تم الشحن', 'تم الاستلام', 'مُرجَّع'];

/** Colour palette for rejection-reason donut slices — cycles via index */
const REJECTION_COLORS = [
  '#f43f5e', '#f97316', '#f59e0b', '#6366f1',
  '#64748b', '#10b981', '#3b82f6', '#8b5cf6',
];

const ARABIC_MONTHS = [
  'يناير','فبراير','مارس','أبريل','مايو','يونيو',
  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر',
];

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════ */

const fmt    = (n: number) => Math.abs(n).toLocaleString('en-US');
/** Format a number as Egyptian Pounds. Handles NaN / Infinity gracefully (returns "0 ج.م"). */
const fmtEGP = (n: number) => {
  const safe = Number.isFinite(n) ? n : 0;
  return `${safe < 0 ? '-' : ''}${Math.abs(safe).toLocaleString('en-US')} ج.م`;
};
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

/** Convert a YYYY-MM-DD string to an Arabic short date, e.g. "9 مايو" */
function fmtDateArabic(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const month = parseInt(parts[1], 10);
  const day   = parseInt(parts[2], 10);
  if (month < 1 || month > 12 || isNaN(day)) return dateStr;
  return `${day} ${ARABIC_MONTHS[month - 1]}`;
}

/* ═══════════════════════════════════════════════════════════════════
   CHART SERIES CONFIG
   ═══════════════════════════════════════════════════════════════════ */

const ORDERS_SERIES = [
  { key: 'orders',    name: 'إجمالي الطلبات',    color: '#6366f1', dash: undefined, isEGP: false },
  { key: 'confirmed', name: 'الطلبات المؤكدة',   color: '#3b82f6', dash: undefined, isEGP: false },
  { key: 'delivered', name: 'الطلبات المُسلَّمة', color: '#14b8a6', dash: undefined, isEGP: false },
] as const;

const PROFIT_SERIES = [
  { key: 'adsSpend',    name: 'الإنفاق الإعلاني',    color: '#f43f5e', dash: '6 3',   isEGP: true },
  { key: 'grossMargin', name: 'هامش الربح الإجمالي', color: '#10b981', dash: undefined, isEGP: true },
  { key: 'netProfit',   name: 'صافي الربح',           color: '#6366f1', dash: undefined, isEGP: true },
] as const;

type ChartView = 'orders' | 'profit';

/* ═══════════════════════════════════════════════════════════════════
   CUSTOM RECHARTS TOOLTIP — view-aware
   ═══════════════════════════════════════════════════════════════════ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label, isDark, chartView }: any) {
  if (!active || !payload?.length) return null;
  const series = chartView === 'orders' ? ORDERS_SERIES : PROFIT_SERIES;
  return (
    <div
      dir="rtl"
      className={`rounded-xl px-4 py-3 shadow-2xl border text-xs min-w-[180px]
        ${isDark
          ? 'bg-slate-800 border-slate-700 text-slate-200'
          : 'bg-white border-slate-200 text-slate-700'}`}
    >
      <p className={`font-bold text-sm mb-3 pb-2 border-b
        ${isDark ? 'text-white border-slate-700' : 'text-slate-800 border-slate-100'}`}>
        {label}
      </p>
      {series.map((s) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = payload.find((p: any) => p.dataKey === s.key);
        if (!entry) return null;
        return (
          <div key={s.key} className="flex items-center justify-between gap-4 mb-1.5 last:mb-0">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />
              <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>{s.name}</span>
            </div>
            <span className="font-bold tabular-nums">
              {s.isEGP ? fmtEGP(entry.value) : fmt(entry.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   DONUT CHART TOOLTIP
   ═══════════════════════════════════════════════════════════════════ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PieTooltip({ active, payload, isDark, total }: any) {
  if (!active || !payload?.length) return null;
  const item = payload[0].payload;
  const pct  = total > 0 ? Math.round((item.value / total) * 100) : 0;
  return (
    <div
      dir="rtl"
      className={`rounded-xl px-4 py-3 shadow-2xl border text-xs min-w-[160px]
        ${isDark
          ? 'bg-slate-800 border-slate-700 text-slate-200'
          : 'bg-white border-slate-200 text-slate-700'}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: item.color }} />
        <span className="font-bold text-sm" style={{ color: item.color }}>{item.name}</span>
      </div>
      <p className={`${isDark ? 'text-slate-400' : 'text-slate-500'} mb-0.5`}>
        العدد:{' '}
        <span className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
          {item.value} طلب
        </span>
      </p>
      <p className={isDark ? 'text-slate-400' : 'text-slate-500'}>
        النسبة:{' '}
        <span className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
          {pct}%
        </span>
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   KPI CARD
   ═══════════════════════════════════════════════════════════════════ */

interface KPICardProps {
  label:      string;
  value:      string;
  subValue?:  string;
  trend?:     number;
  trendGood?: boolean;
  accent?:    string;
  highlight?: boolean;
}

function KPICard({ label, value, subValue, trend, trendGood = true, accent, highlight }: KPICardProps) {
  const trendUp = trend !== undefined && trend > 0;
  const isGood  = trendGood ? trendUp : !trendUp;
  return (
    <div className={`rounded-2xl p-5 border shadow-sm transition-all duration-150 hover:shadow-md
      ${highlight
        ? 'bg-gradient-to-br from-indigo-600 to-indigo-800 dark:from-indigo-700 dark:to-indigo-950 border-indigo-500/50'
        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-widest mb-2 leading-none
        ${highlight ? 'text-indigo-200' : 'text-slate-400 dark:text-slate-500'}`}>
        {label}
      </p>
      <div className={`text-2xl font-bold leading-none tracking-tight
        ${highlight ? 'text-white' : (accent ?? 'text-slate-800 dark:text-white')}`}>
        {value}
      </div>
      <div className="flex items-center justify-between mt-2.5 gap-2">
        {subValue && (
          <span className={`text-xs font-medium leading-snug
            ${highlight ? 'text-indigo-200' : 'text-slate-500 dark:text-slate-400'}`}>
            {subValue}
          </span>
        )}
        {trend !== undefined && (
          <span className={`shrink-0 text-[11px] font-bold px-1.5 py-0.5 rounded-md
            ${highlight
              ? (isGood ? 'bg-white/20 text-white' : 'bg-red-500/30 text-red-200')
              : (isGood
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400')}`}>
            {trendUp ? '▲' : '▼'} {Math.abs(trend)}%
          </span>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   RATE PILL
   ═══════════════════════════════════════════════════════════════════ */

function RatePill({ value, thresholds }: { value: number; thresholds: [number, number] }) {
  const [low, high] = thresholds;
  const good   = value >= high;
  const medium = !good && value >= low;
  return (
    <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-bold
      ${good
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
        : medium
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
          : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'}`}>
      {fmtPct(value)}
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SECTION LABEL
   ═══════════════════════════════════════════════════════════════════ */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 whitespace-nowrap">
        {children}
      </h2>
      <span className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SAFQA AFFILIATE DASHBOARD — 5×4 colored metric grid (20 cards)
   ───────────────────────────────────────────────────────────────────
   A pure mirror of the Safqa webhook data + Meta ad spend. Order matches
   the design left→right, top→bottom across four rows of five.
   ═══════════════════════════════════════════════════════════════════ */

/** Money with up to 2 decimals + EGP suffix (matches the design's "EGP"). */
const fmtMoney = (n: number) =>
  `${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} EGP`;
/** Percentage with 2 decimals (e.g. 63.64%). */
const fmtPct2 = (n: number) => `${(Number.isFinite(n) ? n : 0).toFixed(2)}%`;

/** A few gentle sparkline paths (viewBox 0 0 100 24) reused decoratively. */
const SPARKS = [
  'M0,18 L14,16 L28,17 L42,9 L56,4 L70,11 L84,9 L100,14',
  'M0,14 L16,15 L32,10 L48,13 L64,6 L80,12 L100,8',
  'M0,16 L20,12 L36,17 L52,8 L68,14 L84,7 L100,12',
  'M0,12 L14,13 L30,8 L46,15 L62,11 L78,5 L100,13',
];

interface SafqaCard {
  title: string;
  value: string;
  sub:   string;
  /** Tailwind gradient classes for the card background. */
  grad:  string;
  /** Optional tone for the sub-caption (positive / negative coloring). */
  tone?: 'pos' | 'neg';
}

function SafqaMetricCard({ card, idx, loading }: { card: SafqaCard; idx: number; loading: boolean }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl px-4 pt-3.5 pb-6 shadow-md
      bg-gradient-to-br ${card.grad} ring-1 ring-white/10`}>
      {/* Title */}
      <p className="relative z-10 text-center text-[10px] font-bold uppercase tracking-widest
        text-white/85 leading-tight min-h-[26px] flex items-center justify-center">
        {card.title}
      </p>
      {/* Main value */}
      <div className="relative z-10 text-center mt-0.5">
        <span className="text-2xl font-extrabold text-white tracking-tight drop-shadow-sm">
          {loading ? '…' : card.value}
        </span>
      </div>
      {/* Trend / sub indicator */}
      <p className={`relative z-10 text-center text-[11px] font-semibold mt-1.5 leading-snug
        ${card.tone === 'neg' ? 'text-rose-100' : card.tone === 'pos' ? 'text-emerald-100' : 'text-white/75'}`}>
        {loading ? '' : card.sub}
      </p>
      {/* Decorative sparkline */}
      <svg className="pointer-events-none absolute bottom-0 left-0 w-full h-7 opacity-25"
        viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
        <path d={SPARKS[idx % SPARKS.length]} fill="none" stroke="white" strokeWidth="1.6"
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function SafqaAffiliateGrid({ s, loading }: { s: ExternalNetworkStat; loading: boolean }) {
  /* Safe reads — every field defaults to 0 (disconnected → clean zero grid). */
  const orders          = s.orders               ?? 0;
  const profit          = s.profit               ?? 0;
  const confirmed       = s.confirmed            ?? 0;
  const profitConfirmed = s.profitConfirmed      ?? 0;
  const delivered       = s.delivered            ?? 0;
  const profitDelivered = s.profitDelivered      ?? 0;
  const inProgress      = s.inProgressOrders     ?? 0;
  const pending         = s.pending              ?? 0;
  const onHold          = s.onHold               ?? 0;
  const profitInProg    = s.profitInProgress     ?? 0;
  const futureBalance   = s.futureBalance        ?? 0;
  const cr              = s.cr                    ?? 0;
  const dr              = s.dr                    ?? 0;
  const ndr             = s.ndr                   ?? 0;
  const avgProfit       = s.avgProfit            ?? 0;
  const maxCpp          = s.maxCpp               ?? 0;
  const ads             = s.ads                   ?? 0;
  const cpp             = s.cpp                   ?? 0;
  const netProfit       = s.netProfit            ?? 0;
  const forecasted      = s.forecastedNetProfit  ?? 0;

  const cards: SafqaCard[] = [
    /* ── Row 1 ─────────────────────────────────────────────────────────── */
    { title: 'ORDERS',            value: fmt(orders),             sub: 'إجمالي الطلبات',          grad: 'from-sky-500 to-blue-600' },
    { title: 'PROFIT',            value: fmtMoney(profit),        sub: 'إجمالي الأرباح',          grad: 'from-indigo-500 to-violet-600' },
    { title: 'ORDERS CONFIRMED',  value: fmt(confirmed),          sub: `معدل التأكيد ${fmtPct2(cr)}`, grad: 'from-orange-500 to-amber-600' },
    { title: 'PROFIT (CONFIRMED)',value: fmtMoney(profitConfirmed), sub: 'أرباح الطلبات المؤكدة', grad: 'from-orange-500 to-orange-700' },
    { title: 'ORDERS DELIVERED',  value: fmt(delivered),          sub: `معدل التسليم ${fmtPct2(dr)}`, grad: 'from-emerald-500 to-green-600' },
    /* ── Row 2 ─────────────────────────────────────────────────────────── */
    { title: 'PROFIT (DELIVERED)',value: fmtMoney(profitDelivered), sub: 'الأرباح المُحقّقة',     grad: 'from-green-500 to-emerald-700' },
    { title: 'ORDERS (IN PROGRESS)', value: fmt(inProgress),      sub: 'قيد التنفيذ والشحن',      grad: 'from-purple-500 to-fuchsia-600' },
    { title: 'PENDING CONFIRMATION', value: fmt(pending),         sub: 'بانتظار التأكيد',          grad: 'from-blue-500 to-indigo-600' },
    { title: 'معلق مؤقتاً',        value: fmt(onHold),             sub: 'طلبات معلّقة مؤقتاً',      grad: 'from-violet-500 to-purple-700' },
    { title: 'PROFIT (IN PROGRESS)', value: fmtMoney(profitInProg), sub: 'أرباح قيد التنفيذ',     grad: 'from-fuchsia-500 to-purple-600' },
    /* ── Row 3 ─────────────────────────────────────────────────────────── */
    { title: 'F.B (IN PROGRESS)', value: fmtMoney(futureBalance), sub: 'رصيد مستقبلي متوقّع',     grad: 'from-purple-500 to-violet-700' },
    { title: 'CR',                value: fmtPct2(cr),             sub: 'نسبة التأكيد',             grad: 'from-amber-500 to-yellow-600' },
    { title: 'DR',                value: fmtPct2(dr),             sub: 'نسبة التسليم',             grad: 'from-teal-500 to-cyan-600' },
    /* NDR is now "Net Delivery Rate" (delivered/total): high = GOOD, so the sub
       shows the delivered count and the tone flags LOW rates (not high). */
    { title: 'NDR',               value: fmtPct2(ndr),            sub: `تسليم ${fmt(delivered)} طلب`, grad: 'from-emerald-500 to-teal-600', tone: ndr >= 50 ? 'pos' : (ndr < 35 ? 'neg' : undefined) },
    { title: 'AVG PROFIT',        value: fmtMoney(avgProfit),     sub: 'ربح لكل طلب مُسلَّم',      grad: 'from-cyan-500 to-sky-600' },
    /* ── Row 4 ─────────────────────────────────────────────────────────── */
    { title: 'MAX CPP',           value: fmtMoney(maxCpp),        sub: 'أقصى تكلفة آمنة للطلب',    grad: 'from-rose-500 to-red-600' },
    { title: 'CPP',               value: fmtMoney(cpp),           sub: 'تكلفة الطلب الفعلية',      grad: 'from-red-500 to-rose-600' },
    { title: 'ADS',               value: fmtMoney(ads),           sub: 'إجمالي الإنفاق الإعلاني',  grad: 'from-red-500 to-red-700' },
    { title: 'NET PROFIT',        value: fmtMoney(netProfit),     sub: netProfit >= 0 ? 'ربح صافٍ' : 'خسارة صافية', grad: 'from-amber-500 to-yellow-600', tone: netProfit >= 0 ? 'pos' : 'neg' },
    { title: 'FORECASTED NET PROFIT', value: fmtMoney(forecasted), sub: 'بعد وصول الطلبات الجارية', grad: 'from-yellow-500 to-amber-600', tone: forecasted >= 0 ? 'pos' : 'neg' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3" dir="ltr">
      {cards.map((card, idx) => (
        <SafqaMetricCard key={card.title} card={card} idx={idx} loading={loading} />
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   FILTER SELECT
   ═══════════════════════════════════════════════════════════════════ */

function FilterSelect({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-2 text-sm rounded-xl border outline-none cursor-pointer
        bg-white dark:bg-slate-900
        border-slate-300 dark:border-slate-700
        text-slate-700 dark:text-slate-300
        focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition"
    >
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MEDIA-BUYER SELECT  (Admin-only — agency model impersonation/filter)
   value = the buyer's user id ('' = all buyers). Disabled while loading.
   ═══════════════════════════════════════════════════════════════════ */
function MediaBuyerSelect({ value, onChange, buyers, loading }: {
  value: string; onChange: (v: string) => void; buyers: MediaBuyer[]; loading: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={loading}
      title="فلترة حسب الميديا باير"
      className="px-3 py-2 text-sm rounded-xl border outline-none cursor-pointer
        bg-white dark:bg-slate-900
        border-slate-300 dark:border-slate-700
        text-slate-700 dark:text-slate-300
        focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition
        disabled:opacity-60 disabled:cursor-wait"
    >
      <option value="">{loading ? 'جارٍ تحميل الميديا باير…' : '👥 كل الميديا باير'}</option>
      {/* Pseudo-buyer: ORGANIC orders (marketer='main_account', no referral code). */}
      <option value="main_account">🏠 الحساب الأساسي (طلبات بدون كود)</option>
      {buyers.map((b) => (
        <option key={b.id} value={b.id}>{b.name?.trim() || b.email}</option>
      ))}
    </select>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   DATE INPUT
   ═══════════════════════════════════════════════════════════════════ */

function DateInput({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      dir="ltr"
      className="px-3 py-2 text-sm rounded-xl border outline-none cursor-pointer
        bg-white dark:bg-slate-900
        border-slate-300 dark:border-slate-700
        text-slate-700 dark:text-slate-300
        focus:ring-2 focus:ring-indigo-400 focus:border-transparent
        placeholder-slate-400 dark:placeholder-slate-600 transition"
    />
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CHART VIEW TOGGLE
   ═══════════════════════════════════════════════════════════════════ */

function ChartToggle({ view, onToggle }: { view: ChartView; onToggle: (v: ChartView) => void }) {
  return (
    <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
      {([
        { value: 'orders', label: 'الطلبات', icon: '📦' },
        { value: 'profit', label: 'الأرباح',  icon: '💰' },
      ] as { value: ChartView; label: string; icon: string }[]).map((opt) => (
        <button
          key={opt.value}
          onClick={() => onToggle(opt.value)}
          className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg
            transition-all duration-150
            ${view === opt.value
              ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
        >
          <span>{opt.icon}</span>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CHAMPIONS LEAGUE — rank style helpers
   ═══════════════════════════════════════════════════════════════════ */

function rankCardCls(rank: number): string {
  if (rank === 1) return 'from-amber-50  via-white to-white border-amber-200  dark:from-amber-900/20  dark:via-slate-900 dark:to-slate-900 dark:border-amber-700/40';
  if (rank === 2) return 'from-slate-50  via-white to-white border-slate-200  dark:from-slate-700/20  dark:via-slate-900 dark:to-slate-900 dark:border-slate-600/40';
  if (rank === 3) return 'from-orange-50 via-white to-white border-orange-200 dark:from-orange-900/20 dark:via-slate-900 dark:to-slate-900 dark:border-orange-700/40';
  return               'from-indigo-50/50 via-white to-white border-indigo-100 dark:from-indigo-900/10 dark:via-slate-900 dark:to-slate-900 dark:border-indigo-800/30';
}
function rankBadgeCls(rank: number): string {
  if (rank === 1) return 'bg-amber-100  text-amber-700  border border-amber-300  dark:bg-amber-400/20  dark:text-amber-300  dark:border-amber-500/30';
  if (rank === 2) return 'bg-slate-100  text-slate-600  border border-slate-300  dark:bg-slate-400/20  dark:text-slate-300  dark:border-slate-500/30';
  if (rank === 3) return 'bg-orange-100 text-orange-700 border border-orange-300 dark:bg-orange-400/20 dark:text-orange-300 dark:border-orange-500/30';
  return               'bg-indigo-100 text-indigo-600 border border-indigo-200 dark:bg-indigo-400/20 dark:text-indigo-400 dark:border-indigo-500/30';
}
function rankScoreCls(rank: number): string {
  if (rank === 1) return 'text-amber-600  dark:text-amber-400';
  if (rank === 2) return 'text-slate-500  dark:text-slate-300';
  if (rank === 3) return 'text-orange-600 dark:text-orange-400';
  return               'text-indigo-600 dark:text-indigo-400';
}
function rankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════════════ */

export default function AnalyticsDashboard() {
  const router = useRouter();

  /* ── Permission guard ─────────────────────────────────────────── */
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!u) { router.replace('/'); return; }
      setIsAffiliate(u.plan_type === 'affiliate');
      /* Admins get the "filter by Media Buyer" dropdown; media buyers see a locked,
         self-scoped view (no dropdown) — the backend enforces the scope either way. */
      setIsAdmin(u.role === 'admin');
      /* Admins and Media Buyers always have analytics access. Other roles need
         the explicit 'analytics' permission. */
      if (u.role !== 'admin' && u.role !== 'media_buyer') {
        const perms: string[] = u.permissions ?? ['orders'];
        if (!perms.includes('analytics')) router.replace('/dashboard');
      }
    } catch {
      router.replace('/');
    }
  }, [router]);

  /* ── UI state ─────────────────────────────────────────────────── */
  const [activeRange, setActiveRange] = useState('7d');
  const [fromDate,    setFromDate]    = useState('');
  const [toDate,      setToDate]      = useState('');
  const [product,     setProduct]     = useState('كل المنتجات');
  const [status,      setStatus]      = useState('كل الحالات');
  const [chartView,   setChartView]   = useState<ChartView>('orders');
  const [isDark,      setIsDark]      = useState(false);
  /* True for affiliate-plan tenants — hides local-inventory metrics (COGS,
     stock, product profitability) and drives the core KPIs off external data. */
  const [isAffiliate, setIsAffiliate] = useState(false);
  /* Agency model: admins can filter/impersonate a specific media buyer. */
  const [isAdmin,            setIsAdmin]            = useState(false);
  const [mediaBuyer,         setMediaBuyer]         = useState('');   // '' = all buyers
  const [mediaBuyers,        setMediaBuyers]        = useState<MediaBuyer[]>([]);
  const [loadingMediaBuyers, setLoadingMediaBuyers] = useState(false);

  /* ── API data state ───────────────────────────────────────────── */
  const [products,             setProducts]             = useState<Product[]>([]);
  const [dashStats,            setDashStats]            = useState<DashboardStats | null>(null);
  const [loadingDash,          setLoadingDash]          = useState(false);
  const [errorDash,            setErrorDash]            = useState<string | null>(null);
  const [profitability,        setProfitability]        = useState<ProductProfitability[]>([]);
  const [loadingProfitability, setLoadingProfitability] = useState(false);
  const [businessProfile,      setBusinessProfile]      = useState<BusinessProfile | null>(null);

  /* ── Delivered Orders detailed list (collapsible, lazy-loaded) ──────────── */
  const [deliveredOpen,    setDeliveredOpen]    = useState(false);
  const [deliveredData,    setDeliveredData]    = useState<DeliveredOrdersResponse | null>(null);
  const [deliveredLoading, setDeliveredLoading] = useState(false);

  /* ── White-label branding (business name + logo) ────────────────── */
  useEffect(() => {
    let alive = true;
    getBusinessProfile()
      .then((res) => { if (alive) setBusinessProfile(res.data); })
      .catch(() => { if (alive) setBusinessProfile(null); });
    return () => { alive = false; };
  }, []);

  /* ── Compute effective API dates from the active range pill ──────
     This is the fix for the "date filter is ignored" bug.
     Quick-range pills now resolve to real YYYY-MM-DD boundaries
     that are sent to EVERY API call, just like the custom picker.  */
  const effectiveDates = useMemo(() => {
    if (fromDate || toDate) {
      return { startDate: fromDate || undefined, endDate: toDate || undefined };
    }
    /* Format a Date as YYYY-MM-DD in EGYPT local time (Africa/Cairo), NOT UTC.
       The old `d.toISOString()` shifted the date back by the UTC offset, so in
       the early hours of an Egypt day "today" became yesterday and "This Month"
       started on the previous month's last day (e.g. 2026-06-16 → 2026-06-15 and
       2026-06-01 → 2026-05-31). formatToParts keeps it deterministic across
       browsers regardless of the user's own timezone. */
    const pad = (d: Date) => {
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(d).reduce((acc, part) => {
        acc[part.type] = part.value; return acc;
      }, {} as Record<string, string>);
      return `${p.year}-${p.month}-${p.day}`;
    };

    /* Anchor all date math to Egypt's calendar "today" (parts derived above),
       using a noon-UTC pivot so ±day arithmetic never crosses an offset/DST edge.
       We only ever read these back through pad(), so the value stays Egypt-local. */
    const todayStr = pad(new Date());                       // e.g. "2026-06-16"
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const noonPivot = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day, 12));

    switch (activeRange) {
      case 'today':
        return { startDate: todayStr, endDate: todayStr };
      case 'yesterday': {
        const y = noonPivot(ty, tm, td); y.setUTCDate(y.getUTCDate() - 1);
        const s = pad(y);
        return { startDate: s, endDate: s };
      }
      case '7d': {
        const w = noonPivot(ty, tm, td); w.setUTCDate(w.getUTCDate() - 6);
        return { startDate: pad(w), endDate: todayStr };
      }
      case 'month':
        /* First day of Egypt's current month → strictly through today. */
        return { startDate: `${todayStr.slice(0, 7)}-01`, endDate: todayStr };
      default:
        return { startDate: undefined, endDate: undefined };
    }
  }, [activeRange, fromDate, toDate]);

  /* ── Data fetching ────────────────────────────────────────────── */
  const fetchProducts = useCallback(async () => {
    try {
      const res = await getProducts();
      setProducts(res.data);
    } catch { /* non-admin gets 403 — swallow silently */ }
  }, []);

  const fetchDashStats = useCallback(async (sd?: string, ed?: string, prod?: string, mb?: string) => {
    setLoadingDash(true);
    setErrorDash(null);
    try {
      const res = await getDashboardStats(sd, ed, prod, mb);
      setDashStats(res.data);
    } catch (err: unknown) {
      setDashStats(null);
      /* Surface the server-side error detail so the UI doesn't spin forever */
      const axiosErr = err as { response?: { data?: { details?: string; error?: string } } };
      const detail   = axiosErr?.response?.data?.details
                    ?? axiosErr?.response?.data?.error
                    ?? 'فشل تحميل بيانات لوحة التحكم. تحقق من الخادم.';
      setErrorDash(detail);
      console.error('[fetchDashStats] Error:', err);
    } finally {
      setLoadingDash(false);
    }
  }, []);

  const fetchProfitability = useCallback(async (sd?: string, ed?: string, prod?: string, mb?: string) => {
    setLoadingProfitability(true);
    try {
      const res = await getProductsProfitability(sd, ed, prod, mb);
      setProfitability(res.data);
    } catch {
      setProfitability([]);
    } finally {
      setLoadingProfitability(false);
    }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  /* Media buyers list — admins only (the endpoint 403s anyone else). Fetched once;
     degrade to [] on error so the dropdown still renders with just "all buyers". */
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    setLoadingMediaBuyers(true);
    getMediaBuyers()
      .then((res) => { if (alive) setMediaBuyers(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { if (alive) setMediaBuyers([]); })
      .finally(() => { if (alive) setLoadingMediaBuyers(false); });
    return () => { alive = false; };
  }, [isAdmin]);

  useEffect(() => {
    fetchDashStats(effectiveDates.startDate, effectiveDates.endDate, product, mediaBuyer);
  }, [effectiveDates, product, mediaBuyer, fetchDashStats]);

  useEffect(() => {
    fetchProfitability(effectiveDates.startDate, effectiveDates.endDate, product, mediaBuyer);
  }, [effectiveDates, product, mediaBuyer, fetchProfitability]);

  /* Delivered-orders list: lazy-loaded only while the section is expanded;
     refetches on date-range or product change so it always matches the filters. */
  useEffect(() => {
    if (!deliveredOpen) return;
    let alive = true;
    setDeliveredLoading(true);
    getDeliveredOrders(effectiveDates.startDate, effectiveDates.endDate, product, mediaBuyer)
      .then((res) => { if (alive) setDeliveredData(res.data); })
      .catch(() => { if (alive) setDeliveredData({ total: 0, days: [] }); })
      .finally(() => { if (alive) setDeliveredLoading(false); });
    return () => { alive = false; };
  }, [deliveredOpen, effectiveDates, product, mediaBuyer]);

  /* ── Date picker handlers ─────────────────────────────────────── */
  const handleFromDate = (v: string) => { setFromDate(v); setActiveRange(''); };
  const handleToDate   = (v: string) => { setToDate(v);   setActiveRange(''); };
  const handleRange    = (v: string) => { setActiveRange(v); setFromDate(''); setToDate(''); };

  /* ── Dark mode sync ───────────────────────────────────────────── */
  useEffect(() => {
    const sync = () => setIsDark(document.documentElement.classList.contains('dark'));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const gridStroke = isDark ? '#1e293b' : '#e2e8f0';
  const tickFill   = isDark ? '#64748b' : '#94a3b8';
  const activeSeries = chartView === 'orders' ? ORDERS_SERIES : PROFIT_SERIES;

  /* ── Derived overview numbers ─────────────────────────────────── */
  const ov = dashStats?.overview;

  /* External affiliate networks (Taager / Safqa) — present only for affiliate
     plan tenants with connected keys. Undefined for every other plan. */
  const extStats = dashStats?.externalStats;

  /* Affiliate aggregates (Taager + Safqa). For an affiliate-plan tenant these
     REPLACE the local ERP/product figures, so every downstream KPI (rates, CPA,
     net profit) is computed from the real external-platform data. */
  const affOrders    = (extStats?.taager.orders    ?? 0) + (extStats?.safqa.orders    ?? 0);
  const affConfirmed = (extStats?.taager.confirmed ?? 0) + (extStats?.safqa.confirmed ?? 0);
  const affDelivered = (extStats?.taager.delivered ?? 0) + (extStats?.safqa.delivered ?? 0);
  const affRevenue   = extStats?.totalRevenue ?? 0;

  const totalOrders    = isAffiliate ? affOrders    : (ov?.total_orders    ?? 0);
  const totalConfirmed = isAffiliate ? affConfirmed : (ov?.total_confirmed ?? 0);
  const totalDelivered = isAffiliate ? affDelivered : (ov?.total_delivered ?? 0);
  const totalRejected  = ov?.total_rejected  ?? 0;
  const totalReturned  = ov?.total_returned  ?? 0;
  /* ── Logistics pipeline (LIVE snapshot — independent of the date filter) ──
     Forward-moving orders physically in Bosta toward the customer, and the COD
     riding with them. Affiliate plans don't run the local Bosta pipeline → 0. */
  const inTransitCount  = isAffiliate ? 0 : (ov?.in_transit_count ?? 0);
  const outstandingCash = isAffiliate ? 0 : (ov?.outstanding_cash ?? 0);
  /* Revenue: affiliate plan uses the combined external-platform revenue. */
  const totalRevenue   = isAffiliate ? affRevenue   : (ov?.total_revenue   ?? 0);
  const totalExpenses  = ov?.total_expenses  ?? 0;
  const metaSpend      = ov?.meta_spend      ?? 0;
  /* Meta-attributed purchases — used ONLY for ad-efficiency (CPP/CPA), NOT the
     Total Orders KPI (which is now the authoritative DB count above). */
  const metaOrders     = ov?.meta_orders     ?? 0;

  /* COGS summed from per-product profitability (most accurate source).
     RESPECTS the product dropdown: when a specific product is selected we sum
     only that product's row, so the COGS / Net-Profit KPIs change with the
     filter. (profitability is always fetched for the full catalogue — it feeds
     the dropdown options — so the scoping is done here on the client.)
     The dropdown value === product_name, so the match is exact.
     Guard each row's cogs with isFinite() so a single malformed product row
     cannot poison the whole sum with NaN.                                   */
  const totalCogs = useMemo(() => {
    const rows = (product && product !== 'كل المنتجات')
      ? profitability.filter((p) => p.product_name === product)
      : profitability;
    return rows.reduce((s, p) => s + (Number.isFinite(p.cogs) ? p.cogs : 0), 0);
  }, [profitability, product]);

  /* Affiliate marketers hold no stock → no Cost of Goods Sold. Local plans use
     the real per-product COGS sum. */
  const effectiveCogs = isAffiliate ? 0 : totalCogs;

  /* ── EXACT per-product shipping (Phase B1 / Option C) ──
     Σ of orders.actual_shipping_fee (real Bosta priceAfterVat) for the product's
     delivered orders, summed from profitability exactly like COGS and scoped to
     the dropdown. This hits the per-product MARGIN; the prepaid shipping bundle
     stays separately inside the OPEX shared bucket (additive cash-basis). */
  const totalShipping = useMemo(() => {
    const rows = (product && product !== 'كل المنتجات')
      ? profitability.filter((p) => p.product_name === product)
      : profitability;
    return rows.reduce((s, p) => s + (Number.isFinite(p.shipping_cost) ? (p.shipping_cost as number) : 0), 0);
  }, [profitability, product]);

  /* Affiliates don't ship physical stock → no per-AWB shipping cost. */
  const effectiveShipping = isAffiliate ? 0 : totalShipping;

  /* ── True OPEX (operating expenses) from the treasury ledger — Path A+ model ──
     The backend splits OPEX into two buckets:
       • commissions  → attributed EXACTLY per product (opex_commission_by_product),
                        since every commission row links to a specific order/product.
       • shared costs → shipping / packaging / operational / SaaS — no product link,
                        so we split them by DELIVERED-ORDER COUNT (not revenue): a
                        cheap and an expensive product cost ~the same to ship & pack.
     When a product is selected:  effectiveOpex = exactCommission(product)
                                                + sharedTotal × (productUnits ÷ totalUnits)
     For "all products":          ratio = 1, exactCommission = commissions_total
                                   → effectiveOpex = full business OPEX. */
  const totalOpex            = ov?.operating_expenses     ?? 0;
  const opexCommissionsTotal = ov?.opex_commissions_total ?? 0;
  const opexSharedTotal      = ov?.opex_shared_total      ?? 0;
  const commissionByProduct  = ov?.opex_commission_by_product ?? {};

  /* Delivered-order-count weight for the SHARED-cost split. */
  const opexCountRatio = useMemo(() => {
    if (!product || product === 'كل المنتجات') return 1;
    const totalUnits = profitability.reduce(
      (s, p) => s + (Number.isFinite(p.units_delivered) ? p.units_delivered : 0), 0);
    if (totalUnits <= 0) return 0;
    const prodUnits = profitability
      .filter((p) => p.product_name === product)
      .reduce((s, p) => s + (Number.isFinite(p.units_delivered) ? p.units_delivered : 0), 0);
    return prodUnits / totalUnits;
  }, [profitability, product]);

  /* Exact commission for the current scope (per product, or the full total). */
  const effectiveCommission = useMemo(() => {
    if (!product || product === 'كل المنتجات') return opexCommissionsTotal;
    return commissionByProduct[product] ?? 0;
  }, [product, opexCommissionsTotal, commissionByProduct]);

  /* Affiliates don't use the product split → carry the OPEX they logged as-is. */
  const effectiveOpex = isAffiliate
    ? totalOpex
    : effectiveCommission + opexSharedTotal * opexCountRatio;

  /* OPEX card cost-stack label: one EXACT commission line + each shared (non-comm)
     source scaled by the delivered-order-count ratio. Reflects the Path A+ split
     the headline uses, so the lines reconcile with effectiveOpex. */
  const opexCardSub = useMemo(() => {
    const parts: string[] = [];
    if (effectiveCommission > 0) parts.push(`عمولات: ${fmtEGP(Math.round(effectiveCommission))}`);
    for (const o of (ov?.opex_breakdown ?? [])) {
      if (String(o.source).startsWith('comm_')) continue;   // commissions shown exact above
      parts.push(`${o.label}: ${fmtEGP(Math.round(o.amount * opexCountRatio))}`);
    }
    return parts.length ? parts.join(' · ') : 'عمولات + شحن + تغليف + تشغيل';
  }, [ov, effectiveCommission, opexCountRatio]);

  /* TRUE Net Profit (Option C — additive cash-basis):
       revenue − COGS − ad spend − OPEX(treasury, incl. prepaid shipping bundle)
               − exact per-AWB shipping (real Bosta deduction per product).
     Both shipping outlays are real cash: the bundle is a shared OPEX lump, the
     per-AWB fees are the exact surcharge/post-bundle hits on each product's
     margin. All operands guarded to finite numbers above / via ?? 0. */
  const netProfit = (Number.isFinite(totalRevenue)     ? totalRevenue     : 0)
                  - (Number.isFinite(effectiveCogs)    ? effectiveCogs    : 0)
                  - (Number.isFinite(totalExpenses)    ? totalExpenses    : 0)
                  - (Number.isFinite(effectiveOpex)    ? effectiveOpex    : 0)
                  - (Number.isFinite(effectiveShipping)? effectiveShipping: 0);

  /* Forecasted Net Profit — where the bottom line should land once the current
     logistics pipeline settles. Heuristic: realised net profit + 50% of the COD
     still on the road (a delivery-rate-discounted estimate of pipeline profit). */
  const forecastedNetProfit = netProfit + (Number.isFinite(outstandingCash) ? outstandingCash : 0) * 0.5;

  /* Rates (percentages) — guard against division by zero */
  const cr    = totalOrders    > 0 ? totalConfirmed / totalOrders    * 100 : 0;
  const dr    = totalConfirmed > 0 ? totalDelivered / totalConfirmed * 100 : 0;
  const ndr   = totalOrders    > 0 ? totalDelivered / totalOrders    * 100 : 0;
  const cpp   = metaOrders     > 0 ? metaSpend / metaOrders     : 0;
  const trueCPA = totalDelivered > 0 ? metaSpend / totalDelivered : 0;
  const avgProfit = totalDelivered > 0 ? netProfit / totalDelivered : 0;

  /* Global Break-Even CPP (نقطة التعادل) — the absolute maximum a media buyer can
     spend to ACQUIRE one order before the store loses money, using the real
     blended unit economics:
       Net Profit BEFORE Ads = delivered revenue − COGS − Bosta shipping − OPEX
       Break-Even MAX CPP    = Net Profit Before Ads ÷ Total Orders (DB count)
     Divided by total PLACED orders (DB count) so it is 1:1 comparable with the
     live CPP, which is also per placed order. (Affiliate view has its own MAX
     CPP inside SafqaAffiliateGrid — this only drives the e-commerce card.) */
  const maxCpp = useMemo(() => {
    const netProfitBeforeAds =
        (Number.isFinite(totalRevenue)      ? totalRevenue      : 0)
      - (Number.isFinite(effectiveCogs)     ? effectiveCogs     : 0)
      - (Number.isFinite(effectiveShipping) ? effectiveShipping : 0)
      - (Number.isFinite(effectiveOpex)     ? effectiveOpex     : 0);
    return totalOrders > 0 ? netProfitBeforeAds / totalOrders : 0;
  }, [totalRevenue, effectiveCogs, effectiveShipping, effectiveOpex, totalOrders]);

  /* ── Chart data — maps daily_chart_stats to Recharts shape ─────── */
  const chartData = useMemo(() => {
    if (!dashStats?.daily_chart_stats?.length) return [];
    /* Estimate per-day COGS using average COGS/delivery across all products */
    const avgCogsPer = totalDelivered > 0 ? totalCogs / totalDelivered : 0;
    /* Distribute OPEX + exact shipping across the period's deliveries so the
       daily Net-Profit line reconciles with the headline KPI. */
    const avgOpexPer = totalDelivered > 0 ? effectiveOpex     / totalDelivered : 0;
    const avgShipPer = totalDelivered > 0 ? effectiveShipping / totalDelivered : 0;
    return dashStats.daily_chart_stats.map((s) => {
      const dayRevenue    = s.revenue;
      const dayCogsEst    = Math.round(s.delivered * avgCogsPer);
      const dayOpexEst    = Math.round(s.delivered * avgOpexPer);
      const dayShipEst    = Math.round(s.delivered * avgShipPer);
      const grossMargin   = Math.round(dayRevenue - dayCogsEst);
      const dayNetProfit  = Math.round(grossMargin - s.ads_spend - dayOpexEst - dayShipEst);
      return {
        date:        fmtDateArabic(s.date),
        iso:         s.date,
        orders:      s.orders,
        confirmed:   s.confirmed,
        delivered:   s.delivered,
        adsSpend:    Math.round(s.ads_spend),
        grossMargin,
        netProfit:   dayNetProfit,
      };
    });
  }, [dashStats, totalCogs, totalDelivered, effectiveOpex, effectiveShipping]);

  /* ── Rejection donut chart data ───────────────────────────────── */
  const rejectionData = useMemo(() => {
    if (!dashStats?.rejection_reasons?.length) return [];
    return dashStats.rejection_reasons.map((r, i) => ({
      name:  r.reason,
      value: r.count,
      color: REJECTION_COLORS[i % REJECTION_COLORS.length],
    }));
  }, [dashStats]);

  const rejectionTotal = useMemo(
    () => rejectionData.reduce((s, r) => s + r.value, 0),
    [rejectionData]
  );

  /* ── Governorates table data ──────────────────────────────────── */
  const govData = useMemo(() => {
    if (!dashStats?.governorates_stats?.length) return [];
    return dashStats.governorates_stats.map((g) => {
      const crPct  = g.total_orders > 0 ? parseFloat((g.confirmed / g.total_orders * 100).toFixed(1)) : 0;
      const drPct  = g.confirmed    > 0 ? parseFloat((g.delivered / g.confirmed    * 100).toFixed(1)) : 0;
      const ndrPct = (g.delivered + g.returned) > 0
        ? parseFloat((g.delivered / (g.delivered + g.returned) * 100).toFixed(1))
        : 0;
      return {
        name:           g.governorate,
        orders:         g.total_orders,
        confirmed:      g.confirmed,
        delivered:      g.delivered,
        revenue:        g.revenue,
        cr:             crPct,
        dr:             drPct,
        ndr:            ndrPct,
      };
    });
  }, [dashStats]);

  const govTotals = useMemo(() => govData.reduce(
    (a, g) => ({
      orders:    a.orders    + g.orders,
      confirmed: a.confirmed + g.confirmed,
      delivered: a.delivered + g.delivered,
      revenue:   a.revenue   + g.revenue,
    }),
    { orders: 0, confirmed: 0, delivered: 0, revenue: 0 }
  ), [govData]);

  /* ── Product table data ───────────────────────────────────────── */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tableProductData: any[] = useMemo(() => {
    if (profitability.length === 0) return [];
    /* GLOBAL PRODUCT FILTER: when a product is selected, the detailed table shows
       ONLY that product's row (the dropdown value is the product_name). */
    const scoped = (product && product !== 'كل المنتجات')
      ? profitability.filter((p) => p.product_name === product)
      : profitability;
    return scoped.map((item) => {
      const stockMatch = products.find(
        (p) =>
          (p.sku && item.sku && p.sku.toUpperCase() === item.sku.toUpperCase()) ||
          p.name === item.product_name
      );
      const itemNdr =
        item.total_orders > 0
          ? parseFloat(((item.units_delivered / item.total_orders) * 100).toFixed(1))
          : 0;
      /* Bulletproof numeric coercion — product stubs (e.g. from a Taager sync)
         may carry 0 / null costs, so every value falls back to a finite number. */
      const safe = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      /* DB-sourced counts (date-filtered): total = all statuses, confirmed = confirmed+.
         CR% = confirmed ÷ total DB orders × 100 (null only when there are no orders). */
      const dbOrders      = safe(item.total_orders);
      const confirmedOrds = safe(item.confirmed_orders ?? item.erp_orders);
      const crPct         = dbOrders > 0
        ? parseFloat(((confirmedOrds / dbOrders) * 100).toFixed(1))
        : null;
      return {
        name:            item.product_name ?? '—',
        sku:             item.sku ?? '',
        stock:           safe(stockMatch?.stock_quantity),
        orders:          dbOrders,
        confirmed:       confirmedOrds,
        delivered:       safe(item.units_delivered),
        /* RAW delivered revenue — every deduction is now its own column. */
        revenue:         safe(item.delivered_revenue),
        adsSpend:        safe(item.attributed_ad_spend),
        cogs:            safe(item.cogs),
        shipping:        safe(item.shipping_cost),     // per-product Bosta shipping
        opex:            safe(item.opex_allocated),    // Path A+ allocated OPEX
        actualCpp:       safe(item.actual_cpp),        // affiliate: ad spend ÷ orders
        maxCpp:          safe(item.max_cpp),           // affiliate: break-even CPP
        cr:              crPct,
        /* Product Delivery Rate = delivered ÷ shipped (from the backend).
           null (→ "—") only when nothing was shipped yet, so the rate is N/A. */
        dr:              item.units_shipped > 0 ? safe(item.delivery_rate) : null,
        ndr:             safe(itemNdr),
        netProfit:       safe(item.net_profit),
      };
    });
  }, [profitability, products, product]);

  /* ── PRODUCTS dropdown (built from real profitability data) ────── */
  const PRODUCTS = useMemo(
    () => ['كل المنتجات', ...profitability.map((p) => p.product_name)],
    [profitability]
  );

  /* ── AI Insights: winner + loser from profitability ───────────── */
  const aiWinner = useMemo(
    () => [...profitability].sort((a, b) => b.net_profit - a.net_profit)[0] ?? null,
    [profitability]
  );
  const aiLoser = useMemo(() => {
    const losers = profitability
      .filter((p) => p.net_profit < 0)
      .sort((a, b) => a.net_profit - b.net_profit);
    return losers[0] ?? null;
  }, [profitability]);

  /* ── Chart period label ───────────────────────────────────────── */
  const chartPeriodLabel = (() => {
    if (!chartData.length) return 'لا توجد بيانات';
    const first = chartData[0].date;
    const last  = chartData[chartData.length - 1].date;
    if (fromDate || toDate) return chartData.length === 1 ? first : `${first} — ${last}`;
    const rangeLabel = DATE_RANGES.find((r) => r.value === activeRange)?.label;
    if (!rangeLabel) return chartData.length === 1 ? first : `${first} — ${last}`;
    return chartData.length === 1
      ? `${rangeLabel} · ${first}`
      : `${rangeLabel} · ${first} — ${last}`;
  })();

  /* ══════════════════════════════════════════════════════════════ */

  return (
    <div dir="rtl" className="min-h-full">
      <div className="max-w-screen-2xl mx-auto px-6 pt-8 pb-12 space-y-6">

        {/* ── White-label branding banner (hidden gracefully if no profile) ── */}
        {businessProfile && (businessProfile.brand_name || businessProfile.logo_url) && (
          <div className="flex items-center gap-4 rounded-2xl border border-slate-200 dark:border-slate-800
            bg-gradient-to-l from-white via-white to-indigo-50/40
            dark:from-slate-900 dark:via-slate-900 dark:to-indigo-900/10
            px-6 py-5 shadow-sm">
            {businessProfile.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={businessProfile.logo_url}
                alt={businessProfile.brand_name || 'logo'}
                className="w-14 h-14 rounded-xl object-contain bg-white border border-slate-200
                  dark:border-slate-700 shrink-0 shadow-sm"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="w-14 h-14 rounded-xl shrink-0 flex items-center justify-center
                bg-indigo-600 text-white text-xl font-bold shadow-sm">
                {(businessProfile.brand_name || '؟').trim().charAt(0)}
              </div>
            )}
            <div className="min-w-0">
              {businessProfile.brand_name && (
                <h2 className="text-lg sm:text-xl font-extrabold text-gray-900 dark:text-white leading-tight truncate">
                  {businessProfile.brand_name}
                </h2>
              )}
              {businessProfile.industry && (
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                  {businessProfile.industry}
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Page header ─────────────────────────────────────────── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">
              لوحة التحليلات الشاملة
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              بيانات متكاملة — EasyOrders · تأكيد الطلبات · Bosta · Meta Ads
            </p>
          </div>
          <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs shadow-sm shrink-0
            bg-white dark:bg-slate-900 border
            ${errorDash && !loadingDash
              ? 'border-red-300 dark:border-red-800 text-red-500 dark:text-red-400'
              : 'border-slate-200 dark:border-slate-800 text-slate-400 dark:text-slate-500'}`}>
            <span className={`w-2 h-2 rounded-full shrink-0
              ${loadingDash ? 'bg-amber-400 animate-pulse'
              : errorDash   ? 'bg-red-500'
                            : 'bg-emerald-500'}`} />
            {loadingDash ? 'جارٍ التحميل...'
             : errorDash  ? 'خطأ في الخادم — راجع التفاصيل أدناه'
                          : 'بيانات حقيقية من قاعدة البيانات ✓'}
          </div>
        </div>

        {/* ── Dashboard API error banner ──────────────────────────── */}
        {errorDash && !loadingDash && (
          <div className="flex items-start gap-3 rounded-2xl border border-red-300 dark:border-red-800/60
            bg-red-50 dark:bg-red-950/30 px-5 py-4 text-sm">
            <svg className="w-5 h-5 text-red-500 dark:text-red-400 shrink-0 mt-0.5"
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667
                   1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464
                   0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-red-700 dark:text-red-400 mb-0.5">
                خطأ في تحميل بيانات لوحة التحكم
              </p>
              <p className="text-red-600/80 dark:text-red-400/70 text-xs leading-relaxed font-mono break-all">
                {errorDash}
              </p>
            </div>
            <button
              onClick={() => fetchDashStats(effectiveDates.startDate, effectiveDates.endDate)}
              className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold
                bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300
                hover:bg-red-200 dark:hover:bg-red-900/60 transition"
            >
              إعادة المحاولة
            </button>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            SECTION 1 — Advanced Filters
            ══════════════════════════════════════════════════════════ */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border
          border-slate-200 dark:border-slate-800 p-4 shadow-sm space-y-3">

          <p className="text-[11px] font-bold uppercase tracking-widest
            text-slate-400 dark:text-slate-500">
            فلاتر متقدمة
          </p>

          {/* Row 1: quick ranges + dropdowns + export */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl shrink-0">
              {DATE_RANGES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => handleRange(r.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150
                    ${activeRange === r.value
                      ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <FilterSelect value={status}   onChange={setStatus}   options={STATUSES}  />
            <FilterSelect value={product}  onChange={setProduct}  options={PRODUCTS}  />

            {/* Media-Buyer filter — ADMIN ONLY. Media buyers get a locked, self-scoped
                view (no dropdown); the backend enforces isolation regardless. */}
            {isAdmin && (
              <MediaBuyerSelect
                value={mediaBuyer}
                onChange={setMediaBuyer}
                buyers={mediaBuyers}
                loading={loadingMediaBuyers}
              />
            )}

            <button className="mr-auto flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
              bg-indigo-600 hover:bg-indigo-700 text-white transition shadow-sm shrink-0">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              تصدير التقرير
            </button>
          </div>

          {/* Row 2: custom date range picker */}
          <div className="flex flex-wrap items-center gap-2 pt-1
            border-t border-slate-100 dark:border-slate-800">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0">
              نطاق مخصص:
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">من</span>
              <DateInput value={fromDate} onChange={handleFromDate} />
              <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">إلى</span>
              <DateInput value={toDate}   onChange={handleToDate}   />
            </div>
            {(fromDate || toDate) && (
              <button
                onClick={() => { setFromDate(''); setToDate(''); }}
                className="text-xs text-rose-500 hover:text-rose-700 dark:hover:text-rose-400
                  underline transition shrink-0"
              >
                مسح التاريخ
              </button>
            )}
            {effectiveDates.startDate && (
              <span className="text-xs text-indigo-500 dark:text-indigo-400 font-medium shrink-0">
                {effectiveDates.startDate}
                {effectiveDates.endDate && effectiveDates.endDate !== effectiveDates.startDate
                  ? ` → ${effectiveDates.endDate}` : ''}
              </span>
            )}
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            TOP SECTION — driven STRICTLY by isAffiliate.
            • isAffiliate  → the 20-metric Safqa grid (replaces the KPI cards).
            • !isAffiliate → the original e-commerce financial KPI cards.
            Everything BELOW this block renders for EVERYONE (both systems):
            Operations, Costs, charts, Champions League, Rejection Reasons,
            Product tables and Governorate tables.
            ═══════════════════════════════════════════════════════════ */}
        {isAffiliate ? (
          <div className="space-y-6">
            <div className="space-y-3">
              <SectionLabel>لوحة أداء الأفيليت</SectionLabel>
              {extStats?.safqa ? (
                <SafqaAffiliateGrid s={extStats.safqa} loading={loadingDash} />
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700
                  bg-white dark:bg-slate-900 p-10 text-center">
                  <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                    {loadingDash ? 'جارٍ تحميل بيانات صفقة…' : 'لا توجد بيانات من صفقة بعد'}
                  </p>
                </div>
              )}
            </div>

            {/* Taager (real GET integration) — kept as compact revenue cards. */}
            {extStats?.taager.connected && (
              <div className="space-y-3">
                <SectionLabel>أرباح منصة تاجر</SectionLabel>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <KPICard
                    label="أرباح منصة تاجر"
                    value={loadingDash ? '...' : fmtEGP(Math.round(extStats.taagerRevenue))}
                    subValue={loadingDash ? '' :
                      `${fmt(extStats.taager.orders)} طلب · تأكيد ${fmtPct(extStats.taager.confirmedRate)} · توصيل ${fmtPct(extStats.taager.deliveredRate)}`}
                    accent="text-orange-600 dark:text-orange-400"
                  />
                  <KPICard
                    label="إجمالي أرباح الأفليت"
                    value={loadingDash ? '...' : fmtEGP(Math.round(extStats.totalRevenue))}
                    subValue={`${fmt(extStats.totalOrders)} طلب من المنصات المتصلة`}
                    accent="text-violet-600 dark:text-violet-400"
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ══ E-commerce TOP: original financial KPI cards (5 cards) ══ */
          <div className="space-y-3">
            <SectionLabel>الأرقام المالية الرئيسية</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KPICard
              label="إجمالي الطلبات"
              value={loadingDash ? '...' : fmt(totalOrders)}
              subValue={loadingDash ? '...' : (isAffiliate ? 'إجمالي طلبات منصات الأفليت ✓' : 'عدد الطلبات الفعلي من قاعدة البيانات ✓')}
              trend={12}
              accent="text-slate-800 dark:text-white"
            />
            <KPICard
              label="إجمالي الإنفاق الإعلاني"
              value={loadingDash ? '...' : fmtEGP(Math.round(metaSpend))}
              subValue={dashStats ? 'Meta Ads — بيانات حقيقية ✓' : 'في انتظار البيانات...'}
              trend={8}
              trendGood={false}
              accent="text-rose-600 dark:text-rose-400"
            />
            <KPICard
              label="إجمالي الإيرادات"
              value={loadingDash ? '...' : fmtEGP(Math.round(totalRevenue))}
              subValue={dashStats
                ? (isAffiliate ? 'إجمالي إيرادات منصات الأفليت ✓' : 'إيرادات الطلبات المُسلَّمة ✓')
                : 'في انتظار البيانات...'}
              trend={15}
              accent="text-emerald-600 dark:text-emerald-400"
            />
            <KPICard
              label="صافي الربح النهائي"
              value={loadingDash ? '...' : fmtEGP(Math.round(netProfit))}
              subValue={dashStats
                ? (isAffiliate ? 'إيرادات الأفليت − المصروفات والإعلانات ✓' : 'إيرادات − تكلفة البضاعة − الإعلانات − الشحن الفعلي − المصاريف التشغيلية ✓')
                : 'في انتظار البيانات...'}
              trend={18}
              highlight
            />
            {/* Forecasted Net Profit — realised profit + 50% of the COD still on
                the road. Sits next to the True Net Profit card as a forward look. */}
            <KPICard
              label="صافي الربح المتوقع"
              value={loadingDash ? '...' : fmtEGP(Math.round(forecastedNetProfit))}
              subValue={loadingDash
                ? ''
                : `الحالي + 50% من المستحقات (${fmtEGP(Math.round(outstandingCash))}) قيد التحصيل`}
              trend={20}
              accent="text-indigo-600 dark:text-indigo-400"
            />
            </div>
          </div>
        )}
        {/* ═══ end TOP SECTION — BELOW renders for EVERYONE ═══ */}

        {/* Operations & Rates + Costs & Averages — hidden in the affiliate view
            (these legacy KPI rows are redundant with the 20-metric grid above).
            Visible ONLY for e-commerce accounts (!isAffiliate). */}
        {!isAffiliate && (
        <>
        {/* Row 2: Operations & Rates */}
        <div className="space-y-3">
          <SectionLabel>العمليات والمعدلات</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KPICard
              label="الطلبات المؤكدة"
              value={loadingDash ? '...' : fmt(totalConfirmed)}
              subValue={loadingDash ? '' : `معدل التأكيد: ${fmtPct(cr)}`}
              trend={1.2}
              accent="text-blue-600 dark:text-blue-400"
            />
            <KPICard
              label="الطلبات المُسلَّمة"
              value={loadingDash ? '...' : fmt(totalDelivered)}
              subValue={loadingDash ? '' : `DR: ${fmtPct(dr)} · NDR: ${fmtPct(ndr)}`}
              trend={-2.1}
              trendGood={false}
              accent="text-teal-600 dark:text-teal-400"
            />
            {/* Logistics pipeline (live) — replaces the old "بانتظار التأكيد" card.
                Forward-moving orders in Bosta + the COD riding with them. */}
            <KPICard
              label="طلبات في الطريق"
              value={loadingDash ? '...' : fmt(inTransitCount)}
              subValue="قيد التوصيل لدى بوسطة الآن"
              trend={4}
              accent="text-sky-600 dark:text-sky-400"
            />
            <KPICard
              label="مستحقات لدى الشحن"
              value={loadingDash ? '...' : fmtEGP(Math.round(outstandingCash))}
              subValue="COD متوقع على الطريق"
              trend={4}
              accent="text-cyan-600 dark:text-cyan-400"
            />
            <KPICard
              label="مُرجَّع / فشل التوصيل"
              value={loadingDash ? '...' : fmt(totalReturned)}
              subValue={loadingDash ? '' : `${fmtPct(totalOrders > 0 ? (totalReturned / totalOrders * 100) : 0)} من إجمالي الطلبات`}
              trend={3.5}
              trendGood={false}
              accent="text-red-600 dark:text-red-400"
            />
          </div>
        </div>

        {/* Row 3: Costs & Averages — 6 cards */}
        <div className="space-y-3">
          <SectionLabel>التكاليف والمتوسطات</SectionLabel>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <KPICard
              label="تكلفة الطلب (CPP/CPA)"
              value={loadingDash ? '...' : fmtEGP(parseFloat(cpp.toFixed(2)))}
              subValue="إنفاق Meta ÷ طلبات Meta"
              trend={6.2}
              trendGood={false}
              accent="text-violet-600 dark:text-violet-400"
            />
            {/* MAX CPP is derived from per-product profitability — hidden for
                affiliate tenants who hold no local products. */}
            {!isAffiliate && (
              <KPICard
                label="أقصى تكلفة للطلب (MAX CPP)"
                value={loadingProfitability ? '...' : fmtEGP(parseFloat(maxCpp.toFixed(2)))}
                subValue="نقطة التعادل (Break-Even) للمتجر"
                trend={41.5}
                trendGood={false}
                accent="text-red-600 dark:text-red-400"
              />
            )}
            <KPICard
              label="التكلفة الحقيقية (True CPA)"
              value={loadingDash ? '...' : fmtEGP(parseFloat(trueCPA.toFixed(2)))}
              subValue="إنفاق Meta ÷ الطلبات المُسلَّمة"
              trend={9.1}
              trendGood={false}
              accent="text-orange-600 dark:text-orange-400"
            />
            {/* Cost of Goods Sold — affiliate marketers buy no stock, so this
                metric is hidden entirely for the affiliate plan. */}
            {!isAffiliate && (
              <KPICard
                label="تكلفة البضاعة المباعة (COGS)"
                value={loadingProfitability ? '...' : fmtEGP(Math.round(totalCogs))}
                subValue={profitability.length > 0 ? 'تكلفة حقيقية من ربحية المنتجات ✓' : 'في انتظار بيانات المنتجات...'}
                trend={14.2}
                trendGood={false}
                accent="text-slate-600 dark:text-slate-400"
              />
            )}
            {/* Exact per-AWB shipping (Option C) — real Bosta deduction per
                delivered order, summed per product. The prepaid bundle is counted
                separately inside OPEX (additive cash-basis). */}
            {!isAffiliate && (
              <KPICard
                label="الشحن الفعلي (Bosta)"
                value={loadingProfitability ? '...' : fmtEGP(Math.round(totalShipping))}
                subValue={totalDelivered > 0
                  ? `رسوم Bosta الفعلية · ${fmtEGP(Math.round(totalShipping / totalDelivered))}/طلب`
                  : 'رسوم Bosta الفعلية لكل شحنة'}
                trend={5.2}
                trendGood={false}
                accent="text-amber-600 dark:text-amber-400"
              />
            )}
            {/* Operating expenses (OPEX) from the treasury ledger — commissions
                (exact per product), shipping, packaging, fixed/SaaS. Ad spend
                excluded (counted via Meta). Path A+: commissions exact, shared
                costs split by delivered-order count. */}
            {!isAffiliate && (
              <KPICard
                label="المصاريف التشغيلية (OPEX)"
                value={loadingDash ? '...' : fmtEGP(Math.round(effectiveOpex))}
                subValue={opexCardSub}
                trend={6.5}
                trendGood={false}
                accent="text-rose-600 dark:text-rose-400"
              />
            )}
            <KPICard
              label="متوسط الربح / توصيل"
              value={(loadingDash || loadingProfitability) ? '...' : fmtEGP(Math.round(avgProfit))}
              subValue="صافي الربح ÷ عدد التوصيلات"
              trend={3.8}
              accent="text-emerald-600 dark:text-emerald-400"
            />
            <KPICard
              label="المبيعات المرفوضة"
              value={loadingDash ? '...' : fmt(totalRejected)}
              subValue={loadingDash ? '' : `${fmtPct(totalOrders > 0 ? totalRejected / totalOrders * 100 : 0)} من إجمالي الطلبات`}
              trend={22}
              trendGood={false}
              accent="text-indigo-600 dark:text-indigo-400"
            />
          </div>
        </div>
        </>
        )}
        {/* ═══ end Operations & Costs (affiliate-hidden) ═══ */}

        {/* ══════════════════════════════════════════════════════════
            SECTION 2.5 — Delivered Orders (detailed, per delivery day)
            Lazy-loaded; respects the active date + product filters. Dated by
            the TRUE delivery day (delivered_at), not order-creation date.
            ══════════════════════════════════════════════════════════ */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap gap-y-2">
            <SectionLabel>الطلبات المُسلَّمة — تفصيلي</SectionLabel>
            <button
              onClick={() => setDeliveredOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg shrink-0
                bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100
                dark:bg-teal-900/20 dark:text-teal-400 dark:border-teal-800/50 transition"
            >
              {deliveredOpen ? 'إخفاء القائمة' : 'عرض قائمة المُسلَّم'}
              <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${deliveredOpen ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>

          {deliveredOpen && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
              {deliveredLoading ? (
                <div className="flex items-center justify-center py-16 gap-3 text-slate-400 text-sm">
                  <div className="w-6 h-6 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
                  جارٍ تحميل الطلبات المُسلَّمة...
                </div>
              ) : !deliveredData || deliveredData.days.length === 0 ? (
                <div className="py-14 text-center text-sm text-slate-400 dark:text-slate-600">
                  لا توجد طلبات مُسلَّمة في الفترة المحددة
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between gap-3 flex-wrap">
                    <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                      إجمالي المُسلَّم: {deliveredData.total} طلب
                    </span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">
                      مؤرَّخة بتاريخ التسليم الفعلي · تعكس فلاتر التاريخ والمنتج
                    </span>
                  </div>
                  {deliveredData.days.map((day) => (
                    <div key={day.date}>
                      <div className="px-5 py-2.5 bg-slate-50/60 dark:bg-slate-800/30 flex items-center justify-between gap-3">
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-200 whitespace-nowrap">
                          {fmtDateArabic(day.date)}
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {day.count} طلب · <span className="font-semibold text-emerald-600 dark:text-emerald-400">{fmtEGP(day.day_revenue)}</span>
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-100 dark:border-slate-800 text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                              {['العميل', 'الهاتف', 'المنتج', 'وقت التسليم', 'القيمة'].map((h) => (
                                <th key={h} className="px-4 py-2 text-right font-semibold whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {day.orders.map((o) => (
                              <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                                <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">{o.name}</td>
                                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-400 whitespace-nowrap" dir="ltr">{o.phone}</td>
                                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-400 max-w-[220px] truncate" title={o.product}>{o.product}</td>
                                <td className="px-4 py-2.5 text-slate-500 dark:text-slate-500 whitespace-nowrap" dir="ltr">{o.delivered_at}</td>
                                <td className="px-4 py-2.5 font-semibold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">{fmtEGP(o.value)}</td>
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
          )}
        </div>

        {/* ══════════════════════════════════════════════════════════
            SECTION 3 — AI Insights (dynamic from profitability)
            Hidden for affiliate tenants UNTIL they have product data
            (e.g. after a Taager sync populates the profitability rows).
            ══════════════════════════════════════════════════════════ */}
        {/* visible for EVERYONE — e-commerce & affiliate alike */}
        {true && (
        <div className="space-y-3">
          <SectionLabel>توصيات ذكية — AI Insights</SectionLabel>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* Winner */}
            <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800/40
              bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/30 dark:to-slate-900 p-5">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/60
                  flex items-center justify-center shrink-0 mt-0.5">
                  <svg className="w-5 h-5 text-emerald-600 dark:text-emerald-400"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-bold uppercase tracking-widest
                    text-emerald-600 dark:text-emerald-400">
                    🏆 ركّز على هذا — نجم الأداء
                  </span>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 leading-tight mt-0.5">
                    {loadingProfitability
                      ? '...'
                      : aiWinner
                        ? aiWinner.product_name
                        : 'لا توجد بيانات منتجات'}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                    {aiWinner
                      ? `أعلى صافي ربح في المحفظة (${fmtEGP(Math.round(aiWinner.net_profit))}) مع ${aiWinner.units_delivered} وحدة مُسلَّمة. نوصي بزيادة ميزانية الإعلانات 30–40% وإعادة استهداف الجمهور المتفاعل عبر Lookalike Audiences.`
                      : 'قم بتحديد نطاق زمني لعرض التوصيات.'}
                  </p>
                </div>
              </div>
              {aiWinner ? (
                <>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {[
                      { label: 'صافي الربح',  value: fmtEGP(Math.round(aiWinner.net_profit)),   color: 'text-emerald-700 dark:text-emerald-300' },
                      { label: 'NDR',          value: `${aiWinner.total_orders > 0 ? (aiWinner.units_delivered / aiWinner.total_orders * 100).toFixed(1) : '0.0'}%`, color: 'text-emerald-700 dark:text-emerald-300' },
                      { label: 'CPA الحقيقي', value: aiWinner.cpa !== null ? fmtEGP(parseFloat(aiWinner.cpa.toFixed(1))) : '—', color: 'text-emerald-700 dark:text-emerald-300' },
                    ].map((m) => (
                      <div key={m.label} className="bg-white dark:bg-slate-900 rounded-xl p-3 text-center
                        border border-emerald-100 dark:border-emerald-800/30">
                        <p className={`font-bold text-sm ${m.color}`}>{m.value}</p>
                        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{m.label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button className="flex-1 py-2 rounded-xl text-xs font-semibold
                      bg-emerald-600 hover:bg-emerald-700 text-white transition">
                      زيادة الميزانية الإعلانية
                    </button>
                    <button className="px-4 py-2 rounded-xl text-xs font-semibold
                      bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300
                      hover:bg-emerald-200 dark:hover:bg-emerald-900/60 transition">
                      عرض التقرير
                    </button>
                  </div>
                </>
              ) : !loadingProfitability && (
                <p className="text-xs text-slate-400 dark:text-slate-600 text-center py-4">
                  لا توجد منتجات رابحة للفترة المحددة
                </p>
              )}
            </div>

            {/* Loser */}
            <div className="rounded-2xl border border-red-200 dark:border-red-800/40
              bg-gradient-to-br from-red-50 to-white dark:from-red-950/30 dark:to-slate-900 p-5">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-900/60
                  flex items-center justify-center shrink-0 mt-0.5">
                  <svg className="w-5 h-5 text-red-600 dark:text-red-400"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667
                         1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464
                         0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-bold uppercase tracking-widest
                    text-red-600 dark:text-red-400">
                    ⚠️ راجع هذا فوراً — خسارة صافية
                  </span>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 leading-tight mt-0.5">
                    {loadingProfitability
                      ? '...'
                      : aiLoser
                        ? aiLoser.product_name
                        : 'لا توجد منتجات خاسرة ✓'}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                    {aiLoser
                      ? `خسارة صافية (${fmtEGP(Math.round(aiLoser.net_profit))}) مع ${aiLoser.units_delivered} وحدة مُسلَّمة فقط. أوقف الحملات الإعلانية فوراً وراجع التسعير وجودة المنتج قبل إعادة الإطلاق.`
                      : 'جميع المنتجات محققة لأرباح في الفترة المحددة.'}
                  </p>
                </div>
              </div>
              {aiLoser ? (
                <>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {[
                      { label: 'صافي الربح', value: fmtEGP(Math.round(aiLoser.net_profit)), color: 'text-red-700 dark:text-red-400' },
                      { label: 'NDR',          value: `${aiLoser.total_orders > 0 ? (aiLoser.units_delivered / aiLoser.total_orders * 100).toFixed(1) : '0.0'}%`, color: 'text-red-700 dark:text-red-400' },
                      { label: 'MAX CPA',      value: aiLoser.cpa !== null ? fmtEGP(parseFloat(aiLoser.cpa.toFixed(1))) : '—', color: 'text-red-700 dark:text-red-400' },
                    ].map((m) => (
                      <div key={m.label} className="bg-white dark:bg-slate-900 rounded-xl p-3 text-center
                        border border-red-100 dark:border-red-800/30">
                        <p className={`font-bold text-sm ${m.color}`}>{m.value}</p>
                        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{m.label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button className="flex-1 py-2 rounded-xl text-xs font-semibold
                      bg-red-600 hover:bg-red-700 text-white transition">
                      إيقاف الحملة الإعلانية
                    </button>
                    <button className="px-4 py-2 rounded-xl text-xs font-semibold
                      bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300
                      hover:bg-red-200 dark:hover:bg-red-900/60 transition">
                      عرض التقرير
                    </button>
                  </div>
                </>
              ) : !loadingProfitability && (
                <p className="text-xs text-emerald-500 dark:text-emerald-400 text-center py-4">
                  🎉 لا توجد منتجات خاسرة في الفترة المحددة
                </p>
              )}
            </div>
          </div>
        </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            SECTION 4 — Daily Chart
            ══════════════════════════════════════════════════════════ */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <SectionLabel>التحليل اليومي — {chartPeriodLabel}</SectionLabel>
            <ChartToggle view={chartView} onToggle={setChartView} />
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border
            border-slate-200 dark:border-slate-800 p-6 shadow-sm">

            <div className="flex flex-wrap items-center gap-5 mb-5">
              {activeSeries.map((s) => (
                <span key={s.key} className="flex items-center gap-2 text-xs
                  text-slate-500 dark:text-slate-400">
                  <span
                    className="inline-block w-6 h-0.5 rounded shrink-0"
                    style={{ background: s.color, borderStyle: s.dash ? 'dashed' : 'solid' }}
                  />
                  {s.name}
                </span>
              ))}
            </div>

            {loadingDash ? (
              <div className="h-[300px] flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs text-slate-400 dark:text-slate-600">جارٍ تحميل البيانات...</p>
                </div>
              </div>
            ) : chartData.length === 0 ? (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-sm text-slate-400 dark:text-slate-600">لا توجد بيانات للفترة المحددة</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: tickFill, fontSize: 11, fontFamily: 'Cairo, sans-serif' }}
                    axisLine={false}
                    tickLine={false}
                    dy={8}
                  />
                  <YAxis
                    orientation="right"
                    tick={{ fill: tickFill, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={chartView === 'profit' ? 48 : 32}
                    tickFormatter={
                      chartView === 'profit' ? (v) => `${(v / 1000).toFixed(0)}k` : undefined
                    }
                  />
                  {chartView === 'profit' && (
                    <ReferenceLine y={0} stroke={isDark ? '#475569' : '#cbd5e1'} strokeDasharray="4 2" />
                  )}
                  <Tooltip
                    content={(props) => (
                      <ChartTooltip {...props} isDark={isDark} chartView={chartView} />
                    )}
                  />
                  {chartView === 'orders' && <>
                    <Line yAxisId={0} type="monotone" dataKey="orders"
                      name="إجمالي الطلبات" stroke="#6366f1" strokeWidth={2.5}
                      dot={{ r: 3, fill: '#6366f1', strokeWidth: 0 }}
                      activeDot={{ r: 5, fill: '#6366f1' }} />
                    <Line yAxisId={0} type="monotone" dataKey="confirmed"
                      name="الطلبات المؤكدة" stroke="#3b82f6" strokeWidth={2.5}
                      dot={{ r: 3, fill: '#3b82f6', strokeWidth: 0 }}
                      activeDot={{ r: 5, fill: '#3b82f6' }} />
                    <Line yAxisId={0} type="monotone" dataKey="delivered"
                      name="الطلبات المُسلَّمة" stroke="#14b8a6" strokeWidth={2.5}
                      dot={{ r: 3, fill: '#14b8a6', strokeWidth: 0 }}
                      activeDot={{ r: 5, fill: '#14b8a6' }} />
                  </>}
                  {chartView === 'profit' && <>
                    <Line yAxisId={0} type="monotone" dataKey="adsSpend"
                      name="الإنفاق الإعلاني" stroke="#f43f5e" strokeWidth={2}
                      strokeDasharray="6 3"
                      dot={{ r: 3, fill: '#f43f5e', strokeWidth: 0 }}
                      activeDot={{ r: 5, fill: '#f43f5e' }} />
                    <Line yAxisId={0} type="monotone" dataKey="grossMargin"
                      name="هامش الربح الإجمالي" stroke="#10b981" strokeWidth={2.5}
                      dot={{ r: 3, fill: '#10b981', strokeWidth: 0 }}
                      activeDot={{ r: 5, fill: '#10b981' }} />
                    <Line yAxisId={0} type="monotone" dataKey="netProfit"
                      name="صافي الربح" stroke="#6366f1" strokeWidth={2.5}
                      dot={{ r: 3, fill: '#6366f1', strokeWidth: 0 }}
                      activeDot={{ r: 5, fill: '#6366f1' }} />
                  </>}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════
            SECTION 4.5 — Product Champions League
            Visible for EVERYONE (e-commerce & affiliate). Renders its own
            empty state when there is no product-profitability data yet.
            ══════════════════════════════════════════════════════════ */}
        {/* visible for EVERYONE — e-commerce & affiliate alike */}
        {true && (
        <div className="space-y-3">
          <SectionLabel>دوري أبطال المنتجات</SectionLabel>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border
            border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">

            <div className="bg-gradient-to-bl from-violet-700 via-indigo-600 to-indigo-700 px-6 py-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="mb-2">
                    <span className="inline-flex items-center gap-1.5
                      text-[10px] font-black uppercase tracking-[0.16em]
                      text-indigo-200 bg-white/10 border border-white/20
                      px-2.5 py-1 rounded-lg">
                      🏆 PRODUCT CHAMPIONS LEAGUE
                    </span>
                  </div>
                  <h2 className="text-xl font-black text-white leading-tight">
                    دوري أبطال المنتجات
                  </h2>
                  <p className="text-xs text-indigo-200/80 mt-1 leading-relaxed">
                    ترتيب الجولة حسب الطلبات، التسليم، الربح، وصافي المكسب بعد الإعلانات
                  </p>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1.5 pt-1">
                  <span className="bg-white/15 border border-white/25 text-white
                    text-xs font-bold px-3 py-1.5 rounded-xl whitespace-nowrap">
                    منافسين في الصدارة&nbsp;{Math.min(profitability.length, 5)}
                  </span>
                  <span className="text-[10px] text-indigo-300/70">الجولة الحالية</span>
                </div>
              </div>
            </div>

            {/* Top-5 champion cards — derived from real profitability API data */}
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
              {loadingProfitability ? (
                [...Array(5)].map((_, i) => (
                  <div key={i} className="rounded-xl border border-slate-200 dark:border-slate-700
                    p-4 flex flex-col gap-3 animate-pulse bg-white dark:bg-slate-800/50">
                    <div className="h-8 w-16 bg-slate-100 dark:bg-slate-700 rounded-lg" />
                    <div className="h-4 w-3/4 bg-slate-100 dark:bg-slate-700 rounded" />
                    <div className="h-3 w-full bg-slate-100 dark:bg-slate-700 rounded" />
                    <div className="h-20 bg-slate-100 dark:bg-slate-700 rounded-lg mt-auto" />
                  </div>
                ))
              ) : profitability.length === 0 ? (
                <div className="col-span-full py-10 text-center">
                  <p className="text-sm text-slate-400 dark:text-slate-600">
                    لا توجد بيانات منتجات للفترة المحددة
                  </p>
                </div>
              ) : (
                [...profitability]
                  .sort((a, b) => b.net_profit - a.net_profit)
                  .slice(0, 5)
                  .map((item, idx) => {
                    const rank = idx + 1;
                    /* Bulletproof numeric coercion — stub products may carry 0/null. */
                    const safe = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
                    const orders    = safe(item.total_orders);
                    const delivered = safe(item.units_delivered);
                    const netProfit = safe(item.net_profit);
                    const productName = item.product_name ?? '—';
                    const itemNdr = orders > 0
                      ? parseFloat(((delivered / orders) * 100).toFixed(1))
                      : 0;
                    const score = Math.round(
                      orders * 10 +
                      delivered * 15 +
                      Math.abs(netProfit) / 100 +
                      itemNdr * 20
                    );
                    const tagline = netProfit >= 0
                      ? `NDR ${itemNdr}% · صافي ربح ${fmtEGP(Math.round(netProfit))} · ${delivered} توصيل`
                      : `NDR ${itemNdr}% · خسارة ${fmtEGP(Math.abs(Math.round(netProfit)))} · ${delivered} توصيل`;
                    return (
                      <div key={item.product_id ?? productName ?? rank}
                        className={`rounded-xl border p-4 flex flex-col gap-3
                          bg-gradient-to-b ${rankCardCls(rank)}`}>

                        <div className="flex items-start justify-between gap-1">
                          <span className={`inline-flex items-center justify-center
                            min-w-[36px] h-8 px-2.5 rounded-lg text-sm font-black
                            ${rankBadgeCls(rank)}`}>
                            {rankMedal(rank)}
                          </span>
                          {rank === 1 && (
                            <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5
                              rounded-md border
                              bg-amber-100 text-amber-700 border-amber-200
                              dark:bg-amber-400/20 dark:text-amber-300 dark:border-amber-500/30">
                              MVP
                            </span>
                          )}
                        </div>

                        <div className="flex-1">
                          <p className="font-bold text-sm text-slate-800 dark:text-white
                            leading-snug line-clamp-2">
                            {productName}
                          </p>
                          <p className="text-[10px] text-slate-400 dark:text-slate-500
                            mt-1.5 leading-relaxed line-clamp-3">
                            {tagline}
                          </p>
                        </div>

                        <div className="border-t border-slate-100 dark:border-slate-800/80
                          pt-3 flex items-center gap-3">
                          <div className="shrink-0 text-center">
                            <p className={`text-2xl font-black leading-none tabular-nums
                              ${rankScoreCls(rank)}`} dir="ltr">
                              {score.toLocaleString('en-US')}
                            </p>
                            <p className="text-[9px] font-bold uppercase tracking-[0.15em]
                              text-slate-400 dark:text-slate-600 mt-0.5">
                              SCORE
                            </p>
                          </div>
                          <div className="self-stretch w-px bg-slate-100 dark:bg-slate-800" />
                          <div className="flex-1 min-w-0 space-y-1.5">
                            {[
                              { icon: '📦', label: 'طلبات', val: String(orders),    cls: 'text-slate-700 dark:text-slate-300'   },
                              { icon: '🚚', label: 'تسليم',  val: String(delivered), cls: 'text-teal-600  dark:text-teal-400'    },
                              { icon: '📊', label: 'NDR',    val: `${itemNdr}%`,     cls: 'text-blue-600  dark:text-blue-400'    },
                              { icon: '💰', label: 'صافي',   val: fmtEGP(Math.round(netProfit)),
                                cls: netProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400' },
                            ].map((m) => (
                              <div key={m.label}
                                className="flex items-center justify-between gap-1 text-[10px]">
                                <span className="text-slate-400 dark:text-slate-500 shrink-0">
                                  {m.icon}&nbsp;{m.label}
                                </span>
                                <span className={`font-bold tabular-nums whitespace-nowrap ${m.cls}`}>
                                  {m.val}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
          </div>

          {/* ── Danger Zone ── */}
          <div className="rounded-2xl border overflow-hidden
            bg-red-50/60 border-red-200
            dark:bg-red-950/20 dark:border-red-900/50">
            <div className="flex flex-col md:flex-row">

              <div className="shrink-0 md:w-56 p-5 flex flex-col justify-center gap-3
                bg-red-100/70 dark:bg-red-950/50
                border-b border-red-200 dark:border-red-900/50
                md:border-b-0 md:border-l md:border-red-200 md:dark:border-red-900/50">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667
                         1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464
                         0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <h3 className="font-black text-red-700 dark:text-red-400 text-base leading-tight">
                    منطقة الخطر
                  </h3>
                </div>
                <p className="text-[11px] text-red-600/80 dark:text-red-400/60 leading-relaxed">
                  منتجات محتاجة قرار سريع: تحسين الاستهداف، قفل الإعلان، أو مراجعة العرض.
                </p>
                <span className="self-start bg-red-600 text-white
                  text-[10px] font-bold px-2.5 py-1.5 rounded-lg">
                  {profitability.filter(i => i.net_profit < 0).length} منتجات في الخطر
                </span>
              </div>

              <div className="flex-1 divide-y divide-red-100 dark:divide-red-900/30">
                {loadingProfitability ? (
                  [...Array(2)].map((_, i) => (
                    <div key={i} className="px-5 py-4 animate-pulse">
                      <div className="h-4 w-1/2 bg-red-100 dark:bg-red-900/40 rounded mb-2" />
                      <div className="h-3 w-3/4 bg-red-100 dark:bg-red-900/40 rounded" />
                    </div>
                  ))
                ) : profitability.filter(i => i.net_profit < 0).length === 0 ? (
                  <div className="flex items-center justify-center px-5 py-10">
                    <p className="text-sm text-slate-400 dark:text-slate-600">
                      🎉 لا توجد منتجات في الخسارة للفترة المحددة
                    </p>
                  </div>
                ) : (
                  [...profitability]
                    .filter(d => d.net_profit < 0)
                    .sort((a, b) => a.net_profit - b.net_profit)
                    .map((d) => {
                      const dNdr = d.total_orders > 0
                        ? parseFloat(((d.units_delivered / d.total_orders) * 100).toFixed(1))
                        : 0;
                      const warning =
                        d.attributed_ad_spend > 0 && d.delivered_revenue > 0 && d.attributed_ad_spend > d.delivered_revenue
                          ? `إنفاق إعلاني (${fmtEGP(Math.round(d.attributed_ad_spend))}) يتخطى إيرادات التوصيل — أوقف الحملة فوراً`
                          : d.cpa !== null && d.cpa > 0 && d.delivered_revenue > 0 && d.cpa > d.delivered_revenue / Math.max(d.units_delivered, 1)
                          ? `تكلفة الاكتساب (${fmtEGP(Math.round(d.cpa))}) مرتفعة جداً مقارنة بمتوسط إيراد الوحدة`
                          : dNdr < 30
                          ? `NDR ضعيف جداً (${dNdr}%) — معظم الطلبات مُعادة أو غير مُسلَّمة، راجع جودة المنتج`
                          : `خسارة صافية (${fmtEGP(Math.abs(Math.round(d.net_profit)))}) — راجع التسعير والإنفاق الإعلاني`;
                      return (
                        <div key={d.product_id ?? d.product_name}
                          className="flex items-start justify-between gap-4 px-5 py-4
                            hover:bg-red-50/80 dark:hover:bg-red-950/30 transition-colors">
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <span className="mt-1.5 w-2 h-2 rounded-full bg-red-500
                              shrink-0 animate-pulse" />
                            <div className="min-w-0">
                              <p className="font-bold text-sm text-slate-800 dark:text-slate-200 leading-tight">
                                {d.product_name}
                              </p>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400
                                mt-0.5 leading-snug">
                                {warning}
                              </p>
                            </div>
                          </div>
                          <div className="shrink-0 bg-red-100/80 dark:bg-red-900/30
                            border border-red-200 dark:border-red-800/50
                            rounded-xl px-3 py-2 text-center min-w-[108px]">
                            <p className="font-black text-base leading-tight
                              text-red-600 dark:text-red-400 tabular-nums whitespace-nowrap">
                              {fmtEGP(Math.round(d.net_profit))}
                            </p>
                            <p className="text-[10px] text-red-400/80 dark:text-red-500/70
                              font-semibold mt-0.5">
                              صافي الربح
                            </p>
                          </div>
                        </div>
                      );
                    })
                )}
              </div>
            </div>
          </div>

        </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            SECTION 4.8 — Rejection Reasons Donut Chart
            ══════════════════════════════════════════════════════════ */}
        <div className="space-y-3">
          <SectionLabel>تحليل أسباب رفض وتأجيل الطلبات</SectionLabel>

          <div className="bg-white dark:bg-slate-800/50 dark:backdrop-blur rounded-2xl border
            border-slate-200 dark:border-slate-700 p-6 shadow-sm">

            <div className="flex items-start justify-between gap-4 mb-6">
              <div>
                <h3 className="font-bold text-slate-800 dark:text-white leading-tight">
                  توزيع أسباب الرفض
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  تحليل دوائري للأسباب الرئيسية لرفض الطلبات خلال الفترة المحددة
                </p>
              </div>
              <span className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold
                px-3 py-1.5 rounded-xl whitespace-nowrap
                bg-red-50 text-red-600 border border-red-200
                dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/50">
                <span className={`w-2 h-2 rounded-full ${loadingDash ? 'bg-amber-400 animate-pulse' : 'bg-red-500 animate-pulse'}`} />
                إجمالي المرفوضات: {loadingDash ? '...' : rejectionTotal}
              </span>
            </div>

            {loadingDash ? (
              <div className="h-[220px] flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : rejectionData.length === 0 ? (
              <div className="h-[220px] flex items-center justify-center">
                <p className="text-sm text-slate-400 dark:text-slate-600">
                  {totalRejected === 0
                    ? '🎉 لا توجد طلبات مرفوضة في الفترة المحددة'
                    : 'لا توجد تفاصيل أسباب مسجّلة للطلبات المرفوضة'}
                </p>
              </div>
            ) : (
              <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-12">
                <div className="relative shrink-0">
                  <PieChart width={220} height={220}>
                    <Pie
                      data={rejectionData}
                      cx={110} cy={110}
                      innerRadius={60} outerRadius={100}
                      paddingAngle={3}
                      dataKey="value"
                      startAngle={90} endAngle={-270}
                      strokeWidth={0}
                    >
                      {rejectionData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={(props) => <PieTooltip {...props} isDark={isDark} total={rejectionTotal} />}
                    />
                  </PieChart>
                  <div className="absolute inset-0 flex flex-col items-center justify-center
                    pointer-events-none">
                    <p className="text-3xl font-black text-slate-800 dark:text-white tabular-nums leading-none">
                      {rejectionTotal}
                    </p>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 font-medium mt-1">
                      طلب مرفوض
                    </p>
                  </div>
                </div>

                <div className="flex-1 w-full space-y-4 min-w-0">
                  {rejectionData.map((r) => {
                    const pct = rejectionTotal > 0 ? Math.round((r.value / rejectionTotal) * 100) : 0;
                    return (
                      <div key={r.name} className="flex items-center gap-3 min-w-0">
                        <div className="w-3 h-3 rounded-full shrink-0" style={{ background: r.color }} />
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm text-slate-700 dark:text-slate-300 truncate">
                              {r.name}
                            </span>
                            <div className="flex items-center gap-3 shrink-0">
                              <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums">
                                {r.value} طلب
                              </span>
                              <span className="font-bold text-sm text-slate-700 dark:text-slate-200
                                tabular-nums w-10 text-end">
                                {pct}%
                              </span>
                            </div>
                          </div>
                          <div className="w-full bg-slate-100 dark:bg-slate-700/60 rounded-full h-2">
                            <div
                              className="h-2 rounded-full transition-all duration-700"
                              style={{ width: `${pct}%`, background: r.color }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════
            SECTION 5 — Product Performance Table
            Hidden for affiliate tenants UNTIL they have product data
            (e.g. after a Taager sync populates the profitability rows).
            ══════════════════════════════════════════════════════════ */}
        {/* visible for EVERYONE — e-commerce & affiliate alike */}
        {true && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap gap-y-2">
            <SectionLabel>أداء المنتجات التفصيلي</SectionLabel>
            <div className="flex items-center gap-2 shrink-0">
              {profitability.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold
                  px-2.5 py-1 rounded-lg whitespace-nowrap
                  bg-emerald-50 text-emerald-700 border border-emerald-200
                  dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  بيانات ربحية حقيقية من API ✓
                </span>
              )}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border
            border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            <div className="overflow-x-auto overflow-y-auto max-h-[460px]">
              <table className="w-full text-sm" style={{ minWidth: '1420px' }}>

                <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900 border-b
                  border-slate-200 dark:border-slate-700">
                  <tr>
                    {['المنتج', 'SKU', 'المخزون', 'الطلبات', 'المؤكد', 'المُسلَّم',
                      'إجمالي الإيرادات', 'الإنفاق الإعلاني',
                      /* COGS / Shipping / OPEX are always 0 for affiliates → hidden
                         in the affiliate view, fully kept for e-commerce. */
                      ...(!isAffiliate ? ['تكلفة البضاعة', 'مصاريف الشحن', 'المصاريف التشغيلية'] : []),
                      /* CPP الفعلي / أقصى CPP — affiliate-only (SKU-attributed ad spend). */
                      ...(isAffiliate ? ['CPP الفعلي', 'أقصى CPP'] : []),
                      'CR%', 'DR%', 'NDR%', 'صافي الربح',
                    ].map((h) => (
                      <th key={h} className="px-4 py-3.5 text-right text-[11px] font-bold uppercase
                        tracking-wider text-slate-400 dark:text-slate-500 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {loadingProfitability ? (
                    [...Array(4)].map((_, i) => (
                      <tr key={i}>
                        <td colSpan={isAffiliate ? 14 : 15} className="px-4 py-2.5">
                          <div className="h-9 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
                        </td>
                      </tr>
                    ))
                  ) : tableProductData.length === 0 ? (
                    <tr>
                      <td colSpan={isAffiliate ? 14 : 15} className="py-14 text-center">
                        <p className="text-sm text-slate-400 dark:text-slate-600">
                          لا توجد بيانات للفترة المحددة
                        </p>
                      </td>
                    </tr>
                  ) : tableProductData.map((p) => {
                    const losing = p.netProfit < 0;
                    return (
                      <tr key={p.sku || p.name}
                        className={`transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50
                          ${losing ? 'bg-red-50/50 dark:bg-red-900/5' : ''}`}>
                        <td className="px-4 py-3.5">
                          <p className="font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                            {p.name}
                          </p>
                          {losing && (
                            <span className="text-[10px] font-bold text-red-500 dark:text-red-400">
                              ⚠️ خسارة صافية
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          <span className="font-mono text-xs px-2 py-0.5 rounded-lg
                            bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                            {p.sku}
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          <span className={`text-sm font-bold
                            ${p.stock === 0
                              ? 'text-red-500 dark:text-red-400'
                              : p.stock <= 20
                                ? 'text-amber-500 dark:text-amber-400'
                                : 'text-emerald-600 dark:text-emerald-400'}`}>
                            {p.stock}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 font-medium text-slate-700 dark:text-slate-300">{fmt(p.orders)}</td>
                        <td className="px-4 py-3.5 font-medium text-blue-600 dark:text-blue-400">
                          {p.confirmed !== null ? fmt(p.confirmed) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                        </td>
                        <td className="px-4 py-3.5 font-medium text-teal-600 dark:text-teal-400">{fmt(p.delivered)}</td>
                        {/* RAW revenue, then each deduction in its own column */}
                        <td className="px-4 py-3.5 font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap">{fmtEGP(p.revenue)}</td>
                        <td className="px-4 py-3.5 font-medium text-rose-600 dark:text-rose-400 whitespace-nowrap">{fmtEGP(p.adsSpend)}</td>
                        {/* COGS / Shipping / OPEX — e-commerce only (always 0 for affiliates) */}
                        {!isAffiliate && <td className="px-4 py-3.5 text-slate-500 dark:text-slate-400 whitespace-nowrap">{fmtEGP(p.cogs)}</td>}
                        {!isAffiliate && <td className="px-4 py-3.5 text-amber-600 dark:text-amber-400 whitespace-nowrap">{fmtEGP(p.shipping)}</td>}
                        {!isAffiliate && <td className="px-4 py-3.5 text-orange-600 dark:text-orange-400 whitespace-nowrap">{fmtEGP(p.opex)}</td>}
                        {/* Affiliate-only: Actual CPP + MAX CPP (2-decimal currency) */}
                        {isAffiliate && <td className="px-4 py-3.5 font-medium text-rose-600 dark:text-rose-400 whitespace-nowrap">{fmtMoney(p.actualCpp)}</td>}
                        {isAffiliate && (
                          <td className="px-4 py-3.5 whitespace-nowrap">
                            {/* Green when there's headroom (MAX CPP ≥ Actual CPP), red when over budget. */}
                            <span className={`font-bold ${p.maxCpp >= p.actualCpp
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400'}`}>
                              {fmtMoney(p.maxCpp)}
                            </span>
                          </td>
                        )}
                        <td className="px-4 py-3.5">
                          {p.cr !== null
                            ? <RatePill value={p.cr} thresholds={[50, 70]} />
                            : <span className="text-slate-300 dark:text-slate-600 text-xs">—</span>}
                        </td>
                        <td className="px-4 py-3.5">
                          {p.dr !== null
                            ? <RatePill value={p.dr} thresholds={[60, 75]} />
                            : <span className="text-slate-300 dark:text-slate-600 text-xs">—</span>}
                        </td>
                        <td className="px-4 py-3.5"><RatePill value={p.ndr} thresholds={[35, 50]} /></td>
                        <td className="px-4 py-3.5">
                          <span className={`font-bold whitespace-nowrap
                            ${p.netProfit >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400'}`}>
                            {fmtEGP(p.netProfit)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                {!loadingProfitability && tableProductData.length > 0 && (() => {
                  const totOrders     = tableProductData.reduce((s: number, p: {orders: number}) => s + p.orders, 0);
                  const totConfirmed  = tableProductData.every((p: {confirmed: number | null}) => p.confirmed === null)
                    ? null
                    : tableProductData.reduce((s: number, p: {confirmed: number | null}) => s + (p.confirmed ?? 0), 0);
                  const totDelivered  = tableProductData.reduce((s: number, p: {delivered: number}) => s + p.delivered, 0);
                  const totRevenue    = tableProductData.reduce((s: number, p: {revenue: number}) => s + p.revenue, 0);
                  const totAds        = tableProductData.reduce((s: number, p: {adsSpend: number}) => s + p.adsSpend, 0);
                  const totCogs       = tableProductData.reduce((s: number, p: {cogs: number}) => s + p.cogs, 0);
                  const totShipping   = tableProductData.reduce((s: number, p: {shipping: number}) => s + p.shipping, 0);
                  const totOpex       = tableProductData.reduce((s: number, p: {opex: number}) => s + p.opex, 0);
                  const totNet        = tableProductData.reduce((s: number, p: {netProfit: number}) => s + p.netProfit, 0);
                  /* 15 columns: المنتج | SKU | المخزون | الطلبات | المؤكد | المُسلَّم |
                     إجمالي الإيرادات | الإنفاق الإعلاني | تكلفة البضاعة | مصاريف الشحن |
                     المصاريف التشغيلية | CR% | DR% | NDR% | صافي الربح
                     Footer span: 1 + 2 + 1+1+1 + 1+1+1+1+1 + 3 + 1 = 15. */
                  return (
                    <tfoot>
                      <tr className="bg-slate-100 dark:bg-slate-800/80
                        border-t-2 border-slate-200 dark:border-slate-700">
                        <td className="px-4 py-3.5 font-bold text-slate-700 dark:text-slate-200 text-sm">الإجمالي</td>
                        <td colSpan={2} />
                        <td className="px-4 py-3.5 font-bold text-slate-700 dark:text-slate-200">{fmt(totOrders)}</td>
                        <td className="px-4 py-3.5 font-bold text-blue-600 dark:text-blue-400">
                          {totConfirmed !== null ? fmt(totConfirmed) : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-4 py-3.5 font-bold text-teal-600 dark:text-teal-400">{fmt(totDelivered)}</td>
                        <td className="px-4 py-3.5 font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">{fmtEGP(totRevenue)}</td>
                        <td className="px-4 py-3.5 font-bold text-rose-600 dark:text-rose-400 whitespace-nowrap">{fmtEGP(totAds)}</td>
                        {/* COGS / Shipping / OPEX totals — e-commerce only */}
                        {!isAffiliate && <td className="px-4 py-3.5 font-bold text-slate-600 dark:text-slate-300 whitespace-nowrap">{fmtEGP(totCogs)}</td>}
                        {!isAffiliate && <td className="px-4 py-3.5 font-bold text-amber-600 dark:text-amber-400 whitespace-nowrap">{fmtEGP(totShipping)}</td>}
                        {!isAffiliate && <td className="px-4 py-3.5 font-bold text-orange-600 dark:text-orange-400 whitespace-nowrap">{fmtEGP(totOpex)}</td>}
                        {/* Actual CPP / MAX CPP are per-product ratios — no meaningful column total */}
                        {isAffiliate && <td colSpan={2} />}
                        <td colSpan={3} />
                        <td className={`px-4 py-3.5 font-bold whitespace-nowrap
                          ${totNet >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                          {fmtEGP(totNet)}
                        </td>
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
            </div>
          </div>
        </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            SECTION 6 — Governorates Table
            ══════════════════════════════════════════════════════════ */}
        <div className="space-y-3">
          <SectionLabel>أداء المحافظات التفصيلي</SectionLabel>
          <div className="bg-white dark:bg-slate-900 rounded-2xl border
            border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            <div className="overflow-x-auto overflow-y-auto max-h-[400px]">
              <table className="w-full text-sm" style={{ minWidth: '900px' }}>

                <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900 border-b
                  border-slate-200 dark:border-slate-700">
                  <tr>
                    {[
                      'المحافظة', 'الطلبات', 'الطلبات المؤكدة',
                      'الطلبات المُسلَّمة', 'إيرادات التوصيل',
                      'CR%', 'DR%', 'NDR%',
                    ].map((h) => (
                      <th key={h}
                        className="px-4 py-3.5 text-right text-[11px] font-bold uppercase
                          tracking-wider text-slate-400 dark:text-slate-500 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {loadingDash ? (
                    [...Array(5)].map((_, i) => (
                      <tr key={i}>
                        <td colSpan={8} className="px-4 py-2.5">
                          <div className="h-9 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
                        </td>
                      </tr>
                    ))
                  ) : govData.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-14 text-center">
                        <p className="text-sm text-slate-400 dark:text-slate-600">
                          لا توجد بيانات للفترة المحددة
                        </p>
                      </td>
                    </tr>
                  ) : govData.map((g, i) => {
                    const rank = i + 1;
                    const rankCls =
                      rank === 1 ? 'bg-amber-100  text-amber-700  dark:bg-amber-900/40  dark:text-amber-300'
                    : rank === 2 ? 'bg-slate-200  text-slate-600  dark:bg-slate-700      dark:text-slate-300'
                    : rank === 3 ? 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-300'
                    :              'bg-slate-100  text-slate-400  dark:bg-slate-800      dark:text-slate-500';
                    return (
                      <tr key={g.name}
                        className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2.5">
                            <span className={`w-5 h-5 rounded-full flex items-center justify-center
                              text-[10px] font-bold shrink-0 ${rankCls}`}>
                              {rank}
                            </span>
                            <span className="font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                              {g.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 font-medium text-slate-700 dark:text-slate-300 tabular-nums">
                          {fmt(g.orders)}
                        </td>
                        <td className="px-4 py-3.5 font-medium text-blue-600 dark:text-blue-400 tabular-nums">
                          {fmt(g.confirmed)}
                        </td>
                        <td className="px-4 py-3.5 font-medium text-teal-600 dark:text-teal-400 tabular-nums">
                          {fmt(g.delivered)}
                        </td>
                        <td className="px-4 py-3.5 font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap tabular-nums">
                          {fmtEGP(Math.round(g.revenue))}
                        </td>
                        <td className="px-4 py-3.5"><RatePill value={g.cr}  thresholds={[50, 70]} /></td>
                        <td className="px-4 py-3.5"><RatePill value={g.dr}  thresholds={[60, 75]} /></td>
                        <td className="px-4 py-3.5"><RatePill value={g.ndr} thresholds={[35, 50]} /></td>
                      </tr>
                    );
                  })}
                </tbody>

                {!loadingDash && govData.length > 0 && (
                  <tfoot>
                    <tr className="bg-slate-100 dark:bg-slate-800/80
                      border-t-2 border-slate-200 dark:border-slate-700">
                      <td className="px-4 py-3.5 font-bold text-slate-700 dark:text-slate-200 text-sm">
                        الإجمالي
                      </td>
                      <td className="px-4 py-3.5 font-bold text-slate-700 dark:text-slate-200 tabular-nums">
                        {fmt(govTotals.orders)}
                      </td>
                      <td className="px-4 py-3.5 font-bold text-blue-600 dark:text-blue-400 tabular-nums">
                        {fmt(govTotals.confirmed)}
                      </td>
                      <td className="px-4 py-3.5 font-bold text-teal-600 dark:text-teal-400 tabular-nums">
                        {fmt(govTotals.delivered)}
                      </td>
                      <td className="px-4 py-3.5 font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap tabular-nums">
                        {fmtEGP(Math.round(govTotals.revenue))}
                      </td>
                      <td className="px-4 py-3.5">
                        <RatePill
                          value={govTotals.orders > 0 ? parseFloat((govTotals.confirmed / govTotals.orders * 100).toFixed(1)) : 0}
                          thresholds={[50, 70]}
                        />
                      </td>
                      <td className="px-4 py-3.5">
                        <RatePill
                          value={govTotals.confirmed > 0 ? parseFloat((govTotals.delivered / govTotals.confirmed * 100).toFixed(1)) : 0}
                          thresholds={[60, 75]}
                        />
                      </td>
                      <td className="px-4 py-3.5">
                        <RatePill
                          value={govTotals.orders > 0 ? parseFloat((govTotals.delivered / govTotals.orders * 100).toFixed(1)) : 0}
                          thresholds={[35, 50]}
                        />
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
