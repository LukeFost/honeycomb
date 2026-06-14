"use client";

import { useState } from "react";
import { truncAddr } from "./ui";

// The attestation digest isn't an Etherscan-addressable entity (it's a bytes32 commitment, and the
// tx that carries it is already linked as "Settlement tx"), so instead of a link it's click-to-copy:
// the digest is meant to be COMPARED against the grader's attestation, which copy serves better.
// Shared by the Closed-bounties panel and the bounty detail page.
export function CopyHash({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    const done = navigator.clipboard?.writeText(value);
    if (!done) return;
    done.then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      aria-label={`Copy attestation hash ${value}`}
      className="group inline-flex items-center gap-1 font-mono text-ink-3 transition-colors hover:text-gold"
    >
      {truncAddr(value)}
      {copied ? (
        <span className="text-[0.85em] text-gold">copied</span>
      ) : (
        <svg
          aria-hidden
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          className="opacity-70 transition-opacity group-hover:opacity-100"
        >
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
