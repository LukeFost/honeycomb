"use client";

// ============================================================================
// OpsConsole -- the local-dev WRITE panel for /ops.
//
// Mounted ONLY when the server page sees HONEYCOMB_DEV=1, so this never renders
// in the deployed (public) dashboard. Every action posts to /api/honeycomb/<route>,
// the server proxy that injects the write token (the browser never holds it).
//
// HONESTY (same rule as SummonTee): a non-2xx response is shown as a failure with
// the upstream error text. We never paint success for a request the API rejected.
// The marquee proof is /grade: a 200 carries score + attestationSource +
// signature, which we surface verbatim so the operator can see the enclave path.
// ============================================================================

import { useState } from "react";
import { Card, Chip, SectionLabel, cn } from "@/components/ui";

type RunState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "ok"; status: number; body: unknown }
  | { phase: "error"; status: number | null; message: string };

function readError(body: unknown): string {
  if (body && typeof body === "object") {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === "string") return e;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function postRoute(route: string, payload: unknown): Promise<RunState> {
  let res: Response;
  try {
    res = await fetch(`/api/honeycomb/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { phase: "error", status: null, message: e instanceof Error ? e.message : String(e) };
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    return { phase: "error", status: res.status, message: readError(body) };
  }
  return { phase: "ok", status: res.status, body };
}

export default function OpsConsole() {
  return (
    <Card className="overflow-hidden border-honey/40">
      <div className="flex items-center justify-between border-b border-edge bg-honey/10 px-4 py-3">
        <SectionLabel>Dev console — write</SectionLabel>
        <Chip tone="brand">local only</Chip>
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <GradeForm />
        <CreateBountyForm />
      </div>
    </Card>
  );
}

// --- /grade -----------------------------------------------------------------

function GradeForm() {
  const [submissionPath, setSubmissionPath] = useState("apps/grading-cre/grader/submissions/clean.py");
  const [bounty, setBounty] = useState("directional");
  const [jobId, setJobId] = useState("1");
  const [agentId, setAgentId] = useState("22");
  const [state, setState] = useState<RunState>({ phase: "idle" });

  async function run() {
    setState({ phase: "running" });
    setState(await postRoute("grade", { submissionPath, bounty, jobId, agentId }));
  }

  return (
    <div className="rounded-xl border border-edge bg-card-2 p-3">
      <div className="mb-2 text-sm font-semibold text-ink">Grade a submission</div>
      <Field label="submissionPath (repo-relative)">
        <input className={inputCls} value={submissionPath} onChange={(e) => setSubmissionPath(e.target.value)} />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="bounty">
          <select className={inputCls} value={bounty} onChange={(e) => setBounty(e.target.value)}>
            <option value="directional">directional</option>
            <option value="lp">lp</option>
          </select>
        </Field>
        <Field label="jobId">
          <input className={inputCls} value={jobId} onChange={(e) => setJobId(e.target.value)} />
        </Field>
        <Field label="agentId">
          <input className={inputCls} value={agentId} onChange={(e) => setAgentId(e.target.value)} />
        </Field>
      </div>
      <RunButton onClick={run} running={state.phase === "running"}>Grade</RunButton>
      <Result state={state} />
    </div>
  );
}

// --- /bounties --------------------------------------------------------------

function CreateBountyForm() {
  const [bountyDir, setBountyDir] = useState("apps/grading-cre/grader");
  const [rewardUSDC, setRewardUSDC] = useState("10");
  const [hoursToDeadline, setHoursToDeadline] = useState("24");
  const [state, setState] = useState<RunState>({ phase: "idle" });

  async function run() {
    setState({ phase: "running" });
    setState(
      await postRoute("bounties", {
        bountyDir,
        rewardUSDC: Number(rewardUSDC),
        hoursToDeadline: Number(hoursToDeadline),
      }),
    );
  }

  return (
    <div className="rounded-xl border border-edge bg-card-2 p-3">
      <div className="mb-2 text-sm font-semibold text-ink">Open a bounty</div>
      <Field label="bountyDir (repo-relative)">
        <input className={inputCls} value={bountyDir} onChange={(e) => setBountyDir(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="rewardUSDC">
          <input className={inputCls} value={rewardUSDC} onChange={(e) => setRewardUSDC(e.target.value)} />
        </Field>
        <Field label="hoursToDeadline">
          <input className={inputCls} value={hoursToDeadline} onChange={(e) => setHoursToDeadline(e.target.value)} />
        </Field>
      </div>
      <RunButton onClick={run} running={state.phase === "running"}>Create + fund (broadcasts)</RunButton>
      <Result state={state} />
    </div>
  );
}

// --- shared bits ------------------------------------------------------------

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

function RunButton({
  onClick,
  running,
  children,
}: {
  onClick: () => void;
  running: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running}
      className={cn(
        "mt-1 w-full rounded-md px-3 py-2 text-sm font-semibold transition-colors",
        running
          ? "cursor-wait bg-card-2 text-ink-3"
          : "bg-honey text-cocoa hover:bg-honey-bright",
      )}
    >
      {running ? "Running…" : children}
    </button>
  );
}

function Result({ state }: { state: RunState }) {
  if (state.phase === "idle" || state.phase === "running") return null;

  if (state.phase === "error") {
    return (
      <div className="mt-3 rounded-md border border-sybil/40 bg-sybil/10 p-2 text-xs text-sybil">
        <div className="font-semibold">
          Failed{state.status != null ? ` (HTTP ${state.status})` : ""}
        </div>
        <div className="mt-1 break-words font-mono">{state.message}</div>
      </div>
    );
  }

  // success: show a compact summary + the raw JSON for auditing.
  const b = state.body as Record<string, unknown> | null;
  const score = b?.score;
  const src = b?.attestationSource;
  const signer = b?.signer;
  return (
    <div className="mt-3 rounded-md border border-organic/40 bg-organic/10 p-2 text-xs text-ink-1">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Chip tone="organic">HTTP {state.status}</Chip>
        {score != null && <Chip tone="honey">score {String(score)}</Chip>}
        {typeof src === "string" && <Chip tone="brand">{src}</Chip>}
        {typeof signer === "string" && (
          <span className="font-mono text-[10px] text-ink-2">signer {signer.slice(0, 10)}…</span>
        )}
      </div>
      <pre className="max-h-64 overflow-auto rounded bg-paper-2 p-2 font-mono text-[10px] leading-relaxed text-ink-1">
        {JSON.stringify(state.body, null, 2)}
      </pre>
    </div>
  );
}
