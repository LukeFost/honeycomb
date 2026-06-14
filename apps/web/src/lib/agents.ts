// ============================================================================
// Per-agent dashboard data layer (server-only).
//
// Splits across the two sources, exactly as decided:
//   - TASKS / ACTIVITY ("what I'm working on", "what I've done")  -> Neon
//     (grades + events + tool_calls, filtered by agent_id). Written by the MCP.
//   - MONEY EARNED  -> honeycomb-api live chain (the objective onchain truth:
//     settled bounties this agent won). NOT self-reported by the agent.
//
// Every query degrades safely: if Neon is unconfigured (no DATABASE_URL) the
// agent lists come back empty rather than throwing, and the page says so. The
// earnings leg uses apiGet, which throws loudly -- the page wraps it.
// ============================================================================

import { dbEnabled, sql } from "@/lib/neon";
import { apiGet } from "@/lib/honeycomb";

// --- row types (mirror schema.sql) ------------------------------------------

export type AgentSummary = {
  agentId: string;
  gradeCount: number;
  bestScore: number | null;
  lastSeen: string | null;
};

export type GradeRow = {
  jobId: string | null;
  bounty: string | null;
  score: number | null;
  valid: boolean | null;
  attestationSource: string | null;
  signer: string | null;
  gradedAt: string;
};

export type ActivityRow = {
  tool: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  calledAt: string;
};

export type WonJob = {
  jobId: string;
  rewardUSDC: number;
  status: string;
  settled: boolean;
};

export type AgentEarnings = {
  settledUSDC: number; // paid out (settled jobs this agent won)
  pendingUSDC: number; // leading but not yet settled
  jobsWon: WonJob[];
  source: "honeycomb-api";
};

// --- roster: every agent the MCP has actually interacted with ----------------
//
// This is the "agents-neon" roster: the population the MCP has SEEN, drawn from
// both Neon agent-keyed tables -- tool_calls (any interaction, incl. register)
// and grades (graded work). Distinct from the chain-registry roster served by
// /api/agents (ERC-8004 trust directory from BigQuery): that is "who is registered
// on-chain / is it sybil", this is "who has the MCP touched, and what have they done".
// We keep both and label the difference, per the product decision.
export async function listAgents(): Promise<AgentSummary[]> {
  if (!dbEnabled()) return [];
  const q = sql();
  // Union the two agent-keyed sources, then fold to one row per agent: grade
  // stats come from grades, "last seen" is the latest of either table.
  const rows = (await q`
    WITH seen AS (
      SELECT agent_id, called_at AS at, NULL::int AS score FROM tool_calls WHERE agent_id IS NOT NULL
      UNION ALL
      SELECT agent_id, graded_at AS at, score        FROM grades     WHERE agent_id IS NOT NULL
    ),
    graded AS (
      SELECT agent_id, count(*)::int AS gc, max(score)::int AS bs
      FROM grades WHERE agent_id IS NOT NULL GROUP BY agent_id
    )
    SELECT s.agent_id                                        AS "agentId",
           COALESCE(g.gc, 0)                                 AS "gradeCount",
           g.bs                                              AS "bestScore",
           to_char(max(s.at), 'YYYY-MM-DD"T"HH24:MI:SSZ')    AS "lastSeen"
    FROM seen s
    LEFT JOIN graded g ON g.agent_id = s.agent_id
    GROUP BY s.agent_id, g.gc, g.bs
    ORDER BY max(s.at) DESC
    LIMIT 200
  `) as AgentSummary[];
  return rows;
}

// --- one agent: grades (what I've done) -------------------------------------

export async function agentGrades(agentId: string, limit = 50): Promise<GradeRow[]> {
  if (!dbEnabled()) return [];
  const q = sql();
  const rows = (await q`
    SELECT job_id                          AS "jobId",
           bounty,
           score,
           valid,
           attestation_source             AS "attestationSource",
           signer,
           to_char(graded_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS "gradedAt"
    FROM grades
    WHERE agent_id = ${agentId}
    ORDER BY graded_at DESC
    LIMIT ${limit}
  `) as GradeRow[];
  return rows;
}

// --- one agent: in-flight activity (what I'm working on) --------------------
//
// tool_calls.agent_id is populated at the honeycomb-api chokepoint (resolveAgentId:
// request body agentId -> query agentId -> register response). So "what an agent is
// working on" is the agent's recent tool calls, newest first. Best-effort: telemetry
// is fire-and-forget, so absence of rows means no recorded calls, not necessarily idle.

export async function agentActivity(agentId: string, limit = 25): Promise<ActivityRow[]> {
  if (!dbEnabled()) return [];
  const q = sql();
  const rows = (await q`
    SELECT tool,
           method,
           path,
           status,
           ok,
           to_char(called_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS "calledAt"
    FROM tool_calls
    WHERE agent_id = ${agentId}
    ORDER BY called_at DESC
    LIMIT ${limit}
  `) as ActivityRow[];
  return rows;
}

// --- one agent: money earned (from honeycomb-api live chain) -----------------
//
// Earnings = the agent's share of bounties it WON. The API's /jobs view exposes
// per-job bestAgentId + rewardUSDC + status, which is the chain's view of who is
// leading/winning each job. Settled (resolved) jobs this agent leads = paid out;
// open jobs it leads = pending. This is the objective onchain truth.

type ApiJob = {
  id?: string | number;
  jobId?: string | number;
  bestAgentId?: string | number;
  rewardUSDC?: string | number;
  reward?: string | number;
  status?: string;
  settled?: boolean;
  resolved?: boolean;
};

function jobsFrom(v: unknown): ApiJob[] {
  if (Array.isArray(v)) return v as ApiJob[];
  if (v && typeof v === "object") {
    const inner = (v as Record<string, unknown>).jobs;
    if (Array.isArray(inner)) return inner as ApiJob[];
  }
  return [];
}

function isSettled(j: ApiJob): boolean {
  if (typeof j.settled === "boolean") return j.settled;
  if (typeof j.resolved === "boolean") return j.resolved;
  return (j.status ?? "").toLowerCase() === "resolved" || (j.status ?? "").toLowerCase() === "settled";
}

export async function agentEarnings(agentId: string): Promise<AgentEarnings> {
  const raw = await apiGet<unknown>("/jobs?limit=500");
  const jobs = jobsFrom(raw);
  const mine = jobs.filter((j) => String(j.bestAgentId ?? "") === String(agentId));

  let settledUSDC = 0;
  let pendingUSDC = 0;
  const jobsWon: WonJob[] = [];
  for (const j of mine) {
    const reward = Number(j.rewardUSDC ?? j.reward ?? 0) || 0;
    const settled = isSettled(j);
    if (settled) settledUSDC += reward;
    else pendingUSDC += reward;
    jobsWon.push({
      jobId: String(j.jobId ?? j.id ?? "?"),
      rewardUSDC: reward,
      status: String(j.status ?? (settled ? "resolved" : "open")),
      settled,
    });
  }
  return { settledUSDC, pendingUSDC, jobsWon, source: "honeycomb-api" };
}
