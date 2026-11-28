'use client';

import { useEffect, useMemo, useState } from 'react';
import { splitOrders, type SplitFilters, type SplitResult } from '@/lib/api';

/* ════════════════════════════════════════════════════════════════════
   SplitOrdersDialog — «توزيع بالأعداد» (Team Leader / admin).
   Works on the orders list's CURRENT filter (status + dates + product …),
   so nothing is ticked by hand: how many orders, then how many for each
   girl. An order never goes back to the girl holding it now — a review
   account counts as the same girl (Dina = مريم). Preview first (exactly
   who gets what, from whom), then confirm. Status stays as it is.
   ════════════════════════════════════════════════════════════════════ */
type ApiErr = { response?: { data?: { error?: string } } };
const errOf = (e: unknown, fb: string) => (e as ApiErr)?.response?.data?.error || fb;
const toInt = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

export default function SplitOrdersDialog({ filters, filterLabel, onClose, onDone }: {
  filters:     SplitFilters;
  filterLabel: string;
  onClose:     () => void;
  /** After a real split — a short Arabic summary for the toast. */
  onDone:      (message: string) => void;
}) {
  const [summary, setSummary] = useState<SplitResult | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [countStr, setCountStr] = useState('');
  const [newest, setNewest] = useState(false);
  const [quota, setQuota] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ key: string; data: SplitResult } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const filtersKey = JSON.stringify(filters);
  useEffect(() => {
    let alive = true;
    splitOrders({ filters: JSON.parse(filtersKey) as SplitFilters, dryRun: true })
      .then((r) => { if (!alive) return; setSummary(r.data); setCountStr(String(r.data.total ?? 0)); })
      .catch((e) => { if (alive) setLoadErr(errOf(e, 'تعذّر تحميل الطلبات')); });
    return () => { alive = false; };
  }, [filtersKey]);

  const total = summary?.total ?? 0;
  const count = toInt(countStr);
  /* Absent girls can't receive (the server refuses) — listed as a count only. */
  const agents = useMemo(() => (summary?.agents ?? []).filter((a) => !a.is_absent), [summary]);
  const absentCount = (summary?.agents ?? []).length - agents.length;
  const allocations = useMemo(() => agents
    .map((a) => ({ agentId: a.id, count: toInt(quota[a.id] ?? '') }))
    .filter((a) => Number.isInteger(a.count) && a.count > 0), [agents, quota]);
  const sum = allocations.reduce((s, a) => s + a.count, 0);
  const inputsKey = JSON.stringify({ count, newest, allocations });
  const previewOk = preview?.key === inputsKey;
  const ready = Number.isInteger(count) && count > 0 && count <= total && allocations.length > 0 && sum === count;

  const evenly = () => {
    const list = agents.filter((a) => (quota[a.id] ?? '').trim() !== '');
    if (!list.length || !Number.isInteger(count)) { setError('اكتبي أي رقم قدام البنات اللي هتاخد، وبعدين دوسي «بالتساوي»'); return; }
    const base = Math.floor(count / list.length);
    let extra = count - base * list.length;
    const next = { ...quota };
    for (const a of list) { next[a.id] = String(base + (extra > 0 ? 1 : 0)); if (extra > 0) extra -= 1; }
    setQuota(next); setError('');
  };

  const run = async (dryRun: boolean) => {
    setBusy(true); setError('');
    try {
      const r = await splitOrders({ filters, count, newest, allocations, dryRun });
      if (dryRun) setPreview({ key: inputsKey, data: r.data });
      else {
        const parts = (r.data.plan ?? []).filter((p) => p.count).map((p) => `${p.name} ${p.count}`);
        onDone(`اتوزّع ${r.data.moved} طلب: ${parts.join(' · ')}` +
          (r.data.raced ? ` — و${r.data.raced} اتغيّروا في نفس اللحظة فاتسابوا مكانهم` : ''));
        return;
      }
    } catch (e) {
      setError(errOf(e, dryRun ? 'تعذّرت المعاينة' : 'فشل التوزيع'));
      setPreview(null);
    }
    setBusy(false);
  };

  const field = 'px-2 py-1.5 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500';

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4"
      dir="rtl" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[92dvh] flex flex-col
        border border-slate-200 dark:border-slate-700">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-900 dark:text-white">توزيع بالأعداد</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{filterLabel}</p>
            </div>
            <button onClick={onClose} disabled={busy} aria-label="إغلاق"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* Body (scrolls) */}
        <div className="px-5 py-4 flex-1 overflow-y-auto overscroll-contain space-y-4 text-sm">
          {!summary ? (
            <div className="py-10 text-center text-slate-400">{loadErr || 'جارٍ التحميل…'}</div>
          ) : total === 0 ? (
            <div className="py-8 text-center text-slate-500 dark:text-slate-400">
              مفيش طلبات «لا يرد» أو «مراجعة جديدة» في الفلتر ده.
            </div>
          ) : (
            <>
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60">
                <p className="font-semibold text-slate-800 dark:text-slate-100">
                  في الفلتر: <b className="text-emerald-700 dark:text-emerald-400">{total}</b> طلب
                  {(summary.other_status ?? 0) > 0 && (
                    <span className="mr-1 text-xs font-normal text-slate-400">(و{summary.other_status} بحالات تانية مش هيتنقلوا)</span>
                  )}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                  معاهم دلوقتي: {(summary.holders ?? []).map((h) => `${h.name} ${h.count}`).join(' · ')}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="font-semibold text-slate-700 dark:text-slate-200">عدد الطلبات اللي هتتوزع</label>
                <input value={countStr} onChange={(e) => setCountStr(e.target.value)} inputMode="numeric"
                  className={`${field} w-20 text-center`} />
                <span className="text-xs text-slate-400">من {total}</span>
                {Number.isInteger(count) && count < total && (
                  <select value={newest ? 'new' : 'old'} onChange={(e) => setNewest(e.target.value === 'new')} className={field}>
                    <option value="old">الأقدم الأول</option>
                    <option value="new">الأحدث الأول</option>
                  </select>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">كل بنت تاخد كام (سيبي الخانة فاضية للي مش هتاخد)</p>
                  <button type="button" onClick={evenly} className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline">بالتساوي</button>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-100 dark:border-slate-800 rounded-xl">
                  {agents.map((a) => {
                    const linked = a.person_name !== a.name;
                    return (
                      <div key={a.id} className={`flex items-center gap-3 px-3 py-2 ${a.is_absent ? 'opacity-50' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-slate-800 dark:text-slate-100 truncate">
                            {a.name}
                            {linked && <span className="mr-1 text-[11px] font-normal text-slate-400">(حساب مراجعة — {a.person_name})</span>}
                            {a.is_absent && <span className="mr-1 text-[11px] font-normal text-slate-400">(غائبة)</span>}
                          </p>
                          {a.held > 0 && (
                            <p className="text-[11px] text-amber-700 dark:text-amber-400">
                              {linked ? `معاها هي وحسابها ${a.held}` : `معاها ${a.held}`} من دول — مش هيرجعولها
                            </p>
                          )}
                        </div>
                        <input value={quota[a.id] ?? ''} disabled={a.is_absent || busy} inputMode="numeric" placeholder="—"
                          onChange={(e) => setQuota((q) => ({ ...q, [a.id]: e.target.value }))}
                          className={`${field} w-16 text-center`} />
                      </div>
                    );
                  })}
                </div>
                {absentCount > 0 && (
                  <p className="mt-1 text-[11px] text-slate-400">فيه {absentCount} متسجلين غياب النهارده — مش ظاهرين هنا</p>
                )}
                <p className={`mt-2 text-xs font-semibold ${ready ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  المجموع {sum} من {Number.isInteger(count) ? count : '—'} {ready ? '✓' : ''}
                </p>
              </div>

              {previewOk && preview && (
                <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 space-y-1">
                  <p className="font-semibold text-emerald-800 dark:text-emerald-300">المعاينة — مفيش أي أوردر هيرجع للي معاها:</p>
                  {(preview.data.plan ?? []).map((p) => (
                    <p key={p.id} className="text-xs text-slate-700 dark:text-slate-200">
                      <b>{p.name}</b> ← {p.count} <span className="text-slate-500 dark:text-slate-400">
                        (من: {Object.entries(p.from).map(([n, c]) => `${n} ${c}`).join(' · ')})</span>
                    </p>
                  ))}
                </div>
              )}

            </>
          )}
        </div>

        {/* Error — outside the scroll area, so it is seen on a phone without scrolling */}
        {error && (
          <div className="mx-5 mt-3 p-3 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-xs leading-relaxed">{error}</div>
        )}

        {/* Footer (always visible) */}
        <div className="px-5 pb-5 pt-3 border-t border-slate-100 dark:border-slate-800 flex gap-3">
          <button disabled={!ready || busy} onClick={() => run(!previewOk)}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed
              ${previewOk ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
            {busy ? 'جارٍ…' : previewOk ? `تأكيد توزيع ${count} طلب` : 'معاينة'}
          </button>
          <button onClick={onClose} disabled={busy}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 disabled:opacity-50">
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
