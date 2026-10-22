'use client';

/* ════════════════════════════════════════════════════════════════════════════
   متابعة فريق التأكيد — Team Leader live board (admin + supervisor)
   ════════════════════════════════════════════════════════════════════════════
   Polls GET /api/discipline/live every 20s. Each enrolled agent is a card whose
   colour follows the agreed rules:
     red     — orders withdrawn today
     orange  — idle ≥ 20 min: had workable 'جديد' orders, inside a work window, no real action
     sky     — on a break
     yellow  — a checkpoint was late (1–15 min) or one is in its grace now
     green   — checked in on time
     grey    — not started / not scheduled
   The enrolment section sets users.agent_track (who the system monitors).     */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getDisciplineLive, setDisciplineTrack, reinstateDisciplineAgent, userHasRole, trackCovers,
  DisciplineBoard, DisciplineBoardAgent, DisciplineTrack,
} from '@/lib/api';

const POLL_MS = 20_000;
const CAIRO_HM = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: true,
});
const hm = (iso: string | null | undefined) => (iso ? CAIRO_HM.format(new Date(iso)) : '');
const TRACK_LABEL: Record<DisciplineTrack, string> = { confirmation: 'تأكيد', review: 'مراجعة', both: 'تأكيد ومراجعة' };
const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

