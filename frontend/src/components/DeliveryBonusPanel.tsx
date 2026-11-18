'use client';

/* ════════════════════════════════════════════════════════════════════════════
   بونص التسليم — the delivery-bonus plan list
   ════════════════════════════════════════════════════════════════════════════
   Every order the agent confirmed under the plan, split into «اتسلم» (with the
   bonus she got), «مستلمش» (the customer didn't receive it), «في الطريق» and
   «اتلغى», each with the customer's name, phone and Bosta tracking so she can
   check any order herself. Used on the agent's own page and, for the owner, in
   the staff page (agent = her email).                                        */

import { useEffect, useMemo, useState } from 'react';
import { getDeliveryBonus, DeliveryBonusResponse, DeliveryBonusGroup, DeliveryBonusRow } from '@/lib/api';
import PhoneCall from '@/components/PhoneCall';

const PAGE = 60;

const TABS: { key: DeliveryBonusGroup; label: string; empty: string }[] = [
  { key: 'delivered', label: 'اتسلم',     empty: 'لسه مفيش أوردرات اتسلمت في الفترة دي.' },
  { key: 'returned',  label: 'مستلمش',    empty: 'مفيش أوردرات رجعت في الفترة دي.' },
  { key: 'pending',   label: 'في الطريق', empty: 'مفيش أوردرات في الطريق دلوقتي.' },
  { key: 'cancelled', label: 'اتلغى',     empty: 'مفيش أوردرات اتلغت.' },
];

const money = (n: number) => `${Math.round(n * 100) / 100}`;

/* «19 نوفمبر» with Latin digits, Cairo time. */
function day(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', timeZone: 'Africa/Cairo' });
}
function dayTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('ar-EG-u-nu-latn', {
    day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo',
  });
}

