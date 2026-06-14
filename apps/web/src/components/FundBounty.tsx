"use client";

// ============================================================================
// FundBounty -- the funder-facing "fund a bounty with no ETH" panel (x402).
//
// FLOW (draft -> sign -> finalize), all in the browser, mirroring SummonTee:
//   1. Funder fills in the bounty shape (dir, reward, deadline), clicks Fund.
//   2. POST /api/fund { stage: "draft", ...shape }. The server forwards
//      create_bounty_draft and returns the 402-challenge: { draftId, typedData,
//      authorizationTemplate, accepts, bounty, chainId, payTo }. The typedData is
//      the EXACT EIP-712 TransferWithAuthorization to sign -- the server already
//      built the domain/types/message, so we do NOT re-derive it here.
//   3. We connect the wallet (window.ethereum via viem custom transport), enforce
//      the chain, and signTypedData(draft.typedData) -- but with message.from set
//      to the funder's address (the template ships from = address(0) as a "fill
//      me" marker). Everything else stays verbatim so the signature matches what
//      the facilitator re-verifies.
//   4. POST /api/fund { stage: "finalize", draftId, signature, authorization }.
//      The server forwards finalize_bounty: the facilitator settles the signed
//      EIP-3009 (relayer pays gas, funder USDC -> custodial wallet) THEN opens the
//      bounty on-chain. Returns { jobId, settlementTx, createTx, ... }.
//
// Honesty rule (same as SummonTee/OpsConsole): a non-2xx is shown as a failure
// with the upstream error verbatim. A settle-but-create-failed state surfaces the
// settlementTx and the "funds in custodial wallet, bounty NOT open" reconcile
// message from finalize_bounty -- we never paint a funded bounty that isn't open.
// ============================================================================

import { useState } from "react";
import {
  createWalletClient,
  custom,
  getAddress,
  numberToHex,
  type Address,
  type Hex,
} from "viem";
import { cn, truncAddr } from "@/components/ui";

// ---- types mirroring the draft / finalize tool returns ----------------------

type AuthorizationTemplate = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

type TypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

type Draft = {
  draftId: string;
  expiresAtISO: string;
  network: string;
  accepts: unknown[];
  typedData: TypedData;
  authorizationTemplate: AuthorizationTemplate;
  bounty: {
    rewardUSDC: number;
    budget: string;
    deadlineISO: string;
    testsHash: string;
    specCid: string;
  };
  token: Address;
  tokenName: string;
  tokenVersion: string;
  chainId: number;
  payTo: Address;
};

type Phase =
  | { kind: "idle" }
  | { kind: "drafting" }
  | { kind: "signing"; draft: Draft }
  | { kind: "finalizing"; draft: Draft }
  | { kind: "done"; receipt: Record<string, unknown> }
  | { kind: "error"; message: string; status?: number };

// ---- block explorers (same map shape as SummonTee) --------------------------

const EXPLORERS: Record<number, (h: string) => string> = {
  1: (h) => `https://etherscan.io/tx/${h}`,
  11155111: (h) => `https://sepolia.etherscan.io/tx/${h}`,
};
function explorerTxUrl(chainId: number, hash: string): string | null {
  return EXPLORERS[chainId]?.(hash) ?? null;
}

// ---- the eip-1193 provider, typed loosely (same as SummonTee) ---------------

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
function getProvider(): Eip1193 {
  const w = window as unknown as { ethereum?: Eip1193 };
  if (!w.ethereum) {
    throw new Error("no wallet found: install MetaMask (or any EIP-1193 wallet) to fund a bounty");
  }
  return w.ethereum;
}

