'use client';

/* The owner's list of ready replies for the WhatsApp chat. He writes them
   himself: an agent picks one, it lands in her text box (never sent by itself),
   she can change it, then she sends. A reply with an open [part] stays switched
   off — the server refuses to switch it on or to send it. */

import { useCallback, useEffect, useState } from 'react';
import {
  getWhatsAppQuickReplies, saveWhatsAppQuickReply, deleteWhatsAppQuickReply,
  type WhatsAppQuickReply, type WhatsAppQuickReplyInput,
} from '@/lib/api';

const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 sm:p-6 space-y-4 shadow-sm';
const inputCls = `w-full px-3 py-2 text-sm rounded-xl outline-none transition
  border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100
  focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500`;

/* when a customer did THIS, the reply is offered first */
const TAG_CHOICES: [string, string][] = [
  ['cancel', 'داس «إلغاء»'], ['support', 'طلب الدعم أو كتب سؤال'], ['deposit', 'محتاج مقدم'],
  ['address', 'العنوان ناقص'], ['voice', 'بعت رسالة صوتية'], ['reconfirm', 'أكد بعد ما طلب حاجة'],
  ['dup', 'عنده أوردر تاني'], ['lost', 'طلب مفقود'],
];
const OPEN_PART = /\[[^\]\n]{1,60}\]/;

type Draft = WhatsAppQuickReplyInput & { id: number | null };
const blank = (): Draft => ({ id: null, title: '', body: '', category: 'عام', for_tags: [], product_match: '', sort: 100, active: true });
const errorText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;

