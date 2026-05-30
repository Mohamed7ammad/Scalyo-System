'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { login } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const [showPass, setShowPass] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res  = await login(email, password);
      const user = res.data.user;
      localStorage.setItem('token', res.data.token);
      localStorage.setItem('user',  JSON.stringify(user));

      /* Permissions-aware redirect ──────────────────────────────────
         Admins and agents with the analytics permission land on the
         full analytics dashboard.  Everyone else goes to orders.     */
      const perms: string[] = user.permissions ?? ['orders'];
      if (user.role === 'admin' || perms.includes('analytics')) {
        router.push('/dashboard/analytics');
      } else {
        router.push('/dashboard');
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'حدث خطأ أثناء تسجيل الدخول';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4 overflow-hidden">

      {/* ── Ambient background blobs ─────────────────────────────── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full
          bg-indigo-200/50 dark:bg-indigo-900/25 blur-3xl" />
        <div className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full
          bg-violet-200/40 dark:bg-violet-900/20 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 rounded-full
          bg-sky-100/30 dark:bg-sky-900/10 blur-2xl" />
      </div>

      {/* ── Card ─────────────────────────────────────────────────── */}
      <div className="relative w-full max-w-md">
        <div className="bg-white dark:bg-slate-900
          border border-slate-200/80 dark:border-slate-700/60
          rounded-2xl shadow-xl shadow-slate-900/8 dark:shadow-black/40
          p-8">

          {/* Brand mark */}
          <div className="flex flex-col items-center mb-8 text-center">
            <div className="w-14 h-14 mb-4 rounded-2xl
              bg-indigo-600 dark:bg-indigo-500
              flex items-center justify-center
              shadow-lg shadow-indigo-500/30 dark:shadow-indigo-800/50">
              <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              نظام إدارة الطلبات
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              سجّل دخولك للمتابعة
            </p>
          </div>

          {/* Error banner */}
          {error && (
            <div className="flex items-start gap-2.5
              bg-red-50 dark:bg-red-950/40
              border border-red-200 dark:border-red-800/60
              text-red-700 dark:text-red-400
              px-4 py-3 rounded-xl mb-6 text-sm leading-snug">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5" dir="rtl">

            {/* Email field */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                البريد الإلكتروني
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@email.com"
                required
                dir="ltr"
                autoComplete="email"
                className="w-full px-4 py-3 rounded-xl text-sm text-left
                  bg-slate-50 dark:bg-slate-800/80
                  border border-slate-300 dark:border-slate-600/80
                  text-slate-900 dark:text-white
                  placeholder:text-slate-400 dark:placeholder:text-slate-500
                  focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400
                  dark:focus:border-indigo-500 dark:focus:ring-indigo-500/30
                  transition duration-150"
              />
            </div>

            {/* Password field */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                كلمة المرور
              </label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  dir="ltr"
                  autoComplete="current-password"
                  className="w-full px-4 py-3 pr-11 rounded-xl text-sm
                    bg-slate-50 dark:bg-slate-800/80
                    border border-slate-300 dark:border-slate-600/80
                    text-slate-900 dark:text-white
                    placeholder:text-slate-400 dark:placeholder:text-slate-500
                    focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400
                    dark:focus:border-indigo-500 dark:focus:ring-indigo-500/30
                    transition duration-150"
                />
                {/* Show / hide password toggle */}
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  tabIndex={-1}
                  className="absolute inset-y-0 right-3 flex items-center
                    text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition"
                >
                  {showPass ? (
                    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 inline-flex items-center justify-center gap-2.5
                py-3 px-4 rounded-xl text-sm font-semibold
                bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800
                dark:bg-indigo-600 dark:hover:bg-indigo-500
                text-white
                shadow-md shadow-indigo-500/25 hover:shadow-lg hover:shadow-indigo-500/30
                dark:shadow-indigo-900/40
                disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none
                transition-all duration-150"
            >
              {loading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  جارٍ تسجيل الدخول…
                </>
              ) : (
                <>
                  تسجيل الدخول
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                      d="M11 16l-4-4m0 0l4-4m-4 4h14" />
                  </svg>
                </>
              )}
            </button>
          </form>

          {/* Create-account link */}
          <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
            ليس لديك حساب؟{' '}
            <Link href="/register"
              className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
              أنشئ حساب جديد
            </Link>
          </p>
        </div>

        {/* Subtle footer */}
        <p className="text-center mt-5 text-xs text-slate-400 dark:text-slate-600">
          نظام إدارة وتأكيد الطلبات — جميع الحقوق محفوظة
        </p>
      </div>
    </div>
  );
}
