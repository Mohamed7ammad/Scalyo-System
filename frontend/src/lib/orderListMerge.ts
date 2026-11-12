/* ── Orders-page list helpers (pure — no React, no DOM; unit-testable) ─────── */
import type { Order } from './api';

/* Short product name — the product-pill key. Drop brackets/punctuation (→ space)
   BEFORE taking the first 3 words, so a raw unlinked name like "[جهاز ليزر IPL]"
   collapses to the SAME short name as the clean inventory-linked "جهاز ليزر IPL".
   This keeps the product pill list deduped strictly by short name (price-agnostic)
   while staying short & clean, and keeps the filter, count, stock badge and
   inventory modal all in sync. */
export const getShortName = (name?: string) => {
  if (!name) return '';
  return name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ');
};

/* Server per-ProductName counts (page 1's productCounts) → per SHORT name, the
   product-pill key — names sharing a short name are summed, exactly like the
   pills group the loaded rows. */
export const countsByShortName = (rows: { name: string; n: number }[]) => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = getShortName(r.name);
    if (k) out[k] = (out[k] ?? 0) + (Number(r.n) || 0);
  }
  return out;
};

/* Page 1's activeProducts (an order in the last 7 days) → short name → the most
   recent order time (ms), for "most recently active first" ordering. */
export const activeByShortName = (rows: { name: string; last_at: string }[]) => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = getShortName(r.name);
    const t = new Date(r.last_at).getTime();
    if (k && !Number.isNaN(t)) out[k] = Math.max(out[k] ?? 0, t);
  }
  return out;
};

/* Which product pills to show (owner's rule: only products being worked on):
     • a date range is set → every product with orders in it, most orders first;
     • otherwise          → products with an order in the last 7 days, most
                            recently active first (old ones drop out by
                            themselves and return with their next order);
     • no server answer yet / older backend → the session's seen list;
   the selected product always stays so it can be cleared. */
export const visibleProductPills = (o: {
  active:   Record<string, number> | null;   // activeByShortName
  counts:   Record<string, number> | null;   // countsByShortName (this tab's scope)
  dateMode: boolean;
  seen:     string[];
  selected: string | null;
}): string[] => {
  let list: string[];
  if (o.dateMode && o.counts) {
    const c = o.counts;
    list = Object.keys(c).filter((k) => c[k] > 0).sort((a, b) => c[b] - c[a]);
  } else if (o.active) {
    const a = o.active;
    list = Object.keys(a).sort((x, y) => a[y] - a[x]);
  } else {
    list = o.seen;
  }
  if (o.selected && !list.includes(o.selected)) list = [o.selected, ...list];
  return list;
};

/* Page rows + the agent's pinned due callbacks (GET /orders ?pin_due), deduped. */
export const withPinned = (page: Order[], pinned?: Order[]) => {
  if (!pinned?.length) return page;
  const ids = new Set(page.map((o) => o.id));
  return [...page, ...pinned.filter((o) => !ids.has(o.id))];
};

/* Merge a freshly-fetched FIRST page (the 30 s background refresh) into the
   loaded rows without discarding rows appended by load-more: rows the server
   just returned replace their loaded counterparts (new + edited orders). A
   loaded row that falls INSIDE the window page 1 covers but was NOT returned
   has left this tab (shipped, changed by someone else …) — it is dropped;
   otherwise it lingered with its old status and the tab showed more rows than
   its count. Rows older than the window (appended pages) stay.
     page   — the server page alone (newest first: createdAt DESC, id DESC)
     pinned — her due callbacks (merged on top, never windowed)
     full   — page came back full (more rows exist beyond it); when false,
              page 1 IS the whole filter, so any other loaded row left it. */
export const mergeFirstPage = (prev: Order[], page: Order[], pinned: Order[] | undefined, full: boolean): Order[] => {
  const fresh = withPinned(page, pinned);
  const freshIds = new Set(fresh.map((o) => o.id));
  const last = page[page.length - 1];
  const lastTs = last ? new Date(last.createdAt).getTime() : NaN;
  const insideWindow = (o: Order) => {
    if (!full || !last || Number.isNaN(lastTs)) return true;
    const t = new Date(o.createdAt).getTime();
    return t > lastTs || (t === lastTs && o.id >= last.id);
  };
  return [...fresh, ...prev.filter((o) => !freshIds.has(o.id) && !insideWindow(o))];
};
