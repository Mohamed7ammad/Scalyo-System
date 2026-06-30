/* Dedicated "تأكيد الطلبات المفقودة" route.
 *
 * Reuses the EXACT confirmation UI from /dashboard — that component reads the
 * pathname (usePathname) and, seeing '/dashboard/lost-orders', switches into
 * lostMode: it fetches getOrders(true) (only is_lost_order = true), retitles the
 * page, and defaults the bulk-upload radio to "طلبات مفقودة". No code is
 * duplicated, so the two pages can never drift apart. */
export { default } from '../page';
