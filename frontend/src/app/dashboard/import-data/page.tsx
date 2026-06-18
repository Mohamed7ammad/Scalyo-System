'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { importSafqaCsv, type SafqaImportResult } from '@/lib/api';

export default function ImportDataPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file,    setFile]    = useState<File | null>(null);
  const [busy,    setBusy]    = useState<false | 'preview' | 'import'>(false);
  const [result,  setResult]  = useState<SafqaImportResult | null>(null);
  const [error,   setError]   = useState('');
  const [dragOver, setDragOver] = useState(false);

  /* Plan guard — affiliate plan only (the API enforces it too). */
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!u) { router.replace('/'); return; }
      if (u.plan_type !== 'affiliate') { router.replace('/dashboard/analytics'); }
    } catch { router.replace('/'); }
  }, [router]);

  const pickFile = (f: File | null) => {
    setError(''); setResult(null);
    if (!f) { setFile(null); return; }
    if (!/\.csv$/i.test(f.name)) { setError('من فضلك اختر ملف بصيغة CSV فقط.'); return; }
    setFile(f);
  };

  const run = useCallback(async (dryRun: boolean) => {
    if (!file) { setError('اختر ملف CSV أولاً.'); return; }
    setBusy(dryRun ? 'preview' : 'import');
    setError(''); setResult(null);
    try {
      const { data } = await importSafqaCsv(file, dryRun);
      setResult(data);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'فشل استيراد الملف. تأكد من أنه ملف CSV صحيح وحاول مجدداً.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [file]);

  const unmappedKeys = result ? Object.keys(result.unmapped) : [];

  return (
    <div dir="rtl" className="min-h-full">
      <div className="max-w-screen-md mx-auto px-6 pt-8 pb-12 space-y-6">

        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 shrink-0 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-700
            flex items-center justify-center shadow-lg shadow-indigo-500/25">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white leading-tight">
              استيراد الداتا التاريخية
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-snug">
              ارفع ملف تصدير الطلبات (CSV) من لوحة صفقة لاستيراد طلباتك التاريخية ومزامنتها مع لوحة التحليلات.
              <span className="block text-xs text-indigo-500 dark:text-indigo-400 font-medium mt-0.5">
                الاستيراد آمن للتكرار — يُحدّث الطلب الموجود بدل تكراره.
              </span>
            </p>
          </div>
        </div>

        {/* Upload card */}
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-6 space-y-4">
          {/* Dropzone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0] ?? null); }}
            onClick={() => inputRef.current?.click()}
            className={`cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-colors
              ${dragOver
                ? 'border-indigo-400 bg-indigo-50/60 dark:bg-indigo-950/30'
                : 'border-slate-300 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-700'}`}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            <svg className="w-10 h-10 mx-auto text-slate-400 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6}
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            {file ? (
              <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
                {file.name}
                <span className="text-slate-400 font-normal"> · {(file.size / 1024).toFixed(0)} KB</span>
              </p>
            ) : (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                اسحب ملف CSV هنا أو <span className="text-indigo-600 dark:text-indigo-400 font-semibold">اضغط للاختيار</span>
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => run(false)}
              disabled={!file || busy !== false}
              className="flex-1 min-w-[160px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl
                text-sm font-semibold text-white shadow-md transition-all duration-150 active:scale-[0.98]
                bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
              {busy === 'import' ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  جارٍ الاستيراد…
                </>
              ) : 'رفع واستيراد'}
            </button>
            <button
              onClick={() => run(true)}
              disabled={!file || busy !== false}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl
                text-sm font-semibold transition-all duration-150 active:scale-[0.98]
                text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800
                hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed">
              {busy === 'preview' ? 'جارٍ المعاينة…' : 'معاينة (بدون حفظ)'}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/50
            text-rose-700 dark:text-rose-300 text-sm">
            {error}
          </div>
        )}

        {/* Result */}
        {result && (
          <div className={`rounded-2xl border shadow-sm p-6 space-y-4
            ${result.dryRun
              ? 'border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20'
              : 'border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20'}`}>
            <div className="flex items-center gap-2">
              <span className="text-lg">{result.dryRun ? '🔎' : '✅'}</span>
              <h3 className="font-bold text-slate-900 dark:text-white">
                {result.dryRun
                  ? 'معاينة — لم يتم حفظ أي تغييرات'
                  : 'اكتمل الاستيراد بنجاح'}
              </h3>
            </div>

            {/* Stat grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { label: 'صفوف الملف',       value: result.dataRowCount },
                { label: 'تمت معالجتها',     value: result.processed },
                ...(!result.dryRun ? [
                  { label: 'جديدة',          value: result.inserted },
                  { label: 'تم تحديثها',     value: result.updated },
                  { label: 'إجمالي طلبات صفقة', value: result.totalAfter ?? 0 },
                ] : []),
                ...(result.skippedNoId ? [{ label: 'بدون رقم طلب (تجاهل)', value: result.skippedNoId }] : []),
                ...(result.failed ? [{ label: 'فشلت', value: result.failed }] : []),
              ].map((s) => (
                <div key={s.label} className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-4 py-3">
                  <p className="text-2xl font-extrabold text-slate-800 dark:text-white tabular-nums">{s.value}</p>
                  <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Unmapped statuses warning */}
            {unmappedKeys.length > 0 && (
              <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-100/60 dark:bg-amber-900/30
                border border-amber-200 dark:border-amber-800/50 rounded-xl px-3 py-2.5 leading-relaxed">
                ⚠️ حالات غير معروفة (تُعامَل مؤقتاً كـ «قيد الانتظار»):{' '}
                <span className="font-semibold">{unmappedKeys.join('، ')}</span>. تواصل معنا لإضافتها للخريطة.
              </div>
            )}

            {/* Date note */}
            {!result.dateColumnFound && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                ملاحظة: لم يُعثر على عمود تاريخ الإنشاء، لذلك ستظهر هذه الطلبات بتاريخ اليوم في فلاتر التاريخ.
              </p>
            )}

            {!result.dryRun && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                ستظهر البيانات في لوحة التحليلات مباشرةً. يمكنك إعادة رفع ملف أحدث في أي وقت دون تكرار الطلبات.
              </p>
            )}
          </div>
        )}

        {/* Help */}
        <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed px-1">
          من لوحة صفقة، صدّر كل الطلبات إلى ملف CSV ثم ارفعه هنا. يتعرّف النظام تلقائياً على الأعمدة
          (كود الطلب، الحالة، العمولة، المنتجات، المحافظة، التاريخ…). جرّب «معاينة» أولاً للتأكد من القراءة الصحيحة.
        </div>
      </div>
    </div>
  );
}
