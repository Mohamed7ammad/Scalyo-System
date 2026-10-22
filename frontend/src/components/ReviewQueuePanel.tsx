'use client';

/* ════════════════════════════════════════════════════════════════════════════
   «توزيع طابور المراجعة» — the Team Leader's manual «لا يرد» hand-off
   ════════════════════════════════════════════════════════════════════════════
   On /dashboard/team-monitor (admin + Team Leader). Replaces the old 4-day
   filter-and-transfer sweep: the system tracks each «لا يرد» order's cycle
   (2 days with its agent → 2 review days → «ملغي - عدم رد نهائي»), and she
   decides WHAT is handed out (the ticked queues), to WHOM and WHEN. Ticking
   queues and reviewers shows the exact split first (dry run); the button then
   splits ONLY the ticked queues evenly between ONLY those reviewers.        */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getReviewQueue, distributeReviewQueue, ReviewQueueSummary, ReviewQueueResult, ReviewQueueKey,
} from '@/lib/api';

const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
const CAIRO_HM = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: 'Africa/Cairo', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: true,
});
const handOffs = (r: Pick<ReviewQueueResult, 'to_review' | 'redeal' | 'rescue'>) => r.to_review + r.redeal + r.rescue;

/* The queues she can tick. «مع موظفة غائبة» and the closing step only appear
   when they have orders; everything is ticked by default. */
const QUEUES: { key: ReviewQueueKey; label: string; on: string; optional?: boolean }[] = [
  { key: 'to_review', label: 'جاهزة للمراجعة',
    on: 'bg-indigo-50 border-indigo-300 text-indigo-800 dark:bg-indigo-900/30 dark:border-indigo-700 dark:text-indigo-200' },
  { key: 'redeal',    label: 'جولة مراجعة ثانية',
    on: 'bg-sky-50 border-sky-300 text-sky-800 dark:bg-sky-900/30 dark:border-sky-700 dark:text-sky-200' },
  { key: 'rescue',    label: 'مع موظفة غائبة', optional: true,
    on: 'bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-200' },
  { key: 'close',     label: 'إغلاق نهائي («ملغي - عدم رد نهائي»)', optional: true,
    on: 'bg-zinc-100 border-zinc-300 text-zinc-800 dark:bg-zinc-800 dark:border-zinc-600 dark:text-zinc-200' },
];
const ALL_ON: Record<ReviewQueueKey, boolean> = { to_review: true, redeal: true, rescue: true, close: true };

