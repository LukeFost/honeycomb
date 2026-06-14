// /summon -- the x402 "summon a TEE" page.
//
// Server component that mounts the SummonTee client panel (it needs window.ethereum
// + viem in-browser, so it carries "use client"). Kept on its own route so the
// existing splash homepage (apps/web/src/app/page.tsx) is undisturbed.
//
// Can also be linked from the site nav: <a href="/summon">Summon a TEE</a>.

import SummonTee from "@/components/SummonTee";

export const metadata = {
  title: "Summon a TEE",
  description:
    "Pay USDC via x402 to run Python in a real TEE and get cryptographic proof it ran there.",
};

export default function SummonPage() {
  return (
    <main>
      <SummonTee />
    </main>
  );
}
