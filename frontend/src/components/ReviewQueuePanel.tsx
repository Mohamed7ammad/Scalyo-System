'use client';

/* ════════════════════════════════════════════════════════════════════════════
   «توزيع طابور المراجعة» — the Team Leader's manual «لا يرد» hand-off
   ════════════════════════════════════════════════════════════════════════════
   On /dashboard/team-monitor (admin + Team Leader). Replaces the old 4-day
   filter-and-transfer sweep: the system tracks each «لا يرد» order's cycle
   (2 days with its agent → 2 review days → «ملغي - عدم رد نهائي»), and she
   decides WHO receives the ready ones and WHEN. Picking reviewers shows the
   exact split first (dry run); the button then hands the orders to ONLY those
   reviewers, never back to the order's own agent or its current holder.     */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getReviewQueue, distributeReviewQueue, ReviewQueueSummary, ReviewQueueResult,
} from '@/lib/api';

const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
const CAIRO_HM = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: 'Africa/Cairo', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: true,
});
const handOffs = (r: Pick<ReviewQueueResult, 'to_review' | 'redeal' | 'rescue'>) => r.to_review + r.redeal + r.rescue;

export default function ReviewQueuePanel({ onDone }: { onDone?: () => void }) {
  const [summary,  setSummary]  = useState<ReviewQueueSummary | null>(null);
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

  /* Exact plan for the current selection (dry run, debounced). */
  useEffect(() => {
    if (!selected.length) { setPreview(null); return; }
    let live = true;
    const id = setTimeout(async () => {
      try {
        const { data } = await distributeReviewQueue(selected, true);
        if (live) setPreview(data);
      } catch (e) {
        if (live) { setPreview(null); setMsg({ ok: false, text: errMsg(e, 'تعذّر حساب التوزيع') }); }
      }
    }, 250);
    return () => { live = false; clearTimeout(id); };
  }, [selected, summary]);

  const toggle = (id: string) => {
    setMsg(null);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const run = async () => {
    if (!preview || !selected.length) return;
    const n = handOffs(preview);
    const names = (summary?.reviewers ?? []).filter((r) => selected.includes(r.id)).map((r) => r.name).join(' و');
    if (!window.confirm(
      `توزيع ${n} أوردر «لا يرد» على ${names}؟` +
      (preview.close ? `\nوإغلاق ${preview.close} أوردر نهائياً («ملغي - عدم رد نهائي») بعد انتهاء يومي المراجعة.` : ''))) return;
    setBusy(true);
    setMsg(null);
    try {
      const { data } = await distributeReviewQueue(selected, false);
      const parts = [handOffs(data) ? `تم التوزيع: ${splitText(data.to)}` : 'لا أوردرات جديدة للتوزيع'];
      if (data.close) parts.push(`أُغلق ${data.close} نهائياً`);
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

  if (!summary) return null;
  const r = summary.ready;
  const readyTotal = handOffs(r);
  const skipped = preview ? preview.skipped.same_agent + preview.skipped.product : 0;
  const nothing = !!preview && handOffs(preview) === 0 && preview.close === 0;

  return (
    <div className="rounded-2xl border-2 border-indigo-200 dark:border-indigo-900/60 bg-white dark:bg-slate-900 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">طابور المراجعة — «لا يرد»</h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            كل أوردر: يومان مع موظفته ← يوما مراجعة مع موظفة أخرى ← «ملغي - عدم رد نهائي». أنتِ تختارين مين تستلم ومتى.
          </p>
        </div>
        <button onClick={load} disabled={busy} className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50">تحديث</button>
      </div>

      {/* What a distribution would act on right now */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
          جاهزة للمراجعة <b className="text-sm">{r.to_review}</b>
        </span>
        <span className="px-2.5 py-1 rounded-lg bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
          جولة مراجعة ثانية <b className="text-sm">{r.redeal}</b>
        </span>
        {r.rescue > 0 && (
          <span className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
            مع موظفة غائبة <b className="text-sm">{r.rescue}</b>
          </span>
        )}
        <span className="px-2.5 py-1 rounded-lg bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          ستُغلق نهائياً <b className="text-sm">{r.close}</b>
        </span>
        <span className="px-2.5 py-1 text-slate-500 dark:text-slate-400">
          في الدورة الآن: مع موظفاتهن {summary.open.owner} · في المراجعة {summary.open.review}
        </span>
      </div>

      {/* Reviewer selection */}
      <div>
        <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1.5">اختاري حساب (حسابات) المراجعة:</p>
        <div className="flex flex-wrap gap-2">
          {summary.reviewers.map((rv) => {
            const on = selected.includes(rv.id);
            return (
              <button key={rv.id} onClick={() => toggle(rv.id)} disabled={rv.is_absent || busy}
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
            {handOffs(preview) ? <>التوزيع: <b>{splitText(preview.to)}</b></> : 'لا أوردرات تُنقل لهذا الاختيار.'}
            {preview.close > 0 && <> · سيُغلق <b>{preview.close}</b> نهائياً</>}
          </p>
          {preview.skipped.same_agent > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              {preview.skipped.same_agent} لن تُنقل: الموظفة المختارة هي صاحبة الأوردر أو معها حالياً — أضيفي موظفة مراجعة أخرى لتوزيعها.
            </p>
          )}
          {preview.skipped.product > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              {preview.skipped.product} لن تُنقل: المنتج غير مسموح للموظفة المختارة.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={run} disabled={busy || !selected.length || !preview || nothing}
          className="px-5 py-2.5 rounded-xl text-sm font-bold bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? 'جارٍ التوزيع…' : 'توزيع طابور المراجعة'}
        </button>
        {!selected.length && (readyTotal > 0 || r.close > 0) && (
          <span className="text-xs text-slate-500 dark:text-slate-400">اختاري موظفة مراجعة واحدة على الأقل.</span>
        )}
        {skipped > 0 && selected.length > 0 && !busy && (
          <span className="text-[11px] text-slate-400">({skipped} ستبقى كما هي)</span>
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