export default function WhatsAppQuickReplies({ showToast }: { showToast: (message: string, type: 'success' | 'error') => void }) {
  const [replies, setReplies] = useState<WhatsAppQuickReply[] | null>(null);
  const [error, setError]     = useState('');
  const [draft, setDraft]     = useState<Draft | null>(null);
  const [busy, setBusy]       = useState(false);
  const [askDelete, setAskDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getWhatsAppQuickReplies();
      setReplies(data.replies);
      setError('');
    } catch (e) { setError(errorText(e, 'تعذّر تحميل الردود الجاهزة')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const edit = (r: WhatsAppQuickReply) => {
    setAskDelete(false);
    setDraft({ id: r.id, title: r.title, body: r.body, category: r.category, for_tags: r.for_tags ?? [],
      product_match: r.product_match ?? '', sort: r.sort ?? 100, active: r.active !== false });
  };

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const { id, ...body } = draft;
      const { data } = await saveWhatsAppQuickReply(id, { ...body, product_match: (body.product_match ?? '').trim() || null });
      setReplies(data.replies);
      setDraft(null);
      showToast('الرد اتحفظ', 'success');
    } catch (e) { showToast(errorText(e, 'الرد متحفظش'), 'error'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!draft?.id || busy) return;
    setBusy(true);
    try {
      const { data } = await deleteWhatsAppQuickReply(draft.id);
      setReplies(data.replies);
      setDraft(null);
      showToast('الرد اتمسح', 'success');
    } catch (e) { showToast(errorText(e, 'الرد متمسحش'), 'error'); }
    finally { setBusy(false); setAskDelete(false); }
  };

  const categories = [...new Set((replies ?? []).map((r) => r.category))];
  const hasOpenPart = !!draft && OPEN_PART.test(draft.body);

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">7. ردود الموظفات الجاهزة</h2>
        <button type="button" onClick={() => { setAskDelete(false); setDraft(blank()); }}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700">
          رد جديد
        </button>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
        الموظفة بتختار الرد فينزل في خانة الكتابة، تعدّل فيه لو عايزة، وبعدين تبعته. مفيش رد بيتبعت لوحده.
        تقدر تكتب {'{العميل}'} و{'{المنتج}'} و{'{المبلغ}'} و{'{المتجر}'} والسيستم بيحط بيانات الأوردر مكانها.
        الرد اللي فيه جزء بين قوسين [ ] بيفضل مقفول لحد ما تكمّله.
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!replies && !error && <p className="text-sm text-slate-500 dark:text-slate-400">بيحمّل…</p>}

      {draft && (
        <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 sm:p-4 space-y-3">
          <p className="text-sm font-bold text-slate-900 dark:text-white">{draft.id ? 'تعديل الرد' : 'رد جديد'}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
              اسم الرد (اللي الموظفة بتشوفه)
              <input className={`${inputCls} mt-1`} value={draft.title} maxLength={60}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
              المجموعة
              <input className={`${inputCls} mt-1`} value={draft.category} maxLength={30} list="wa-reply-categories"
                onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
              <datalist id="wa-reply-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            </label>
          </div>
          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
            نص الرد
            <textarea className={`${inputCls} mt-1 leading-relaxed`} rows={4} value={draft.body} maxLength={1000}
              onChange={(e) => setDraft({ ...draft, body: e.target.value, active: OPEN_PART.test(e.target.value) ? false : draft.active })} />
          </label>
          {hasOpenPart && (
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
              في جزء بين قوسين [ ] لسه مكتبتوش، فالرد هيتحفظ مقفول ومش هيظهر للموظفات لحد ما تكمّله.
            </p>
          )}
          <div>
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">يظهر أول اقتراح لما العميل:</p>
            <div className="flex flex-wrap gap-1.5">
              {TAG_CHOICES.map(([key, label]) => {
                const on = draft.for_tags.includes(key);
                return (
                  <button key={key} type="button"
                    onClick={() => setDraft({ ...draft, for_tags: on ? draft.for_tags.filter((t) => t !== key) : [...draft.for_tags, key] })}
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition ${on
                      ? 'bg-emerald-600 border-emerald-600 text-white'
                      : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300'}`}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
              لمنتج معين بس (اختياري) — جزء من اسم المنتج
              <input className={`${inputCls} mt-1`} value={draft.product_match ?? ''} maxLength={80} placeholder="مثال: داش كام"
                onChange={(e) => setDraft({ ...draft, product_match: e.target.value })} />
            </label>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
              الترتيب (الأصغر يظهر الأول)
              <input className={`${inputCls} mt-1`} type="number" min={0} max={9999} value={draft.sort ?? 100}
                onChange={(e) => setDraft({ ...draft, sort: Number(e.target.value) || 0 })} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <input type="checkbox" className="w-4 h-4 accent-emerald-600" checked={!!draft.active && !hasOpenPart} disabled={hasOpenPart}
              onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
            شغال (يظهر للموظفات)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={save} disabled={busy || !draft.title.trim() || !draft.body.trim()}
              className="px-4 py-2 rounded-xl text-sm font-bold bg-emerald-600 text-white disabled:opacity-50">
              {busy ? '…' : 'احفظ'}
            </button>
            <button type="button" onClick={() => setDraft(null)} disabled={busy}
              className="px-4 py-2 rounded-xl text-sm font-semibold border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200">
              إلغاء
            </button>
            {draft.id && !askDelete && (
              <button type="button" onClick={() => setAskDelete(true)} disabled={busy}
                className="ms-auto px-3 py-2 rounded-xl text-sm font-semibold text-red-700 dark:text-red-300">
                امسح الرد
              </button>
            )}
            {draft.id && askDelete && (
              <span className="ms-auto flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
                يتمسح نهائي؟
                <button type="button" onClick={remove} disabled={busy} className="px-3 py-1.5 rounded-lg font-bold bg-red-600 text-white">امسح</button>
                <button type="button" onClick={() => setAskDelete(false)} className="px-2 py-1.5 font-semibold text-slate-600 dark:text-slate-300">لأ</button>
              </span>
            )}
          </div>
        </div>
      )}

      {replies && (
        <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800">
          {replies.map((r) => (
            <div key={r.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {r.title}
                  <span className="ms-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">{r.category}{r.product_match ? ` · ${r.product_match}` : ''}</span>
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed line-clamp-2 whitespace-pre-wrap">{r.body}</p>
              </div>
              <span className={`shrink-0 mt-0.5 px-2 py-0.5 rounded-full text-[11px] font-bold ${r.active
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'}`}>
                {r.active ? 'شغال' : OPEN_PART.test(r.body) ? 'محتاج تكمّله' : 'مقفول'}
              </span>
              <button type="button" onClick={() => edit(r)}
                className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200">
                تعديل
              </button>
            </div>
          ))}
          {!replies.length && <p className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400">مفيش ردود — اضغط «رد جديد».</p>}
        </div>
      )}
    </div>
  );
}
