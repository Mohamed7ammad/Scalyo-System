'use client';

import { phoneCallTargets } from '@/lib/phone';

/* ════════════════════════════════════════════════════════════════════
   PhoneCall — a customer number with a call button next to it.
   On a phone, tapping the button opens the dialer with the number already
   filled in (the browser always leaves the final «اتصال» tap to the user —
   no website can place a call on its own). On a computer it opens the PC's
   calling app (e.g. Windows «Phone Link», which calls through the paired
   mobile). The number itself stays plain, selectable text.
   A field holding two numbers ("010…#011…") gets a button for each.
   ════════════════════════════════════════════════════════════════════ */

function CallLink({ href, number }: { href: string; number: string }) {
  return (
    <a
      href={href}
      onClick={(e) => e.stopPropagation()}
      title={`اتصال بـ ${number}`}
      aria-label={`اتصال بـ ${number}`}
      className="shrink-0 inline-flex items-center justify-center w-9 h-9 md:w-7 md:h-7 rounded-full
        bg-emerald-50 text-emerald-600 hover:bg-emerald-100 active:scale-95
        dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50
        focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 transition"
    >
      <svg className="w-4 h-4 md:w-3.5 md:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
      </svg>
    </a>
  );
}

export default function PhoneCall({ phone, className = '' }: {
  phone?: string | number | null;
  className?: string;
}) {
  const text = phone === null || phone === undefined ? '' : String(phone).trim();
  if (!text) return <span className="text-slate-300 dark:text-slate-600">—</span>;
  const targets = phoneCallTargets(text);

  /* Several numbers in one field → each on its own line with its own button. */
  if (targets.length > 1) {
    return (
      <span className={`inline-flex flex-col gap-1 ${className}`} dir="ltr" title={text}>
        {targets.map((t) => (
          <span key={t.href} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span>{t.number}</span>
            <CallLink href={t.href} number={t.number} />
          </span>
        ))}
      </span>
    );
  }

  /* The usual case: the number exactly as stored + one button. */
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${className}`} dir="ltr">
      <span className="inline-block max-w-[11rem] truncate align-middle" title={text}>{text}</span>
      {targets[0] && <CallLink href={targets[0].href} number={targets[0].number} />}
    </span>
  );
}
