/* ── Server clock ──────────────────────────────────────────────────────────────
   A phone's own clock can be wrong: one agent's phone ran ~12 hours behind, so
   every new order looked 12 hours in the future and stayed locked in the
   15-minute wait (and «منذ …» labels lied). Anything time-based on screen uses
   serverNow(): the device clock corrected by the offset measured against the
   server's time on every heartbeat (sent on load, on focus and every ~90 s). */

let offsetMs = 0;
const KEY = 'serverClockOffsetMs';
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  try {
    const saved = Number(sessionStorage.getItem(KEY));
    if (Number.isFinite(saved)) offsetMs = saved;
  } catch { /* storage blocked — start at 0 until the first heartbeat */ }
}

/** Record the server's time from a response (`sentAt`/`receivedAt` = device ms
 *  around the request, so half the round trip is taken off). */
export function noteServerTime(serverIso: string | undefined, sentAt: number, receivedAt: number): void {
  const server = serverIso ? Date.parse(serverIso) : NaN;
  if (!Number.isFinite(server)) return;
  const next = Math.round(server - (sentAt + receivedAt) / 2);
  if (Math.abs(next - offsetMs) < 3000) return;   // network jitter — keep the current offset
  offsetMs = next;
  try { sessionStorage.setItem(KEY, String(next)); } catch { /* fine */ }
  listeners.forEach((fn) => fn());
}

/** "Now" by the server's clock, in ms. */
export const serverNow = (): number => Date.now() + offsetMs;

/** How far the device clock is off, in ms (for diagnostics). */
export const clockOffsetMs = (): number => offsetMs;

/** Call `fn` whenever the measured offset changes; returns an unsubscribe. */
export function onServerClockChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
