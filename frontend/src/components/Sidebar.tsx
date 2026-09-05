'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

/* ── Nav item definitions ──────────────────────────────────────── */
interface NavChild {
  href:       string;
  label:      string;
  icon:       React.ReactNode;
  adminOnly?: boolean;   // hide for non-admin users
}

interface NavItem {
  href:                string;
  label:               string;
  subLabel:            string;
  soon?:               boolean;
  adminOnly?:          boolean;   // true = admins only; no permission check
  agentOnly?:          boolean;   // true = agents only (hidden from admins)
  affiliateOnly?:      boolean;   // true = visible only to plan_type === 'affiliate'
  hideForRoles?:       string[];  // roles explicitly denied this link, even if a permission would allow it
  requiredPermission?: string;    // if set, user must have this key (or be admin)
  icon:                React.ReactNode;
  children?:           NavChild[];   // optional sub-links shown when parent is active
}

/* The ONLY pages the After-Sales customer-service role may see — a strict
   allowlist (returns/replacements + read-only order verification). Everything
   else in the nav is hidden for this role. */
const AFTER_SALES_ALLOWED = new Set<string>([
  '/dashboard/exchange-returns',
  '/dashboard/order-lookup',
]);

/* A 'moderator' (chat data-entry) is the most locked-down role: they may ONLY
   reach their own performance/commission page (which carries the Add-Order
   action) and the read-only order lookup scoped to their own orders. Company
   analytics, treasury, inventory, staff and Bosta settings are all hidden. */
const MODERATOR_ALLOWED = new Set<string>([
  '/dashboard/my-orders',
  '/dashboard/order-lookup',
]);

/* hrefs an 'affiliate' plan tenant is allowed to see */
const AFFILIATE_ALLOWED = new Set<string>([
  '/dashboard/analytics',
  '/dashboard/staff',
  '/dashboard/integrations/meta',
  '/dashboard/external-affiliate',
  '/dashboard/import-data',
  '/dashboard/business-profile',
]);

const NAV_ITEMS: NavItem[] = [
  {
    href: '/dashboard/analytics', label: 'لوحة التحكم والتحليلات',
    subLabel: 'Analytics', requiredPermission: 'analytics',
    /* Financial dashboard — never shown to team-leaders (they get the orders
       system + the non-financial performance tab in Staff instead). */
    hideForRoles: ['supervisor'],
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/order-sources', label: 'مصادر الطلبات',
    subLabel: 'Order Sources', requiredPermission: 'analytics',
    hideForRoles: ['supervisor'],
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M7 8h10M7 12h6m-6 8l-4-4V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2H9l-2 4z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/my-performance', label: 'أدائي',
    subLabel: 'My Performance', agentOnly: true,
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
      </svg>
    ),
  },
  {
    href: '/dashboard', label: 'سيستم تأكيد الطلبات',
    subLabel: 'Orders', requiredPermission: 'orders',
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
      </svg>
    ),
  },
  {
    href: '/dashboard/lost-orders', label: 'تأكيد الطلبات المفقودة',
    subLabel: 'Lost Orders', requiredPermission: 'orders',
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/delayed-shipments', label: 'الشحنات المتأخرة',
    subLabel: 'Delayed Shipments', requiredPermission: 'orders',
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/whatsapp', label: 'تأكيد الواتساب',
    subLabel: 'WhatsApp', soon: true,
    icon: (
      <svg fill="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/inventory', label: 'إدارة المخزون',
    subLabel: 'Inventory', requiredPermission: 'inventory',
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
    ),
    children: [
      {
        href: '/dashboard/inventory/returns',
        label: 'سجل المرتجعات',
        icon: (
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
        ),
      },
      {
        href: '/dashboard/inventory/purchases',
        label: 'سجل الشحنات',
        adminOnly: true,
        icon: (
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
        ),
      },
    ],
  },
  {
    href: '/dashboard/in-transit-orders', label: 'البضاعة قيد التنفيذ',
    subLabel: 'In-Transit', adminOnly: true,
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M9 17a2 2 0 11-4 0 2 2 0 014 0zm10 0a2 2 0 11-4 0 2 2 0 014 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1" />
      </svg>
    ),
  },
  {
    href: '/dashboard/returns-collection', label: 'إدارة تحصيل المرتجعات',
    subLabel: 'Returns', requiredPermission: 'shipping_followups',
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M3 10h11a6 6 0 016 6v1M3 10l5 5m-5-5l5-5M21 12a9 9 0 01-9 9" />
      </svg>
    ),
  },
  {
    href: '/dashboard/after-sales', label: 'خدمة ما بعد البيع',
    subLabel: 'After-Sales',   // no role/permission flags — visible to every employee
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/exchange-returns', label: 'الاستبدال والاسترجاع',
    subLabel: 'Exchange & Returns',   // no role/permission flags — visible to every employee
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>
    ),
  },
  {
    href: '/dashboard/order-lookup', label: 'التحقق من الطلبات',
    subLabel: 'Order Lookup', requiredPermission: 'order_lookup',
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
  },
  {
    /* Data-entry (moderator) home: THEIR OWN created orders + commission tracking.
       The page is scoped to created_by = current user, so it's only meaningful to
       the role that actually creates orders. Moderators get it via MODERATOR_ALLOWED
       in canSee(); the denylist hides it from every other role — notably the ADMIN,
       who already has the global orders/analytics views and doesn't need it. */
    href: '/dashboard/my-orders', label: 'طلباتي والعمولة',
    subLabel: 'My Orders & Commission',
    hideForRoles: ['admin', 'agent', 'media_buyer', 'supervisor'],
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M9 17v-2m3 2v-4m3 4v-6m2 10H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/staff', label: 'إدارة الموظفين',
    subLabel: 'Team', requiredPermission: 'manage_staff',
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/treasury', label: 'الخزينة والماليات',
    subLabel: 'Treasury', adminOnly: true,
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/integrations/meta', label: 'الربط مع Meta Ads',
    subLabel: 'Meta', adminOnly: true,
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/external-affiliate', label: 'الربط مع منصات الأفليت',
    subLabel: 'Affiliate Networks', affiliateOnly: true,
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
      </svg>
    ),
  },
  {
    href: '/dashboard/import-data', label: 'استيراد الداتا التاريخية',
    subLabel: 'Import Data', affiliateOnly: true,
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
      </svg>
    ),
  },
  {
    href: '/dashboard/integrations/bosta', label: 'الربط مع شركة الشحن',
    subLabel: 'Shipping', adminOnly: true,
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" />
      </svg>
    ),
  },
  {
    href: '/dashboard/easyorder', label: 'الربط مع إيزي أوردر',
    subLabel: 'EasyOrder', adminOnly: true,
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
    ),
  },
  {
    href: '/dashboard/business-profile', label: 'بروفايل البيزنس',
    subLabel: 'Profile',
    icon: (
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
  },
];

