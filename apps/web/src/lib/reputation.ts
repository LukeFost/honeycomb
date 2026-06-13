// Layer 2 — earned, participation-scoped Honeycomb reputation.
//
// Reads the LIVE BigQuery market tables (honeycomb.{bounties,submissions,validations,
// settlements} + registrations for agent owners), decoded from the Honeycomb escrow's events
// by the indexer. Each submission's enclave_score / attestation_ok come from the escrow's
// ValidationRecorded event (the enclave is the `validator`, `response` is the score). The
// global ERC-8004 trust score (snapshot.ts) is used only as a cold-start prior for agents with
// no wins yet. Server-only — keep imports inside Server Components / routes.
import { queryRows } from "./bqClient";
import {
  selectMarketAgentsSql,
  selectBountiesSql,
  selectSubmissionsSql,
  selectValidationsSql,
  selectSettlementsSql,
} from "./bq";
import { loadSnapshot } from "./snapshot";
import { cached } from "./cache";

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
  asOf: string | null; // freshness of the live ERC-8004 trust prior (ISO)
  asOfBlock: number | null;
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

// --- BigQuery row shapes (snake_case, as the serving SELECTs return them) ---
type AgentRow = { agent_id: number; owner: string | null; agent_uri: string | null };
type BountyRow = {
  bounty_id: number; requester: string | null; category: string; title: string;
  reward_eth: number; created_at: string; deadline: string;
};
type SubmissionRow = { bounty_id: number; agent_id: number; submission_cid: string | null };
type ValidationRow = {
  bounty_id: number; agent_id: number; validator: string | null; response: number; valid: boolean;
  response_hash: string | null;
};
type SettlementRow = { bounty_id: number; winner_agent_id: number; winner_score: number; attestation_hash: string | null };

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

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/** Layer-2 market (cached ~TTL). All tables are small derived stores — never the raw logs. */
export function loadMarket(): Promise<Market> {
  return cached("market", buildMarket);
}

async function buildMarket(): Promise<Market> {
  const [agentRows, bountyRows, subRows, valRows, setRows, snap] = await Promise.all([
    queryRows<AgentRow>(selectMarketAgentsSql()),
    queryRows<BountyRow>(selectBountiesSql()),
    queryRows<SubmissionRow>(selectSubmissionsSql()),
    queryRows<ValidationRow>(selectValidationsSql()),
    queryRows<SettlementRow>(selectSettlementsSql()),
    loadSnapshot(),
  ]);

  // a bounty is settled iff a settlement was recorded for it
  const settledIds = new Set(setRows.map((r) => Number(r.bounty_id)));

  const ownerOf = new Map<number, string>();
  const nameOf = new Map<number, string>();
  for (const r of agentRows) {
    const id = Number(r.agent_id);
    ownerOf.set(id, (r.owner || "").toLowerCase());
    nameOf.set(id, `Agent #${id}`); // on-chain identity carries no name; resolved off-chain later
  }

  const subsPerBounty = new Map<number, number>();
  for (const r of subRows) {
    const b = Number(r.bounty_id);
    subsPerBounty.set(b, (subsPerBounty.get(b) ?? 0) + 1);
  }
  const bountyById = new Map<number, Bounty>();
  const bounties: Bounty[] = bountyRows.map((r) => {
    const id = Number(r.bounty_id);
    const b: Bounty = {
      id,
      requester: (r.requester || "").toLowerCase(),
      category: r.category,
      title: r.title,
      rewardEth: Number(r.reward_eth),
      status: settledIds.has(id) ? "settled" : "open",
      createdAt: r.created_at,
      deadline: r.deadline,
      submissions: subsPerBounty.get(id) ?? 0,
    };
    bountyById.set(id, b);
    return b;
  });

  // global ERC-8004 trust score (live from BigQuery), for the cold-start prior
  const globalTrust = new Map<number, number>();
  for (const a of snap.agents) globalTrust.set(a.agentId, a.trustScore);

  // index submissions, wins (settlements), validations by agent
  const subsByAgent = new Map<number, SubmissionRow[]>();
  for (const r of subRows) push(subsByAgent, Number(r.agent_id), r);
  const winsByAgent = new Map<number, SettlementRow[]>();
  for (const r of setRows) push(winsByAgent, Number(r.winner_agent_id), r);
  const valsByAgent = new Map<number, ValidationRow[]>();
  for (const r of valRows) push(valsByAgent, Number(r.agent_id), r);

  const agents: AgentReputation[] = agentRows.map((ar) => {
    const agentId = Number(ar.agent_id);
    const owner = ownerOf.get(agentId)!;
    const mySubs = subsByAgent.get(agentId) ?? [];
    const myWins = winsByAgent.get(agentId) ?? [];
    const myVals = valsByAgent.get(agentId) ?? [];

    // quality from the enclave's ValidationRecorded events on SETTLED bounties
    const graded = myVals.filter((v) => bountyById.get(Number(v.bounty_id))?.status === "settled");
    const scores = graded.map((v) => Number(v.response));
    const avgEnclaveScore = scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const validAttestationRate = graded.length
      ? round1((graded.filter((v) => Boolean(v.valid)).length / graded.length) * 100) / 100
      : 1;

    // demand: distinct independent requesters among wins, self-dealing tagged
    let selfDealtWins = 0;
    let valueWonEth = 0;
    const independentRequesters = new Set<string>();
    for (const w of myWins) {
      const b = bountyById.get(Number(w.bounty_id));
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
        clamp(avgEnclaveScore * validAttestationRate * (1 - 0.9 * selfShare) * demandMultiplier(indep)),
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
      bountiesEntered: new Set(mySubs.map((s) => Number(s.bounty_id))).size,
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

  return {
    agents,
    bounties,
    openBounties,
    categories: [...catMap.values()].sort((a, b) => b.total - a.total),
    validator: (valRows[0]?.validator ?? "").toLowerCase(),
    asOf: snap.asOf,
    asOfBlock: snap.asOfBlock,
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
}
