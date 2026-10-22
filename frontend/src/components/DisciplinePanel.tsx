'use client';

/* ════════════════════════════════════════════════════════════════════════════
   DisciplinePanel — the enrolled agent's check-in strip (top of every page)
   ════════════════════════════════════════════════════════════════════════════
   • Compact line: day status · next checkpoint + live countdown · check-in
     button · break balance. Tap to expand: today's checkpoints + break controls.
   • Every countdown runs on the SERVER clock (offset measured on each fetch), so
     a phone with a wrong time can't show a misleading deadline.
   • 13-minute prompt «هل ما زلتِ هنا؟»: the server's action clock is refreshed
     first — an agent who just updated an order is never interrupted.
   Renders nothing for anyone who isn't an enrolled agent (one /me call, then off).
   Backend: /api/discipline (services/agentDiscipline.js).                       */

import { useCallback, useEffect, useRef, useState } from 'react';
import api, {
  getDisciplineMe, disciplineCheckIn, disciplineBreak, disciplineStillHere,
  DisciplineState, DisciplineCheckpoint,
} from '@/lib/api';
import { installAudioUnlock, playTone } from '@/lib/alertSound';

const POLL_MS = 30_000;
const CHIME_REPEAT_MS = 15_000;   // re-chime while the prompt waits (agent may be on a call)

