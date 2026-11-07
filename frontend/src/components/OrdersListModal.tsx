'use client';

import { useState } from 'react';

/* Minimal row shape shared by every drill-down (in-transit + status cards). */
export interface OrdersListRow {
  id:              number;
  phone:           string;
  tracking_number: string | null;
  cod:             number | string;
  /* Delivered list (showOrderValue) — explain cash vs order value per order. */
  order_value?:    number | string;
  deposit?:        number | string;
  payment_type?:   string | null;
  electronic?:     number | string;
  cash_gap?:       number | string;
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
  /** Delivered list: show «قيمة الأوردر» next to the cash collected, the
   *  per-order reason for any difference, and the 3-number summary line. */
  showOrderValue?: boolean;
  totalValue?:     number;
  totalPrepaid?:   number;
  totalCashGap?:   number;
}

const egp = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US');
const num = (v: unknown) => Number(v) || 0;

/* Bosta paymentType → the method shown after «دفع إلكتروني» (types seen in real
   Bosta docs; anything else shows the generic label). */
const PAY_KIND: Record<string, string> = { flash: 'Flash', card: 'كارت', valu: 'ValU', wallet: 'محفظة', 'apple pay': 'Apple Pay' };
const payLabel = (t: string) => {
  const kind = PAY_KIND[t.trim().toLowerCase()];
  return kind ? `دفع إلكتروني (${kind})` : 'دفع إلكتروني';
};

/* ════════════════════════════════════════════════════════════════════
   OrdersListModal — reusable drill-down list behind a dashboard metric card.
   Presentational: the parent fetches the rows (status-filtered, date-scoped)
   and passes them in. Shows Order #, Customer Phone, Bosta AWB (click-to-copy)
   and COD — so ops can copy an AWB and track it in the Bosta portal.
   With showOrderValue (delivered list) it also shows the order value, so the
   list reconciles with «إجمالي الإيرادات»: value − deposits − electronic = cash.
   ════════════════════════════════════════════════════════════════════ */
export default function OrdersListModal({
  open, onClose, title, loading, count, totalCod, orders,
  dateStart, dateEnd, countNoun = 'طلب', emptyText = 'لا توجد طلبات', emptySub,
  showOrderValue = false, totalValue, totalPrepaid, totalCashGap,
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

  /* Why the cash differs from the order value (delivered list only). */
  const tagsFor = (o: OrdersListRow) => {
    const tags: { text: string; cls: string; title?: string }[] = [];
    if (num(o.deposit) > 0.009) {
      tags.push({ text: `عربون ${egp(num(o.deposit))}`, cls: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' });
    }
    if (o.payment_type) {
      tags.push({
        text: payLabel(o.payment_type),
        cls: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
        title: num(o.electronic) > 0 ? `اتدفع إلكترونياً: ${egp(num(o.electronic))} ج.م` : undefined,
      });
    }
    if (num(o.cash_gap) > 0.009) {
      tags.push({
        text: `فرق تحصيل ${egp(num(o.cash_gap))}`,
        cls: 'bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
        title: 'بوسطة حصّلت أقل من سعر الأوردر ومفيش دفع إلكتروني مسجّل',
      });
    }
    return tags;
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
                : showOrderValue
                  ? <>
                      {count.toLocaleString('en-US')} {countNoun}
                      {' · '}قيمة الطلبات {egp(totalValue ?? 0)}
                      {' · '}يتحصّل نقداً {egp(totalCod)}
                      {' · '}مدفوع مقدماً {egp(totalPrepaid ?? 0)}
                      {(totalCashGap ?? 0) > 0.009 && <span className="text-rose-600 dark:text-rose-400">{' · '}فرق تحصيل {egp(totalCashGap ?? 0)}</span>}
                      {' '}ج.م
                      {dateStart && (
                        <span className="text-slate-400"> · {dateStart}
                          {dateEnd && dateEnd !== dateStart ? ` → ${dateEnd}` : ''}
                        </span>
                      )}
                    </>
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
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
              {showOrderValue
                ? 'قيمة الطلبات = يتحصّل نقداً + مدفوع مقدماً (عربون أو دفع إلكتروني عند الاستلام). انسخ رقم الشحنة (AWB) وتتبّعه في بوابة بوسطة.'
                : 'انسخ رقم الشحنة (AWB) وتتبّعه في بوابة بوسطة.'}
            </p>
            {!loading && orders.length > 0 && orders.length < count && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                يعرض أحدث {orders.length.toLocaleString('en-US')} طلب من {count.toLocaleString('en-US')} — الإجماليات فوق تشمل كل الطلبات.
              </p>
            )}
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
                  {showOrderValue && <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">قيمة الأوردر</th>}
                  <th className="text-right font-semibold px-4 py-3 whitespace-nowrap">{showOrderValue ? 'يتحصّل نقداً' : 'قيمة التحصيل (COD)'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {orders.map((o) => {
                  const tags = showOrderValue ? tagsFor(o) : [];
                  return (
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
                    {showOrderValue && (
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap tabular-nums" dir="ltr">
                        {egp(num(o.order_value))} ج.م
                      </td>
                    )}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-slate-800 dark:text-slate-100 font-semibold tabular-nums" dir="ltr">{egp(o.cod as number)} ج.م</span>
                      {tags.length > 0 && (
                        <span className="flex flex-wrap gap-1 mt-1">
                          {tags.map((t) => (
                            <span key={t.text} title={t.title} className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold ${t.cls}`}>{t.text}</span>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
