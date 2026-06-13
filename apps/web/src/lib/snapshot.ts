// Server-only module: it reads the filesystem (node:fs), so it can never be bundled
// into a client component. Keep imports of this module inside Server Components / routes.
import fs from "node:fs";
import path from "node:path";
import { parseCsv, num, bool, type Row } from "./csv";

// Loads the materialized BigQuery snapshot (the analysis/ CSVs) into typed objects the
// dashboard renders. The CSVs ARE the output of the BigQuery pipeline (see analysis/);
// reading the snapshot keeps page loads instant and free, while /api/bigquery proves the
// same queries run live against Ethereum mainnet on demand.

export type AdoptionPoint = { day: string; newAgents: number; cumulative: number };

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

export type Kpis = {
  registered: number;
  withReputation: number;
  resolvedDirectory: number;
  organic: number;
  sybilRing: number;
  x402Payable: number;
  avgRaw: number;
  avgTrust: number;
};

export type RingInfo = {
  wallet: string;
  agentsReviewed: number;
  totalAgents: number;
};

export type Snapshot = {
  window: { start: string; end: string; days: number };
  kpis: Kpis;
  adoption: AdoptionPoint[];
  agents: TrustAgent[];
  ring: RingInfo;
};

/** Walk up from cwd to locate the repo's analysis/ dir (env override wins). */
function analysisDir(): string {
  const override = process.env.HONEYCOMB_ANALYSIS_DIR;
  if (override && fs.existsSync(path.join(override, "erc8004_trust.csv"))) {
    return override;
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "analysis");
    if (fs.existsSync(path.join(candidate, "erc8004_trust.csv"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate analysis/erc8004_trust.csv. Run the analysis pipeline, or set HONEYCOMB_ANALYSIS_DIR.",
  );
}

function readCsv(dir: string, file: string): Row[] {
  return parseCsv(fs.readFileSync(path.join(dir, file), "utf8"));
}

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
  const adoptionRows = readCsv(dir, "erc8004_adoption.csv");
  const resolvedRows = readCsv(dir, "erc8004_directory_resolved.csv");
  const feedbackRows = readCsv(dir, "erc8004_feedback_raw.csv");

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

  const adoption: AdoptionPoint[] = adoptionRows.map((r) => ({
    day: r.day,
    newAgents: num(r.new_agents),
    cumulative: num(r.cumulative),
  }));

  // Derive the sybil-ring wallet dynamically: the client that reviewed the most agents.
  const breadth = new Map<string, Set<number>>();
  for (const r of feedbackRows) {
    const client = (r.client || "").toLowerCase();
    if (!client) continue;
    if (!breadth.has(client)) breadth.set(client, new Set());
    breadth.get(client)!.add(num(r.agent_id));
  }
  let ringWallet = "";
  let ringReviewed = 0;
  for (const [client, set] of breadth) {
    if (set.size > ringReviewed) {
      ringReviewed = set.size;
      ringWallet = client;
    }
  }

  const withReputation = agents.length;
  const organic = agents.filter((a) => a.category === "organic").length;
  const sybilRing = agents.filter((a) => a.category === "sybil").length;
  const x402Payable = resolvedRows.filter((r) => bool(r.x402_resolved)).length;
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

  const kpis: Kpis = {
    registered: adoption.length ? adoption[adoption.length - 1].cumulative : 0,
    withReputation,
    resolvedDirectory: resolvedRows.length,
    organic,
    sybilRing,
    x402Payable,
    avgRaw: avg(agents.map((a) => a.avgScore)),
    avgTrust: avg(agents.map((a) => a.trustScore)),
  };

  cached = {
    window: {
      start: adoption[0]?.day ?? "",
      end: adoption[adoption.length - 1]?.day ?? "",
      days: adoption.length,
    },
    kpis,
    adoption,
    agents,
    ring: { wallet: ringWallet, agentsReviewed: ringReviewed, totalAgents: withReputation },
  };
  return cached;
}
