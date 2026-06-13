// Server-only module: it reads the filesystem, so it can never be bundled into a client
// component. Keep imports of this module inside Server Components / routes.
import { num, bool } from "./csv";
import { analysisDir, readCsv } from "./repoData";

// Loads the materialized ERC-8004 trust snapshot (analysis/erc8004_trust.csv): the dashboard's
// Directory renders these agents, and Layer-2 reputation (reputation.ts) uses each agent's
// trust score as a cold-start prior. The CSV is the frozen output of the BigQuery pipeline
// (see analysis/); /api/bigquery proves the same queries run live against mainnet on demand.

export type TrustCategory = "organic" | "thin" | "sybil";

export type TrustAgent = {
  agentId: number;
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
};

function categorize(independentClients: number, flags: string): TrustCategory {
  if (independentClients >= 5) return "organic";
  if (flags.includes("ring-only")) return "sybil";
  return "thin";
}

function splitServices(v: string): string[] {
  if (!v || v.toLowerCase() === "nan") return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanName(v: string | undefined): string | null {
  if (!v || v.toLowerCase() === "nan") return null;
  return v;
}

let cached: Snapshot | null = null;

export function loadSnapshot(): Snapshot {
  if (cached) return cached;
  const dir = analysisDir();

  const trustRows = readCsv(dir, "erc8004_trust.csv");

  const agents: TrustAgent[] = trustRows
    .map((r) => {
      const independentClients = num(r.independent_clients);
      const flags = r.flags ?? "";
      return {
        agentId: num(r.agent_id),
        name: cleanName(r.name),
        avgScore: num(r.avg_score),
        trustScore: num(r.trust_score),
        trustMult: num(r.trust_mult),
        feedbackCount: num(r.feedback_count),
        uniqueClients: num(r.unique_clients),
        independentClients,
        reviewerRing: num(r.reviewer_ring),
        x402: bool(r.x402_resolved),
        services: splitServices(r.services),
        agentUri: r.agent_uri ?? "",
        flags,
        category: categorize(independentClients, flags),
      };
    })
    .sort((a, b) => b.trustScore - a.trustScore || b.uniqueClients - a.uniqueClients);

  cached = { agents, withReputation: agents.length };
  return cached;
}
