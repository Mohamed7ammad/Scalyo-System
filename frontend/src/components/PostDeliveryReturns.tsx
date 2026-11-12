'use client';

/* ════════════════════════════════════════════════════════════════════════════
   Post-delivery returns received through Bosta — «مرتجعات بعد التسليم»
   ════════════════════════════════════════════════════════════════════════════
   A customer who already received an order sends it back on its own Bosta
   delivery: a pickup («Customer Return Pickup») or an exchange. The webhook
   records each one, links it to the customer's delivered order when the phone
   + item leave no doubt, and adds the item back to stock ONCE when Bosta hands
   it back (backend services/returnPickups.js). This panel is where a person:
     • links the ones the system couldn't place (stock moves on link);
     • undoes a wrong link (the stock movement is reversed);
     • ignores a parcel that isn't a product return.
   Admin only — mounted on /dashboard/inventory/returns.
   ════════════════════════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useState } from 'react';
import PhoneCall from '@/components/PhoneCall';
import {
  getReturnPickups, linkReturnPickup, unlinkReturnPickup, ignoreReturnPickup, refreshReturnPickup,
  getProducts, Product, ReturnPickup, PickupStatus, PickupList,
} from '@/lib/api';

const TABS: { key: PickupStatus; label: string }[] = [
  { key: 'review',  label: 'محتاجة مراجعة' },
  { key: 'done',    label: 'اتسجلت في المخزون' },
  { key: 'transit', label: 'في الطريق' },
  { key: 'ignored', label: 'متجاهلة' },
];

const fmtDay = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', timeZone: 'Africa/Cairo' });
};
const money = (n?: number | null) => `${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ج`;

export default function PostDeliveryReturns() {
  const [tab,      setTab]      = useState<PickupStatus>('review');
  const [data,     setData]     = useState<PickupList | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [busyId,   setBusyId]   = useState<number | null>(null);
  const [msg,      setMsg]      = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [orderInput, setOrderInput] = useState<Record<number, string>>({});
  const [fwdInput,   setFwdInput]   = useState<Record<number, string>>({});
  const [products, setProducts] = useState<Product[]>([]);

  const load = useCallback(async (t: PickupStatus) => {
    setLoading(true);
    try {
      const res = await getReturnPickups(t);
      setData(res.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(tab); }, [tab, load]);
  useEffect(() => {
    getProducts().then((r) => setProducts(Array.isArray(r.data) ? r.data : [])).catch(() => setProducts([]));
  }, []);

  const flash = (text: string, type: 'success' | 'error' = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 4000);
  };
  const errText = (ex: unknown, fallback: string) =>
    (ex as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;

  const act = async (id: number, fn: () => Promise<string>) => {
    setBusyId(id);
    try {
      flash(await fn());
      await load(tab);
    } catch (ex) {
      flash(errText(ex, 'فشلت العملية'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const link = (p: ReturnPickup, orderId: number) => act(p.id, async () => {
    const r = await linkReturnPickup(p.id, orderId, fwdInput[p.id] || null);
    return r.data.applied ? `اتربط بطلب #${orderId} واتسجّل في المخزون ✓` : `اتربط بطلب #${orderId}${r.data.reason ? ` — ${r.data.reason}` : ''}`;
  });
  const unlink = (p: ReturnPickup) => {
    if (!window.confirm(`فك ربط ${p.tracking_number} من طلب #${p.order_id}؟ حركة المخزون هتتعكس.`)) return;
    act(p.id, async () => { await unlinkReturnPickup(p.id); return 'اتفك الربط واتعكست حركة المخزون'; });
  };
  const ignore = (p: ReturnPickup) => {
    if (!window.confirm(`تجاهل ${p.tracking_number}؟ مش هيتسجّل في المخزون.`)) return;
    act(p.id, async () => { await ignoreReturnPickup(p.id); return 'اتجاهل'; });
  };
  const refresh = (p: ReturnPickup) => act(p.id, async () => {
    const r = await refreshReturnPickup(p.id);
    return r.data.restocked_at ? 'اتحدّث واتسجّل في المخزون ✓' : (r.data.note || 'اتحدّث من بوسطة');
  });

  const counts = data?.counts;

  return (
    <section className="mb-8 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm" dir="rtl">
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-slate-100 dark:border-slate-800">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">مرتجعات بعد التسليم (بيك أب / استبدال)</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
          اللي العميل بيرجّعه بعد ما استلم. بيتسجّل في المخزون تلقائياً أول ما بوسطة تسلّمه — واللي مش واضح هو تبع أنهي طلب بيستناك هنا.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {TABS.map((t) => {
            const n = counts ? counts[t.key as keyof PickupList['counts']] : undefined;
            const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                  active ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-indigo-300'}`}>
                {t.label}{n !== undefined ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>
      </div>

      {msg && (
        <div className={`mx-4 sm:mx-5 mt-3 px-3 py-2 rounded-lg text-xs font-medium border ${
          msg.type === 'success'
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800/40'
            : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/40'}`}>
          {msg.text}
        </div>
      )}

      <div className="p-4 sm:p-5">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">جارٍ التحميل…</p>
        ) : !data || data.pickups.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">
            {tab === 'review' ? 'مفيش مرتجعات مستنية مراجعة ✓' : 'مفيش حاجة هنا'}
          </p>
        ) : (
          <div className="space-y-3">
            {data.pickups.map((p) => {
              const busy = busyId === p.id;
              return (
                <div key={p.id} className="rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={`px-2 py-0.5 rounded-md font-semibold ${p.kind === 'exchange'
                      ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
                      : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'}`}>
                      {p.kind === 'exchange' ? 'استبدال' : 'بيك أب مرتجع'}
                    </span>
                    <span className="font-mono text-slate-500 dark:text-slate-400" dir="ltr">{p.tracking_number}</span>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-500 dark:text-slate-400">
                      {p.received_at ? `وصل ${fmtDay(p.received_at)}` : `في الطريق${p.state_code ? ` (حالة ${p.state_code})` : ''}`}
                    </span>
                    {p.customer_name || p.customer_phone ? (
                      <span className="text-slate-500 dark:text-slate-400">· {p.customer_name || ''} {p.customer_phone ? <PhoneCall phone={`0${p.customer_phone}`} /> : null}</span>
                    ) : null}
                  </div>

                  <div className="mt-2 text-sm text-slate-800 dark:text-slate-100">
                    <span className="text-emerald-600 dark:text-emerald-400 font-semibold">راجع: </span>
                    {p.return_desc || '—'} × {p.return_qty}
                    {p.kind === 'exchange' && (
                      <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        <span className="text-rose-500 font-semibold">خرج بداله: </span>{p.forward_desc || '—'} × {p.forward_qty || 1}
                      </span>
                    )}
                  </div>
                  {(p.pickup_fee != null || p.collected_cod > 0) && (
                    <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                      شحن بوسطة {money(p.pickup_fee)}{p.collected_cod > 0 ? ` · العميل دفع ${money(p.collected_cod)}` : ''}
                    </p>
                  )}

                  {p.order_id ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-slate-600 dark:text-slate-300">
                        طلب #{p.order_id} · {p.order_product || '—'} · اتعمل {fmtDay(p.order_placed_on)}
                        {p.link_method === 'auto' ? ' · ربط تلقائي' : p.linked_by ? ` · ربط ${p.linked_by.split('@')[0]}` : ''}
                      </span>
                      {p.restocked_at && (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 font-semibold">
                          {p.kind === 'exchange' && p.forward_product && p.forward_product === p.return_product && p.forward_qty === p.return_qty
                            ? `استبدال بنفس المنتج — المخزون من غير تغيير`
                            : `+${p.return_qty} ${p.return_product || ''}${p.kind === 'exchange' && p.forward_product ? ` / −${p.forward_qty} ${p.forward_product}` : ''}`}
                        </span>
                      )}
                      {p.restocked_at && (
                        <button onClick={() => unlink(p)} disabled={busy}
                          className="px-2 py-1 rounded-lg text-[11px] font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 disabled:opacity-50">
                          فك الربط
                        </button>
                      )}
                    </div>
                  ) : null}

                  {p.note && !p.restocked_at && (
                    <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">{p.note}</p>
                  )}

                  {tab === 'review' && !p.restocked_at && (
                    <div className="mt-3 space-y-2">
                      {(p.candidates ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {(p.candidates ?? []).map((c) => (
                            <button key={c.id} onClick={() => link(p, c.id)} disabled={busy}
                              className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium border border-indigo-200 dark:border-indigo-800/50
                                text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-50 text-right">
                              ربط بطلب #{c.id} · {c.product || '—'} · {fmtDay(c.placed_on)}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={orderInput[p.id] ?? ''}
                          onChange={(e) => setOrderInput((s) => ({ ...s, [p.id]: e.target.value.replace(/[^\d]/g, '') }))}
                          placeholder="رقم الطلب"
                          inputMode="numeric"
                          className="w-28 px-2.5 py-1.5 text-xs rounded-lg border bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100"
                        />
                        {p.kind === 'exchange' && (
                          <select
                            value={fwdInput[p.id] ?? ''}
                            onChange={(e) => setFwdInput((s) => ({ ...s, [p.id]: e.target.value }))}
                            className="max-w-[220px] px-2 py-1.5 text-xs rounded-lg border bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                            title="المنتج اللي خرج للعميل بدل المرتجع"
                          >
                            <option value="">منتج الاستبدال: تلقائي</option>
                            {products.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                          </select>
                        )}
                        <button
                          onClick={() => { const id = parseInt(orderInput[p.id] || '', 10); if (id > 0) link(p, id); }}
                          disabled={busy || !(parseInt(orderInput[p.id] || '', 10) > 0)}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50">
                          ربط
                        </button>
                        {!p.details_fetched_at && (
                          <button onClick={() => refresh(p)} disabled={busy}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-50">
                            تحديث من بوسطة
                          </button>
                        )}
                        <button onClick={() => ignore(p)} disabled={busy}
                          className="mr-auto px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50">
                          تجاهل
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
