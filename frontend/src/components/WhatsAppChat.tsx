'use client';

/* The WhatsApp conversation on the order — the agent answers the customer in
   writing, from inside the system, from the one business number.

   · <WhatsAppChatButton orderId> sits on the order row / card: it shows only for
     an order that HAS a conversation, with the count of unread customer messages.
   · <WhatsAppChatHost> is mounted once by the orders table: the chat itself
     (the whole screen on a phone, a side panel on a computer) and a small
     «رسايل جديدة» pill that jumps to the conversations waiting.

   Who may write is the server's decision (the agent holding the order, within 24
   hours of the customer's last message); this file only shows the reason. */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getWhatsAppChat, sendWhatsAppChat, getWhatsAppMediaBlob,
  type WhatsAppChatThread, type WhatsAppChatMessage, type WhatsAppQuickReply, type WhatsAppChatWhy,
} from '@/lib/api';
import { closeChat, markRead, openChat, useChatEntry, useChatInbox, useOpenChat } from '@/lib/whatsappChatStore';
import { serverNow } from '@/lib/serverClock';

const POLL_MS = 6_000;

const WHY: Record<WhatsAppChatWhy, string> = {
  unconfigured: 'رقم الواتساب مش متوصل — كلمي الإدارة.',
  closed:       'الأوردر مش مع موظفة دلوقتي، فالمحادثة للقراءة بس.',
  not_holder:   'الرد للموظفة اللي ماسكة الأوردر بس.',
  other_order:  'العميل عنده أوردر أحدث مع موظفة تانية — هي اللي بترد عليه.',
  window:       'عدّى 24 ساعة على آخر رسالة من العميل، وواتساب مبيسمحش بالكتابة بعدها. كلميه تليفون.',
  never_wrote:  'العميل مبعتش حاجة على واتساب، ومينفعش نبدأ إحنا المحادثة.',
};

const ACTION_LABEL: Record<string, string> = { 'تم التأكيد': 'تأكيد الطلب', 'مؤجل': 'مؤجل', 'تم الرفض': 'رفض' };
const STATUS_MARK: Record<string, string> = { sending: '…', sent: 'اتبعتت', delivered: 'وصلت', read: 'اتقرت', failed: 'متبعتتش' };
const KIND_LABEL: Record<string, string> = { audio: 'رسالة صوتية', image: 'صورة', video: 'فيديو', document: 'ملف', sticker: 'ملصق' };

const cairoTime = (iso: string) =>
  new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const cairoDay = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date(iso));
const dayLabel = (iso: string) => {
  const d = cairoDay(iso);
  const today = cairoDay(new Date(serverNow()).toISOString());
  const yesterday = cairoDay(new Date(serverNow() - 86_400_000).toISOString());
  if (d === today) return 'النهارده';
  if (d === yesterday) return 'امبارح';
  return new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'long' }).format(new Date(iso));
};

/* «{العميل}» / «{المبلغ}» … in a ready reply → this order's own values. */
const fillVars = (body: string, vars: Record<string, string> = {}) =>
  body.replace(/\{([^{}\n]{1,20})\}/g, (whole, key: string) => (key.trim() in vars ? vars[key.trim()] : whole)).replace(/ {2,}/g, ' ').trim();

const errorText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;

/* ── on the order row ─────────────────────────────────────────────────────── */

export const WhatsAppChatButton = memo(function WhatsAppChatButton({ orderId }: { orderId: number }) {
  const entry = useChatEntry(orderId);
  if (!entry) return null;
  return (
    <button type="button" onClick={() => openChat(orderId)}
      className="mt-1 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold shadow-sm
        bg-emerald-600 text-white hover:bg-emerald-700 active:scale-95 transition">
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 4v-4z" />
      </svg>
      المحادثة
      {entry.unread > 0 && (
        <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[11px] leading-[18px] text-center">
          {entry.unread > 9 ? '9+' : entry.unread}
        </span>
      )}
    </button>
  );
});

/* ── one voice note / picture inside the conversation (fetched when pressed) ── */

