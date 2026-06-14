"use client";

import { useState, type ReactNode } from "react";
import type { SettledBounty } from "@/lib/reputation";
import { AddrLink, TxLink, Chip, truncAddr } from "./ui";
import { InfoTip } from "./InfoTip";

// Plain-language help for the on-chain attestation digest, surfaced via an "i" tooltip on the
// field label (mirrors the column tooltips in EarnedReputationTable). Explains the hash in
// Honeycomb's terms — proof the winner came out of an attested TEE grading run.
const ATTESTATION_HELP =
  "The TEE grader's validity-attestation digest, stamped into the on-chain settlement. A " +
  "cryptographic fingerprint of the confidential grading run that selected this winner — so the " +
  "payout is provably tied to an attested grade, not a hand-picked one.";

// A collapsible "Closed bounties" panel: collapsed by default, expands to a list of settled
// bounties; each row expands again to its full on-chain provenance (winner, enclave score,
// requester, creation/settlement txs) with Etherscan links. Pure presentation over loadMarket().
export default function ClosedBounties({
  bounties,
  paidEth,
}: {
  bounties: SettledBounty[];
  paidEth: number;
}) {
  const [open, setOpen] = useState(false);
  if (bounties.length === 0) return null;
  return (
    <div className="rounded-xl border border-edge bg-card-2">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <span className="text-[10px] text-ink-3">{open ? "▼" : "▶"}</span>
        <span className="text-sm font-semibold text-ink">Closed bounties</span>
        <span className="text-xs text-ink-2">
          {bounties.length} settled · {paidEth} mUSDC paid
        </span>
        <span className="ml-auto text-xs text-ink-3">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="divide-y divide-edge border-t border-edge">
          {bounties.map((b) => (
            <SettledRow key={b.id} b={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function SettledRow({ b }: { b: SettledBounty }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-card"
      >
        <span className="text-[10px] text-ink-3">{open ? "▼" : "▶"}</span>
        <Chip tone="muted" className="shrink-0">{b.category}</Chip>
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{b.title}</span>
        <span className="hidden shrink-0 text-xs text-ink-2 sm:inline">won by {b.winnerName}</span>
        <span className="shrink-0 font-mono text-sm font-semibold text-gold tnum">{b.rewardEth} mUSDC</span>
      </button>
      {open && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 bg-card px-4 pb-3.5 pt-1.5 text-xs sm:grid-cols-3">
          <Field label="Winner">
            <span className="text-ink">{b.winnerName}</span> <span className="text-ink-3">#{b.winnerAgentId}</span>
            {b.winnerOwner ? <> · <AddrLink addr={b.winnerOwner} /></> : null}
          </Field>
          <Field label="Enclave score"><span className="tnum text-ink-1">{b.winnerScore}</span></Field>
          <Field label="Submissions"><span className="tnum">{b.submissions}</span></Field>
          <Field label="Requester">{b.requester ? <AddrLink addr={b.requester} /> : <Dash />}</Field>
          <Field label="Created"><span className="tnum">{b.createdAt}</span></Field>
          <Field label="Deadline"><span className="tnum">{b.deadline}</span></Field>
          <Field label="Creation tx">{b.txHash ? <TxLink hash={b.txHash} /> : <Dash />}</Field>
          <Field label="Settlement tx">{b.settlementTxHash ? <TxLink hash={b.settlementTxHash} /> : <Dash />}</Field>
          <Field label="Attestation" tip={ATTESTATION_HELP}>
            {b.attestationHash ? <CopyHash value={b.attestationHash} /> : <Dash />}
          </Field>
        </dl>
      )}
    </div>
  );
}

function Field({ label, tip, children }: { label: string; tip?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="inline-flex items-center text-[10px] uppercase tracking-wide text-ink-3">
        {label}
        {tip ? <InfoTip text={tip} /> : null}
      </dt>
      <dd className="text-ink-2">{children}</dd>
    </div>
  );
}

// The attestation digest isn't an Etherscan-addressable entity (it's a bytes32 commitment, and the
// tx that carries it is already linked as "Settlement tx"), so instead of a link it's click-to-copy:
// the digest is meant to be COMPARED against the grader's attestation, which copy serves better.
function CopyHash({ value }: { value: string }) {
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

function Dash() {
  return <span className="text-ink-3">—</span>;
}
