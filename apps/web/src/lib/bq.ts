// ERC-8004 on-chain constants + the exact BigQuery SQL the dashboard runs against
// Ethereum mainnet. Pure strings only (no node imports) so this is safe to import from
// both the server (the /api/bigquery route) and the client (the live-query panel that
// renders the SQL). This mirrors analysis/query_example.py.

/** Google's public Ethereum mainnet logs table (partitioned by month). */
export const DATASET =
  "bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs";

/** Canonical Ethereum Foundation ERC-8004 registry addresses (note the 0x8004… vanity). */
export const REGISTRIES = {
  identity: {
    label: "Identity Registry",
    address: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
    // Registered(uint256 agentId, address owner, string metadataURI)
    topic0:
      "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a",
    event: "Registered",
  },
  reputation: {
    label: "Reputation Registry",
    address: "0x8004baa17c55a88189ae136b182e5fda19de9b63",
    // NewFeedback(uint256 agentId, address client, uint256 value, uint8 decimals, ...)
    topic0:
      "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc",
    event: "NewFeedback",
  },
} as const;

// The ERC-8004 Validation Registry — where a validator (Honeycomb's TEE enclave) publishes
// its verdict on a submission. The event schema + topic0 below are canonical: the topic0
// hashes were computed from the EIP-8004 event signatures and the method was verified
// against the two deployed topics above. There is NO EF Ethereum-mainnet deployment yet —
// the Validation Registry is still under active discussion with the TEE community (per
// erc-8004/erc-8004-contracts), so the address is configuration, not a hardcoded guess.
// Set BQ_VALIDATION_REGISTRY to the EF address once it lands, or to Honeycomb's own
// spec-conformant validator contract, and the live route + dashboard light it up.
const _validationAddress =
  (typeof process !== "undefined" ? process.env.BQ_VALIDATION_REGISTRY : undefined) ?? "";

export const VALIDATION_REGISTRY = {
  label: "Validation Registry",
  address: _validationAddress,
  status: _validationAddress ? "configured" : "pending EF mainnet deployment",
  events: {
    // ValidationResponse carries the validator's verdict — `response` (uint8) is the score.
    response: {
      name: "ValidationResponse",
      sig: "ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)",
      topic0: "0xafddf629e874ccc3963b6a888c477bd464a6c8525024fc88759ea3b2326349ae",
    },
    request: {
      name: "ValidationRequest",
      sig: "ValidationRequest(address,uint256,string,bytes32)",
      topic0: "0x530436c3634a98e1e626b0898be2f1e9980cc1bd2a78c07a0aba52d0a48a5059",
    },
  },
} as const;

export const VALIDATION_CONFIGURED = _validationAddress.length > 0;

/** First block_timestamp at which ERC-8004 events appear on mainnet. */
export const HISTORY_START = "2026-01-28";

/** A counting query for one registry event since `start`. Used live (dry-run + execute). */
export function countSql(address: string, topic0: string, start: string): string {
  return `SELECT COUNT(*) AS n
FROM \`${DATASET}\`
WHERE address = '${address}'
  AND topics[SAFE_OFFSET(0)] = '${topic0}'
  AND block_timestamp >= TIMESTAMP('${start}')`;
}

/** Daily new-agent adoption curve, computed server-side in BigQuery. */
export function adoptionSql(start: string): string {
  const r = REGISTRIES.identity;
  return `SELECT DATE(block_timestamp) AS day, COUNT(*) AS new_agents
FROM \`${DATASET}\`
WHERE address = '${r.address}'
  AND topics[SAFE_OFFSET(0)] = '${r.topic0}'
  AND block_timestamp >= TIMESTAMP('${start}')
GROUP BY day
ORDER BY day`;
}

/** The named queries surfaced in the live panel (validation included once configured). */
export function liveQueries(start: string) {
  const queries = [
    {
      key: "registered",
      title: "Agents registered",
      sql: countSql(REGISTRIES.identity.address, REGISTRIES.identity.topic0, start),
    },
    {
      key: "feedback",
      title: "Reputation feedback events",
      sql: countSql(REGISTRIES.reputation.address, REGISTRIES.reputation.topic0, start),
    },
  ];
  if (VALIDATION_CONFIGURED) {
    queries.push({
      key: "validation",
      title: "Validation responses (enclave verdicts)",
      sql: countSql(VALIDATION_REGISTRY.address, VALIDATION_REGISTRY.events.response.topic0, start),
    });
  }
  return queries;
}
