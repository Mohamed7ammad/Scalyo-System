import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: 'نظام إدارة الطلبات',
  description: 'نظام متكامل لإدارة وتأكيد الطلبات',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body
        className="bg-slate-50 dark:bg-slate-950 text-gray-900 dark:text-slate-100 antialiased"
        suppressHydrationWarning
      >
        {/*
         * Runs synchronously before React hydration — zero flash of unstyled content.
         * Sets `dark` class on <html> based on localStorage or OS preference.
         */}
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var t = localStorage.getItem('theme');
                if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.documentElement.classList.add('dark');
                }
              } catch(_) {}
            `,
          }}
        />
        {children}
      </body>
    </html>
  );
}
