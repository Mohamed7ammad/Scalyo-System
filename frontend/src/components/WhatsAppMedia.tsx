'use client';

/* What the customer SENT on WhatsApp besides text — voice notes and pictures —
   for whoever works the order. Nothing is fetched until the button is pressed:
   the orders list stays exactly as light as before. Files come through our own
   API (the agent's login), never straight from Meta. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getWhatsAppOrderMedia, getWhatsAppMediaBlob, type WhatsAppMediaItem } from '@/lib/api';

type Loaded = WhatsAppMediaItem & { url?: string };

const KIND_LABEL: Record<string, string> = { audio: 'رسالة صوتية', image: 'صورة', video: 'فيديو', document: 'ملف', sticker: 'ملصق' };

export default function WhatsAppMedia({ orderId }: { orderId: number }) {
  const [open, setOpen]       = useState(false);
  const [busy, setBusy]       = useState(false);
  const [items, setItems]     = useState<Loaded[] | null>(null);
  const [error, setError]     = useState('');
  const urls = useRef<string[]>([]);

  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const { data } = await getWhatsAppOrderMedia(orderId);
      const out: Loaded[] = [];
      for (const it of data.items) {
        if (it.status !== 'done') { out.push(it); continue; }
        try {
          const { data: blob } = await getWhatsAppMediaBlob(it.id);
          const url = URL.createObjectURL(blob);
          urls.current.push(url);
          out.push({ ...it, url });
        } catch {
          out.push({ ...it, status: 'failed' });
        }
      }
      setItems(out);
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err?.response?.data?.error || 'تعذّر تحميل رسايل العميل');
    } finally {
      setBusy(false);
    }
  }, [orderId]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !items && !busy) load();
  };

  return (
    <div className="mt-1 max-w-[260px]">
      <button type="button" onClick={toggle}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-bold shadow-sm
          bg-violet-600 text-white hover:bg-violet-700 active:scale-95 transition">
        🎤 {open ? 'اقفلي رسايل العميل' : 'اسمعي / شوفي رسايل العميل'}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 rounded-md border border-violet-200 dark:border-violet-800/60 bg-violet-50/70 dark:bg-violet-950/30 p-2">
          {busy && <p className="text-xs text-slate-500 dark:text-slate-400">بيحمّل…</p>}
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {items && !items.length && !busy && (
            <p className="text-xs text-slate-500 dark:text-slate-400">مفيش ملفات متسجلة للأوردر ده.</p>
          )}
          {items?.map((it, i) => (
            <div key={it.id} className="space-y-0.5">
              <p className="text-[11px] font-semibold text-violet-900 dark:text-violet-200">{KIND_LABEL[it.kind] ?? 'ملف'} {i + 1}</p>
              {it.status === 'pending' && <p className="text-[11px] text-slate-500 dark:text-slate-400">لسه بتتحمّل من واتساب — جرّبي بعد دقيقة.</p>}
              {it.status === 'failed' && <p className="text-[11px] text-red-600 dark:text-red-400">الملف متحمّلش من واتساب.</p>}
              {it.url && it.kind === 'audio' && <audio controls preload="metadata" src={it.url} className="w-full h-9" />}
              {it.url && (it.kind === 'image' || it.kind === 'sticker') && (
                // eslint-disable-next-line @next/next/no-img-element
                <a href={it.url} target="_blank" rel="noreferrer"><img src={it.url} alt="صورة من العميل" className="max-h-56 rounded border border-violet-200 dark:border-violet-800/60" /></a>
              )}
              {it.url && it.kind === 'video' && <video controls preload="metadata" src={it.url} className="w-full max-h-56 rounded" />}
              {it.url && it.kind === 'document' && <a href={it.url} target="_blank" rel="noreferrer" className="text-xs text-violet-700 dark:text-violet-300 underline">افتحي الملف</a>}
            </div>
          ))}
          {items && items.some((it) => it.status === 'pending') && !busy && (
            <button type="button" onClick={load} className="text-[11px] font-semibold text-violet-700 dark:text-violet-300 underline">تحديث</button>
          )}
        </div>
      )}
    </div>
  );
}
