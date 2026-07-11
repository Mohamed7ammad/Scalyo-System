'use client';

import { useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import { getBusinessProfile, sendHeartbeat } from '@/lib/api';

/** How often the presence heartbeat pings the backend (ms). */
const HEARTBEAT_INTERVAL_MS = 90_000; // 90s

/* Path prefixes an 'affiliate' plan tenant is NOT allowed to open directly.
   These are the eCommerce-only sections (orders, shipping, inventory, …). */
const AFFILIATE_BLOCKED_PREFIXES = [
  '/dashboard/inventory',
  '/dashboard/treasury',
  '/dashboard/integrations/bosta',
  '/dashboard/easyorder',
  '/dashboard/whatsapp',
  '/dashboard/my-performance',
];

/** A bare /dashboard (orders) visit is also blocked for affiliate tenants. */
function isAffiliateBlocked(path: string): boolean {
  if (path === '/dashboard') return true;
  return AFFILIATE_BLOCKED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

/* Affiliate-plan-exclusive pages. Every other plan is bounced to their own
   orders dashboard. */
const AFFILIATE_ONLY_PREFIXES = [
  '/dashboard/external-affiliate',
  '/dashboard/import-data',
];
function isAffiliateOnlyRoute(path: string): boolean {
  return AFFILIATE_ONLY_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [collapsed,  setCollapsed]  = useState(false);
  /* Mobile drawer state — the sidebar is off-canvas below md and slides in
     over a backdrop; opened by the hamburger in the mobile top bar. */
  const [mobileOpen, setMobileOpen] = useState(false);
  const [brandName,  setBrandName]  = useState('Product Pulse');
  const pathname = usePathname();
  const router   = useRouter();

  /* Route guard — redirect affiliate tenants away from eCommerce-only URLs */
  useEffect(() => {
    try {
      const stored = localStorage.getItem('user');
      if (!stored) return;
      const u = JSON.parse(stored) as { plan_type?: string };
      if (u?.plan_type === 'affiliate') {
        // Affiliate tenants: keep them out of the eCommerce-only sections.
        if (isAffiliateBlocked(pathname)) router.replace('/dashboard/analytics');
      } else {
        // Non-affiliate tenants: the affiliate-exclusive page is off-limits.
        if (isAffiliateOnlyRoute(pathname)) router.replace('/dashboard');
      }
    } catch { /* ignore */ }
  }, [pathname, router]);

  /* Fetch brand name once — sidebar header shows live brand */
  useEffect(() => {
    getBusinessProfile()
      .then((res) => { if (res.data?.brand_name) setBrandName(res.data.brand_name); })
      .catch(() => { /* silently fall back to default */ });
  }, []);

  /* ── Presence heartbeat ─────────────────────────────────────────────────
     While the dashboard is mounted (i.e. the user is logged in), silently ping
     the backend every ~90s so the staff table can show real-time Online/Offline.
     Fires once immediately, again when the tab regains focus, then on interval. */
  useEffect(() => {
    const ping = () => { sendHeartbeat().catch(() => { /* silent */ }); };
    ping();
    const id = setInterval(ping, HEARTBEAT_INTERVAL_MS);
    const onFocus = () => ping();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, []);

  return (
    /*
     * dir="rtl" on the root so flex flows right→left, placing the sidebar
     * on the RIGHT side of the screen — correct for an Arabic dashboard.
     * Child pages inherit RTL and don't need to redeclare it.
     */
    /* h-dvh (not h-screen) so the layout tracks the REAL visible height on
       mobile browsers whose URL bar collapses/expands while scrolling. */
    <div className="flex h-dvh overflow-hidden bg-slate-50 dark:bg-slate-950" dir="rtl">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        brandName={brandName}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar — hamburger + brand; hidden from md up where the
            sidebar rail is always in-flow. */}
        <header className="md:hidden shrink-0 flex items-center gap-2 px-2 py-1.5
          bg-white dark:bg-gray-900
          border-b border-slate-200 dark:border-gray-700/60 shadow-sm">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="فتح القائمة"
            className="w-11 h-11 flex items-center justify-center rounded-xl
              text-slate-600 dark:text-gray-300
              hover:bg-slate-100 dark:hover:bg-gray-800 active:scale-95 transition"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="font-bold text-sm text-slate-900 dark:text-white truncate">{brandName}</span>
        </header>

        {/* Main scrollable content area */}
        <main className="flex-1 overflow-y-auto min-w-0 bg-slate-50 dark:bg-slate-950">
          {children}
        </main>
      </div>
    </div>
  );
}
