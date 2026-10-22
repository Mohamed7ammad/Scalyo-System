'use client';

/* ════════════════════════════════════════════════════════════════════════════
   Schedule editor — work windows + checkpoint times (admin / Team Leader)
   ════════════════════════════════════════════════════════════════════════════
   Collapsible section of /dashboard/team-monitor; loads only when opened.
   Both lists take effect immediately:
     • work windows   → the idle tracker runs only inside them (computed live);
     • checkpoint times → every future day AND today's checkpoints that are not
       due yet; a new time that has already passed today applies from tomorrow.
   Checked-in / missed checkpoints never change. The API re-validates all of it. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getDisciplineCheckpointDefs, updateDisciplineCheckpoint, getDisciplineWorkWindows, setDisciplineWorkWindows,
  DisciplineCheckpointDef, DisciplineWorkWindow,
} from '@/lib/api';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_WINDOWS = 10;
const TRACK_AR: Record<'confirmation' | 'review', string> = { confirmation: 'تأكيد', review: 'مراجعة' };
const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

/* "13:30" → "1:30 م" — the native time input follows the device's locale, so
   the 12-hour reading is shown beside it to avoid AM/PM slips. */
const ar12 = (t: string) => {
  if (!HHMM.test(t)) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'ص' : 'م'}`;
};
const addMinutes = (t: string, mins: number) => {
  if (!HHMM.test(t)) return '';
  const [h, m] = t.split(':').map(Number);
  const total = h * 60 + m + mins;
  return total > 23 * 60 + 59 ? '' : `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const sameWindows = (a: DisciplineWorkWindow[], b: DisciplineWorkWindow[]) =>
  a.length === b.length && a.every((w, i) => w.start === b[i].start && w.end === b[i].end);
const byStart = (list: DisciplineWorkWindow[]) => [...list].sort((x, y) => x.start.localeCompare(y.start));

/* Mirrors the server's rules: HH:MM, start < end, no overlaps (touching is fine), 1–10. */
function validateWindows(list: DisciplineWorkWindow[]) {
  const rows: (string | null)[] = list.map((w) =>
    !HHMM.test(w.start) || !HHMM.test(w.end) ? 'أدخلي وقت البداية والنهاية'
      : w.end <= w.start ? 'النهاية يجب أن تكون بعد البداية' : null);
  const order = list.map((w, i) => ({ ...w, i })).filter((w) => rows[w.i] == null).sort((x, y) => x.start.localeCompare(y.start));
  for (let k = 1; k < order.length; k++) {
    if (order[k].start < order[k - 1].end) {
      rows[order[k].i] = `متداخلة مع ${order[k - 1].start}–${order[k - 1].end}`;
      rows[order[k - 1].i] ??= `متداخلة مع ${order[k].start}–${order[k].end}`;
    }
  }
  const general = !list.length ? 'أضيفي فترة عمل واحدة على الأقل'
    : list.length > MAX_WINDOWS ? `الحد الأقصى ${MAX_WINDOWS} فترات` : null;
  return { rows, general, ok: !general && rows.every((r) => r == null) };
}

type Msg = { ok: boolean; text: string } | null;

const INPUT = 'px-1.5 sm:px-2 py-1.5 rounded-lg text-sm border bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 [color-scheme:light] dark:[color-scheme:dark] disabled:opacity-60';
const BTN_PRIMARY = 'px-3 py-1.5 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed';
const BTN_GHOST = 'px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 disabled:opacity-40';