function Row({ r }: { r: DeliveryBonusRow }) {
  return (
    <li className="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/60 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-900 dark:text-white truncate">
            <span className="text-slate-400 dark:text-slate-500 font-semibold tabular-nums">#{r.id}</span>{' '}
            <bdi>{r.customer || 'بدون اسم'}</bdi>
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
            <span className="font-semibold text-slate-700 dark:text-slate-300">{r.pieces} {r.pieces === 1 ? 'قطعة' : 'قطع'}</span>
            {' · '}<bdi>{r.product || '—'}</bdi>
          </p>
        </div>
        <span className={`shrink-0 text-[11px] font-bold px-2 py-0.5 rounded-full ${
          r.group === 'delivered' ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300'
          : r.group === 'returned' ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
          : r.group === 'pending' ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
          : 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300'}`}>
          {r.status}
        </span>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
        <PhoneCall phone={r.phone} />
        {r.tracking && (
          <span className="text-slate-500 dark:text-slate-400 select-all" dir="ltr">
            Bosta <span className="font-semibold text-slate-700 dark:text-slate-200 tabular-nums">{r.tracking}</span>
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-dashed border-slate-200 dark:border-slate-700/60 text-xs">
        <span className="text-slate-500 dark:text-slate-400">
          اتأكد {day(r.confirmedAt)}{r.deliveredAt && r.group === 'delivered' ? ` · اتسلم ${day(r.deliveredAt)}` : ''}
        </span>
        <span className="flex items-center gap-3 font-semibold tabular-nums">
          <span className="text-slate-600 dark:text-slate-300">تأكيد {money(r.confirmAmount)} ج.م</span>
          {r.bonusAmount != null ? (
            <span className="text-teal-700 dark:text-teal-300">بونص <span dir="ltr">+{money(r.bonusAmount)}</span> ج.م</span>
          ) : r.group === 'pending' ? (
            <span className="text-sky-700 dark:text-sky-300">بونص لما يتسلم {money(r.bonusPerPiece * r.pieces)} ج.م</span>
          ) : (
            <span className="text-slate-400 dark:text-slate-500">مفيش بونص</span>
          )}
        </span>
      </div>
    </li>
  );
}

export default function DeliveryBonusPanel({
  startDate, endDate, agent, hideWhenOff = false,
}: {
  startDate?: string;
  endDate?: string;
  agent?: string;
  /** Agent page: show nothing at all when the plan is off and she has no plan orders. */
  hideWhenOff?: boolean;
}) {
  const [data, setData] = useState<DeliveryBonusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<DeliveryBonusGroup>('delivered');
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    getDeliveryBonus({ startDate, endDate, agent })
      .then((res) => { if (alive) { setData(res.data); setShown(PAGE); } })
      .catch(() => { if (alive) setError('تعذّر تحميل أوردرات البونص.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [startDate, endDate, agent]);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => r.group === tab), [data, tab]);

  if (hideWhenOff && !loading && (!data || (!data.enabled && data.rows.length === 0))) return null;

  const s = data?.summary;
  return (
    <section className="bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-sm space-y-4" dir="rtl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-gray-900 dark:text-white">بونص التسليم</h2>
          {data && (
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 leading-relaxed max-w-xl">
              التأكيد {money(data.confirmRate)} ج.م × عدد القطع، ولما الأوردر يتسلم {money(data.perPiece)} ج.م × عدد القطع زيادة.
              الحسبة على الأوردرات اللي اتأكدت من وقت التفعيل بس.
            </p>
          )}
        </div>
        {data && (
          <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${data.enabled
            ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300'
            : 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300'}`}>
            {data.enabled ? `مفعّل من ${dayTime(data.since)}` : 'متوقف'}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <div className="w-7 h-7 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {!loading && error && <p className="text-sm text-red-500 dark:text-red-400 text-center py-6">{error}</p>}

      {!loading && !error && data && s && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="rounded-xl bg-teal-50 dark:bg-teal-900/20 p-3">
              <p className="text-[11px] font-semibold text-teal-700 dark:text-teal-300">بونص اتصرف</p>
              <p className="text-xl font-extrabold text-teal-700 dark:text-teal-300 tabular-nums">{money(s.bonusEarned)} <span className="text-xs">ج.م</span></p>
              <p className="text-[11px] text-teal-700/70 dark:text-teal-300/70">{s.delivered} أوردر اتسلم</p>
            </div>
            <div className="rounded-xl bg-slate-50 dark:bg-slate-900/40 p-3">
              <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">عمولة التأكيد</p>
              <p className="text-xl font-extrabold text-slate-900 dark:text-white tabular-nums">{money(s.confirmEarned)} <span className="text-xs">ج.م</span></p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{s.orders} أوردر اتأكد</p>
            </div>
            <div className="rounded-xl bg-sky-50 dark:bg-sky-900/20 p-3">
              <p className="text-[11px] font-semibold text-sky-700 dark:text-sky-300">في الطريق</p>
              <p className="text-xl font-extrabold text-sky-700 dark:text-sky-300 tabular-nums">{s.pending}</p>
              <p className="text-[11px] text-sky-700/70 dark:text-sky-300/70">لو اتسلموا: {money(s.bonusPossible)} ج.م</p>
            </div>
            <div className="rounded-xl bg-rose-50 dark:bg-rose-900/20 p-3">
              <p className="text-[11px] font-semibold text-rose-700 dark:text-rose-300">مستلمش</p>
              <p className="text-xl font-extrabold text-rose-700 dark:text-rose-300 tabular-nums">{s.returned}</p>
              <p className="text-[11px] text-rose-700/70 dark:text-rose-300/70">مفيش عليهم بونص</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <button key={t.key} onClick={() => { setTab(t.key); setShown(PAGE); }}
                className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${tab === t.key
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700/60 dark:text-slate-300 dark:hover:bg-slate-700'}`}>
                {t.label} <span className="tabular-nums opacity-70">{s[t.key]}</span>
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-6">
              {data.rows.length === 0
                ? (data.enabled ? 'لسه مفيش أوردرات اتأكدت بالنظام الجديد في الفترة دي.' : 'النظام مش مفعّل.')
                : TABS.find((t) => t.key === tab)?.empty}
            </p>
          ) : (
            <>
              <ul className="space-y-2">
                {rows.slice(0, shown).map((r) => <Row key={r.id} r={r} />)}
              </ul>
              {rows.length > shown && (
                <button onClick={() => setShown((n) => n + PAGE)}
                  className="w-full py-2 rounded-xl text-sm font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-700/60 dark:hover:bg-slate-700 dark:text-slate-200">
                  عرض المزيد ({rows.length - shown})
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
