'use client';

/* ════════════════════════════════════════════════════════════════════════════
   «رد فلوس مرتجع» — record money paid back to a customer AFTER delivery.
   Finance only (backend services/orderRefunds.js): it writes the treasury cash
   row + the order link, and the refund is charged to the ORDER's own day in
   «ربح الطلبات». It never touches stock (the Bosta pickup/exchange receipt
   restocks), the order's status or the agent's commission.

   Modes:
     • new   — a fresh payment (amount + date entered here);
     • link  — `convertTx`: an existing manual expense row (e.g. «مرتجع» typed
               as مصاريف تشغيل) is linked to the order; amount/date stay as-is.
   Used by the treasury page and the exchange/returns page.
   ════════════════════════════════════════════════════════════════════════════ */

import { useEffect, useRef, useState } from 'react';
import { searchRefundOrders, createRefund, RefundOrder, RefundResult } from '@/lib/api';

const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
const today = () => CAIRO_DAY.format(new Date());
const fmtMoney = (n: number) => `${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ج`;
const fmtDay = (ymd?: string | null) => {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export interface RefundDialogProps {
  onClose:  () => void;
  onSaved:  (result: RefundResult) => void;
  /** Pre-fill the search (e.g. the customer phone of an «استرجاع» request). */
  initialQuery?: string;
  /** The after-sales request this refund settles. */
  requestId?: number;
  /** Link an existing manual expense row instead of creating a new payment. */
  convertTx?: { id: number; amount: number; transaction_date: string; description: string | null };
}

export default function RefundDialog({ onClose, onSaved, initialQuery, requestId, convertTx }: RefundDialogProps) {
  const [query,    setQuery]    = useState(initialQuery ?? '');
  const [results,  setResults]  = useState<RefundOrder[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [order,    setOrder]    = useState<RefundOrder | null>(null);
  const [amount,   setAmount]   = useState(convertTx ? String(convertTx.amount) : '');
  const [date,     setDate]     = useState(convertTx ? convertTx.transaction_date : today());
  const [note,     setNote]     = useState('');
  const [saving,   setSaving]   = useState(false);
  const [err,      setErr]      = useState('');
  const seq = useRef(0);

  const runSearch = async (q: string) => {
    const term = q.trim();
    if (term.length < 2) { setResults(null); return; }
    const my = ++seq.current;
    setSearching(true);
    try {
      const res = await searchRefundOrders(term);
      if (my === seq.current) setResults(res.data.orders);
    } catch {
      if (my === seq.current) setResults([]);
    } finally {
      if (my === seq.current) setSearching(false);
    }
  };

  /* Search as the user types (debounced). */
  useEffect(() => {
    if (order) return;
    const h = setTimeout(() => runSearch(query), 350);
    return () => clearTimeout(h);
  }, [query, order]);

  const pick = (o: RefundOrder) => {
    if (!o.refundable) return;
    setOrder(o);
    if (!convertTx) setAmount(String(Math.max(0, Math.round((o.price - o.refunded_total) * 100) / 100)));
    setErr('');
  };

  const save = async () => {
    if (!order) return;
    setErr('');
    const amt = parseFloat(amount);
    if (!convertTx) {
      if (!Number.isFinite(amt) || amt <= 0) return setErr('المبلغ المردود مطلوب');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setErr('اختار تاريخ رد الفلوس');
    }
    setSaving(true);
    try {
      const res = await createRefund({
        order_id: order.id,
        ...(convertTx ? { treasury_tx_id: convertTx.id } : { amount: amt, refunded_on: date }),
        note: note.trim() || undefined,
        request_id: requestId,
      });
      onSaved(res.data);
    } catch (ex: unknown) {
      const msg = (ex as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setErr(msg || 'فشل تسجيل رد الفلوس');
      setSaving(false);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm rounded-xl border bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 ' +
    'text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 ' +
    'focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors';

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[92dvh] flex flex-col border border-slate-200 dark:border-slate-700" dir="rtl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              {convertTx ? 'ربط مرتجع بطلبه' : 'رد فلوس مرتجع'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
              {convertTx
                ? `القيد #${convertTx.id} (${fmtMoney(convertTx.amount)}${convertTx.description ? ` — ${convertTx.description}` : ''}) هيتخصم من ربح يوم الطلب بدل يوم الدفع.`
                : 'فلوس اترجعت لعميل بعد ما استلم الطلب — هتتخصم من ربح يوم الطلب نفسه.'}
            </p>
          </div>
          <button onClick={onClose} disabled={saving}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:text-slate-300 dark:hover:bg-slate-800 transition-colors shrink-0">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Step 1 — the order */}
          {!order ? (
            <div className="space-y-3">
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400">
                الطلب <span className="text-red-500">*</span>
              </label>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="رقم الطلب أو رقم البوليصة أو تليفون العميل"
                className={inputCls}
                inputMode="search"
              />
              {searching && <p className="text-xs text-slate-400">جارٍ البحث…</p>}
              {results && results.length === 0 && !searching && (
                <p className="text-xs text-slate-400">مفيش طلبات بالبيانات دي</p>
              )}
              <div className="space-y-2">
                {(results ?? []).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => pick(o)}
                    disabled={!o.refundable}
                    className={`w-full text-right rounded-xl border px-3 py-2.5 transition-colors ${
                      o.refundable
                        ? 'border-slate-200 dark:border-slate-700 hover:border-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/20'
                        : 'border-slate-100 dark:border-slate-800 opacity-60 cursor-not-allowed'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                        #{o.id} · {o.product || '—'}
                      </span>
                      <span className="text-sm font-bold tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">{fmtMoney(o.price)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      <span>{o.customer || '—'}</span>
                      <span>اتعمل {fmtDay(o.placed_on)}</span>
                      <span className={o.refundable ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}>
                        {o.refundable ? `اتسلّم${o.delivered_on ? ` ${fmtDay(o.delivered_on)}` : ''}` : `«${o.status}» — مينفعش`}
                      </span>
                      {o.refunded_total > 0 && <span className="text-amber-600 dark:text-amber-400">اترد منه {fmtMoney(o.refunded_total)}</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/60 dark:bg-indigo-900/15 px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">#{order.id} · {order.product || '—'}</span>
                  <button type="button" onClick={() => setOrder(null)} className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap">
                    تغيير
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  {order.customer || '—'} · سعر الطلب {fmtMoney(order.price)}
                  {order.refunded_total > 0 ? ` · اترد منه قبل كده ${fmtMoney(order.refunded_total)}` : ''}
                </p>
              </div>

              {!convertTx && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                      المبلغ المردود (ج.م) <span className="text-red-500">*</span>
                    </label>
                    <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                      تاريخ رد الفلوس <span className="text-red-500">*</span>
                    </label>
                    <input type="date" value={date} min={order.placed_on} max={today()} onChange={(e) => setDate(e.target.value)} className={inputCls} dir="ltr" />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">ملاحظة (اختياري)</label>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="فودافون كاش / انستاباي…" className={inputCls} />
              </div>

              {/* Where it lands */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2.5 space-y-1.5 text-xs leading-snug">
                <p className="text-slate-700 dark:text-slate-200">
                  <span className="font-semibold">هيتخصم من ربح يوم {fmtDay(order.placed_on)}</span> — {order.product || 'الطلب'}
                </p>
                <p className="text-slate-500 dark:text-slate-400">
                  {convertTx
                    ? `الخزينة مش هتتغيّر — القيد موجود بتاريخ ${fmtDay(convertTx.transaction_date)}.`
                    : `الخزينة: −${fmtMoney(parseFloat(amount) || 0)} بتاريخ ${fmtDay(date)}.`}
                </p>
                <p className="text-slate-400 dark:text-slate-500">
                  المخزون مش بيتغيّر من هنا — بيزيد تلقائياً لما بوسطة تسلّم المرتجع. عمولة المندوب مش بتتأثر.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-slate-100 dark:border-slate-800 px-5 py-3 space-y-2">
          {err && (
            <div className="px-3 py-2 rounded-lg text-xs font-medium border bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/40">
              {err}
            </div>
          )}
          <div className="flex gap-3">
            <button
              onClick={save}
              disabled={!order || saving}
              className="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {saving ? 'جارٍ الحفظ…' : convertTx ? 'ربط بالطلب' : 'تسجيل رد الفلوس'}
            </button>
            <button onClick={onClose} disabled={saving}
              className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
              إلغاء
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