const CAIRO_HM = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: true,
});
const hm = (iso: string | null | undefined) => (iso ? CAIRO_HM.format(new Date(iso)) : '');
/* 24-hour "HH:MM" in Cairo — compared against the work-window bounds. */
const CAIRO_HHMM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const pad = (n: number) => String(n).padStart(2, '0');
const countdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
};
const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending:   { label: 'لم تبدئي بعد', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  active:    { label: 'نشطة',         cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  break:     { label: 'استراحة',      cls: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  withdrawn: { label: 'تم سحب الأوردرات', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  off:       { label: 'إجازة',        cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
};

/* Where the next checkpoint stands right now (server clock). */
type Phase = 'not_open' | 'open' | 'late' | 'expired';
function phaseOf(cp: DisciplineCheckpoint, now: number): Phase {
  const opens = Date.parse(cp.opens_at), due = Date.parse(cp.due_at), deadline = Date.parse(cp.deadline_at);
  if (now < opens)          return 'not_open';
  if (now < due + 60_000)   return 'open';
  if (now < deadline)       return 'late';
  return 'expired';
}

function CheckpointChip({ cp, now }: { cp: DisciplineCheckpoint; now: number }) {
  let cls = 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700';
  let mark = hm(cp.due_at);
  const auto = cp.checked_in_via === 'work' ? ' ⚡' : '';
  if (cp.outcome === 'on_time') { cls = 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'; mark = `✓ ${hm(cp.checked_in_at)}${auto}`; }
  else if (cp.outcome === 'late') { cls = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'; mark = `+${cp.late_minutes} د${auto}`; }
  else if (cp.outcome === 'missed') { cls = 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800'; mark = '✗ فائتة'; }
  else if (phaseOf(cp, now) === 'late') { cls = 'bg-red-50 text-red-700 border-red-300 animate-pulse dark:bg-red-900/30 dark:text-red-300'; mark = 'في المهلة'; }
  return (
    <span title={cp.checked_in_via === 'work' ? 'سُجّل تلقائياً — كنتِ تعملين على الأوردرات' : undefined}
      className={`inline-flex flex-col items-center px-2.5 py-1 rounded-lg border text-[11px] leading-tight ${cls}`}>
      <span className="font-semibold">{cp.label_ar}</span>
      <span dir="ltr" className="opacity-90">{mark}</span>
    </span>
  );
}

export default function DisciplinePanel() {
  const [state,     setState]     = useState<DisciplineState | null>(null);
  const [offset,    setOffset]    = useState(0);     // server − client (ms)
  const [fetchedAt, setFetchedAt] = useState(0);     // server ms at the last fetch
  const [now,       setNow]       = useState(() => Date.now());
  const [busy,      setBusy]      = useState(false);
  const [msg,       setMsg]       = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const [expanded,  setExpanded]  = useState(false);
  const [idleOpen,  setIdleOpen]  = useState(false);
  const enabled    = useRef(true);
  const confirming = useRef(false);

  const apply = useCallback((s: DisciplineState) => {
    if (!s.enrolled) { enabled.current = false; setState(null); return; }
    const server = s.server_time ? Date.parse(s.server_time) : Date.now();
    setOffset(server - Date.now());
    setFetchedAt(server);
    setState(s);
  }, []);

  const load = useCallback(async () => {
    if (!enabled.current) return null;
    try { const { data } = await getDisciplineMe(); apply(data); return data; }
    catch { return null; }
  }, [apply]);

  /* Only agents are ever enrolled — admins / TLs never call /me. */
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null') as { role?: string; roles?: string[] } | null;
      const roles = u?.roles?.length ? u.roles : u?.role ? [u.role] : [];
      if (!roles.includes('agent')) { enabled.current = false; return; }
    } catch { enabled.current = false; return; }
    load();
    const poll = setInterval(load, POLL_MS);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(poll); window.removeEventListener('focus', onFocus); };
  }, [load]);

  /* Right after a successful order write (status / note / call attempt), the
     server may have AUTO-checked her in — refresh now instead of waiting for the
     30-s poll, and tell her which checkpoint it covered. */
  const stateRef = useRef<DisciplineState | null>(null);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => {
    if (!state) return;
    const id = api.interceptors.response.use((res) => {
      const m = String(res.config?.method ?? 'get').toLowerCase();
      const url = String(res.config?.url ?? '');
      if (m !== 'get' && url.startsWith('/api/orders')) {
        const openBefore = new Set((stateRef.current?.checkpoints ?? []).filter((c) => c.outcome === 'open').map((c) => c.code));
        setTimeout(() => {
          load().then((fresh) => {
            const auto = (fresh?.checkpoints ?? []).filter((c) => openBefore.has(c.code) && c.outcome !== 'open' && c.checked_in_via === 'work');
            if (auto.length) setMsg({ text: `⚡ تم تسجيل حضورك تلقائياً في «${auto.map((c) => c.label_ar).join('» و«')}» لأنك تعملين على الأوردرات`, tone: 'ok' });
          });
        }, 800);
      }
      return res;
    });
    return () => api.interceptors.response.eject(id);
  }, [state ? 1 : 0, load]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* 1-second clock, only while enrolled. */
  useEffect(() => {
    if (!state) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(id);
  }, [msg]);

  const serverNow = now + offset;

  /* ── Inactivity prompt (18 min) ───────────────────────────────────────────────
     Runs on the SERVER's idle clock, which is paused with no workable 'جديد'
     orders and outside the work windows — so waiting for work is never nagged.
     The local guard stops it the second the current window ends, without
     waiting for the next poll. */
  const windowOver = !!state?.current_window && CAIRO_HHMM.format(new Date(serverNow)) >= state.current_window.end;
  const sinceAction = state?.idle_seconds == null || windowOver
    ? null
    : state.idle_seconds + Math.max(0, (serverNow - fetchedAt) / 1000);
  const idleThreshold = (state?.idle_warning_minutes ?? 18) * 60;
  useEffect(() => {
    if (!state?.idle_watch || sinceAction == null) { if (idleOpen) setIdleOpen(false); return; }
    if (sinceAction < idleThreshold) { if (idleOpen) setIdleOpen(false); return; }
    if (idleOpen || confirming.current) return;
    /* Re-check with the server first: an order she updated seconds ago resets it. */
    confirming.current = true;
    load().then((fresh) => {
      confirming.current = false;
      if (fresh?.idle_watch && (fresh.idle_seconds ?? 0) >= idleThreshold) {
        setIdleOpen(true);
        /* Buzz the phone — only after a tap (Chrome blocks it otherwise and logs noise). */
        try {
          const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
          if (ua?.hasBeenActive) navigator.vibrate?.(200);
        } catch { /* not supported */ }
      }
    });
  }, [state?.idle_watch, sinceAction, idleThreshold, idleOpen, load]);

  /* Unlock audio on the agent's taps (browser autoplay rule). */
  useEffect(() => {
    if (!state) return;
    return installAudioUnlock();
  }, [state]);

  /* While the prompt is open: chime now and every 15 s, flash the tab title. */
  useEffect(() => {
    if (!idleOpen) return;
    const title = document.title;
    playTone('agentIdlePrompt');
    const chime = setInterval(() => playTone('agentIdlePrompt'), CHIME_REPEAT_MS);
    let flip = false;
    const flash = setInterval(() => { flip = !flip; document.title = flip ? '⏰ هل ما زلتِ هنا؟' : title; }, 1000);
    return () => { clearInterval(chime); clearInterval(flash); document.title = title; };
  }, [idleOpen]);

  if (!state) return null;

  /* ── Actions ──────────────────────────────────────────────────────────────── */
  const run = async (fn: () => Promise<DisciplineState>, okText: string) => {
    setBusy(true);
    try { apply(await fn()); setMsg({ text: okText, tone: 'ok' }); }
    catch (e) { setMsg({ text: errMsg(e, 'تعذّر تنفيذ الطلب'), tone: 'err' }); load(); }
    finally { setBusy(false); }
  };
  const doCheckIn = () => run(async () => {
    const { data } = await disciplineCheckIn(state.next_checkpoint?.code);
    return data.state;
  }, 'تم تسجيل الحضور ✓');
  const doBreak = (action: 'start' | 'end') => run(async () => (await disciplineBreak(action)).data.state,
    action === 'start' ? 'بدأت الاستراحة' : 'انتهت الاستراحة');
  const doStillHere = async () => {
    setBusy(true);
    try { apply((await disciplineStillHere()).data); setIdleOpen(false); }
    catch (e) { setMsg({ text: errMsg(e, 'تعذّر الإرسال'), tone: 'err' }); }
    finally { setBusy(false); }
  };

  /* ── Derived view ─────────────────────────────────────────────────────────── */
  const status   = state.status ?? 'pending';
  const meta     = STATUS_META[status] ?? STATUS_META.pending;
  const cp       = state.next_checkpoint ?? null;
  const phase    = cp ? phaseOf(cp, serverNow) : null;
  const brk      = state.break;
  const onBreak  = !!brk?.active;
  const canCheck = !!cp && status !== 'withdrawn' && (phase === 'open' || phase === 'late');

  let headline: React.ReactNode;
  if (!state.scheduled_today) {
    headline = <span className="text-slate-500 dark:text-slate-400">{state.is_absent ? 'مسجّلة كغائبة اليوم' : 'لا توجد نقاط متابعة لكِ اليوم'}</span>;
  } else if (status === 'withdrawn') {
    headline = <span className="font-semibold text-red-700 dark:text-red-300">تم سحب أوردراتك اليوم — تواصلي مع التيم ليدر</span>;
  } else if (!cp) {
    headline = <span className="text-emerald-700 dark:text-emerald-300 font-medium">انتهت نقاط المتابعة لليوم ✓</span>;
  } else if (phase === 'not_open') {
    headline = <span><b>{cp.label_ar}</b> {hm(cp.due_at)} · يفتح التسجيل خلال <b dir="ltr">{countdown(Date.parse(cp.opens_at) - serverNow)}</b></span>;
  } else if (phase === 'open') {
    headline = <span><b>{cp.label_ar}</b> {hm(cp.due_at)} · {serverNow < Date.parse(cp.due_at)
      ? <>الموعد خلال <b dir="ltr">{countdown(Date.parse(cp.due_at) - serverNow)}</b></>
      : <b className="text-emerald-700 dark:text-emerald-300">الآن</b>}</span>;
  } else if (phase === 'late') {
    headline = <span className="text-red-700 dark:text-red-300"><b>{cp.label_ar}</b> · متأخرة — سحب الأوردرات خلال <b dir="ltr">{countdown(Date.parse(cp.deadline_at) - serverNow)}</b></span>;
  } else {
    headline = <span className="text-red-700 dark:text-red-300">انتهت مهلة «{cp.label_ar}»</span>;
  }

  return (
    <>
      <div className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur" dir="rtl">
        {/* ── Compact line ── */}
        <div className="flex items-center gap-2 px-3 sm:px-4 py-2 text-sm">
          <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold ${meta.cls}`}>{meta.label}</span>
          <div className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">{headline}</div>
          {canCheck && !onBreak && (
            <button onClick={doCheckIn} disabled={busy}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-bold text-white shadow-sm transition disabled:opacity-50
                ${phase === 'late' ? 'bg-red-600 hover:bg-red-700 animate-pulse' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
              تسجيل الحضور
            </button>
          )}
          {brk && status !== 'withdrawn' && state.scheduled_today && (
            <span title="رصيد الاستراحة" className="shrink-0 hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
              ☕ {brk.remaining_minutes}د · {brk.sessions_left}/{brk.max_sessions}
            </span>
          )}
          <button onClick={() => setExpanded((v) => !v)} aria-label={expanded ? 'إخفاء التفاصيل' : 'عرض التفاصيل'}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
            <svg className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {/* ── Break running ── */}
        {onBreak && brk?.active && (
          <div className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-sky-50 dark:bg-sky-900/20 border-t border-sky-100 dark:border-sky-900/40 text-sm">
            <span className="flex-1 text-sky-800 dark:text-sky-200">
              ☕ في استراحة — تنتهي خلال <b dir="ltr">{countdown(Date.parse(brk.active.ends_at) - serverNow)}</b>
            </span>
            <button onClick={() => doBreak('end')} disabled={busy}
              className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-50">
              إنهاء الاستراحة
            </button>
          </div>
        )}

        {/* ── Expanded details ── */}
        {expanded && state.scheduled_today && (
          <div className="px-3 sm:px-4 pb-3 pt-1 space-y-3 border-t border-slate-100 dark:border-slate-800">
            {!!state.checkpoints?.length && (
              <div className="flex flex-wrap gap-1.5 pt-2">
                {state.checkpoints.map((c) => <CheckpointChip key={c.code} cp={c} now={serverNow} />)}
              </div>
            )}
            {status === 'active' && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {state.idle_paused_reason === 'no_new_orders'
                  ? '⏸️ عداد عدم النشاط متوقف — لا توجد أوردرات «جديد» عليكِ الآن'
                  : state.idle_paused_reason === 'outside_window'
                    ? `⏸️ خارج فترات العمل — عداد عدم النشاط يعمل فقط في: ${(state.work_windows ?? []).map((w) => `${w.start}–${w.end}`).join(' · ')}`
                    : `عداد عدم النشاط يعمل (فترة ${state.current_window?.start ?? ''}–${state.current_window?.end ?? ''} · ${state.new_orders ?? 0} أوردر جديد) — التنبيه بعد ${state.idle_warning_minutes ?? 18} دقيقة بدون إجراء`}
              </p>
            )}
            {brk && status !== 'withdrawn' && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-600 dark:text-slate-300">
                  الاستراحة: <b>{brk.remaining_minutes}</b> دقيقة متبقية من {brk.allowance_minutes} ·
                  فترات متبقية <b>{brk.sessions_left}</b> من {brk.max_sessions}
                </span>
                {!onBreak && (
                  <button onClick={() => doBreak('start')} disabled={busy || !brk.can_start}
                    className="px-3 py-1.5 rounded-lg font-bold bg-sky-600 hover:bg-sky-700 text-white disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-slate-700 dark:disabled:text-slate-400 disabled:cursor-not-allowed">
                    بدء استراحة
                  </button>
                )}
                {!onBreak && !brk.can_start && brk.blocked_reason && (
                  <span className="w-full text-[11px] text-slate-500 dark:text-slate-400">{brk.blocked_reason}</span>
                )}
              </div>
            )}
          </div>
        )}

        {msg && (
          <div className={`px-3 sm:px-4 py-1.5 text-xs font-medium ${msg.tone === 'ok'
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
            : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}>
            {msg.text}
          </div>
        )}
      </div>

      {/* ── 13-minute inactivity prompt ── */}
      {idleOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" dir="rtl">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 shadow-2xl p-6 text-center">
            <div className="text-4xl mb-2" aria-hidden>⏰</div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-2">هل ما زلتِ هنا؟</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 mb-5 leading-relaxed">
              لديكِ أوردرات جديدة ولم يُسجَّل أي إجراء عليها منذ{' '}
              <b>{Math.floor((sinceAction ?? 0) / 60)}</b> دقيقة.
              عند {state.idle_minutes ?? 20} دقيقة تظهرين للتيم ليدر كغير نشطة.
            </p>
            <button onClick={doStillHere} disabled={busy}
              className="w-full py-3 rounded-xl text-base font-bold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50">
              نعم، ما زلت هنا
            </button>
          </div>
        </div>
      )}
    </>
  );
}
