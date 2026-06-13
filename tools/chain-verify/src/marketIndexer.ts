// Layer-2 fixture loader: fetch the Honeycomb escrow's logs via RPC, decode them with viem,
// and insert into honeycomb_demo.{bounties,submissions,validations,settlements}. The dashboard's
// reputation.ts reads those tables. (Layer 1 stays raw-logs → SQL decode; only Layer 2 is
// indexer-decoded for the demo.) NOT a production ingestion path — a demo fixture loader.
import { createPublicClient, http, parseEventLogs, type Address } from "viem";
import { getClient, testDataset, bqLocation } from "./bqClient";

const ESCROW_ABI = [
  {
    type: "event",
    name: "BountyCreated",
    inputs: [
      { name: "bountyId", type: "uint256", indexed: true },
      { name: "requester", type: "address", indexed: true },
      { name: "category", type: "string", indexed: false },
      { name: "title", type: "string", indexed: false },
      { name: "rewardWei", type: "uint256", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SubmissionMade",
    inputs: [
      { name: "bountyId", type: "uint256", indexed: true },
      { name: "agentId", type: "uint256", indexed: true },
      { name: "submissionCid", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidationRecorded",
    inputs: [
      { name: "bountyId", type: "uint256", indexed: true },
      { name: "agentId", type: "uint256", indexed: true },
      { name: "validator", type: "address", indexed: false },
      { name: "response", type: "uint8", indexed: false },
      { name: "valid", type: "bool", indexed: false },
      { name: "responseHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BountySettled",
    inputs: [
      { name: "bountyId", type: "uint256", indexed: true },
      { name: "winnerAgentId", type: "uint256", indexed: true },
      { name: "winnerScore", type: "uint32", indexed: false },
      { name: "attestationHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

const RPC = process.env.ETH_RPC_URL || process.env.ANVIL_RPC || "http://127.0.0.1:8545";
const escrow = (process.env.ESCROW_ADDRESS || process.argv[2]) as Address | undefined;

const iso = (secs: bigint) => new Date(Number(secs) * 1000).toISOString();

async function main() {
  if (!escrow) throw new Error("Pass the escrow address: `pnpm exec tsx src/marketIndexer.ts 0xADDR`.");
  const chain = createPublicClient({ transport: http(RPC) });
  const raw = await chain.getLogs({ address: escrow, fromBlock: 0n, toBlock: "latest" });
  const logs = parseEventLogs({ abi: ESCROW_ABI, logs: raw });

  const tsCache = new Map<string, string>();
  const tsOf = async (bn: bigint): Promise<string> => {
    const k = bn.toString();
    let v = tsCache.get(k);
    if (!v) {
      const b = await chain.getBlock({ blockNumber: bn });
      v = iso(b.timestamp);
      tsCache.set(k, v);
    }
    return v;
  };

  const bounties: Record<string, unknown>[] = [];
  const submissions: Record<string, unknown>[] = [];
  const validations: Record<string, unknown>[] = [];
  const settlements: Record<string, unknown>[] = [];

  for (const l of logs) {
    const at = await tsOf(l.blockNumber);
    const base = { block_number: Number(l.blockNumber), tx_hash: l.transactionHash, log_index: l.logIndex };
    if (l.eventName === "BountyCreated") {
      const a = l.args;
      bounties.push({
        bounty_id: Number(a.bountyId),
        requester: a.requester.toLowerCase(),
        category: a.category,
        title: a.title,
        reward_eth: Number(a.rewardWei) / 1e18,
        created_at: at,
        deadline: iso(a.deadline),
        ...base,
      });
    } else if (l.eventName === "SubmissionMade") {
      const a = l.args;
      submissions.push({ bounty_id: Number(a.bountyId), agent_id: Number(a.agentId), submission_cid: a.submissionCid, submitted_at: at, ...base });
    } else if (l.eventName === "ValidationRecorded") {
      const a = l.args;
      validations.push({
        bounty_id: Number(a.bountyId),
        agent_id: Number(a.agentId),
        validator: a.validator.toLowerCase(),
        response: a.response,
        valid: a.valid,
        response_hash: a.responseHash,
        validated_at: at,
        ...base,
      });
    } else if (l.eventName === "BountySettled") {
      const a = l.args;
      settlements.push({ bounty_id: Number(a.bountyId), winner_agent_id: Number(a.winnerAgentId), winner_score: a.winnerScore, attestation_hash: a.attestationHash, settled_at: at, ...base });
    }
  }

  const { bq } = getClient();
  const ds = bq.dataset(testDataset(), { location: bqLocation() });
  async function insert(table: string, rows: Record<string, unknown>[]) {
    if (rows.length) await ds.table(table).insert(rows);
    console.log(`  ${table}: +${rows.length}`);
  }
  console.log(`decoded ${logs.length} escrow events from ${escrow} → ${testDataset()}`);
  await insert("bounties", bounties);
  await insert("submissions", submissions);
  await insert("validations", validations);
  await insert("settlements", settlements);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
