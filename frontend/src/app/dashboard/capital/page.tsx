'use client';

/* «رأس المال» — what the business owns right now: money (Bosta wallet + treasury)
   + goods at COST wherever they are (shelf, confirmed, on the road, coming back).
   No expected profit in it. Owner only. Every number opens to the products it
   comes from. Backend: GET /api/capital (services/capital.js). */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getCapital, type CapitalBucket, type CapitalItem, type CapitalResponse } from '@/lib/api';

const fmt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');
const fmtWhen = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('ar-EG-u-nu-latn', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo',
  });
};
const fmtDay = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Cairo' });
};

function ProductTable({ items, showOrders }: { items: CapitalItem[]; showOrders?: boolean }) {
  if (!items.length) return <p className="text-xs text-slate-400 py-2">مفيش حاجة هنا دلوقتي</p>;
  return (
    <div className="mt-3 divide-y divide-slate-100 dark:divide-slate-800 border-t border-slate-100 dark:border-slate-800">
      {items.map((it, i) => (
        <div key={`${it.product_id ?? it.name}-${i}`} className="py-2 flex items-start justify-between gap-3 text-sm">
          <div className="min-w-0">
            <div className="font-medium text-slate-800 dark:text-slate-100 break-words">{it.name}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {showOrders && it.orders !== undefined ? `${it.orders} أوردر · ` : ''}
              {it.units} قطعة × {fmt(it.unit_cost)} ج
              {it.unit_cost === 0 && <span className="text-amber-600 dark:text-amber-400"> · ناقصه سعر تكلفة</span>}
            </div>
          </div>
          <div className="shrink-0 font-semibold tabular-nums text-slate-900 dark:text-white">{fmt(it.cost)}</div>
        </div>
      ))}
    </div>
  );
}

type RowProps = {
  sign: '+' | '';
  title: string;
  desc: React.ReactNode;
  amount: number | null;
  tone: 'money' | 'goods';
  children?: React.ReactNode;
  note?: React.ReactNode;
  warn?: React.ReactNode;
};

