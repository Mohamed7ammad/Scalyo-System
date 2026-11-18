'use client';

import { useEffect, useState } from 'react';

/* True below Tailwind's `md` breakpoint (phones). SSR-safe: false on the server
   and on the first client render, then follows the media query — the orders
   page shows a skeleton until its data arrives, so the switch is invisible. */
export function useIsMobile(query = '(max-width: 767px)'): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return isMobile;
}
