'use client';

import { useEffect, useLayoutEffect, useRef, TextareaHTMLAttributes } from 'react';

/* A text field that grows to show ALL of its text — for the phone order cards,
   where a long address or note in a one-line <input> is cut off and there is no
   hover to reveal it. It behaves like that input otherwise: Enter finishes
   editing (blur → the caller's onBlur saves), and pasted line breaks become
   spaces, as a one-line input would make them. */
export default function AutoGrowTextarea(
  { className = '', onPaste, onKeyDown, onInput, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'>,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  useLayoutEffect(fit);

  /* Re-fit when the width changes (rotation, sidebar) — the text re-wraps. */
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) { width = el.clientWidth; requestAnimationFrame(fit); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <textarea
      ref={ref}
      rows={1}
      {...rest}
      onInput={(e) => { fit(); onInput?.(e); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        onKeyDown?.(e);
      }}
      onPaste={(e) => {
        const text = e.clipboardData.getData('text');
        if (/\n/.test(text)) {
          e.preventDefault();
          const el = e.currentTarget;
          el.setRangeText(text.replace(/\s*\n\s*/g, ' '), el.selectionStart, el.selectionEnd, 'end');
          fit();
        }
        onPaste?.(e);
      }}
      className={`${className} block resize-none overflow-hidden leading-relaxed`}
    />
  );
}