function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <p className={`text-xs rounded-lg px-2.5 py-1.5 ${msg.ok
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
      : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}>{msg.text}</p>
  );
}

export default function DisciplineScheduleEditor({ onSaved }: { onSaved?: () => void }) {
  const [open,    setOpen]    = useState(false);
  const [loaded,  setLoaded]  = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const [windows, setWindows] = useState<DisciplineWorkWindow[]>([]);   // saved
  const [wDraft,  setWDraft]  = useState<DisciplineWorkWindow[]>([]);
  const [wBusy,   setWBusy]   = useState(false);
  const [wMsg,    setWMsg]    = useState<Msg>(null);

  const [defs,    setDefs]    = useState<DisciplineCheckpointDef[]>([]); // saved
  const [tDraft,  setTDraft]  = useState<Record<string, string>>({});    // code → due_time
  const [cBusy,   setCBusy]   = useState(false);
  const [cMsg,    setCMsg]    = useState<Msg>(null);

  const load = useCallback(async () => {
    try {
      const [w, c] = await Promise.all([getDisciplineWorkWindows(), getDisciplineCheckpointDefs()]);
      setWindows(w.data);
      setWDraft(w.data.map((x) => ({ ...x })));
      setDefs(c.data);
      setTDraft(Object.fromEntries(c.data.map((d) => [d.code, d.due_time])));
      setLoaded(true);
      setLoadErr('');
    } catch (e) {
      setLoadErr(errMsg(e, 'تعذّر تحميل إعدادات الجدول'));
    }
  }, []);

  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded, load]);

  /* ── Work windows ─────────────────────────────────────────────────────────── */
  const wCheck = useMemo(() => validateWindows(wDraft), [wDraft]);
  const wDirty = !sameWindows(byStart(wDraft), windows);

  const editWindow = (i: number, key: 'start' | 'end', value: string) => {
    setWMsg(null);
    setWDraft((list) => list.map((w, j) => (j === i ? { ...w, [key]: value } : w)));
  };
  const addWindow = () => {
    setWMsg(null);
    setWDraft((list) => {
      const last = byStart(list).at(-1);
      const start = last ? addMinutes(last.end, 30) : '12:00';
      return [...list, { start, end: start ? addMinutes(start, 60) || '23:59' : '' }];
    });
  };
  const removeWindow = (i: number) => {
    setWMsg(null);
    setWDraft((list) => list.filter((_, j) => j !== i));
  };

  const saveWindows = async () => {
    if (!wCheck.ok || !wDirty) return;
    setWBusy(true);
    setWMsg(null);
    try {
      const { data } = await setDisciplineWorkWindows(byStart(wDraft));
      setWindows(data);
      setWDraft(data.map((x) => ({ ...x })));
      setWMsg({ ok: true, text: 'تم حفظ فترات العمل — تسري فوراً على عداد عدم النشاط' });
      onSaved?.();
    } catch (e) {
      setWMsg({ ok: false, text: errMsg(e, 'تعذّر حفظ فترات العمل') });
    } finally {
      setWBusy(false);
    }
  };

  /* ── Checkpoints ──────────────────────────────────────────────────────────── */
  const changed = defs.filter((d) => (tDraft[d.code] ?? d.due_time) !== d.due_time);
  const cValid  = changed.every((d) => HHMM.test(tDraft[d.code] ?? ''));
  /* Hint only: a checkpoint outside every (draft) window is legal, but the idle
     tracker is asleep then — usually a typo. */
  const outsideWindows = (t: string) => HHMM.test(t) && wCheck.ok && !wDraft.some((w) => t >= w.start && t < w.end);

  const saveCheckpoints = async () => {
    if (!changed.length || !cValid) return;
    if (!window.confirm(
      `حفظ ${changed.length === 1 ? 'موعد واحد' : `${changed.length} مواعيد`}؟\n` +
      'يسري فوراً على نقاط اليوم التي لم يحن موعدها بعد، وعلى كل الأيام القادمة.\n' +
      'الموعد الذي مرّ وقته اليوم يُطبَّق من الغد.')) return;
    setCBusy(true);
    setCMsg(null);
    let retimed = 0, kept = 0;
    const failed: string[] = [];
    const saved = new Map<string, DisciplineCheckpointDef>();
    for (const d of changed) {
      try {
        const { data } = await updateDisciplineCheckpoint(d.code, { due_time: tDraft[d.code] });
        saved.set(d.code, data.checkpoint);
        retimed += data.today.retimed;
        kept    += data.today.kept;
      } catch (e) {
        failed.push(`«${d.label_ar}»: ${errMsg(e, 'تعذّر الحفظ')}`);
      }
    }
    if (saved.size) {
      setDefs((list) => list.map((d) => saved.get(d.code) ?? d));
      setTDraft((draft) => ({ ...draft, ...Object.fromEntries([...saved].map(([code, d]) => [code, d.due_time])) }));
      onSaved?.();
    }
    if (failed.length) {
      setCMsg({ ok: false, text: failed.join(' · ') });
    } else {
      const parts = ['تم حفظ المواعيد'];
      if (retimed) parts.push(`مواعيد اليوم القادمة التي عُدِّلت: ${retimed}`);
      if (kept)    parts.push(`مواعيد مرّ وقتها اليوم: ${kept} — تُطبَّق من الغد`);
      setCMsg({ ok: true, text: parts.join(' · ') });
    }
    setCBusy(false);
  };

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
        <span>⚙️ إعدادات الجدول — فترات العمل ومواعيد نقاط المتابعة</span>
        <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-3 sm:px-4 pb-4 space-y-4">
          {loadErr && (
            <div className="flex items-center gap-2">
              <Note msg={{ ok: false, text: loadErr }} />
              <button onClick={load} className={BTN_GHOST}>إعادة المحاولة</button>
            </div>
          )}
          {!loaded && !loadErr && <p className="text-xs text-slate-500 dark:text-slate-400">جارٍ التحميل…</p>}

          {loaded && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Work windows */}
              <section className="rounded-xl border border-slate-200 dark:border-slate-800 p-2.5 sm:p-3 space-y-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">فترات العمل</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    عداد عدم النشاط يعمل داخل هذه الفترات فقط — خارجها لا لون برتقالي ولا تنبيه «هل ما زلتِ هنا؟». يسري فوراً.
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_auto_1fr_1.75rem] gap-1.5 sm:gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    <span>من</span><span /><span>إلى</span><span />
                  </div>
                  {wDraft.map((w, i) => {
                    const err = wCheck.rows[i];
                    const border = err ? 'border-red-400 dark:border-red-500' : 'border-slate-200 dark:border-slate-700';
                    return (
                      <div key={i}>
                        <div className="grid grid-cols-[1fr_auto_1fr_1.75rem] items-center gap-1.5 sm:gap-2">
                          <input type="time" dir="ltr" value={w.start} disabled={wBusy} aria-label={`بداية الفترة ${i + 1}`}
                            onChange={(e) => editWindow(i, 'start', e.target.value)} className={`${INPUT} w-full min-w-0 ${border}`} />
                          <span className="text-slate-400">–</span>
                          <input type="time" dir="ltr" value={w.end} disabled={wBusy} aria-label={`نهاية الفترة ${i + 1}`}
                            onChange={(e) => editWindow(i, 'end', e.target.value)} className={`${INPUT} w-full min-w-0 ${border}`} />
                          <button onClick={() => removeWindow(i)} disabled={wBusy} aria-label={`حذف الفترة ${i + 1}`} title="حذف الفترة"
                            className="w-7 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40">
                            ×
                          </button>
                        </div>
                        <p className={`text-[11px] mt-0.5 ${err ? 'text-red-600 dark:text-red-400' : 'text-slate-400'}`}>
                          {err ?? `${ar12(w.start)} ← ${ar12(w.end)}`}
                        </p>
                      </div>
                    );
                  })}
                  {wCheck.general && <p className="text-[11px] text-red-600 dark:text-red-400">{wCheck.general}</p>}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={addWindow} disabled={wBusy || wDraft.length >= MAX_WINDOWS} className={BTN_GHOST}>+ إضافة فترة</button>
                  <span className="flex-1" />
                  {wDirty && (
                    <button onClick={() => { setWDraft(windows.map((x) => ({ ...x }))); setWMsg(null); }} disabled={wBusy} className={BTN_GHOST}>
                      تراجع
                    </button>
                  )}
                  <button onClick={saveWindows} disabled={wBusy || !wDirty || !wCheck.ok} className={BTN_PRIMARY}>
                    {wBusy ? 'جارٍ الحفظ…' : 'حفظ الفترات'}
                  </button>
                </div>
                <Note msg={wMsg} />
              </section>

              {/* Checkpoints */}
              <section className="rounded-xl border border-slate-200 dark:border-slate-800 p-2.5 sm:p-3 space-y-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">مواعيد نقاط المتابعة</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    التسجيل يفتح قبل الموعد بـ 30 دقيقة، والسحب بعد انتهاء مهلة السماح. التعديل يسري فوراً على نقاط اليوم القادمة وعلى الأيام التالية.
                  </p>
                </div>

                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {defs.map((d) => {
                    const value = tDraft[d.code] ?? d.due_time;
                    const dirty = value !== d.due_time;
                    const bad = dirty && !HHMM.test(value);
                    return (
                      <div key={d.code} className={`flex items-center gap-3 py-2 ${d.is_active ? '' : 'opacity-60'}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">
                            {d.label_ar}{!d.is_active && <span className="text-[11px] text-slate-400"> (موقوفة)</span>}
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400">
                            {d.tracks.map((t) => TRACK_AR[t]).join(' + ')} · مهلة {d.grace_minutes} د
                            {HHMM.test(value) && <> · {ar12(value)}</>}
                            {outsideWindows(value) && <span className="text-amber-600 dark:text-amber-400"> · ⚠️ خارج فترات العمل</span>}
                          </p>
                        </div>
                        <input type="time" dir="ltr" value={value} disabled={cBusy} aria-label={`موعد ${d.label_ar}`}
                          onChange={(e) => { setCMsg(null); setTDraft((t) => ({ ...t, [d.code]: e.target.value })); }}
                          className={`${INPUT} w-28 shrink-0 ${bad ? 'border-red-400 dark:border-red-500'
                            : dirty ? 'border-indigo-400 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-800'
                            : 'border-slate-200 dark:border-slate-700'}`} />
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 text-[11px] text-slate-500 dark:text-slate-400">
                    {changed.length ? `تعديلات غير محفوظة: ${changed.length}` : ''}
                  </span>
                  {changed.length > 0 && (
                    <button onClick={() => { setTDraft(Object.fromEntries(defs.map((d) => [d.code, d.due_time]))); setCMsg(null); }} disabled={cBusy} className={BTN_GHOST}>
                      تراجع
                    </button>
                  )}
                  <button onClick={saveCheckpoints} disabled={cBusy || !changed.length || !cValid} className={BTN_PRIMARY}>
                    {cBusy ? 'جارٍ الحفظ…' : 'حفظ المواعيد'}
                  </button>
                </div>
                <Note msg={cMsg} />
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
