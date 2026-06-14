"use client";

// Shared top nav across every route (/, /dashboard, /summon). Mounted once in the
// root layout. Translucent + sticky so it reads cleanly over all three page
// backgrounds (splash .hc-root, dashboard .hc-dashboard, base body). Uses the
// global --color-* theme tokens (globals.css @theme), NOT the .hc-dashboard-scoped
// wash, so it themes consistently everywhere.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bee, cn } from "@/components/ui";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/summon", label: "Summon" },
] as const;

export default function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-edge bg-paper/75 backdrop-blur-md">
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-80">
          <Bee size={26} />
          <span className="text-lg font-semibold tracking-tight text-ink">Honeycomb</span>
        </Link>

        <div className="flex items-center gap-1 sm:gap-2">
          {LINKS.map(({ href, label }) => {
            // exact match for "/", prefix match for the others (so nested routes stay lit)
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-honey/15 text-gold"
                    : "text-ink-2 hover:bg-card-2 hover:text-ink-1",
                )}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
