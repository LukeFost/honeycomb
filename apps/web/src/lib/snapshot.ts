// Server-only module: loads the Layer-1 ERC-8004 trust directory from the LIVE BigQuery
// store (honeycomb.agent_trust), behind a short-TTL cache — it never touches the raw logs.
// The Directory renders these agents, and Layer-2 reputation (reputation.ts) uses each
// agent's trust score as a cold-start prior. The frozen analysis/erc8004_trust.csv is now
// just the reference the view reproduces; /api/bigquery still proves the raw-log queries
// run live against mainnet on demand. Keep imports of this module inside Server
// Components / routes (never a client component).
import { cached } from "./cache";
import { queryAgentTrust, queryStoreMeta, type AgentTrustRow } from "./queries";

export type TrustCategory = "organic" | "thin" | "sybil";

export type TrustAgent = {
  agentId: number;
  owner: string;
  name: string | null;
  avgScore: number;
  trustScore: number;
  trustMult: number;
  feedbackCount: number;
  uniqueClients: number;
  independentClients: number;
  reviewerRing: number;
  x402: boolean;
  services: string[];
  agentUri: string;
  flags: string;
  category: TrustCategory;
};

export type Snapshot = {
  agents: TrustAgent[];
  withReputation: number;
  asOf: string | null; // newest event timestamp in the store (ISO)
  asOfBlock: number | null;
};

function categorize(independentClients: number, flags: string): TrustCategory {
  if (independentClients >= 5) return "organic";
  if (flags.includes("ring-only")) return "sybil";
  return "thin";
}

function splitServices(v: string | null): string[] {
  if (!v || v.toLowerCase() === "nan") return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanName(v: string | null): string | null {
  if (!v || v.toLowerCase() === "nan") return null;
  return v;
}

function toAgent(r: AgentTrustRow): TrustAgent {
  const independentClients = Number(r.independent_clients);
  const flags = r.flags ?? "";
  return {
    agentId: Number(r.agent_id),
    owner: (r.owner ?? "").toLowerCase(),
    name: cleanName(r.name),
    avgScore: Number(r.avg_score),
    trustScore: Number(r.trust_score),
    trustMult: Number(r.trust_mult),
    feedbackCount: Number(r.feedback_count),
    uniqueClients: Number(r.unique_clients),
    independentClients,
    reviewerRing: Number(r.reviewer_ring),
    x402: Boolean(r.x402_resolved),
    services: splitServices(r.services),
    agentUri: r.agent_uri ?? "",
    flags,
    category: categorize(independentClients, flags),
  };
}

/** Load the trust directory (cached ~TTL). Promise-memoized so concurrent readers share
 *  one BigQuery round-trip. */
export function loadSnapshot(): Promise<Snapshot> {
  return cached("snapshot", async () => {
    const [rows, meta] = await Promise.all([queryAgentTrust(), queryStoreMeta()]);
    const agents = rows
      .map(toAgent)
      .sort((a, b) => b.trustScore - a.trustScore || b.uniqueClients - a.uniqueClients);
    return { agents, withReputation: agents.length, asOf: meta.asOf, asOfBlock: meta.asOfBlock };
  });
}
