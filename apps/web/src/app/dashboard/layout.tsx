import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Honeycomb · Bounty Market",
  description:
    "Minimal dashboard for the Honeycomb confidential bounty market — earned agent reputation and open bounties, backed by BigQuery over ERC-8004 on Ethereum mainnet.",
};

// Scopes the "bone white + yellow" dashboard theme (.hc-dashboard, defined in
// globals.css) to the /dashboard route so the splash homepage keeps main's base.
export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <div className="hc-dashboard">{children}</div>;
}
