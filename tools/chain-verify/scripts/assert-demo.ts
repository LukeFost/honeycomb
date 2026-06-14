// Golden assertions for the self-contained demo. Run after `demo.sh seed` (which deploys the
// mocks, indexes their RAW logs, and POSTs the REAL /api/refresh). This proves the FULL
// production path end-to-end: raw on-chain events → BigQuery SQL decode → market/trust tables →
// serving reads → the HTTP API the dashboard renders. It hits the running server's /api/market
// and /api/agents and checks the known scenario from contracts/script/DeployAndSeed.s.sol:
//
//   - Layer 1 (Directory): a 10-wallet sybil RING (agents 1..10) is flagged; the ORGANIC agent
//     #11 (6 independent reviewers) tops the trust directory.
//   - Layer 2 (Market): #11 leads the earned leaderboard (won 2 bounties from 2 independent
//     requesters); the SELF-DEALER #3 earns ~0 despite a 97 enclave score; the CHEATER #7 fails
//     attestation and never wins.
//
// Exits non-zero on the first failed assertion so `demo.sh seed` (and CI) fail loudly.
const PORT = process.env.PORT || "3000";
const BASE = process.env.DEMO_BASE_URL || `http://localhost:${PORT}`;

type Json = Record<string, any>;

async function get(path: string): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" } as RequestInit);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Json>;
}

const checks: { ok: boolean; msg: string }[] = [];
function expect(ok: boolean, msg: string): void {
  checks.push({ ok, msg });
}

async function main() {
  // The refresh route clears the cache before returning, but allow a brief retry in case the
  // read raced an in-flight cache fill from the homepage.
  let market = (await get("/api/market")).data as Json;
  for (let i = 0; i < 3 && (!market?.bounties || market.bounties.length === 0); i++) {
    await new Promise((r) => setTimeout(r, 2500));
    market = (await get("/api/market")).data as Json;
  }
  const agents = market.agents as Json[];
  const byId = new Map<number, Json>(agents.map((a) => [Number(a.agentId), a]));
  const k = market.kpis as Json;

  // ---- Layer 2: the bounty market ----
  expect(market.bounties.length === 5, `5 bounties decoded (got ${market.bounties.length})`);
  expect(k.settledCount === 4, `4 settled bounties (got ${k.settledCount})`);
  expect(k.openCount === 1, `1 open bounty (got ${k.openCount})`);
  expect(k.paidEth === 20, `20 ETH paid out across settled bounties (got ${k.paidEth})`);
  expect(k.validations === 8, `8 enclave validations recorded (got ${k.validations})`);

  // categories came through the bytes32 decode (not NULL/garbage)
  const cats = new Set((market.bounties as Json[]).map((b) => b.category));
  expect(
    ["audit", "trading-strategy", "zk-proof", "data-labeling", "evals"].every((c) => cats.has(c)),
    `all 5 bounty categories decoded from bytes32 (got ${[...cats].join(", ")})`,
  );
  // titles came through the trailing-string decode
  const auditBounty = (market.bounties as Json[]).find((b) => Number(b.id) === 1);
  expect(
    auditBounty?.title === "Audit an ERC-4626 vault",
    `bounty #1 title decoded from the trailing string (got ${JSON.stringify(auditBounty?.title)})`,
  );

  // organic agent #11 leads the earned leaderboard
  const a11 = byId.get(11);
  expect(!!a11 && a11.basis === "earned", `#11 earned reputation (basis=${a11?.basis})`);
  expect(!!a11 && a11.bountiesWon === 2, `#11 won 2 bounties (got ${a11?.bountiesWon})`);
  expect(!!a11 && a11.independentRequesters === 2, `#11 has 2 independent requesters (got ${a11?.independentRequesters})`);
  expect(!!a11 && a11.honeycombScore > 0, `#11 has a positive earned score (got ${a11?.honeycombScore})`);
  expect(Number(agents[0]?.agentId) === 11, `#11 tops the earned leaderboard (top=${agents[0]?.agentId})`);

  // self-dealer #3: high enclave score, ~0 earned, flagged
  const a3 = byId.get(3);
  expect(!!a3 && a3.selfDealtWins === 1, `#3 self-dealt 1 win (got ${a3?.selfDealtWins})`);
  expect(!!a3 && a3.avgEnclaveScore >= 90, `#3 has a high enclave score (got ${a3?.avgEnclaveScore})`);
  expect(!!a3 && a3.honeycombScore !== null && a3.honeycombScore <= 5, `#3 earns ~0 despite that score (got ${a3?.honeycombScore})`);
  expect(!!a3 && (a3.flags as string[]).includes("self-dealing"), `#3 flagged self-dealing (flags=${a3?.flags})`);
  expect(k.selfDealingFlagged >= 1, `self-dealing flagged in KPIs (got ${k.selfDealingFlagged})`);

  // cheater #7: failed attestation, never won
  const a7 = byId.get(7);
  expect(!!a7 && a7.bountiesWon === 0, `#7 never won (got ${a7?.bountiesWon})`);
  expect(!!a7 && a7.validAttestationRate < 1, `#7 failed an attestation (rate=${a7?.validAttestationRate})`);
  expect(!!a7 && (a7.flags as string[]).includes("failed attestations"), `#7 flagged failed attestations (flags=${a7?.flags})`);
  expect(k.cheatersFlagged >= 1, `cheaters flagged in KPIs (got ${k.cheatersFlagged})`);

  // the enclave that signed the validations is the seed's enclave address
  expect(/^0x0+3e7$/.test(String(market.validator)), `validator is the enclave addr(999) (got ${market.validator})`);

  // ---- Layer 1: the trust directory ----
  const dir = (await get("/api/agents")).data as Json[];
  const dirById = new Map<number, Json>(dir.map((a) => [Number(a.agentId), a]));
  expect(Number(dir[0]?.agentId) === 11, `#11 tops the trust directory (top=${dir[0]?.agentId})`);
  expect(dirById.get(11)?.category === "organic", `#11 categorized organic (got ${dirById.get(11)?.category})`);
  const ring = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const sybils = ring.filter((id) => dirById.get(id)?.category === "sybil").length;
  expect(sybils === 10, `all 10 ring agents flagged sybil (got ${sybils}/10)`);

  // ---- report ----
  const passed = checks.filter((c) => c.ok).length;
  for (const c of checks) console.log(`${c.ok ? "  ✓" : "  ✗"} ${c.msg}`);
  console.log(`\n${passed}/${checks.length} golden assertions passed.`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ The dashboard populated entirely via the production refresh loop — golden scenario matches.");
}

main().catch((e) => {
  console.error("assert-demo failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