async function postFund(payload: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch("/api/fund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  return { status: res.status, json };
}

function readErr(json: any, fallback: string): string {
  if (json && typeof json === "object" && typeof json.error === "string") return json.error;
  return fallback;
}

export default function FundBounty() {
  const [bountyDir, setBountyDir] = useState("apps/grading-cre/grader");
  const [rewardUSDC, setRewardUSDC] = useState("10");
  const [hoursToDeadline, setHoursToDeadline] = useState("24");
  const [specCid, setSpecCid] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const busy =
    phase.kind === "drafting" || phase.kind === "signing" || phase.kind === "finalizing";

  async function run() {
    try {
      // --- 1. DRAFT: get the 402-challenge + ready-to-sign typedData ----------
      setPhase({ kind: "drafting" });
      const draftBody: Record<string, unknown> = {
        stage: "draft",
        bountyDir,
        rewardUSDC: Number(rewardUSDC),
        hoursToDeadline: Number(hoursToDeadline),
      };
      // specCid is optional: when set it skips the GCS spec upload (which needs the
      // owner SA). Leave blank to let the server resolve/upload the spec.
      if (specCid.trim()) draftBody.specCid = specCid.trim();

      const d = await postFund(draftBody);
      if (d.status !== 200) {
        setPhase({ kind: "error", status: d.status, message: readErr(d.json, "draft failed") });
        return;
      }
      const draft = d.json as Draft;

      // --- 2. SIGN: connect wallet, enforce chain, sign the draft's typedData --
      setPhase({ kind: "signing", draft });
      const provider = getProvider();
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts?.length) throw new Error("wallet returned no account");
      const from = getAddress(accounts[0]);

      const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
      if (Number(chainIdHex) !== draft.chainId) {
        // Ask the wallet to switch to the funding chain. If the chain is unknown to
        // the wallet this throws; surface it rather than signing on the wrong chain.
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: numberToHex(draft.chainId) }],
        });
      }

      // The template ships from = address(0); the funder fills their own address.
      // Every other field stays verbatim so the signature matches the draft.
      const authorization: AuthorizationTemplate = {
        ...draft.authorizationTemplate,
        from,
      };
      const message = { ...draft.typedData.message, from };

      const walletClient = createWalletClient({ account: from, transport: custom(provider) });
      // signTypedData's params are a heavily-overloaded generic; the draft already
      // carries a fully-formed, on-chain-verified EIP-712 payload, so we hand it the
      // whole object cast once (per-field `as never` casts collapse the overload to
      // `never` and break inference). The runtime shape is exactly what viem expects.
      const signature = (await walletClient.signTypedData({
        account: from,
        domain: draft.typedData.domain,
        types: draft.typedData.types,
        primaryType: draft.typedData.primaryType,
        message,
      } as Parameters<typeof walletClient.signTypedData>[0])) as Hex;

      // --- 3. FINALIZE: settle (gasless) + open the bounty on-chain -----------
      setPhase({ kind: "finalizing", draft });
      const f = await postFund({
        stage: "finalize",
        draftId: draft.draftId,
        signature,
        authorization,
      });
      if (f.status !== 200) {
        setPhase({ kind: "error", status: f.status, message: readErr(f.json, "finalize failed") });
        return;
      }
      setPhase({ kind: "done", receipt: f.json as Record<string, unknown> });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-card-2 p-3">
      <div className="mb-2 text-sm font-semibold text-ink">Fund a bounty (gasless)</div>
      <p className="mb-3 text-[11px] leading-relaxed text-ink-3">
        Sign an EIP-3009 USDC authorization in your wallet. No ETH needed: the relayer
        pays gas, your USDC funds the bounty, and it opens on-chain in one step.
      </p>

      <Field label="bountyDir (repo-relative)">
        <input className={inputCls} value={bountyDir} onChange={(e) => setBountyDir(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="rewardUSDC">
          <input className={inputCls} value={rewardUSDC} onChange={(e) => setRewardUSDC(e.target.value)} />
        </Field>
        <Field label="hoursToDeadline">
          <input
            className={inputCls}
            value={hoursToDeadline}
            onChange={(e) => setHoursToDeadline(e.target.value)}
          />
        </Field>
      </div>
      <Field label="specCid (optional — skips spec upload)">
        <input
          className={inputCls}
          value={specCid}
          placeholder="honeycomb://… or leave blank"
          onChange={(e) => setSpecCid(e.target.value)}
        />
      </Field>

      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={cn(
          "mt-1 w-full rounded-md px-3 py-2 text-sm font-semibold transition-colors",
          busy ? "cursor-wait bg-card-2 text-ink-3" : "bg-honey text-cocoa hover:bg-honey-bright",
        )}
      >
        {phase.kind === "drafting" && "Drafting…"}
        {phase.kind === "signing" && "Sign in your wallet…"}
        {phase.kind === "finalizing" && "Settling + opening bounty…"}
        {(phase.kind === "idle" || phase.kind === "done" || phase.kind === "error") &&
          "Fund bounty (sign, no ETH)"}
      </button>

      <FundResult phase={phase} />
    </div>
  );
}

function FundResult({ phase }: { phase: Phase }) {
  if (phase.kind === "error") {
    return (
      <div className="mt-3 rounded-md border border-sybil/40 bg-sybil/10 p-2 text-xs text-sybil">
        <div className="font-semibold">
          Failed{phase.status != null ? ` (HTTP ${phase.status})` : ""}
        </div>
        <div className="mt-1 break-words font-mono">{phase.message}</div>
      </div>
    );
  }
  if (phase.kind !== "done") return null;

  const r = phase.receipt;
  const jobId = r.jobId as string | number | undefined;
  const settlementTx = r.settlementTx as string | undefined;
  const createTx = (r.createTx ?? r.createBountyTx) as string | undefined;
  const funder = r.funder as string | undefined;
  const chainId = Number(r.chainId ?? 0);

  return (
    <div className="mt-3 rounded-md border border-organic/40 bg-organic/10 p-2 text-xs text-ink-1">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="rounded bg-organic/20 px-1.5 py-0.5 font-semibold text-organic">
          Bounty funded
        </span>
        {jobId != null && (
          <span className="font-mono text-ink-2">job #{String(jobId)}</span>
        )}
        {funder && <span className="font-mono text-[10px] text-ink-3">by {truncAddr(funder)}</span>}
      </div>
      <div className="space-y-0.5 font-mono text-[10px] text-ink-2">
        {settlementTx && <TxLine label="settle" hash={settlementTx} chainId={chainId} />}
        {createTx && <TxLine label="create" hash={createTx} chainId={chainId} />}
      </div>
      <pre className="mt-2 max-h-64 overflow-auto rounded bg-paper-2 p-2 font-mono text-[10px] leading-relaxed text-ink-1">
        {JSON.stringify(phase.receipt, null, 2)}
      </pre>
    </div>
  );
}

function TxLine({ label, hash, chainId }: { label: string; hash: string; chainId: number }) {
  const url = explorerTxUrl(chainId, hash);
  return (
    <div>
      <span className="text-ink-3">{label}: </span>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="text-honey hover:underline">
          {hash.slice(0, 18)}…
        </a>
      ) : (
        <span>{hash.slice(0, 18)}…</span>
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-edge bg-card px-2 py-1.5 font-mono text-xs text-ink-1 outline-none focus:border-gold";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-3">{label}</span>
      {children}
    </label>
  );
}
