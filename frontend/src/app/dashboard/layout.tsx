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

/* The External Affiliate integrations page is exclusive to the affiliate plan.
   Every other plan is bounced back to their own orders dashboard. */
const AFFILIATE_ONLY_PREFIX = '/dashboard/external-affiliate';
function isAffiliateOnlyRoute(path: string): boolean {
  return path === AFFILIATE_ONLY_PREFIX || path.startsWith(AFFILIATE_ONLY_PREFIX + '/');
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [collapsed,  setCollapsed]  = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);   // off-canvas drawer (< lg)
  const [brandName,  setBrandName]  = useState('Product Pulse');
  const pathname = usePathname();
  const router   = useRouter();

  /* Auto-close the mobile drawer whenever the route changes (link tapped). */
  useEffect(() => { setMobileOpen(false); }, [pathname]);

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
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950" dir="rtl">

      {/* ── Mobile top bar (< lg) — hamburger + live brand ──────────── */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-30 h-14 flex items-center gap-3 px-4
        bg-white/90 dark:bg-slate-900/90 backdrop-blur-md
        border-b border-slate-200 dark:border-slate-800 shadow-sm">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="فتح القائمة"
          className="p-2 -mr-2 rounded-xl text-slate-600 dark:text-slate-300
            hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-200
            focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center shrink-0
            shadow-sm shadow-indigo-500/30">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="font-bold text-sm text-slate-900 dark:text-white truncate">{brandName}</span>
        </div>
      </header>

      {/* ── Backdrop — only when the mobile drawer is open ──────────── */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden
            transition-opacity duration-300"
        />
      )}

      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        brandName={brandName}
        mobileOpen={mobileOpen}
        onNavigate={() => setMobileOpen(false)}
      />

      {/* Main scrollable content area — top padding clears the fixed mobile bar */}
      <main className="flex-1 overflow-y-auto min-w-0 bg-slate-50 dark:bg-slate-950 pt-14 lg:pt-0">
        {children}
      </main>
    </div>
  );
}
