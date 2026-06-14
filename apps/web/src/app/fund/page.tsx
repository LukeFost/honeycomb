// /fund -- the x402 "fund a bounty with no ETH" page.
//
// Server component that mounts the FundBounty client panel (it needs
// window.ethereum + viem in-browser, so it carries "use client"). The panel
// drives create_bounty_draft -> in-browser EIP-3009 signTypedData ->
// finalize_bounty via the /api/fund route (which injects the API token
// server-side; the browser never holds it).
//
// Unlike /ops (the dev-only write console), this is a PUBLIC front door: any
// funder with a wallet can open a bounty here, including in the deployed
// dashboard. It is structurally disabled (503) in any environment where
// HONEYCOMB_API_TOKEN is unset, so it never runs half-wired.

import { Card, SectionLabel } from "@/components/ui";
import FundBounty from "@/components/FundBounty";

export const metadata = {
  title: "Fund a bounty",
  description:
    "Sign a gasless EIP-3009 USDC authorization to open a Honeycomb bounty. No ETH required.",
};

export default function FundPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <Card className="overflow-hidden border-honey/40">
        <div className="flex items-center justify-between border-b border-edge bg-honey/10 px-4 py-3">
          <SectionLabel>Fund a bounty — gasless (x402)</SectionLabel>
        </div>
        <div className="p-4">
          <FundBounty />
        </div>
      </Card>
    </main>
  );
}
