import type { ReactNode } from "react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function truncAddr(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** A truncated wallet address linking to its Etherscan page. The link is meaningful on the
 *  live-mainnet path; in the local demo the address still distinguishes agents even though
 *  Etherscan won't have it. Renders nothing for an empty address. */
export function AddrLink({ addr, className }: { addr: string; className?: string }) {
  if (!addr) return null;
  return (
    <a
      href={`https://etherscan.io/address/${addr}`}
      target="_blank"
      rel="noopener noreferrer"
      title={addr}
      className={cn("transition-colors hover:text-gold hover:underline", className)}
    >
      {truncAddr(addr)}
    </a>
  );
}

/** A truncated transaction hash linking to its Etherscan tx page. Same demo caveat as AddrLink —
 *  resolves for real escrow txs; the demo's mock tx hashes won't exist on Etherscan. */
export function TxLink({ hash, className }: { hash: string; className?: string }) {
  if (!hash) return null;
  return (
    <a
      href={`https://etherscan.io/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      title={hash}
      className={cn("font-mono transition-colors hover:text-gold hover:underline", className)}
    >
      {truncAddr(hash)}
    </a>
  );
}

/** The honeycomb mark: a honey hexagon with a smaller hex cut out (cutout shows the paper). */
export function Hex({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="hc-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffc62b" />
          <stop offset="100%" stopColor="#f5b301" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.5l9.1 5.25v10.5L12 22.5 2.9 17.25V6.75z"
        fill="url(#hc-grad)"
      />
      <path
        d="M12 6.4l4.85 2.8v5.6L12 17.6 7.15 14.8V9.2z"
        fill="#f1ecdf"
      />
    </svg>
  );
}

/** The Honeycomb bee mark — a honeycomb-hexagon body with stripes, eyes, and wings, matching the
 *  vector bee animated on the splash page (app/components/BeeScene.tsx): amber body (#EFA92E),
 *  dark detail (#23262d). Drop-in replacement for <Hex /> as the brand logo. */
export function Bee({ size = 28 }: { size?: number }) {
  const body = "24,16 20,22.93 12,22.93 8,16 12,9.07 20,9.07";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <clipPath id="hc-bee-body">
          <polygon points={body} />
        </clipPath>
      </defs>
      {/* wings (behind the body) */}
      <g fill="rgba(35,38,45,0.05)" stroke="rgba(35,38,45,0.45)" strokeWidth={0.7}>
        <ellipse cx="5.76" cy="-1.76" rx="4.96" ry="2.24" transform="translate(19.36 15.68) rotate(3.4)" />
        <ellipse cx="-5.76" cy="-1.76" rx="4.96" ry="2.24" transform="translate(12.64 15.68) rotate(-3.4)" />
      </g>
      {/* hexagon body */}
      <polygon points={body} fill="#EFA92E" stroke="#23262d" strokeWidth={1.12} strokeLinejoin="round" />
      {/* stripes, clipped to the body */}
      <g clipPath="url(#hc-bee-body)" fill="#23262d">
        <rect x="8" y="16.96" width="16" height="1.6" />
        <rect x="8" y="19.76" width="16" height="1.6" />
      </g>
      {/* eyes */}
      <g fill="#23262d">
        <circle cx="13.6" cy="12.64" r="0.9" />
        <circle cx="18.4" cy="12.64" r="0.9" />
      </g>
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
        "rounded-2xl border border-edge bg-card shadow-card",
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
  tone?: "default" | "brand" | "honey" | "organic" | "sybil" | "muted";
  className?: string;
}) {
  const tones: Record<string, string> = {
    default: "border-edge-2 bg-card-2 text-ink-1",
    brand: "border-honey/60 bg-honey text-cocoa font-semibold",
    honey: "border-gold/40 bg-honey/15 text-gold",
    organic: "border-organic/30 bg-organic/10 text-organic",
    sybil: "border-sybil/30 bg-sybil/10 text-sybil",
    muted: "border-edge bg-transparent text-ink-2",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
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
    <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold">
      {children}
    </div>
  );
}