function MediaBubble({ media }: { media: NonNullable<WhatsAppChatMessage['media']> }) {
  const [url, setUrl]   = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');
  const made = useRef('');
  useEffect(() => () => { if (made.current) URL.revokeObjectURL(made.current); }, []);

  const load = async () => {
    setBusy(true); setErr('');
    try {
      const { data } = await getWhatsAppMediaBlob(media.id);
      made.current = URL.createObjectURL(data);
      setUrl(made.current);
    } catch (e) {
      setErr(errorText(e, 'الملف متحمّلش'));
    } finally { setBusy(false); }
  };

  const label = KIND_LABEL[media.kind] ?? 'ملف';
  if (media.status === 'pending') return <p className="text-xs opacity-70">{label} — لسه بتتحمّل من واتساب، جرّبي بعد دقيقة.</p>;
  if (media.status === 'failed')  return <p className="text-xs text-red-600 dark:text-red-400">{label} — متحمّلتش من واتساب.</p>;
  if (!url) {
    return (
      <div>
        <button type="button" onClick={load} disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-violet-600 text-white active:scale-95 disabled:opacity-60">
          {busy ? 'بيحمّل…' : media.kind === 'audio' ? `▶ اسمعي ال${label}` : `افتحي ال${label}`}
        </button>
        {err && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>
    );
  }
  if (media.kind === 'audio') return <audio controls autoPlay preload="metadata" src={url} className="w-56 max-w-full h-10" />;
  if (media.kind === 'video') return <video controls preload="metadata" src={url} className="max-h-64 max-w-full rounded-lg" />;
  if (media.kind === 'document') return <a href={url} target="_blank" rel="noreferrer" className="text-sm underline">افتحي الملف</a>;
  // eslint-disable-next-line @next/next/no-img-element
  return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="صورة من العميل" className="max-h-64 max-w-full rounded-lg" /></a>;
}

/* ── one message ──────────────────────────────────────────────────────────── */

const Bubble = memo(function Bubble({ m }: { m: WhatsAppChatMessage }) {
  const out = m.dir === 'out';
  const tone = out
    ? (m.type === 'system'
        ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
        : 'bg-emerald-100 text-emerald-950 dark:bg-emerald-900/50 dark:text-emerald-50')
    : 'bg-white text-slate-900 border border-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-700';
  return (
    <div className={`flex ${out ? 'justify-start' : 'justify-end'}`}>
      <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed break-words ${tone} ${m.error ? 'ring-1 ring-red-400' : ''}`}>
        {m.type === 'tap' && <p className="font-bold">داس «{m.text}»</p>}
        {m.type === 'media' && m.media && <MediaBubble media={m.media} />}
        {m.type === 'other' && <p className="opacity-80">[{m.text}]</p>}
        {m.type !== 'tap' && m.type !== 'other' && m.text && (
          <p className={`whitespace-pre-wrap ${m.type === 'reaction' ? 'text-xl' : ''} ${m.type === 'system' ? 'text-xs' : ''}`}>{m.text}</p>
        )}
        {m.tapped && <p className="mt-0.5 text-[11px] opacity-75">العميل داس عليها «{m.tapped}»</p>}
        <p className="mt-0.5 text-[10px] opacity-60">
          {out ? `${m.by ?? ''} · ` : ''}{cairoTime(m.at)}
          {out && m.status ? ` · ${STATUS_MARK[m.status] ?? m.status}` : ''}
        </p>
      </div>
    </div>
  );
});

/* ── the chat itself ──────────────────────────────────────────────────────── */

interface HostProps {
  /* What the order's own status control would allow right now (null = the order
     is not on this screen → no buttons). Same rules as the row: cooldown, locks. */
  actionsFor?: (orderId: number) => string[] | null;
  onAct?: (orderId: number, status: string) => void;
}

function ChatPanel({ orderId, actionsFor, onAct }: { orderId: number } & HostProps) {
  const [thread, setThread]   = useState<WhatsAppChatThread | null>(null);
  const [error, setError]     = useState('');
  const [text, setText]       = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [armed, setArmed]     = useState(false);          // «تأكيد الطلب» needs a second tap
  const bottom  = useRef<HTMLDivElement | null>(null);
  const input   = useRef<HTMLTextAreaElement | null>(null);
  const shown   = useRef(-1);                             // messages on screen (scroll down only when it grows)
  const known   = useRef(-1);                             // customer messages in the last answer
  const acked   = useRef(-1);                             // …and how many of them the server knows I have seen
  const alive   = useRef(true);

  const load = useCallback(async (light: boolean) => {
    try {
      /* "seen" goes with the first load, and again only after the customer wrote something new */
      const seen = !light || known.current > acked.current;
      const { data } = await getWhatsAppChat(orderId, { light, seen });
      if (!alive.current) return;
      known.current = data.messages.filter((m) => m.dir === 'in').length;
      if (seen) acked.current = known.current;
      setThread((prev) => (light && prev ? { ...prev, ...data } : data));
      setError('');
      markRead(orderId);
    } catch (e) {
      if (!alive.current) return;
      if (!light) setError(errorText(e, 'تعذّر تحميل المحادثة'));
    }
  }, [orderId]);

  useEffect(() => {
    alive.current = true;
    shown.current = -1; known.current = -1; acked.current = -1;
    load(false);
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
      /* a message that arrived in the last few seconds was on screen too: say so before the badge is asked for again */
      if (known.current > acked.current) getWhatsAppChat(orderId, { light: true, seen: true }).catch(() => {});
    };
  }, [load, orderId]);

  /* keep the newest message in view */
  const total = thread?.messages.length ?? 0;
  useEffect(() => {
    if (total && total !== shown.current) {
      bottom.current?.scrollIntoView({ block: 'end' });
      shown.current = total;
    }
  }, [total]);

  /* the box grows with the text (typed, or dropped in by a ready reply) and shrinks back after sending */
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  /* Esc closes; the page behind does not scroll while the chat is open */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeChat(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, []);

  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true); setSendErr('');
    try {
      const { data } = await sendWhatsAppChat(orderId, body);
      if (!alive.current) return;
      setText('');
      setThread((prev) => (prev ? { ...prev, messages: [...prev.messages, data.message] } : prev));
      input.current?.focus();
    } catch (e) {
      if (!alive.current) return;
      setSendErr(errorText(e, 'الرسالة متبعتتش — جرّبي تاني'));
      load(true);
    } finally {
      if (alive.current) setSending(false);
    }
  };

  const pickReply = (r: WhatsAppQuickReply) => {
    setText(fillVars(r.body, thread?.vars));
    setShowAll(false);
    setSendErr('');
    requestAnimationFrame(() => input.current?.focus());
  };

  const replies = thread?.replies ?? [];
  const suggested = useMemo(
    () => (thread?.suggested ?? []).map((id) => replies.find((r) => r.id === id)).filter(Boolean) as WhatsAppQuickReply[],
    [thread?.suggested, replies]);
  const groups = useMemo(() => {
    const out: { name: string; items: WhatsAppQuickReply[] }[] = [];
    for (const r of replies) {
      const name = r.product ? 'عن المنتج ده' : r.category;
      const g = out.find((x) => x.name === name);
      if (g) g.items.push(r); else out.push({ name, items: [r] });
    }
    return out;
  }, [replies]);

  const actions = thread ? actionsFor?.(orderId) ?? null : null;
  const o = thread?.order;
  let lastDay = '';

  return (
    <div className="fixed inset-0 z-[70] flex md:justify-end" dir="rtl">
      <div className="hidden md:block flex-1 bg-black/40" onClick={closeChat} aria-hidden />
      <section role="dialog" aria-label="محادثة واتساب"
        className="flex flex-col w-full md:w-[440px] h-[100dvh] bg-slate-50 dark:bg-slate-950 md:border-r md:border-slate-200 md:dark:border-slate-800 md:shadow-2xl">

        {/* header */}
        <header className="flex items-center gap-2 px-3 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <button type="button" onClick={closeChat} aria-label="رجوع"
            className="p-2 -m-1 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" /></svg>
          </button>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-slate-900 dark:text-white truncate">{o ? `${o.name || 'العميل'} · #${o.id}` : `#${orderId}`}</p>
            {o && (
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {o.product}{o.amount ? ` · ${o.amount} ج` : ''} · {o.status}
              </p>
            )}
          </div>
        </header>

        {/* messages — or the full list of ready replies */}
        {showAll ? (
          <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-2">
            <div className="flex items-center justify-between py-1">
              <p className="font-bold text-slate-800 dark:text-slate-100">الردود الجاهزة</p>
              <button type="button" onClick={() => setShowAll(false)} className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 px-2 py-1">رجوع للمحادثة</button>
            </div>
            {groups.map((g) => (
              <div key={g.name} className="mt-2">
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">{g.name}</p>
                <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                  {g.items.map((r) => (
                    <button key={r.id} type="button" onClick={() => pickReply(r)} className="block w-full text-right px-3 py-2.5 active:bg-slate-100 dark:active:bg-slate-800">
                      <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{r.title}</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{fillVars(r.body, thread?.vars)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!groups.length && <p className="text-sm text-slate-500 dark:text-slate-400 py-6 text-center">مفيش ردود جاهزة متفعّلة.</p>}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-3 space-y-2">
            {!thread && !error && <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-8">بيحمّل المحادثة…</p>}
            {error && (
              <div className="text-center py-8">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                <button type="button" onClick={() => load(false)} className="mt-2 text-sm font-semibold underline text-slate-700 dark:text-slate-200">حاولي تاني</button>
              </div>
            )}
            {thread?.messages.map((m) => {
              const d = cairoDay(m.at);
              const head = d !== lastDay;
              lastDay = d;
              return (
                <div key={m.id}>
                  {head && <p className="my-2 text-center text-[11px] text-slate-500 dark:text-slate-400">{dayLabel(m.at)}</p>}
                  <Bubble m={m} />
                </div>
              );
            })}
            {thread && !thread.messages.length && <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-8">مفيش رسايل لسه.</p>}
            <div ref={bottom} />
          </div>
        )}

        {/* writing */}
        {thread && !showAll && (
          <footer className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {thread.can_reply ? (
              <>
                {(suggested.length > 0 || replies.length > 0) && (
                  <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">
                    {suggested.map((r) => (
                      <button key={r.id} type="button" onClick={() => pickReply(r)}
                        className="shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border border-emerald-300 text-emerald-800 bg-emerald-50
                          dark:border-emerald-700 dark:text-emerald-200 dark:bg-emerald-900/30 active:scale-95">
                        {r.title}
                      </button>
                    ))}
                    {replies.length > 0 && (
                      <button type="button" onClick={() => setShowAll(true)}
                        className="shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border border-slate-300 text-slate-700
                          dark:border-slate-600 dark:text-slate-200 active:scale-95">
                        كل الردود ({replies.length})
                      </button>
                    )}
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <textarea ref={input} value={text} rows={1} maxLength={1000} placeholder="اكتبي ردك للعميل"
                    onChange={(e) => { setText(e.target.value); setSendErr(''); }}
                    onKeyDown={(e) => {
                      /* a real keyboard: Enter sends, Shift+Enter breaks the line. A phone keyboard: Enter is a new line. */
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); }
                    }}
                    style={{ minHeight: 42, maxHeight: 140 }}
                    className="flex-1 resize-none rounded-2xl px-3 py-2 text-[15px] leading-relaxed outline-none
                      border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100
                      focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />
                  <button type="button" onClick={send} disabled={sending || !text.trim()} aria-label="ابعتي"
                    className="shrink-0 h-[42px] px-4 rounded-2xl text-sm font-bold bg-emerald-600 text-white active:scale-95 disabled:opacity-50">
                    {sending ? '…' : 'ابعتي'}
                  </button>
                </div>
                {sendErr && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{sendErr}</p>}
                {thread.window.until && (
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    الكتابة متاحة لحد {dayLabel(thread.window.until)} {cairoTime(thread.window.until)} · الرسالة بتوصل من رقم الشركة
                  </p>
                )}
              </>
            ) : (
              <p className="py-2 text-sm font-semibold text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-3">
                {thread.why ? WHY[thread.why] : 'المحادثة للقراءة بس.'}
                {thread.why === 'other_order' && thread.reply_order_id ? ` (أوردر #${thread.reply_order_id})` : ''}
              </p>
            )}

            {actions && actions.length > 0 && onAct && (
              <div className="mt-2 flex gap-2">
                {actions.map((st) => {
                  const confirm = st === 'تم التأكيد';
                  return (
                    <button key={st} type="button"
                      onClick={() => {
                        if (confirm && !armed) { setArmed(true); return; }
                        closeChat();
                        onAct(orderId, st);
                      }}
                      className={`flex-1 py-2 rounded-xl text-sm font-bold active:scale-95 transition
                        ${confirm ? 'bg-indigo-600 text-white' : st === 'تم الرفض'
                          ? 'border border-red-300 text-red-700 dark:border-red-800 dark:text-red-300'
                          : 'border border-slate-300 text-slate-700 dark:border-slate-600 dark:text-slate-200'}`}>
                      {confirm && armed ? 'دوسي تاني للتأكيد' : ACTION_LABEL[st] ?? st}
                    </button>
                  );
                })}
              </div>
            )}
          </footer>
        )}
      </section>
    </div>
  );
}

/* ── mounted once by the orders table ─────────────────────────────────────── */

let hostSeq = 0;
let activeHost = 0;                     // two tables on one page must not open two chats

export function WhatsAppChatHost({ actionsFor, onAct }: HostProps) {
  const openId = useOpenChat();
  const inbox  = useChatInbox();
  const [active, setActive] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    const id = ++hostSeq;
    if (!activeHost) { activeHost = id; setActive(true); }
    return () => { if (activeHost === id) activeHost = 0; };
  }, []);
  if (!active) return null;

  const waiting = inbox.filter((it) => it.unread > 0);
  const totalUnread = waiting.reduce((s, it) => s + it.unread, 0);

  /* straight under <body>: the orders list sits inside scrolled / transformed
     boxes, and a "fixed" layer inside one of those is not the whole screen */
  return createPortal(
    <>
      {openId === null && totalUnread > 0 && (
        <div className="fixed z-[60] bottom-4 left-4 flex flex-col items-start gap-2" dir="rtl">
          {listOpen && (
            <div className="w-64 max-h-72 overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl divide-y divide-slate-100 dark:divide-slate-800">
              {waiting.map((it) => (
                <button key={it.order_id} type="button" onClick={() => { setListOpen(false); openChat(it.order_id); }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-right active:bg-slate-100 dark:active:bg-slate-800">
                  <span className="flex-1 min-w-0 text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{it.name || 'عميل'} · #{it.order_id}</span>
                  <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] leading-5 text-center">{it.unread > 9 ? '9+' : it.unread}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setListOpen((v) => !v)}
            className="inline-flex items-center gap-2 px-3.5 py-2 md:px-4 md:py-2.5 rounded-full text-sm font-bold shadow-xl bg-emerald-600 text-white active:scale-95">
            {/* a phone card has controls down here — keep the pill small */}
            <span className="md:hidden">واتساب</span>
            <span className="hidden md:inline">رسايل واتساب جديدة</span>
            <span className="min-w-[22px] h-[22px] px-1.5 rounded-full bg-white text-emerald-700 text-xs leading-[22px] text-center">{totalUnread > 99 ? '99+' : totalUnread}</span>
          </button>
        </div>
      )}
      {openId !== null && <ChatPanel key={openId} orderId={openId} actionsFor={actionsFor} onAct={onAct} />}
    </>,
    document.body,
  );
}