/* ── Sidebar ───────────────────────────────────────────────────── */
interface SidebarProps {
  collapsed:  boolean;
  onToggle:   () => void;
  brandName?: string;
  /* Mobile drawer (below md): the sidebar is off-canvas by default and slides
     in over a backdrop when the layout's hamburger opens it. `collapsed` is a
     desktop-only concept — the drawer always renders expanded. */
  mobileOpen?:     boolean;
  onMobileClose?:  () => void;
}

export default function Sidebar({
  collapsed, onToggle, brandName = 'Product Pulse',
  mobileOpen = false, onMobileClose,
}: SidebarProps) {
  const pathname = usePathname();
  const router   = useRouter();
  const [user,   setUser]   = useState<{ email: string; role: string; permissions?: string[]; plan_type?: string } | null>(null);
  const [isDark, setIsDark] = useState(false);

  /* Navigating (tapping a link) closes the mobile drawer automatically. */
  useEffect(() => {
    onMobileClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('user');
      if (stored) setUser(JSON.parse(stored));
    } catch { /* ignore */ }
    // Sync toggle state with the class already set by the root layout script
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  /** Returns true if the current user may see this nav item */
  const canSee = (item: NavItem): boolean => {
    // Moderator (chat data-entry): the most locked-down role — ONLY their own
    // orders/commission page + the (self-scoped) order lookup.
    if (user?.role === 'moderator') return MODERATOR_ALLOWED.has(item.href);
    // After-Sales role: strict allowlist — ONLY returns/replacements + order lookup.
    if (user?.role === 'after_sales') return AFTER_SALES_ALLOWED.has(item.href);
    // Affiliate-plan tenants only ever see a restricted set of links.
    if (user?.plan_type === 'affiliate' && !AFFILIATE_ALLOWED.has(item.href)) return false;
    // Role-level denylist wins over any permission that would otherwise allow it.
    if (item.hideForRoles && user?.role && item.hideForRoles.includes(user.role)) return false;
    // Affiliate-exclusive links are hidden from every other plan.
    if (item.affiliateOnly)      return user?.plan_type === 'affiliate';
    if (item.adminOnly)          return user?.role === 'admin';
    if (item.agentOnly)          return user?.role === 'agent';
    if (item.requiredPermission) {
      if (user?.role === 'admin') return true; // admins bypass all permission gates
      const perms = user?.permissions ?? ['orders'];
      return perms.includes(item.requiredPermission);
    }
    return true; // no restriction — visible to everyone
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    router.push('/');
  };

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  };

  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href);

  /* Icon-rail rendering is desktop-only: when the MOBILE drawer is open it
     always renders fully expanded, regardless of the persisted desktop
     collapse state (an icon-only drawer on a phone is useless). */
  const rail = collapsed && !mobileOpen;

  return (
    <>
      {/* Mobile backdrop — tap to dismiss the drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={onMobileClose}
          aria-hidden
        />
      )}

    {/* Below md: off-canvas drawer over the content (RTL → sidebar lives on
        the RIGHT, so translate-x-full slides it out to the right; always
        expanded). md+: the original in-flow rail with collapse-to-icons. */}
    <aside
      className={`
        flex flex-col
        bg-white dark:bg-gray-900
        border-l border-slate-200 dark:border-gray-700/60
        shadow-[-2px_0_12px_rgba(0,0,0,0.06)] dark:shadow-[-2px_0_16px_rgba(0,0,0,0.25)]
        shrink-0
        fixed inset-y-0 right-0 z-50 h-dvh w-72 max-w-[85vw]
        transition-transform duration-300 ease-in-out
        ${mobileOpen ? 'translate-x-0' : 'translate-x-full'}
        md:relative md:z-auto md:h-screen md:translate-x-0
        md:transition-all
        ${rail ? 'md:w-[72px]' : 'md:w-64'}
      `}
    >
      {/* ── Brand header ─────────────────────────────────────── */}
      <div className={`flex items-center gap-3 px-4 py-5
        border-b border-slate-200 dark:border-gray-700/60
        ${rail ? 'justify-center' : ''}`}>
        <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shrink-0
          shadow-md shadow-indigo-500/30 dark:shadow-indigo-900/50">
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        {!rail && (
          <div className="min-w-0 flex-1">
            <p className="text-slate-900 dark:text-white font-bold text-sm truncate">{brandName}</p>
            <p className="text-slate-500 dark:text-gray-500 text-xs truncate">لوحة الإدارة</p>
          </div>
        )}
        {/* Mobile drawer close (44px touch target) — hidden on desktop */}
        <button
          onClick={onMobileClose}
          aria-label="إغلاق القائمة"
          className="md:hidden shrink-0 w-11 h-11 -my-2 flex items-center justify-center rounded-xl
            text-slate-500 dark:text-gray-400
            hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-gray-800 dark:hover:text-gray-200
            transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* ── Toggle button — desktop-only rail collapse, on the LEFT edge ── */}
      <button
        onClick={onToggle}
        className="absolute -left-3.5 top-[68px] z-10 w-7 h-7
          bg-white dark:bg-gray-800
          border border-slate-300 dark:border-gray-600
          rounded-full hidden md:flex items-center justify-center
          text-slate-500 dark:text-gray-400
          hover:text-white hover:bg-indigo-600 hover:border-indigo-500 transition-all duration-150
          shadow-md shadow-black/10 dark:shadow-black/40"
        title={rail ? 'توسيع القائمة' : 'طي القائمة'}
      >
        {/* Arrow points RIGHT (›) when expanded = collapse inward;
            points LEFT (‹) when rail = expand outward toward content. */}
        <svg className={`w-3 h-3 transition-transform duration-300 ${rail ? '' : 'rotate-180'}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {/* ── Nav items ────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 space-y-0.5 px-2">
        {NAV_ITEMS.filter(canSee).map((item) => {
          const active = isActive(item.href);
          return (
            <div key={item.href} className="relative group">
              {item.soon ? (
                /* Coming-soon items — not clickable */
                <div
                  className={`
                    flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-not-allowed select-none
                    text-slate-400 dark:text-gray-600
                    ${rail ? 'justify-center' : ''}
                  `}
                  title={rail ? item.label : undefined}
                >
                  <span className="shrink-0 opacity-40">{item.icon}</span>
                  {!rail && (
                    <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium truncate leading-snug opacity-50">{item.label}</span>
                      <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-lg
                        bg-slate-100 text-slate-400 border border-slate-200
                        dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700
                        whitespace-nowrap tracking-wide">
                        قريباً
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                /* Implemented items */
                <>
                  <Link
                    href={item.href}
                    title={rail ? item.label : undefined}
                    className={`
                      group/item flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150
                      ${rail ? 'justify-center' : ''}
                      ${active
                        ? 'bg-indigo-50 text-indigo-700 font-medium shadow-sm ring-1 ring-inset ring-indigo-200/80 dark:bg-indigo-600 dark:text-white dark:shadow-indigo-950/60 dark:ring-white/10'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100'}
                    `}
                  >
                    <span className={`shrink-0 transition-transform duration-150
                      ${active ? '' : 'group-hover/item:scale-110'}`}>
                      {item.icon}
                    </span>
                    {!rail && (
                      <span className="text-xs truncate leading-snug">{item.label}</span>
                    )}
                  </Link>

                  {/* Sub-links — only visible when parent section is active and sidebar is expanded */}
                  {!rail && active && item.children && item.children.length > 0 && (
                    <div className="mt-0.5 mr-4 border-r-2 border-indigo-200 dark:border-indigo-700/60 pr-2 space-y-0.5">
                      {item.children
                        .filter((child) => !child.adminOnly || user?.role === 'admin')
                        .map((child) => {
                          const childActive = pathname === child.href || pathname.startsWith(child.href);
                          return (
                            <Link
                              key={child.href}
                              href={child.href}
                              className={`
                                flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs transition-all duration-150
                                ${childActive
                                  ? 'bg-indigo-50 text-indigo-700 font-semibold dark:bg-indigo-900/50 dark:text-indigo-300'
                                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300'}
                              `}
                            >
                              <span className="shrink-0 opacity-70">{child.icon}</span>
                              <span className="truncate">{child.label}</span>
                            </Link>
                          );
                        })}
                    </div>
                  )}
                </>
              )}

              {/* Collapsed tooltip — appears to the LEFT (toward content area) */}
              {rail && (
                <div className="absolute right-full top-1/2 -translate-y-1/2 ml-3 px-3 py-2
                  bg-white border border-slate-200 text-slate-800 text-xs rounded-xl
                  dark:bg-gray-800 dark:border-gray-700/80 dark:text-white
                  whitespace-nowrap shadow-xl shadow-black/10 dark:shadow-black/30 z-50
                  opacity-0 group-hover:opacity-100 pointer-events-none
                  transition-opacity duration-150"
                  dir="rtl"
                >
                  {item.label}
                  {item.soon && (
                    <span className="mr-2 text-amber-500 dark:text-amber-400 text-[9px] font-bold tracking-wide">قريباً</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* ── User footer ──────────────────────────────────────── */}
      <div className={`border-t border-slate-200 dark:border-gray-700/60 p-3
        ${rail ? 'flex flex-col items-center gap-1' : ''}`}>
        {!rail ? (
          <div className="flex items-center gap-2 px-1">
            {/* Avatar */}
            <div className="w-8 h-8 rounded-full
              bg-indigo-100 border border-indigo-200
              dark:bg-indigo-900/80 dark:border-indigo-700/60
              flex items-center justify-center shrink-0 shadow-sm">
              <span className="text-indigo-600 dark:text-indigo-300 text-xs font-bold">
                {user?.email?.[0]?.toUpperCase() ?? '?'}
              </span>
            </div>
            {/* Name + role */}
            <div className="flex-1 min-w-0">
              <p className="text-slate-800 dark:text-gray-200 text-xs font-medium truncate leading-tight">
                {user?.email?.split('@')[0] ?? '—'}
              </p>
              <p className="text-slate-500 dark:text-gray-600 text-[10px] truncate mt-0.5 leading-tight">
                {user?.role === 'admin'
                  ? 'مدير النظام'
                  : user?.role === 'supervisor'
                    ? 'تيم ليدر'
                    : user?.role === 'media_buyer'
                      ? 'ميديا باير'
                      : user?.role === 'after_sales'
                        ? 'خدمة ما بعد البيع'
                        : user?.role === 'moderator'
                          ? 'تسجيل أوردرات'
                          : 'موظف تأكيد'}
              </p>
            </div>
            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              title={isDark ? 'الوضع الفاتح' : 'الوضع الداكن'}
              className="p-1.5 rounded-lg text-slate-500 dark:text-gray-600
                hover:text-amber-500 hover:bg-amber-400/10
                transition-all duration-150 shrink-0"
            >
              {isDark ? (
                /* Sun */
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                /* Moon */
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
            {/* Logout */}
            <button
              onClick={handleLogout}
              title="تسجيل الخروج"
              className="p-1.5 rounded-lg text-slate-500 dark:text-gray-600
                hover:text-red-500 hover:bg-red-400/10
                transition-all duration-150 shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        ) : (
          /* Collapsed: theme + logout stacked */
          <>
            <button
              onClick={toggleTheme}
              title={isDark ? 'الوضع الفاتح' : 'الوضع الداكن'}
              className="p-2 rounded-xl text-slate-500 dark:text-gray-600
                hover:text-amber-500 hover:bg-amber-400/10
                transition-all duration-150"
            >
              {isDark ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
            <button
              onClick={handleLogout}
              title="تسجيل الخروج"
              className="p-2 rounded-xl text-slate-500 dark:text-gray-600
                hover:text-red-500 hover:bg-red-400/10
                transition-all duration-150"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </>
        )}
      </div>
    </aside>
    </>
  );
}
