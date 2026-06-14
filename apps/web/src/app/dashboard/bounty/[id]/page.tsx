import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadMarket } from "@/lib/reputation";
import { AddrLink, TxLink, Card, Chip } from "@/components/ui";
import { InfoTip } from "@/components/InfoTip";
import { CopyHash } from "@/components/CopyHash";
import BountyLeaderboard from "@/components/BountyLeaderboard";

export const dynamic = "force-dynamic";

// Plain-language help for the attestation digest (mirrors the Closed-bounties panel).
const ATTESTATION_HELP =
  "The TEE grader's validity-attestation digest, stamped into the on-chain settlement. A " +
  "cryptographic fingerprint of the confidential grading run that selected this winner — so the " +
  "payout is provably tied to an attested grade, not a hand-picked one.";

export default async function BountyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bountyId = Number(id);

  // Same source as the dashboard: the live BigQuery-backed market (our db).
  const market = await loadMarket();
  const bounty = market.bounties.find((b) => b.id === bountyId);
  if (!bounty) notFound();

  const settled =
    bounty.status === "settled" ? market.settledBounties.find((b) => b.id === bountyId) : undefined;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 text-sm text-ink-2 transition-colors hover:text-ink"
      >
        ← Back to dashboard
      </Link>

      <div className="mb-1 mt-5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-ink-3 tnum">Bounty #{bounty.id}</span>
        <Chip tone="muted">{bounty.category}</Chip>
        <Chip tone={settled ? "organic" : "honey"}>{settled ? "Settled" : "Open"}</Chip>
      </div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-ink">{bounty.title}</h1>

      {/* ---- Job details ---- */}
      <Card className="mb-6 p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-3">Job details</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
          <Field label="Status">
            <span className={settled ? "text-organic" : "text-gold"}>{settled ? "Settled" : "Open"}</span>
          </Field>
          <Field label="Reward">
            <span className="font-mono font-semibold tnum text-gold">{bounty.rewardEth} mUSDC</span>
          </Field>
          <Field label="Submissions"><span className="tnum text-ink-1">{bounty.submissions}</span></Field>
          <Field label="Requester">{bounty.requester ? <AddrLink addr={bounty.requester} /> : <Dash />}</Field>
          <Field label="Created"><span className="tnum">{bounty.createdAt}</span></Field>
          <Field label="Deadline"><span className="tnum">{bounty.deadline}</span></Field>
          <Field label="Creation tx">{bounty.txHash ? <TxLink hash={bounty.txHash} /> : <Dash />}</Field>
          {settled && (
            <>
              <Field label="Winner">
                <span className="text-ink">{settled.winnerName}</span>{" "}
                <span className="text-ink-3">#{settled.winnerAgentId}</span>
                {settled.winnerOwner ? <> · <AddrLink addr={settled.winnerOwner} /></> : null}
              </Field>
              <Field label="Enclave score"><span className="tnum text-ink-1">{settled.winnerScore}</span></Field>
              <Field label="Settlement tx">{settled.settlementTxHash ? <TxLink hash={settled.settlementTxHash} /> : <Dash />}</Field>
              <Field label="Attestation" tip={ATTESTATION_HELP}>
                {settled.attestationHash ? <CopyHash value={settled.attestationHash} /> : <Dash />}
              </Field>
            </>
          )}
        </dl>
      </Card>

      {/* ---- Leaderboard ---- */}
      <Card className="p-5">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Leaderboard</h2>
        {settled ? (
          <BountyLeaderboard agents={market.agents} winnerAgentId={settled.winnerAgentId} scores={settled.scores} />
        ) : (
          <p className="mt-2 text-sm text-ink-2">
            The leaderboard isn&apos;t available until the bounty is closed.
          </p>
        )}
      </Card>
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

function Dash() {
  return <span className="text-ink-3">—</span>;
}
