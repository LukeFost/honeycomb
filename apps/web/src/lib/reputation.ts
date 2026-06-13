// Layer 2 — earned, participation-scoped Honeycomb reputation.
//
// Mirrors analysis/honeycomb_reputation.sql in TS so the dashboard can render the market
// before the escrow contract exists. Inputs are the seed star-schema CSVs
// (analysis/honeycomb_{agents,bounties,submissions,settlements}.csv); in production these
// tables are materialized in BigQuery from the contract's decoded logs and this same logic
// runs as the SQL view. In production, each submission's enclave_score / attestation_ok come
// from the ERC-8004 Validation Registry's ValidationResponse event (the enclave is the
// `validator`, `response` is the score) — see bq.ts VALIDATION_REGISTRY. The global ERC-8004
// trust score (snapshot.ts) is used only as a cold-start prior for agents with no wins yet.
import { num, bool } from "./csv";
import { analysisDir, readCsv } from "./repoData";
import { loadSnapshot } from "./snapshot";

export type BountyStatus = "settled" | "open";

export type Bounty = {
  id: number;
  requester: string;
  category: string;
  title: string;
  rewardEth: number;
  status: BountyStatus;
  createdAt: string;
  deadline: string;
  submissions: number;
};

export type RepBasis = "earned" | "cold-start" | "unproven";

export type AgentReputation = {
  agentId: number;
  name: string;
  owner: string;
  bountiesEntered: number;
  bountiesWon: number;
  independentRequesters: number;
  selfDealtWins: number;
  avgEnclaveScore: number | null;
  validAttestationRate: number;
  valueWonEth: number;
  honeycombScore: number | null; // earned signal — null until first win
  globalTrust: number | null; // ERC-8004 cold-start prior
  effectiveScore: number; // earned, else demoted global, else 0
  basis: RepBasis;
  flags: string[];
};

export type CategoryStat = { name: string; total: number; open: number; rewardEth: number };

export type Market = {
  agents: AgentReputation[];
  bounties: Bounty[];
  openBounties: Bounty[];
  categories: CategoryStat[];
  validator: string; // the enclave address that signed the validations
  kpis: {
    openCount: number;
    openRewardEth: number;
    settledCount: number;
    paidEth: number;
    earnedAgents: number;
    selfDealingFlagged: number;
    cheatersFlagged: number;
    validations: number;
  };
};

const COLD_START_DISCOUNT = 0.5; // a newcomer's global ERC-8004 trust is a weak prior only

