'use client';

import { useState } from 'react';

/* Minimal row shape shared by every drill-down (in-transit + status cards). */
export interface OrdersListRow {
  id:              number;
  phone:           string;
  tracking_number: string | null;
  cod:             number | string;
}

interface Props {
  open:       boolean;
  onClose:    () => void;
  title:      string;
  loading:    boolean;
  count:      number;
  totalCod:   number;
  orders:     OrdersListRow[];
  dateStart?: string | null;
  dateEnd?:   string | null;
  /** Noun after the count, e.g. 'طلب قيد التوصيل' or 'طلب مؤكد'. */
  countNoun?: string;
  emptyText?: string;
  emptySub?:  string;
}

const egp = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US');

/* ════════════════════════════════════════════════════════════════════
   OrdersListModal — reusable drill-down list behind a dashboard metric card.
   Presentational: the parent fetches the rows (status-filtered, date-scoped)
   and passes them in. Shows Order #, Customer Phone, Bosta AWB (click-to-copy)
   and COD — so ops can copy an AWB and track it in the Bosta portal.
   ════════════════════════════════════════════════════════════════════ */
export default function OrdersListModal({
  open, onClose, title, loading, count, totalCod, orders,
  dateStart, dateEnd, countNoun = 'طلب', emptyText = 'لا توجد طلبات', emptySub,
}: Props) {
  const [copiedAwb, setCopiedAwb] = useState<string | null>(null);
  if (!open) return null;

  const copy = (awb: string | null) => {
    if (!awb) return;
    navigator.clipboard?.writeText(awb).then(() => {
      setCopiedAwb(awb);
      setTimeout(() => setCopiedAwb((c) => (c === awb ? null : c)), 1500);
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      dir="rtl"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/60
        w-full max-w-3xl flex flex-col max-h-[88dvh]">
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white leading-tight">{title}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {loading
                ? 'جارٍ التحميل…'
                : <>
                    {count.toLocaleString('en-US')} {countNoun}
                    {' · '}مستحقات {egp(totalCod)} ج.م
                    {dateStart && (
                      <span className="text-slate-400"> · {dateStart}
                        {dateEnd && dateEnd !== dateStart ? ` → ${dateEnd}` : ''}
                      </span>
                    )}
                  </>}
            </p>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">انسخ رقم الشحنة (AWB) وتتبّعه في بوابة بوسطة.</p>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200
              hover:bg-slate-100 dark:hover:bg-slate-800 transition" aria-label="إغلاق">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-auto">
          {loading ? (
            <div className="text-center py-16 text-slate-400 text-sm">جارٍ تحميل الطلبات…</div>
          ) : orders.length === 0 ? (
            <div className="text-center py-16 px-6">
              <p className="text-slate-700 dark:text-slate-300 font-semibold">{emptyText}</p>
              {emptySub && <p className="text-slate-400 dark:text-slate-500 text-sm mt-1">{emptySub}</p>}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide sticky top-0">
                <tr>
                  <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">رقم الطلب</th>
                  <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">هاتف العميل</th>
                  <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">رقم الشحنة (AWB)</th>
                  <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">قيمة التحصيل (COD)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap tabular-nums text-xs" dir="ltr">#{o.id}</td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200 whitespace-nowrap" dir="ltr">{o.phone || '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {o.tracking_number ? (
                        <button
                          type="button"
                          onClick={() => copy(o.tracking_number)}
                          className="inline-flex items-center gap-1.5 font-mono text-xs text-sky-700 dark:text-sky-300
                            bg-sky-50 dark:bg-sky-900/30 hover:bg-sky-100 dark:hover:bg-sky-900/50
                            px-2 py-1 rounded-lg transition" dir="ltr" title="انسخ رقم الشحنة"
                        >
                          {copiedAwb === o.tracking_number ? (
                            <><svg className="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>تم النسخ</>
                          ) : (
                            <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>{o.tracking_number}</>
                          )}
                        </button>
                      ) : (
                        <span className="text-slate-400 text-xs">لا يوجد</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-800 dark:text-slate-100 font-semibold whitespace-nowrap tabular-nums" dir="ltr">
                      {egp(o.cod as number)} ج.م
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