export default function ReviewQueuePanel({ onDone }: { onDone?: () => void }) {
  const [summary,  setSummary]  = useState<ReviewQueueSummary | null>(null);
  const [queues,   setQueues]   = useState<Record<ReviewQueueKey, boolean>>(ALL_ON);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview,  setPreview]  = useState<ReviewQueueResult | null>(null);
  const [busy,     setBusy]     = useState(false);
  const [msg,      setMsg]      = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await getReviewQueue();
      setSummary(data);
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e, 'تعذّر تحميل طابور المراجعة') });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const nameOf = useMemo(() => {
    const m = new Map((summary?.reviewers ?? []).map((r) => [r.email.trim().toLowerCase(), r.name]));
    return (email: string) => m.get(email.trim().toLowerCase()) ?? email.split('@')[0];
  }, [summary]);
  const splitText = (to: Record<string, number>) =>
    Object.entries(to).map(([email, n]) => `${nameOf(email)} (${n})`).join(' · ');

  /* What is ticked, and whether it needs reviewers (closing alone doesn't). */
  const ready = summary?.ready;
  const chosen = useMemo(() => QUEUES.map((q) => q.key).filter((k) => queues[k]), [queues]);
  const chosenCount = ready ? chosen.reduce((n, k) => n + ready[k], 0) : 0;
  const needAgents  = ready ? chosen.some((k) => k !== 'close' && ready[k] > 0) : false;
  const canPreview  = chosenCount > 0 && (!needAgents || selected.length > 0);

  /* Exact plan for the current selection (dry run, debounced). */
  useEffect(() => {
    if (!canPreview) { setPreview(null); return; }
    let live = true;
    const id = setTimeout(async () => {
      try {
        const { data } = await distributeReviewQueue(selected, true, chosen);
        if (live) setPreview(data);
      } catch (e) {
        if (live) { setPreview(null); setMsg({ ok: false, text: errMsg(e, 'تعذّر حساب التوزيع') }); }
      }
    }, 250);
    return () => { live = false; clearTimeout(id); };
  }, [canPreview, selected, chosen, summary]);

  const toggleReviewer = (id: string) => {
    setMsg(null);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const toggleQueue = (k: ReviewQueueKey) => {
    setMsg(null);
    setQueues((q) => ({ ...q, [k]: !q[k] }));
  };

  const run = async () => {
    if (!preview || !canPreview) return;
    const n = handOffs(preview);
    const names = (summary?.reviewers ?? []).filter((r) => selected.includes(r.id)).map((r) => r.name).join(' و');
    const lines = [];
    if (n) lines.push(`توزيع ${n} أوردر «لا يرد» على ${names}؟`);
    if (preview.close) lines.push(`${n ? 'و' : ''}إغلاق ${preview.close} أوردر نهائياً («ملغي - عدم رد نهائي») بعد انتهاء يومي المراجعة${n ? '.' : '؟'}`);
    if (!window.confirm(lines.join('\n'))) return;
    setBusy(true);
    setMsg(null);
    try {
      const { data } = await distributeReviewQueue(selected, false, chosen);
      const parts = [];
      if (handOffs(data)) parts.push(`تم التوزيع: ${splitText(data.to)}`);
      if (data.close) parts.push(`أُغلق ${data.close} نهائياً`);
      if (!parts.length) parts.push('لا أوردرات جديدة في القوائم المختارة');
      if (data.raced) parts.push(`${data.raced} تغيّر أثناء التوزيع وتُرك كما هو`);
      setMsg({ ok: true, text: parts.join(' · ') });
      setSelected([]);
      await load();
      onDone?.();
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e, 'تعذّر التوزيع') });
    } finally {
      setBusy(false);
    }
  };

  if (!summary || !ready) return null;
  const nothing = !!preview && handOffs(preview) === 0 && preview.close === 0;

  return (
    <div className="rounded-2xl border-2 border-indigo-200 dark:border-indigo-900/60 bg-white dark:bg-slate-900 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">طابور المراجعة — «لا يرد»</h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            كل أوردر: يومان مع موظفته ← يوما مراجعة مع موظفة أخرى ← «ملغي - عدم رد نهائي». أنتِ تختارين ماذا يُوزَّع، ومين تستلم، ومتى.
            يصل لحساب المراجعة كـ «مراجعة جديدة»، واللي ميردش تحوّله الموظفة «لا يرد».
          </p>
        </div>
        <button onClick={load} disabled={busy} className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50">تحديث</button>
      </div>

      {/* Which queues to hand out */}
      <div>
        <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1.5">ماذا يُوزَّع؟</p>
        <div className="flex flex-wrap gap-2">
          {QUEUES.filter((q) => !q.optional || ready[q.key] > 0).map((q) => {
            const on = queues[q.key];
            return (
              <label key={q.key}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm border cursor-pointer select-none transition
                  ${busy ? 'opacity-60 cursor-not-allowed' : ''}
                  ${on ? q.on : 'bg-white border-slate-200 text-slate-500 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-400'}`}>
                <input type="checkbox" checked={on} disabled={busy} onChange={() => toggleQueue(q.key)}
                  className="w-4 h-4 accent-indigo-600 cursor-pointer" />
                {q.label} <b className="text-sm">{ready[q.key]}</b>
              </label>
            );
          })}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
          في الدورة الآن: مع موظفاتهن {summary.open.owner} · في المراجعة {summary.open.review}
        </p>
      </div>

      {/* Reviewer selection */}
      <div>
        <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1.5">اختاري حساب (حسابات) المراجعة:</p>
        <div className="flex flex-wrap gap-2">
          {summary.reviewers.map((rv) => {
            const on = selected.includes(rv.id);
            return (
              <button key={rv.id} onClick={() => toggleReviewer(rv.id)} disabled={rv.is_absent || busy}
                aria-pressed={on}
                title={rv.is_absent ? 'مسجّلة غائبة اليوم' : `معها الآن ${rv.review_load} أوردر مراجعة`}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed
                  ${on
                    ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                    : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-700'}`}>
                <span aria-hidden>{on ? '✓' : '○'}</span>
                {rv.name}
                <span className={`text-[11px] ${on ? 'text-indigo-200' : 'text-slate-400'}`}>
                  {rv.is_absent ? '(غائبة)' : `معها ${rv.review_load}`}
                </span>
              </button>
            );
          })}
          {!summary.reviewers.length && (
            <span className="text-xs text-slate-500 dark:text-slate-400">لا توجد حسابات مراجعة — سجّلي حساباً بمسار «مراجعة فقط» من «تسجيل الموظفات».</span>
          )}
        </div>
      </div>

      {/* Exact plan for the selection */}
      {preview && (
        <div className="text-xs rounded-xl bg-slate-50 dark:bg-slate-800/60 p-2.5 space-y-1">
          <p className="text-slate-700 dark:text-slate-200">
            {handOffs(preview) ? <>التوزيع ({handOffs(preview)} أوردر): <b>{splitText(preview.to)}</b></> : null}
            {handOffs(preview) > 0 && preview.close > 0 && ' · '}
            {preview.close > 0 && <>سيُغلق <b>{preview.close}</b> نهائياً</>}
            {nothing && 'لا أوردرات في القوائم المختارة.'}
          </p>
          {preview.skipped.product > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              {preview.skipped.product} لن تُنقل: المنتج غير مسموح للموظفة المختارة.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={run} disabled={busy || !canPreview || !preview || nothing}
          className="px-5 py-2.5 rounded-xl text-sm font-bold bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? 'جارٍ التوزيع…' : 'توزيع طابور المراجعة'}
        </button>
        {chosenCount === 0 && (
          <span className="text-xs text-slate-500 dark:text-slate-400">اختاري قائمة واحدة على الأقل فيها أوردرات.</span>
        )}
        {chosenCount > 0 && needAgents && !selected.length && (
          <span className="text-xs text-slate-500 dark:text-slate-400">اختاري موظفة مراجعة واحدة على الأقل.</span>
        )}
      </div>

      {msg && (
        <p className={`text-xs rounded-lg px-2.5 py-1.5 ${msg.ok
          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
          : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}>{msg.text}</p>
      )}

      {summary.last && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          آخر توزيع: {CAIRO_HM.format(new Date(summary.last.created_at))}
          {summary.last.actor_email && <> · بواسطة {summary.last.actor_email.split('@')[0]}</>}
          {Object.keys(summary.last.summary?.to ?? {}).length > 0 && <> · {splitText(summary.last.summary.to)}</>}
          {summary.last.summary?.close ? <> · أُغلق {summary.last.summary.close}</> : null}
        </p>
      )}
    </div>
  );
}
