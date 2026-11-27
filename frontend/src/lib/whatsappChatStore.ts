'use client';

/* Which of my orders have a WhatsApp conversation, how many customer messages I
   have not opened, and which chat is open right now.

   A tiny module-level store read with useSyncExternalStore, so:
     · the orders list is NOT touched — no new column, no heavier query; one
       light request every 30 s while the page is visible;
     · a row re-renders only when ITS OWN entry changes (the memoised OrderRow
       stays as cheap as it was). */

import { useSyncExternalStore } from 'react';
import { getWhatsAppInbox, type WhatsAppInboxItem } from '@/lib/api';

const POLL_MS = 30_000;

let byOrder = new Map<number, WhatsAppInboxItem>();
let list: WhatsAppInboxItem[] = [];
let openId: number | null = null;
let stopped = false;                 // the server said this account has no business here → stop asking
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let lastAsked = 0;                   // the list remounts its rows often: that must not mean a request each time
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const same = (a: WhatsAppInboxItem | undefined, b: WhatsAppInboxItem) =>
  !!a && a.unread === b.unread && a.last_in_at === b.last_in_at && a.name === b.name && a.tag === b.tag;

function apply(items: WhatsAppInboxItem[]) {
  let changed = items.length !== list.length;
  const next = new Map<number, WhatsAppInboxItem>();
  for (const it of items) {
    const old = byOrder.get(it.order_id);
    if (same(old, it)) next.set(it.order_id, old as WhatsAppInboxItem);     // keep the reference → that row does not re-render
    else { next.set(it.order_id, it); changed = true; }
  }
  if (!changed) return;
  byOrder = next;
  list = items.map((it) => next.get(it.order_id) as WhatsAppInboxItem);
  emit();
}

export async function refreshInbox() {
  if (stopped || inFlight) return;
  inFlight = true;
  lastAsked = Date.now();
  try {
    const { data } = await getWhatsAppInbox();
    apply(data.items || []);
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403 || status === 404) stopped = true;
  } finally {
    inFlight = false;
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1 && typeof window !== 'undefined') {
    if (Date.now() - lastAsked > POLL_MS) refreshInbox();
    timer = setInterval(() => { if (document.visibilityState === 'visible') refreshInbox(); }, POLL_MS);
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; }
  };
}

/* I have read this conversation: the badge goes now, the server learns it from the chat request. */
export function markRead(orderId: number) {
  const cur = byOrder.get(orderId);
  if (!cur || cur.unread === 0) return;
  const next = { ...cur, unread: 0 };
  byOrder = new Map(byOrder).set(orderId, next);
  list = list.map((it) => (it.order_id === orderId ? next : it));
  emit();
}

export function openChat(orderId: number) { if (openId !== orderId) { openId = orderId; emit(); } }
export function closeChat() { if (openId !== null) { openId = null; emit(); refreshInbox(); } }

const none = () => undefined;
const nil = () => null;
const empty: WhatsAppInboxItem[] = [];

export const useChatEntry = (orderId: number) =>
  useSyncExternalStore(subscribe, () => byOrder.get(orderId), none);
export const useOpenChat = () => useSyncExternalStore(subscribe, () => openId, nil);
export const useChatInbox = () => useSyncExternalStore(subscribe, () => list, () => empty);