type Tone = 'red' | 'orange' | 'sky' | 'yellow' | 'green' | 'grey';
const TONE: Record<Tone, { label: string; border: string; pill: string }> = {
  red:    { label: 'تم سحب الأوردرات', border: 'border-r-red-500',     pill: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  orange: { label: 'غير نشطة',         border: 'border-r-orange-500',  pill: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
  sky:    { label: 'استراحة',           border: 'border-r-sky-500',     pill: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  yellow: { label: 'تأخير بسيط',        border: 'border-r-amber-400',   pill: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  green:  { label: 'ملتزمة',            border: 'border-r-emerald-500', pill: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  grey:   { label: 'لم تبدأ',           border: 'border-r-slate-300 dark:border-r-slate-600', pill: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
};

function toneOf(a: DisciplineBoardAgent, idleSeconds: number | null, idleMin: number, now: number): Tone {
  if (!a.scheduled_today) return 'grey';
  if (a.status === 'withdrawn') return 'red';
  if (a.status === 'break') return 'sky';
  if (a.status === 'active' && idleSeconds != null && idleSeconds >= idleMin * 60) return 'orange';
  if (a.checkpoints.some((c) => c.outcome === 'late')) return 'yellow';
  if (a.checkpoints.some((c) => c.outcome === 'open' && Date.parse(c.due_at) <= now)) return 'yellow';
  if (a.checkpoints.some((c) => c.outcome === 'on_time')) return 'green';
  return 'grey';
}

const ago = (sec: number | null) => {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  if (m < 1) return 'الآن';
  if (m < 60) return `منذ ${m} د`;
  const h = Math.floor(m / 60);
  return h < 24 ? `منذ ${h} س` : `منذ ${Math.floor(h / 24)} يوم`;
};

export default function TeamMonitorPage() {
  const router = useRouter();
  const [allowed,  setAllowed]  = useState(false);
  const [board,    setBoard]    = useState<DisciplineBoard | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);     // client ms of last fetch
  const [offset,   setOffset]   = useState(0);       // server − client
  const [now,      setNow]      = useState(() => Date.now());
  const [error,    setError]    = useState('');
  const [toast,    setToast]    = useState('');
  const [busyId,   setBusyId]   = useState<string | null>(null);
  const [showEnrol, setShowEnrol] = useState(false);

  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!u) { router.replace('/'); return; }
      if (!(userHasRole(u, 'admin') || userHasRole(u, 'supervisor'))) { router.replace('/dashboard'); return; }
      setAllowed(true);
    } catch { router.replace('/'); }
  }, [router]);

  const load = useCallback(async () => {
    try {
      const { data } = await getDisciplineLive();
      setBoard(data);
      setFetchedAt(Date.now());
      setOffset(Date.parse(data.server_time) - Date.now());
      setError('');
    } catch (e) {
      setError(errMsg(e, 'تعذّر تحميل بيانات المتابعة'));
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [allowed, load]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const serverNow = now + offset;
  const drift = Math.max(0, (now - fetchedAt) / 1000);   // seconds since the board was fetched
  /* The server's idle clock (null = paused: no workable 'جديد' orders / outside shift). */
  const idleSec = useCallback((a: DisciplineBoardAgent) =>
    a.idle_seconds == null ? null : a.idle_seconds + drift, [drift]);

  const enrolled = useMemo(() => (board?.agents ?? []).filter((a) => a.track), [board]);
  const tones = useMemo(() => {
    const m = new Map<string, Tone>();
    for (const a of enrolled) m.set(a.id, toneOf(a, idleSec(a), board?.idle_minutes ?? 20, serverNow));
    return m;
  }, [enrolled, idleSec, board, serverNow]);
  const counts = useMemo(() => {
    const c: Record<Tone, number> = { red: 0, orange: 0, sky: 0, yellow: 0, green: 0, grey: 0 };
    tones.forEach((t) => { c[t] += 1; });
    return c;
  }, [tones]);

  const changeTrack = async (a: DisciplineBoardAgent, value: string) => {
    const track = value === '' ? null : (value as DisciplineTrack);
    if (track && !a.track && !window.confirm(`تسجيل ${a.name} في نظام المتابعة؟ تُطبَّق عليها مواعيد اليوم المتبقية فوراً، والتأخير أكثر من 15 دقيقة يسحب أوردراتها.`)) return;
    setBusyId(a.id);
    try { await setDisciplineTrack(a.id, track); setToast(track ? `تم تسجيل ${a.name} (${TRACK_LABEL[track]})` : `تم إلغاء تسجيل ${a.name}`); await load(); }
    catch (e) { setToast(errMsg(e, 'تعذّر الحفظ')); }
    finally { setBusyId(null); }
  };

  const reinstate = async (a: DisciplineBoardAgent) => {
    if (!window.confirm(`إعادة تفعيل ${a.name}؟ الأوردرات التي سُحبت تبقى مع من استلمتها، والتأخير يبقى في سجلها الشهري.`)) return;
    setBusyId(a.id);
    try { await reinstateDisciplineAgent(a.id); setToast(`تمت إعادة تفعيل ${a.name}`); await load(); }
    catch (e) { setToast(errMsg(e, 'تعذّر إعادة التفعيل')); }
    finally { setBusyId(null); }
  };

  if (!allowed) return null;

  return (
    <div className="p-4 sm:p-6 space-y-5" dir="rtl">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">متابعة فريق التأكيد</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            مواعيد اليوم: {board?.checkpoints.map((c) => c.due_time).join(' · ') || '…'} · مهلة السماح 15 دقيقة
            {board?.enforce_from && <> · بدء التطبيق {board.enforce_from} (القاهرة)</>}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          {fetchedAt > 0 && <span>آخر تحديث {CAIRO_HM.format(new Date(fetchedAt + offset))}</span>}
          <button onClick={load} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-medium">
            تحديث
          </button>
        </div>
      </div>

      {error && <div className="p-3 rounded-xl bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 text-sm">{error}</div>}
      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm shadow-lg">{toast}</div>}

      {/* Summary */}
      {board && (
        <div className="flex flex-wrap gap-2">
          {(['green', 'yellow', 'red', 'orange', 'sky', 'grey'] as Tone[]).map((t) => (
            <span key={t} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold ${TONE[t].pill}`}>
              {TONE[t].label} <b className="text-sm">{counts[t]}</b>
            </span>
          ))}
        </div>
      )}

      {/* Agent cards */}
      {board && enrolled.length === 0 && (
        <div className="p-6 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 text-center text-sm text-slate-500 dark:text-slate-400">
          لا توجد موظفات مسجّلات في نظام المتابعة بعد — سجّليهن من «تسجيل الموظفات» بالأسفل.
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {enrolled.map((a) => {
          const tone = tones.get(a.id) ?? 'grey';
          const idle = idleSec(a);
          const defs = (board?.checkpoints ?? []).filter((d) => d.tracks.some((t) => trackCovers(a.track, t)));
          const withdrawnLabel = board?.checkpoints.find((d) => d.code === a.withdrawn_checkpoint)?.label_ar ?? a.withdrawn_checkpoint;
          return (
            <div key={a.id} className={`rounded-2xl border border-slate-200 dark:border-slate-800 border-r-4 ${TONE[tone].border} bg-white dark:bg-slate-900 p-4 shadow-sm`}>
              <div className="flex items-center gap-2 mb-3">
                <span className="font-bold text-slate-900 dark:text-white truncate">{a.name}</span>
                {a.track && <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">{TRACK_LABEL[a.track]}</span>}
                <span className={`mr-auto px-2 py-0.5 rounded-full text-[11px] font-semibold ${TONE[tone].pill}`}>
                  {a.is_absent ? 'غائبة' : !a.scheduled_today ? 'غير مجدولة' : TONE[tone].label}
                </span>
              </div>

              {/* Checkpoints */}
              <div className="flex flex-wrap gap-1.5 mb-3">
                {defs.map((d) => {
                  const c = a.checkpoints.find((x) => x.code === d.code);
                  let cls = 'bg-slate-50 text-slate-400 border-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:border-slate-700';
                  let txt = d.due_time;
                  if (!c) txt = `${d.due_time} —`;
                  else if (c.outcome === 'on_time') { cls = 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'; txt = `✓ ${hm(c.checked_in_at)}${c.checked_in_via === 'work' ? ' ⚡' : ''}`; }
                  else if (c.outcome === 'late') { cls = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'; txt = `${hm(c.checked_in_at)} (+${c.late_minutes}د)${c.checked_in_via === 'work' ? ' ⚡' : ''}`; }
                  else if (c.outcome === 'missed') { cls = 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800'; txt = '✗ فائتة'; }
                  else if (Date.parse(c.due_at) <= serverNow) { cls = 'bg-amber-50 text-amber-800 border-amber-300 animate-pulse dark:bg-amber-900/30 dark:text-amber-300'; txt = 'في المهلة'; }
                  return (
                    <span key={d.code} title={c?.checked_in_via === 'work' ? `${d.label_ar} — سُجّل تلقائياً من العمل على الأوردرات` : d.label_ar} className={`px-2 py-1 rounded-lg border text-[11px] leading-tight ${cls}`}>
                      <span className="block text-[10px] opacity-75">{d.label_ar}</span>
                      <span dir="ltr">{txt}</span>
                    </span>
                  );
                })}
              </div>

              {/* Facts */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
                <span>آخر إجراء: <b className={tone === 'orange' ? 'text-orange-600 dark:text-orange-400' : ''}>{ago(a.seconds_since_action == null ? null : a.seconds_since_action + drift)}</b></span>
                <span>
                  {a.idle_paused_reason === 'no_new_orders' ? <span className="text-slate-400">⏸️ بانتظار أوردرات جديدة</span>
                    : a.idle_paused_reason === 'outside_window' ? <span className="text-slate-400">⏸️ خارج فترات العمل</span>
                    : <>جديد: <b>{a.new_orders}</b> · خمول <b className={tone === 'orange' ? 'text-orange-600 dark:text-orange-400' : ''}>{Math.floor((idle ?? 0) / 60)} د</b></>}
                </span>
                <span>تأكيد التواجد: <b>{a.still_here_today}</b></span>
                <span>استراحة: <b>{a.break.used_minutes}</b>/30 د · <b>{a.break.sessions_used}</b>/2</span>
                {a.break.active_until && <span className="text-sky-700 dark:text-sky-300">حتى {hm(a.break.active_until)}</span>}
              </div>

              {a.status === 'withdrawn' && (
                <div className="mt-3 flex items-center gap-2 p-2 rounded-xl bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-300">
                  <span className="flex-1">سُحبت عند «{withdrawnLabel}» {hm(a.withdrawn_at)} · {a.orders_withdrawn} أوردر</span>
                  <button onClick={() => reinstate(a)} disabled={busyId === a.id}
                    className="shrink-0 px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold disabled:opacity-50">
                    إعادة تفعيل
                  </button>
                </div>
              )}
              {a.reinstated_at && a.status !== 'withdrawn' && (
                <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">أُعيد تفعيلها {hm(a.reinstated_at)}</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Enrolment */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <button onClick={() => setShowEnrol((v) => !v)} className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <span>تسجيل الموظفات في نظام المتابعة ({enrolled.length} مسجّلة)</span>
          <svg className={`w-4 h-4 transition-transform ${showEnrol ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showEnrol && (
          <div className="px-4 pb-4 space-y-2">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              المسجّلة تُطبَّق عليها نقاط المتابعة المتبقية اليوم فوراً (النقاط التي انتهت مهلتها لا تُحسب عليها). «غير مسجّلة» = لا متابعة.
            </p>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {(board?.agents ?? []).map((a) => (
                <div key={a.id} className="flex items-center gap-3 py-2">
                  <span className="flex-1 min-w-0 truncate text-sm text-slate-700 dark:text-slate-200">
                    {a.name} {a.is_absent && <span className="text-[11px] text-slate-400">(غائبة)</span>}
                  </span>
                  <select value={a.track ?? ''} disabled={busyId === a.id} onChange={(e) => changeTrack(a, e.target.value)}
                    className="px-2 py-1.5 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                    <option value="">غير مسجّلة</option>
                    <option value="confirmation">تأكيد فقط</option>
                    <option value="review">مراجعة فقط</option>
                    <option value="both">تأكيد ومراجعة</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
