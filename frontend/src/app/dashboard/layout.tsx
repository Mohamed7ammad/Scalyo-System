'use client';

import { useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import { getBusinessProfile } from '@/lib/api';

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

  return (
    /*
     * dir="rtl" on the root so flex flows right→left, placing the sidebar
     * on the RIGHT side of the screen — correct for an Arabic dashboard.
     * Child pages inherit RTL and don't need to redeclare it.
     */
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950" dir="rtl">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        brandName={brandName}
      />

      {/* Main scrollable content area */}
      <main className="flex-1 overflow-y-auto min-w-0 bg-slate-50 dark:bg-slate-950">
        {children}
      </main>
    </div>
  );
}
