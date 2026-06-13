// Fixture loader: fetch logs for a contract via RPC (viem) and insert them into the BigQuery
// fixture table in the public-table shape. Works against a local Anvil chain (a contract we
// deployed) OR a mainnet RPC over a bounded block range (to capture real ERC-8004 bytes).
//
// ⚠️ This is a TEST fixture loader, NOT a production ingestion path. Production Layer-1 still
// reads mainnet via BigQuery's public dataset (sponsor constraint §3). See the plan doc §5.
import { createPublicClient, http, type Address, type Hex } from "viem";
import { getClient, testDataset, bqLocation } from "./bqClient";

type LogRow = {
  address: string;
  topics: readonly string[];
  data: string;
  block_timestamp: string;
  block_number: number;
  transaction_hash: string;
  log_index: number;
};

const RPC = process.env.ETH_RPC_URL || process.env.ANVIL_RPC || "http://127.0.0.1:8545";
const address = (process.env.MOCK_ADDRESS || process.argv[2]) as Address | undefined;
const fromBlock = process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n;
const toBlock = process.env.TO_BLOCK ? BigInt(process.env.TO_BLOCK) : undefined;
const topic0 = (process.env.TOPIC0 as Hex | undefined)?.toLowerCase();

async function main() {
  if (!address) {
    throw new Error("Pass a contract address: `pnpm run index 0xADDR` (or set MOCK_ADDRESS).");
  }
  const chain = createPublicClient({ transport: http(RPC) });

  let logs = await chain.getLogs({ address, fromBlock, toBlock: toBlock ?? "latest" });
  if (topic0) logs = logs.filter((l) => l.topics[0]?.toLowerCase() === topic0);
  if (logs.length === 0) {
    console.log(`No matching logs at ${address} in [${fromBlock}, ${toBlock ?? "latest"}] on ${RPC}`);
    return;
  }

  // Cache block timestamps by block number to avoid one getBlock per log.
  const tsByBlock = new Map<string, string>();
  const rows: LogRow[] = [];
  for (const l of logs) {
    const bn = l.blockNumber ?? 0n;
    const key = bn.toString();
    let iso = tsByBlock.get(key);
    if (!iso) {
      const block = await chain.getBlock({ blockNumber: bn });
      iso = new Date(Number(block.timestamp) * 1000).toISOString();
      tsByBlock.set(key, iso);
    }
    rows.push({
      address: l.address.toLowerCase(),
      topics: l.topics,
      data: l.data,
      block_timestamp: iso,
      block_number: Number(bn),
      transaction_hash: (l.transactionHash ?? "").toLowerCase(),
      log_index: l.logIndex ?? 0,
    });
  }

  const { bq } = getClient();
  await bq.dataset(testDataset(), { location: bqLocation() }).table("logs").insert(rows);
  console.log(`Inserted ${rows.length} log row(s) into ${testDataset()}.logs from ${address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
