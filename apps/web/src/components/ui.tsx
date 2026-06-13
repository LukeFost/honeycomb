import type { ReactNode } from "react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function truncAddr(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** The honeycomb mark: a honey hexagon with a smaller hex cut out. */
export function Hex({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="hc-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffcf4d" />
          <stop offset="100%" stopColor="#f5b301" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.5l9.1 5.25v10.5L12 22.5 2.9 17.25V6.75z"
        fill="url(#hc-grad)"
      />
      <path
        d="M12 6.4l4.85 2.8v5.6L12 17.6 7.15 14.8V9.2z"
        fill="#0a0a0b"
      />
    </svg>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-edge bg-panel/60 backdrop-blur-sm",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_20px_40px_-24px_rgba(0,0,0,0.8)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Chip({
  children,
  tone = "default",
  className,
}: {
  children: ReactNode;
  tone?: "default" | "honey" | "organic" | "sybil" | "muted";
  className?: string;
}) {
  const tones: Record<string, string> = {
    default: "border-edge bg-white/[0.03] text-zinc-300",
    honey: "border-honey/30 bg-honey/10 text-honey-bright",
    organic: "border-organic/30 bg-organic/10 text-organic",
    sybil: "border-sybil/30 bg-sybil/10 text-sybil",
    muted: "border-edge bg-white/[0.02] text-zinc-500",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-honey/80">
      {children}
    </div>
  );
}
