'use client';

/* ════════════════════════════════════════════════════════════════════════════
   SupervisorAlerts — dashboard-wide team alerts for admins + Team Leaders
   ════════════════════════════════════════════════════════════════════════════
   Mounted once in the dashboard layout, so it works on EVERY page. Polls the
   tiny GET /api/discipline/alerts every 30 s and raises a toast + a soft ping
   when an enrolled agent:
     🚨 is withdrawn (missed a checkpoint)          — once per withdrawal
     ⚠️ becomes idle (20 min with actionable 'جديد') — once per idle stretch
   Each event is alerted ONCE per browser per day (ids kept in localStorage),
   so navigating or reloading never repeats them; the first load of the day
   catches up on anything already pending (> 3 at once → one summary toast).
   In a background tab the title shows «(🚨 n)» until she comes back.
   Renders nothing for anyone else.                                              */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getDisciplineAlerts, userHasRole, DisciplineAlertAgent } from '@/lib/api';
import { installAudioUnlock, playTone } from '@/lib/alertSound';

const POLL_MS        = 30_000;
const TOAST_MS       = 20_000;
const MAX_INDIVIDUAL = 3;
const SEEN_KEY       = 'supervisorAlertsSeen';

const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
const CAIRO_HM  = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: true });

interface AlertToast { id: string; tone: 'red' | 'orange'; title: string; body: string }
interface AlertEvent { key: string; kind: 'withdrawn' | 'idle'; agent: DisciplineAlertAgent }

/* Seen-event ids for today (Cairo). Storage can be unavailable — then alerts
   still work, they just may repeat after a reload. */
function loadSeen(day: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null') as { day?: string; keys?: string[] } | null;
    return new Set(raw?.day === day ? raw.keys ?? [] : []);
  } catch { return new Set(); }
}
function saveSeen(day: string, keys: Set<string>) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ day, keys: [...keys] })); } catch { /* unavailable */ }
}

function toToast(e: AlertEvent): AlertToast {
  const a = e.agent;
  return e.kind === 'withdrawn'
    ? { id: e.key, tone: 'red', title: `🚨 تم سحب الأوردرات من ${a.name}`,
        body: `فاتتها «${a.withdrawn_label ?? 'نقطة متابعة'}» · ${a.orders_withdrawn} أوردر${a.withdrawn_at ? ` · ${CAIRO_HM.format(new Date(a.withdrawn_at))}` : ''}` }
    : { id: e.key, tone: 'orange', title: `⚠️ الموظفة ${a.name} خاملة الآن`,
        body: `${a.idle_minutes ?? 20} دقيقة بدون أي إجراء ولديها أوردرات جديدة` };
}

export default function SupervisorAlerts() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [toasts,  setToasts]  = useState<AlertToast[]>([]);
  const hiddenCount = useRef(0);
  const baseTitle   = useRef<string | null>(null);

  /* Admins + Team Leaders only. */
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (u && (userHasRole(u, 'admin') || userHasRole(u, 'supervisor'))) setEnabled(true);
    } catch { /* not logged in */ }
  }, []);

  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const poll = useCallback(async () => {
    let data;
    try { ({ data } = await getDisciplineAlerts()); }
    catch (e) {
      if ((e as { response?: { status?: number } })?.response?.status === 403) setEnabled(false);
      return;
    }
    const day  = CAIRO_DAY.format(new Date(data.server_time));
    const seen = loadSeen(day);
    const events: AlertEvent[] = [];
    for (const a of data.agents) {
      if (a.withdrawn_at) {
        const key = `${a.id}:w:${a.withdrawn_at}`;
        if (!seen.has(key)) events.push({ key, kind: 'withdrawn', agent: a });
      }
      if (a.idle && a.idle_since) {
        const key = `${a.id}:i:${a.idle_since}`;
        if (!seen.has(key)) events.push({ key, kind: 'idle', agent: a });
      }
    }
    if (!events.length) return;
    events.forEach((e) => seen.add(e.key));
    saveSeen(day, seen);

    const fresh: AlertToast[] = events.length > MAX_INDIVIDUAL
      ? [{ id: `summary:${Date.now()}`, tone: events.some((e) => e.kind === 'withdrawn') ? 'red' : 'orange',
           title: `🚨 ${events.length} تنبيهات جديدة للفريق`,
           body: `${events.filter((e) => e.kind === 'withdrawn').length} مسحوبة · ${events.filter((e) => e.kind === 'idle').length} خاملة — اضغطي للعرض` }]
      : events.map(toToast);
    setToasts((t) => [...t, ...fresh].slice(-5));
    fresh.forEach((t) => setTimeout(() => dismiss(t.id), TOAST_MS));
    playTone('supervisorAlert');

    /* Background tab: count in the title until she comes back. */
    if (document.hidden) {
      if (baseTitle.current == null) baseTitle.current = document.title;
      hiddenCount.current += fresh.length;
      document.title = `(🚨 ${hiddenCount.current}) ${baseTitle.current}`;
    }
  }, [dismiss]);

  useEffect(() => {
    if (!enabled) return;
    poll();
    const id = setInterval(poll, POLL_MS);
    const unlock = installAudioUnlock();
    const onVisible = () => {
      if (!document.hidden && baseTitle.current != null) {
        document.title = baseTitle.current;
        baseTitle.current = null;
        hiddenCount.current = 0;
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); unlock(); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, poll]);

  if (!enabled || !toasts.length) return null;

  return (
    <div className="fixed z-[70] bottom-4 inset-x-3 sm:inset-x-auto sm:left-4 sm:w-96 flex flex-col gap-2" dir="rtl" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role="alert"
          className={`rounded-xl border border-slate-200 dark:border-slate-700 border-r-4 shadow-lg bg-white dark:bg-slate-900 p-3
            ${t.tone === 'red' ? 'border-r-red-500' : 'border-r-orange-500'}`}>
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-bold ${t.tone === 'red' ? 'text-red-700 dark:text-red-300' : 'text-orange-700 dark:text-orange-300'}`}>{t.title}</p>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">{t.body}</p>
            </div>
            <button onClick={() => dismiss(t.id)} aria-label="إغلاق"
              className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">×</button>
          </div>
          <button onClick={() => { dismiss(t.id); router.push('/dashboard/team-monitor'); }}
            className="mt-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
            عرض متابعة الفريق ←
          </button>
        </div>
      ))}
    </div>
  );
}