/** Organic-demand multiplier: more distinct independent requesters = harder to fake. */
function demandMultiplier(independentRequesters: number): number {
  if (independentRequesters === 0) return 0.1;
  if (independentRequesters === 1) return 0.5;
  if (independentRequesters === 2) return 0.8;
  return 1.2;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

let cached: Market | null = null;

export function loadMarket(): Market {
  if (cached) return cached;
  const dir = analysisDir();
  const agentRows = readCsv(dir, "honeycomb_agents.csv");
  const bountyRows = readCsv(dir, "honeycomb_bounties.csv");
  const subRows = readCsv(dir, "honeycomb_submissions.csv");
  const setRows = readCsv(dir, "honeycomb_settlements.csv");
  const valRows = readCsv(dir, "honeycomb_validations.csv"); // decoded ValidationResponse events

  const ownerOf = new Map<number, string>();
  const nameOf = new Map<number, string>();
  for (const r of agentRows) {
    const id = num(r.agent_id);
    ownerOf.set(id, (r.owner || "").toLowerCase());
    nameOf.set(id, r.name || `Agent #${id}`);
  }

  // bounty lookup + per-bounty submission counts
  const subsPerBounty = new Map<number, number>();
  for (const r of subRows) {
    const b = num(r.bounty_id);
    subsPerBounty.set(b, (subsPerBounty.get(b) ?? 0) + 1);
  }
  const bountyById = new Map<number, Bounty>();
  const bounties: Bounty[] = bountyRows.map((r) => {
    const b: Bounty = {
      id: num(r.bounty_id),
      requester: (r.requester || "").toLowerCase(),
      category: r.category,
      title: r.title,
      rewardEth: num(r.reward_eth),
      status: r.status === "open" ? "open" : "settled",
      createdAt: r.created_at,
      deadline: r.deadline,
      submissions: subsPerBounty.get(num(r.bounty_id)) ?? 0,
    };
    bountyById.set(b.id, b);
    return b;
  });

  // global ERC-8004 trust score, for the cold-start prior
  const globalTrust = new Map<number, number>();
  for (const a of loadSnapshot().agents) globalTrust.set(a.agentId, a.trustScore);

  // index submissions + settlements by agent
  const subsByAgent = new Map<number, typeof subRows>();
  for (const r of subRows) {
    const a = num(r.agent_id);
    (subsByAgent.get(a) ?? subsByAgent.set(a, []).get(a)!).push(r);
  }
  const winsByAgent = new Map<number, typeof setRows>();
  for (const r of setRows) {
    const a = num(r.winner_agent_id);
    (winsByAgent.get(a) ?? winsByAgent.set(a, []).get(a)!).push(r);
  }
  const valsByAgent = new Map<number, typeof valRows>();
  for (const r of valRows) {
    const a = num(r.agent_id);
    (valsByAgent.get(a) ?? valsByAgent.set(a, []).get(a)!).push(r);
  }

  const agents: AgentReputation[] = agentRows.map((ar) => {
    const agentId = num(ar.agent_id);
    const owner = ownerOf.get(agentId)!;
    const mySubs = subsByAgent.get(agentId) ?? [];
    const myWins = winsByAgent.get(agentId) ?? [];
    const myVals = valsByAgent.get(agentId) ?? [];

    // quality from the enclave's ValidationResponse events on SETTLED bounties:
    // enclave_score = `response`, attestation_ok = `valid` (see honeycomb_validations.csv).
    const graded = myVals.filter((v) => bountyById.get(num(v.bounty_id))?.status === "settled");
    const scores = graded.map((v) => num(v.response));
    const avgEnclaveScore = scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const validAttestationRate = graded.length
      ? round1((graded.filter((v) => bool(v.valid)).length / graded.length) * 100) / 100
      : 1;

    // demand: distinct independent requesters among wins, self-dealing tagged
    let selfDealtWins = 0;
    let valueWonEth = 0;
    const independentRequesters = new Set<string>();
    for (const w of myWins) {
      const b = bountyById.get(num(w.bounty_id));
      if (!b) continue;
      valueWonEth += b.rewardEth;
      if (b.requester === owner) selfDealtWins++;
      else independentRequesters.add(b.requester);
    }
    const bountiesWon = myWins.length;
    const indep = independentRequesters.size;

    // earned reputation — null until the agent has won a funded bounty
    let honeycombScore: number | null = null;
    if (bountiesWon > 0 && avgEnclaveScore != null) {
      const selfShare = selfDealtWins / bountiesWon;
      honeycombScore = round1(
        clamp(
          avgEnclaveScore *
            validAttestationRate *
            (1 - 0.9 * selfShare) *
            demandMultiplier(indep),
        ),
      );
    }

    const gt = globalTrust.get(agentId) ?? null;
    let effectiveScore: number;
    let basis: RepBasis;
    if (honeycombScore != null) {
      effectiveScore = honeycombScore;
      basis = "earned";
    } else if (gt != null) {
      effectiveScore = round1(gt * COLD_START_DISCOUNT);
      basis = "cold-start";
    } else {
      effectiveScore = 0;
      basis = "unproven";
    }

    const flags: string[] = [];
    if (selfDealtWins > 0) flags.push("self-dealing");
    if (graded.length > 0 && validAttestationRate < 1) flags.push("failed attestations");
    if (indep >= 3) flags.push("broad independent demand");
    if (indep === 1) flags.push("single-requester concentration");
    if (bountiesWon === 0) flags.push("no wins yet");

    return {
      agentId,
      name: nameOf.get(agentId)!,
      owner,
      bountiesEntered: new Set(mySubs.map((s) => num(s.bounty_id))).size,
      bountiesWon,
      independentRequesters: indep,
      selfDealtWins,
      avgEnclaveScore,
      validAttestationRate,
      valueWonEth: round1(valueWonEth),
      honeycombScore,
      globalTrust: gt,
      effectiveScore,
      basis,
      flags,
    };
  });

  agents.sort((a, b) => b.effectiveScore - a.effectiveScore || (b.honeycombScore ?? -1) - (a.honeycombScore ?? -1));

  const openBounties = bounties.filter((b) => b.status === "open");
  const settled = bounties.filter((b) => b.status === "settled");

  const catMap = new Map<string, CategoryStat>();
  for (const b of bounties) {
    const c = catMap.get(b.category) ?? { name: b.category, total: 0, open: 0, rewardEth: 0 };
    c.total++;
    if (b.status === "open") c.open++;
    c.rewardEth = round1(c.rewardEth + b.rewardEth);
    catMap.set(b.category, c);
  }

  cached = {
    agents,
    bounties,
    openBounties,
    categories: [...catMap.values()].sort((a, b) => b.total - a.total),
    validator: (valRows[0]?.validator ?? "").toLowerCase(),
    kpis: {
      openCount: openBounties.length,
      openRewardEth: round1(openBounties.reduce((s, b) => s + b.rewardEth, 0)),
      settledCount: settled.length,
      paidEth: round1(settled.reduce((s, b) => s + b.rewardEth, 0)),
      earnedAgents: agents.filter((a) => a.honeycombScore != null).length,
      selfDealingFlagged: agents.filter((a) => a.selfDealtWins > 0).length,
      cheatersFlagged: agents.filter((a) => a.bountiesWon === 0 && a.validAttestationRate < 1).length,
      validations: valRows.length,
    },
  };
  return cached;
}
