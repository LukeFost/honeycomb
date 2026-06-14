import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadMarket } from "@/lib/reputation";
import { apiGet } from "@/lib/honeycomb";
import { AddrLink, TxLink, Card, Chip } from "@/components/ui";
import { InfoTip } from "@/components/InfoTip";
import { CopyHash } from "@/components/CopyHash";
import BountyLeaderboard from "@/components/BountyLeaderboard";

export const dynamic = "force-dynamic";

// The bounty's PUBLIC spec is the off-chain markdown an agent reads to decide
// whether to compete. It lives in GCS (gcs://honeycomb-specs/<sha256>); the
// on-chain job carries only the specCid pointer. honeycomb-api exposes two
// read routes for it: GET /jobs/{id} -> { specCid }, GET /spec?cid -> { content }.
// We resolve both here, server-side (apiGet is unauthenticated + throws loud).
//
// This is best-effort and MUST NOT 500 the page: the rest of the detail view is
// driven by BigQuery (loadMarket) and renders fine without the spec. The deployed
// dashboard reads a MAINNET escrow while the API serves Sepolia jobs, so a given
// bounty id may legitimately have no matching job/spec on the API. We catch,
// log to server stderr, and surface a visible "unavailable" state in the UI
// rather than hide the section silently.
type SpecResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

async function fetchSpec(jobId: number): Promise<SpecResult> {
  try {
    const job = await apiGet<{ specCid?: string }>(`/jobs/${jobId}`);
    const cid = job.specCid?.trim();
    if (!cid) return { ok: false, reason: "This bounty has no published spec." };
    const spec = await apiGet<{ resolved?: boolean; content?: string }>(
      `/spec?cid=${encodeURIComponent(cid)}`,
    );
    if (!spec.resolved || !spec.content) {
      return { ok: false, reason: "The spec pointer did not resolve to any content." };
    }
    return { ok: true, content: spec.content };
  } catch (e) {
    // Loud on the server; soft in the UI. A spec fetch failure is never fatal.
    console.error(`[bounty ${jobId}] spec fetch failed:`, e instanceof Error ? e.message : e);
    return { ok: false, reason: "The spec could not be loaded from the content layer." };
  }
}

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

  // Resolve the bounty's public spec markdown from the GCS content layer (best-effort).
  const spec = await fetchSpec(bountyId);

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

      {/* ---- Spec (public off-chain markdown from the GCS content layer) ---- */}
      <Card className="mb-6 p-5">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
          Spec
          <InfoTip text="The bounty's public task description, stored off-chain in the GCS content layer (gcs://honeycomb-specs/<sha256>). The on-chain job carries only the content hash; this is the markdown it resolves to." />
        </h2>
        {spec.ok ? (
          <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/20 p-4 font-mono text-[13px] leading-relaxed text-ink-1">
            {spec.content}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-ink-2">{spec.reason}</p>
        )}
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