function Row({ sign, title, desc, amount, tone, children, note, warn }: RowProps) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(children);
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-sm">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={`w-full flex items-start justify-between gap-3 text-right ${expandable ? 'cursor-pointer' : 'cursor-default'}`}
        aria-expanded={expandable ? open : undefined}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-lg font-bold w-5 text-center ${tone === 'money' ? 'text-emerald-600 dark:text-emerald-400' : 'text-indigo-600 dark:text-indigo-400'}`}>{sign}</span>
            <span className="font-bold text-slate-900 dark:text-white">{title}</span>
            {expandable && (
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed pr-7">{desc}</div>
        </div>
        <div className={`shrink-0 text-lg sm:text-xl font-bold tabular-nums ${amount === null ? 'text-slate-400' : 'text-slate-900 dark:text-white'}`}>
          {amount === null ? '—' : fmt(amount)}
        </div>
      </button>
      {warn && <div className="mt-2 pr-7 text-xs text-amber-700 dark:text-amber-400 leading-relaxed">⚠️ {warn}</div>}
      {note && <div className="mt-1 pr-7 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">ℹ️ {note}</div>}
      {open && children}
    </div>
  );
}

function bucketDesc(b: CapitalBucket, what: string) {
  return `${b.orders} أوردر · ${b.units} قطعة ${what} × سعر التكلفة`;
}

export default function CapitalPage() {
  const [data, setData]       = useState<CapitalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: d } = await getCapital();
      setData(d);
      setError('');
    } catch (e) {
      const err = e as { response?: { status?: number; data?: { error?: string } } };
      setError(err?.response?.status === 403 ? 'الصفحة دي لصاحب الحساب بس' : (err?.response?.data?.error || 'تعذّر حساب رأس المال'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const missingOrders = data?.missing_cost.orders ?? [];
  const missingProducts = data?.missing_cost.products ?? [];
  const negative = data?.warehouse.negative ?? [];
  const history = data?.history ?? [];

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-4" dir="rtl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">رأس المال</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
            اللي تملكه دلوقتي: فلوس + بضاعة بسعر التكلفة. مفيهوش أي ربح لسه ما جاش.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="shrink-0 px-3 py-2 rounded-xl text-sm font-semibold border border-slate-300 dark:border-slate-700
            text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? '…' : 'تحديث'}
        </button>
      </div>

      {error && <div className="rounded-2xl border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>}

      {loading && !data && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 py-16 text-center">
          <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
          <p className="text-xs text-slate-400 mt-3">بنجيب رصيد محفظة بوسطة ونحسب البضاعة…</p>
        </div>
      )}

      {data && (
        <>
          {/* The total */}
          <div className="rounded-2xl p-5 sm:p-6 bg-gradient-to-br from-indigo-600 to-indigo-800 text-white shadow-md">
            <div className="text-sm opacity-90">رأس مالك الحالي</div>
            <div className="text-3xl sm:text-4xl font-extrabold tabular-nums mt-1">{fmt(data.total.capital)} <span className="text-lg font-bold">ج</span></div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-white/10 px-3 py-2">
                <div className="text-xs opacity-80">فلوس</div>
                <div className="text-lg font-bold tabular-nums">{fmt(data.total.money)}</div>
              </div>
              <div className="rounded-xl bg-white/10 px-3 py-2">
                <div className="text-xs opacity-80">بضاعة بسعر التكلفة</div>
                <div className="text-lg font-bold tabular-nums">{fmt(data.total.goods)}</div>
              </div>
            </div>
            <div className="text-[11px] opacity-75 mt-3">آخر تحديث: {fmtWhen(data.generated_at)}</div>
          </div>

          {!data.total.complete && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-4 text-sm text-amber-800 dark:text-amber-200 leading-relaxed">
              رصيد محفظة بوسطة ماوصلش دلوقتي، فالرقم اللي فوق <b>ناقص فلوس المحفظة</b>. جرّب «تحديث» بعد شوية.
              {data.wallet.error && <div className="text-xs opacity-80 mt-1">{data.wallet.error}</div>}
            </div>
          )}

          {/* Money */}
          <div className="text-xs font-bold text-emerald-700 dark:text-emerald-400 pt-2">الفلوس</div>
          <Row
            sign="" tone="money" title="فلوس في محفظة بوسطة" amount={data.wallet.ok ? data.wallet.balance : null}
            desc="أوردرات اتسلمت والعميل دفع، وبوسطة لسه ما حوّلتهاش. الرقم بعد ما بوسطة خصمت رسومها، ونفس رقم المحفظة في صفحة الخزينة."
          />
          <Row
            sign="+" tone="money" title="فلوس البنك (الخزينة)" amount={data.treasury.balance}
            desc={<>كل اللي دخل الخزينة − كل اللي خرج منها. آخر حركة اتسجلت: {fmtWhen(data.treasury.last_entry_at)} · <Link href="/dashboard/treasury" className="underline">افتح الخزينة</Link></>}
            note="أي حركة تضيفها في الخزينة بتتحسب هنا على طول."
          />

          {/* Goods */}
          <div className="text-xs font-bold text-indigo-700 dark:text-indigo-400 pt-2">البضاعة (بسعر التكلفة)</div>
          <Row
            sign="+" tone="goods" title="بضاعة في المخزن" amount={data.warehouse.cost}
            desc={`${data.warehouse.units} قطعة في ${data.warehouse.products} منتج × سعر التكلفة`}
          >
            <ProductTable items={data.warehouse.items} />
          </Row>
          <Row
            sign="+" tone="goods" title="متأكدة لسه ما اتشحنتش" amount={data.confirmed.cost}
            desc={`${data.confirmed.orders} أوردر · ${data.confirmed.units} قطعة موجودة فعلًا على الرف (اتخصمت من رصيد المخزن ولسه ما اتشحنتش) × سعر التكلفة`}
            warn={data.confirmed_unbacked.orders > 0
              ? `فيه ${data.confirmed_unbacked.orders} أوردر متأكد (${data.confirmed_unbacked.units} قطعة) منتجه خلصان من المخزن — دول مش محسوبين لأن البضاعة لسه مش موجودة. تفاصيلهم تحت في «مش محسوب».`
              : undefined}
          >
            <ProductTable items={data.confirmed.items} showOrders />
          </Row>
          <Row
            sign="+" tone="goods" title="في الطريق مع بوسطة" amount={data.in_transit.cost}
            desc={`${bucketDesc(data.in_transit, 'رايحة للعملاء')} — شحنات اتحركت آخر ${data.old_days} يوم`}
            warn={data.in_transit.stale.orders > 0
              ? `منهم ${data.in_transit.stale.orders} شحنة متأخرة (أكتر من ${data.stale_days} أيام) بتكلفة ${fmt(data.in_transit.stale.cost)} — محسوبة، بس راجعها مع بوسطة`
              : undefined}
          >
            <ProductTable items={data.in_transit.items} showOrders />
          </Row>
          <Row
            sign="+" tone="goods" title="مرتجعات راجعة" amount={data.returning.cost}
            desc={`${bucketDesc(data.returning, 'راجعة لك')}`}
            note={data.returning.expected_return_fees
              ? `أول ما توصل، بوسطة هتخصم رسوم المرتجع من المحفظة — تقريبًا ${fmt(data.returning.expected_return_fees)} ج (${fmt(data.returning.avg_return_fee)} للشحنة). ولما بوسطة تعلّمها «تم الإرجاع» بتدخل المخزن لوحدها.`
              : 'لما بوسطة تعلّمها «تم الإرجاع» بتدخل المخزن لوحدها.'}
            warn={data.returning.stale.orders > 0 ? `منهم ${data.returning.stale.orders} مرتجع بقاله أكتر من ${data.stale_days} أيام في الطريق` : undefined}
          >
            <ProductTable items={data.returning.items} showOrders />
          </Row>
          {data.other.map((b) => (
            <Row key={b.status} sign="+" tone="goods" title={`أوردرات «${b.status}» مخصومة من المخزن`} amount={b.cost}
              desc={`${b.orders} أوردر · ${b.units} قطعة × سعر التكلفة`}>
              <ProductTable items={b.items} showOrders />
            </Row>
          ))}

          {/* = total */}
          <div className="rounded-2xl border-2 border-indigo-200 dark:border-indigo-900 bg-indigo-50/60 dark:bg-indigo-950/20 p-4 flex items-center justify-between gap-3">
            <div>
              <div className="font-bold text-indigo-900 dark:text-indigo-200">= رأس المال الحالي</div>
              <div className="text-xs text-indigo-700/80 dark:text-indigo-300/70 mt-0.5">فلوس {fmt(data.total.money)} + بضاعة {fmt(data.total.goods)}</div>
            </div>
            <div className="text-xl sm:text-2xl font-extrabold tabular-nums text-indigo-900 dark:text-white">{fmt(data.total.capital)}</div>
          </div>

          {/* Not counted — on purpose */}
          {(data.confirmed_unbacked.orders > 0 || data.old_shipments.in_transit.orders > 0 || data.old_shipments.returning.orders > 0) && (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-4 space-y-3">
              <div>
                <div className="font-bold text-slate-800 dark:text-slate-100">مش محسوب في رأس المال (عن قصد)</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">حاجات مكتوبة في السيستم بس مش في إيدك فعلًا، أو حالتها مش معروفة.</div>
              </div>
              {data.confirmed_unbacked.orders > 0 && (
                <Row sign="" tone="goods" title="أوردرات متأكدة منتجها خلصان" amount={data.confirmed_unbacked.cost}
                  desc={`${data.confirmed_unbacked.orders} أوردر · ${data.confirmed_unbacked.units} قطعة اتأكدت والمخزن مكانش فيه بضاعة ليها (رصيده راح بالسالب). محتاج تشتريها الأول — الرقم ده تكلفتها التقريبية.`}>
                  <ProductTable items={data.confirmed_unbacked.items} showOrders />
                  {data.confirmed_unbacked.order_ids && data.confirmed_unbacked.order_ids.length > 0 && (
                    <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 break-words">أرقام الأوردرات: {data.confirmed_unbacked.order_ids.map((id) => `#${id}`).join('، ')}</div>
                  )}
                </Row>
              )}
              {(data.old_shipments.in_transit.orders > 0 || data.old_shipments.returning.orders > 0) && (
                <Row sign="" tone="goods" title={`شحنات حالتها واقفة من أكتر من ${data.old_days} يوم`}
                  amount={data.old_shipments.in_transit.cost + data.old_shipments.returning.cost}
                  desc={`${data.old_shipments.in_transit.orders} «تم الشحن» + ${data.old_shipments.returning.orders} «جاري الإعادة»، أقدمها من ${data.old_shipments.in_transit.oldest || data.old_shipments.returning.oldest || '—'}. دي مش في الطريق فعلًا: غالبًا اتسلمت وفلوسها دخلت المحفظة أو الخزنة، أو رجعت ومتسجلتش. لو اتحسبت هنا هتبقى محسوبة مرتين.`}>
                  <ProductTable items={[...data.old_shipments.in_transit.items, ...data.old_shipments.returning.items]} showOrders />
                  <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 break-words">
                    أرقام الأوردرات: {[...(data.old_shipments.in_transit.order_ids || []), ...(data.old_shipments.returning.order_ids || [])].map((id) => `#${id}`).join('، ')}
                  </div>
                </Row>
              )}
            </div>
          )}

          {/* Missing data */}
          {(missingOrders.length > 0 || missingProducts.length > 0 || negative.length > 0 || (data.stock_gaps ?? []).length > 0) && (
            <details className="bg-amber-50/70 dark:bg-amber-950/20 rounded-2xl border border-amber-200 dark:border-amber-900/50 p-4">
              <summary className="cursor-pointer text-sm font-bold text-amber-800 dark:text-amber-300 select-none">
                عشان الرقم يبقى أدق: {missingOrders.length + missingProducts.length + negative.length} حاجة محتاجة تتصلح
              </summary>
              <div className="mt-3 space-y-3 text-xs text-amber-900/90 dark:text-amber-200/90 leading-relaxed">
                {missingProducts.length > 0 && (
                  <div>
                    <div className="font-semibold mb-1">منتجات في المخزن من غير سعر تكلفة (محسوبة بصفر):</div>
                    <ul className="list-disc pr-5">{missingProducts.map((p) => <li key={p.product_id}>{p.name} — {p.units} قطعة</li>)}</ul>
                  </div>
                )}
                {missingOrders.length > 0 && (
                  <div>
                    <div className="font-semibold mb-1">{missingOrders.length} أوردر منتجها ملهوش سعر تكلفة (محسوبة بصفر):</div>
                    <ul className="list-disc pr-5 max-h-48 overflow-y-auto">
                      {missingOrders.map((o) => <li key={o.order_id}>#{o.order_id} · {o.product || '—'} · {o.status}</li>)}
                    </ul>
                    <div className="mt-1 opacity-80">غالبًا منتجات مش متسجلة في المخزون، أو متسجلة بسعر تكلفة صفر.</div>
                  </div>
                )}
                {negative.length > 0 && (
                  <div>
                    <div className="font-semibold mb-1">منتجات رصيدها بالسالب في المخزون:</div>
                    <ul className="list-disc pr-5">{negative.map((p) => <li key={p.product_id}>{p.name} — {p.units} قطعة</li>)}</ul>
                    <div className="mt-1 opacity-80">
                      يعني اتأكد عليها أكتر من اللي في المخزن. الأوردرات اللي ملهاش بضاعة ظاهرة فوق في «مش محسوب»، ولما البضاعة توصل سجّلها في المخزون.
                    </div>
                  </div>
                )}
                {(data?.stock_gaps ?? []).length > 0 && (
                  <div>
                    <div className="font-semibold mb-1">رصيد لسه بالسالب حتى بعد حساب الأوردرات المتأكدة:</div>
                    <ul className="list-disc pr-5">{(data?.stock_gaps ?? []).map((g) => <li key={g.product_id}>{g.name} — ناقص {g.units_below_zero} قطعة</li>)}</ul>
                    <div className="mt-1 opacity-80">غالبًا بضاعة دخلت المخزن ومتسجلتش (أو اتشحن أكتر من المسجل).</div>
                  </div>
                )}
              </div>
            </details>
          )}

          {/* Day by day */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-sm">
            <div className="font-bold text-slate-900 dark:text-white">رأس المال يوم بيوم</div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              الرقم بيتسجل كل يوم تفتح فيه الصفحة. لو بيطلع يبقى كسبان فعلًا، ولو بينزل يبقى فيه حاجة بتسرّب.
            </div>
            {history.length <= 1 ? (
              <p className="text-xs text-slate-400 mt-3">أول يوم اتسجل النهارده. الرسم هيبان مع الأيام.</p>
            ) : (
              <div className="mt-3 space-y-1.5">
                {(() => {
                  /* honest scale (value ÷ the biggest day): a 2% dip looks like 2%, not like a crash */
                  const max = Math.max(...history.map((h) => h.capital), 1);
                  return [...history].reverse().slice(0, 30).map((h, i, arr) => {
                    const prev = arr[i + 1];
                    const diff = prev ? h.capital - prev.capital : null;
                    const width = Math.max(2, (100 * Math.max(0, h.capital)) / max);
                    return (
                      <div key={h.day} className="flex items-center gap-2 text-xs">
                        <div className="w-24 shrink-0 text-slate-500 dark:text-slate-400">{fmtDay(h.day)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="h-2 rounded-full bg-indigo-500/80" style={{ width: `${width}%` }} />
                        </div>
                        <div className="w-24 shrink-0 text-left tabular-nums font-semibold text-slate-800 dark:text-slate-100">{fmt(h.capital)}</div>
                        <div className={`w-16 shrink-0 text-left tabular-nums ${diff === null ? 'text-slate-400' : diff >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                          {diff === null ? '' : `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}`}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>

          <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed pb-4">
            رأس المال = محفظة بوسطة + الخزينة + المخزن + المتأكدة اللي لسه ما اتشحنتش + اللي في الطريق + المرتجعات الراجعة.
            البضاعة كلها بسعر التكلفة (تكلفة القطعة وقت تأكيد الأوردر، وإلا سعر التكلفة الحالي للمنتج). الأوردرات اللي اتسلمت اتباعت خلاص، وفلوسها في محفظة بوسطة أو في الخزينة.
          </p>
        </>
      )}
    </div>
  );
}
