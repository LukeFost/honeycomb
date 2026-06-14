"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const TIP_WIDTH = 240; // px — matches the rendered bubble width

/** A small "i" affordance that reveals a tooltip on hover or keyboard focus, used to explain
 *  non-obvious table headers. The bubble is portaled to <body> with fixed positioning and
 *  centered under the dot (clamped to the viewport), so every header behaves identically and
 *  the tooltip never clips — even inside the table's scroll container. `text` may be rich
 *  content; pass `label` to supply the accessible string when it isn't plain text. */
export function InfoTip({ text, label }: { text: ReactNode; label?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const aria = label ?? (typeof text === "string" ? text : undefined);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(r.left + r.width / 2 - TIP_WIDTH / 2, window.innerWidth - TIP_WIDTH - 8),
    );
    setPos({ top: r.bottom + 6, left });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  return (
    <span
      ref={ref}
      tabIndex={0}
      role="button"
      aria-label={aria}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className="ml-1 inline-flex h-3.5 w-3.5 cursor-help select-none items-center justify-center rounded-full border border-edge-2 text-[9px] font-bold normal-case text-ink-3 transition-colors hover:border-gold/60 hover:text-gold focus:border-gold/60 focus:text-gold focus:outline-none"
    >
      i
      {pos &&
        createPortal(
          <span
            role="tooltip"
            style={{ top: pos.top, left: pos.left, width: TIP_WIDTH }}
            className="pointer-events-none fixed z-50 rounded-lg border border-edge-2 bg-card-2 p-2.5 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-ink-1 shadow-card"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
