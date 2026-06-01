'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getBusinessProfile, updateBusinessProfile, BusinessProfile } from '@/lib/api';

/* ── Toast ─────────────────────────────────────────────────────── */
interface Toast { message: string; type: 'success' | 'error' }

/* ── Field definitions (order controls render order) ──────────── */
const FIELDS: {
  key: keyof Omit<BusinessProfile, 'id' | 'updated_at'>;
  label:       string;
  placeholder: string;
  type?:       string;
}[] = [
  { key: 'brand_name',    label: 'اسم البراند',          placeholder: 'Product Pulse',           type: 'text'  },
  { key: 'contact_email', label: 'البريد الإلكتروني',     placeholder: 'admin@example.com',        type: 'email' },
  { key: 'phone_number',  label: 'رقم التواصل',           placeholder: '01xxxxxxxxx',             type: 'tel'   },
  { key: 'industry',      label: 'المجال / الصناعة',      placeholder: 'تجارة إلكترونية',         type: 'text'  },
  { key: 'logo_url',      label: 'رابط الشعار (Logo URL)', placeholder: 'https://…/logo.png',     type: 'url'   },
];

export default function BusinessProfilePage() {
  const router = useRouter();

  const [profile,  setProfile]  = useState<BusinessProfile | null>(null);
  const [draft,    setDraft]    = useState<Partial<BusinessProfile>>({});
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState<Toast | null>(null);
  const [isAdmin,  setIsAdmin]  = useState(false);
  const [dirty,    setDirty]    = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Auth + role check ──────────────────────────────────────── */
  useEffect(() => {
    const token    = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (!token || !userData) { router.push('/'); return; }
    try {
      const u = JSON.parse(userData);
      setIsAdmin(u.role === 'admin');
    } catch { router.push('/'); }
  }, [router]);

  /* ── Load profile ──────────────────────────────────────────── */
  useEffect(() => {
    setLoading(true);
    getBusinessProfile()
      .then((res) => {
        setProfile(res.data);
        setDraft(res.data);
      })
      .catch(() => showToast('فشل تحميل بيانات البروفايل', 'error'))
      .finally(() => setLoading(false));
  }, []);

  /* ── Toast helper ───────────────────────────────────────────── */
  const showToast = (message: string, type: Toast['type']) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  /* ── Field change ───────────────────────────────────────────── */
  const handleChange = (key: keyof BusinessProfile, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  /* ── Save ───────────────────────────────────────────────────── */
  const handleSave = async () => {
    if (!profile || !isAdmin) return;
    setSaving(true);
    try {
      const payload: Partial<Omit<BusinessProfile, 'id' | 'updated_at'>> = {
        brand_name:    draft.brand_name    ?? '',
        contact_email: draft.contact_email ?? '',
        phone_number:  draft.phone_number  ?? '',
        industry:      draft.industry      ?? '',
        logo_url:      draft.logo_url      ?? '',
      };
      const res = await updateBusinessProfile(profile.id, payload);
      setProfile(res.data);
      setDraft(res.data);
      setDirty(false);
      showToast('تم الحفظ بنجاح ✓', 'success');
    } catch {
      showToast('فشل في الحفظ — تحقق من الاتصال', 'error');
    } finally {
      setSaving(false);
    }
  };

  /* ── Discard ─────────────────────────────────────────────────── */
  const handleDiscard = () => {
    if (profile) { setDraft(profile); setDirty(false); }
  };

  /* ── Render helpers ─────────────────────────────────────────── */
  const logoUrl = (draft.logo_url ?? '').trim();

  /* ─────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 p-6" dir="rtl">

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-lg
            text-white text-sm font-medium transition-all
            ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-600'}`}
        >
          {toast.message}
        </div>
      )}

      {/* ── Page header ──────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">بروفايل البيزنس</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">معلومات البراند والإعدادات الأساسية</p>
      </div>

      {loading ? (
        /* Loading skeleton */
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-800 shadow-sm p-8 text-center">
          <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600
            rounded-full animate-spin mb-3" />
          <p className="text-gray-400 dark:text-slate-500 text-sm">جارٍ التحميل...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

          {/* ── Left column: form ──────────────────────────────────── */}
          <div className="xl:col-span-2 space-y-5">

            {/* Non-admin notice */}
            {!isAdmin && (
              <div className="flex items-center gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50
                text-amber-800 dark:text-amber-300 rounded-xl px-4 py-3 text-sm">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                صلاحية العرض فقط — التعديل متاح للمدير
              </div>
            )}

            {/* Form card */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-800 shadow-sm">
              <div className="px-6 py-5 border-b border-gray-100 dark:border-slate-800">
                <h2 className="text-base font-semibold text-gray-800 dark:text-white">معلومات البراند</h2>
                <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                  تُستخدم هذه البيانات في الفواتير والتقارير والإشعارات
                </p>
              </div>

              <div className="p-6 space-y-5">
                {FIELDS.map(({ key, label, placeholder, type }) => (
                  <div key={key}>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                      {label}
                    </label>
                    <input
                      type={type ?? 'text'}
                      value={(draft[key] as string) ?? ''}
                      onChange={(e) => handleChange(key, e.target.value)}
                      placeholder={placeholder}
                      disabled={!isAdmin}
                      dir={key === 'contact_email' || key === 'logo_url' || key === 'phone_number' ? 'ltr' : 'rtl'}
                      className={`w-full px-4 py-2.5 border rounded-xl text-sm outline-none transition
                        placeholder-slate-400 dark:placeholder-slate-600
                        ${isAdmin
                          ? 'border-gray-300 dark:border-slate-700 focus:ring-2 focus:ring-indigo-400 focus:border-transparent bg-white dark:bg-slate-800 text-gray-900 dark:text-white'
                          : 'border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50 text-gray-500 dark:text-slate-500 cursor-not-allowed'}`}
                    />
                  </div>
                ))}
              </div>

              {/* Action bar */}
              {isAdmin && (
                <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-800 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleSave}
                      disabled={saving || !dirty}
                      className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700
                        text-white rounded-xl text-sm font-semibold transition
                        disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {saving ? (
                        <>
                          <span className="w-4 h-4 border-2 border-white/40 border-t-white
                            rounded-full animate-spin" />
                          جارٍ الحفظ...
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M5 13l4 4L19 7" />
                          </svg>
                          حفظ التغييرات
                        </>
                      )}
                    </button>

                    {dirty && (
                      <button
                        onClick={handleDiscard}
                        className="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-600
                          dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300
                          rounded-xl text-sm font-medium transition"
                      >
                        تجاهل التغييرات
                      </button>
                    )}
                  </div>

                  {profile?.updated_at && (
                    <p className="text-xs text-gray-400 dark:text-slate-500 text-left">
                      آخر تحديث:{' '}
                      {new Date(profile.updated_at).toLocaleString('ar-EG', {
                        dateStyle: 'medium', timeStyle: 'short',
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Right column: preview card ─────────────────────────── */}
          <div className="space-y-5">

            {/* Brand preview */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-800 shadow-sm p-6">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300 mb-4">معاينة البراند</h2>

              {/* Logo / avatar */}
              <div className="flex flex-col items-center gap-4">
                {logoUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={logoUrl}
                    alt="شعار البراند"
                    className="w-24 h-24 object-contain rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 p-2"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div className="w-24 h-24 rounded-2xl bg-indigo-600 flex items-center justify-center">
                    <svg className="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                        d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                )}

                <div className="text-center">
                  <p className="text-lg font-bold text-gray-900 dark:text-white">
                    {(draft.brand_name ?? '').trim() || 'اسم البراند'}
                  </p>
                  {(draft.industry ?? '').trim() && (
                    <span className="inline-block mt-1 px-3 py-0.5 bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300
                      text-xs font-medium rounded-full">
                      {draft.industry}
                    </span>
                  )}
                </div>
              </div>

              {/* Contact details */}
              <div className="mt-5 space-y-2.5">
                {(draft.contact_email ?? '').trim() && (
                  <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300">
                    <svg className="w-4 h-4 text-gray-400 dark:text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    <span dir="ltr" className="truncate">{draft.contact_email}</span>
                  </div>
                )}
                {(draft.phone_number ?? '').trim() && (
                  <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300">
                    <svg className="w-4 h-4 text-gray-400 dark:text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                    <span dir="ltr">{draft.phone_number}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Info card */}
            <div className="bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900/50 rounded-2xl p-4 text-sm text-indigo-700 dark:text-indigo-300">
              <p className="font-semibold mb-1.5 flex items-center gap-1.5">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                ملاحظة
              </p>
              <p className="text-indigo-600 dark:text-indigo-400/90 leading-relaxed text-xs">
                يُستخدم اسم البراند في رأس الصفحة وشعار الـ Sidebar. رابط الشعار يجب أن يكون URL مباشر لصورة
                (PNG أو SVG أو JPG). يمكن استضافته على Supabase Storage أو أي CDN.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
