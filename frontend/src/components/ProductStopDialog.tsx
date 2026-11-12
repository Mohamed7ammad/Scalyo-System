'use client';

import { useEffect, useState } from 'react';
import {
  getProductStopPreview, stopProduct, reopenProduct,
  type ProductStopPreview, type ProductStopSpec,
} from '@/lib/api';

/* ════════════════════════════════════════════════════════════════════
   ProductStopDialog — «إيقاف المنتج» / «تشغيل المنتج» (admin).
   Loads what the action would do (preview), then stops or reopens the
   product. Used by the «قفل» dialog (spec = the order's product, in
   inventory or not), the «مغلق» tab list and the inventory page.
   Stop: confirmed orders → «مغلق - لن يشحن» (commission + confirmation
   credit kept), open ones → «مغلق - منتج متوقف», new ones born closed.
   ════════════════════════════════════════════════════════════════════ */
export default function ProductStopDialog({ spec, onClose, onDone }: {
  spec:    ProductStopSpec;
  onClose: () => void;
  /** Called after a successful stop / reopen with a short Arabic summary. */
  onDone:  (message: string) => void;
}) {
  const [preview, setPreview] = useState<ProductStopPreview | null>(null);
  const [error,   setError]   = useState('');
  const [busy,    setBusy]    = useState(false);
  const [restore, setRestore] = useState(false);

  const specKey = JSON.stringify(spec);
  useEffect(() => {
    let alive = true;
    setPreview(null); setError('');
    getProductStopPreview(JSON.parse(specKey) as ProductStopSpec)
      .then((r) => { if (alive) setPreview(r.data); })
      .catch(() => { if (alive) setError('تعذّر تحميل تفاصيل المنتج'); });
    return () => { alive = false; };
  }, [specKey]);

  const confirm = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      if (preview.stopped) {
        const r = await reopenProduct(spec, restore);
        onDone(r.data.restored ? `اتشغّل المنتج ورجع ${r.data.restored} أوردر` : 'اتشغّل المنتج');
      } else {
        const r = await stopProduct(spec);
        const n = r.data.closedConfirmed + r.data.closedOpen;
        onDone(n ? `اتوقف المنتج واتقفل ${n} أوردر` : 'اتوقف المنتج');
      }
    } catch (e: unknown) {
      setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'فشل في تنفيذ العملية');
      setBusy(false);
    }
  };

  const stopped = !!preview?.stopped;
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4"
      dir="rtl" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[90dvh] overflow-y-auto p-5
        border border-slate-200 dark:border-slate-700">
        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-1">
          {preview ? (stopped ? 'تشغيل المنتج تاني' : 'إيقاف المنتج كله') : 'المنتج'}
        </h2>
        {preview && (
          <p className="font-semibold text-slate-600 dark:text-slate-300 mb-4">
            {preview.target.name}
            {preview.target.kind === 'name' && (
              <span className="mr-2 text-xs font-normal text-slate-400">(مش متسجل في المخزون)</span>
            )}
          </p>
        )}

        {!preview ? (
          <div className="py-8 text-center text-sm text-slate-400">{error || 'جارٍ التحميل…'}</div>
        ) : stopped ? (
          <div className="space-y-3 text-sm text-slate-700 dark:text-slate-300 mb-5">
            <p>الأوردرات الجديدة للمنتج ده هتنزل للبنات عادي تاني.</p>
            {preview.closedByStop > 0 && (
              <label className="flex items-start gap-2 p-3 rounded-xl cursor-pointer
                bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                <input type="checkbox" checked={restore} onChange={(e) => setRestore(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-emerald-600" />
                <span>
                  رجّع كمان الـ<strong>{preview.closedByStop}</strong> أوردر اللي اتقفلوا لما وقفته — كل أوردر
                  يرجع للحالة اللي كان عليها.
                </span>
              </label>
            )}
          </div>
        ) : (
          <div className="space-y-2 text-sm text-slate-700 dark:text-slate-300 mb-5">
            <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-900/40 border border-stone-200 dark:border-stone-700">
              <p className="font-bold">{preview.confirmed} أوردر مؤكد ← «مغلق - لن يشحن»</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                بيختفوا من الشحن، وعمولة البنات ونسبة التأكيد بتاعتهم فاضلين زي ما هما
                {preview.commissionKept > 0 ? ` (${preview.commissionKept.toLocaleString('en-US')} ج.م عمولة محفوظة)` : ''}.
              </p>
            </div>
            <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-900/40 border border-stone-200 dark:border-stone-700">
              <p className="font-bold">{preview.open} أوردر لسه متأكدش ← «مغلق - منتج متوقف»</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                بيطلعوا من طابور البنات ومش بيتحسبوا عليهم في النسبة
                {Object.keys(preview.openByStatus).length > 0
                  ? ` (${Object.entries(preview.openByStatus).map(([s, n]) => `${s}: ${n}`).join('، ')})`
                  : ''}.
              </p>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              أي أوردر جديد ييجي للمنتج ده هيتقفل لوحده لحد ما تشغّله تاني (من تاب «مغلق»
              {preview.target.kind === 'inventory' ? ' أو من المخزون' : ''}).
            </p>
            {preview.deposits.count > 0 && (
              <p className="px-3 py-2 rounded-xl text-sm font-semibold bg-amber-50 text-amber-800 border border-amber-200
                dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-700/50">
                {preview.deposits.count} أوردر منهم عليهم عربون ({preview.deposits.total.toLocaleString('en-US')} ج.م) — افتكر ترجّعه للعملاء.
              </p>
            )}
          </div>
        )}

        {error && preview && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={confirm}
            disabled={busy || !preview}
            className={`flex-1 flex items-center justify-center gap-2 text-white py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50
              ${stopped ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-stone-700 hover:bg-stone-800'}`}
          >
            {busy
              ? <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              : stopped ? 'تشغيل المنتج' : 'إيقاف المنتج'}
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition
              bg-slate-100 hover:bg-slate-200 text-slate-700
              dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 disabled:opacity-50"
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
