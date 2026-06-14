// ERC-8004 on-chain constants + the exact BigQuery SQL the dashboard runs against
// Ethereum mainnet. Pure strings only (no node imports) so this is safe to import from
// both the server (the /api/bigquery route) and the client (the live-query panel that
// renders the SQL).

/** Google's public Ethereum mainnet logs table (partitioned by month). */
export const DATASET =
  "bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs";

/** Source logs table the decode/count SQL scans. Defaults to the real mainnet public table
 *  (DATASET) so production behavior is unchanged; override with BQ_LOGS_TABLE to point the
 *  SAME decode/count SQL at a fixture table for on-chain read-verification (a contract we
 *  control on a local chain, indexed into a public-table-shaped fixture). Guarded like
 *  HONEYCOMB_DATASET so the client bundle always renders the canonical mainnet table.
 *  See docs/onchain-verification-plan.md §6 and tools/chain-verify/. */
export const LOGS_TABLE =
  (typeof process !== "undefined" ? process.env.BQ_LOGS_TABLE : undefined) || DATASET;

/** Read an env var on the server (undefined on the client, where `process` is absent), so the
 *  registry addresses/topics can be repointed at a local mock-contract chain for the
 *  self-contained demo (tools/chain-verify) while defaulting to the real EF mainnet values. */
function envVar(name: string): string | undefined {
  return (typeof process !== "undefined" ? process.env[name] : undefined) || undefined;
}

/** ERC-8004 registries. address/topic0 default to the canonical EF mainnet contracts (note the
 *  0x8004… vanity); override per-registry (BQ_IDENTITY_REGISTRY / BQ_IDENTITY_TOPIC0 /
 *  BQ_REPUTATION_REGISTRY / BQ_REPUTATION_TOPIC0) to drive the pipeline from mock contracts. */
export const REGISTRIES = {
  identity: {
    label: "Identity Registry",
    address: (envVar("BQ_IDENTITY_REGISTRY") || "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432").toLowerCase(),
    // Registered(uint256 agentId, string metadataURI, address owner)
    topic0: (envVar("BQ_IDENTITY_TOPIC0")
      || "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a").toLowerCase(),
    event: "Registered",
  },
  reputation: {
    label: "Reputation Registry",
    address: (envVar("BQ_REPUTATION_REGISTRY") || "0x8004baa17c55a88189ae136b182e5fda19de9b63").toLowerCase(),
    // NewFeedback(uint256 agentId, address client, uint256 value, uint8 decimals, …)
    topic0: (envVar("BQ_REPUTATION_TOPIC0")
      || "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc").toLowerCase(),
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
const _validationAddress = (envVar("BQ_VALIDATION_REGISTRY") || "").toLowerCase();
// Override with BQ_VALIDATION_TOPIC0 to count a different verdict event (e.g. the demo escrow's
// ValidationRecorded) in the live provenance panel; defaults to the canonical ValidationResponse.
const _validationTopic0 = (envVar("BQ_VALIDATION_TOPIC0")
  || "0xafddf629e874ccc3963b6a888c477bd464a6c8525024fc88759ea3b2326349ae").toLowerCase();

export const VALIDATION_REGISTRY = {
  label: "Validation Registry",
  address: _validationAddress,
  status: _validationAddress ? "configured" : "pending EF mainnet deployment",
  events: {
    // ValidationResponse carries the validator's verdict — `response` (uint8) is the score.
    response: {
      name: "ValidationResponse",
      sig: "ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)",
      topic0: _validationTopic0,
    },
    request: {
      name: "ValidationRequest",
      sig: "ValidationRequest(address,uint256,string,bytes32)",
      topic0: "0x530436c3634a98e1e626b0898be2f1e9980cc1bd2a78c07a0aba52d0a48a5059",
    },
  },
} as const;

export const VALIDATION_CONFIGURED = _validationAddress.length > 0;

// The Honeycomb bounty-market escrow (BountyEscrow.sol) — emits the live contest lifecycle:
// JobCreated (bounty opened) / Submitted (agent entry) / ScoreRecorded + ValidityRecorded (the
// grader enclave's per-agent score and the AI attestor's validity verdict) / JobResolved (winner
// paid). The SAME warehouse-native decode→MERGE machinery that fills the Layer-1 tables fills the
// Layer-2 market tables from these events, so there is NO off-chain indexer in the production
// path. There is no production escrow on EF mainnet, so the address defaults to "" (like
// VALIDATION_REGISTRY): the refresh loop SKIPS Layer 2 while unconfigured, leaving production cost
// identical to Layer-1-only. Point BQ_ESCROW_ADDRESS at the deployed escrow (the demo points it at
// the Sepolia escrow / a local fixture) and the loop decodes its events.
//
// The five topic0s are fixed by the event ABI (each verified with `cast keccak` against
// apps/grading-cre/contracts/BountyEscrow.sol). The market tables keep their original
// (bounty/submission/validation/settlement) shape so reputation.ts is unchanged; the per-agent
// grading model maps on: a `validation` row is the JOIN of ScoreRecorded (the score) with
// ValidityRecorded (the valid flag) on (jobId, agentId), and a `settlement` is one JobResolved.
// Each event is SQL-friendly: fixed-width except a single trailing `string` (specCid / encCid),
// so a decode never slices two dynamic blobs (see the multi-string trap in the handoff doc §5).
const _escrowAddress = (envVar("BQ_ESCROW_ADDRESS") || "").toLowerCase();
export const ESCROW = {
  label: "Honeycomb Escrow",
  address: _escrowAddress,
  status: _escrowAddress ? "configured" : "pending deployment",
  events: {
    // JobCreated(uint256 jobId, address client, address token, uint256 budget, uint64 expiredAt,
    //   bytes32 testsHash, string specCid) — bounty opened + funded. jobId/client are indexed.
    jobCreated: {
      name: "JobCreated",
      topic0: "0x9855ca043ca23bb0633159f2812ae1fa3bd48bb40b276c4a4235b1f10b9b5dc9",
    },
    // Submitted(uint256 jobId, uint256 agentId, string encCid) — agent's sealed entry.
    submitted: {
      name: "Submitted",
      topic0: "0xae08e1249fd19814a089a2a9752c327d3810a8a59ae7f4186f9d31f3c061cf61",
    },
    // ScoreRecorded(uint256 jobId, uint256 agentId, uint16 score, bytes32 scoreDigest) — the
    //   grader enclave's ecrecover'd execution score. Carries the score the leaderboard reads.
    scoreRecorded: {
      name: "ScoreRecorded",
      topic0: "0x3f1262f8c7a1883060be13e8764209845606db24de9c26de2a8c8297e57b6506",
    },
    // ValidityRecorded(uint256 jobId, uint256 agentId, bool valid, bytes32 validityAtt) — the AI
    //   attestor's verdict. Joined to ScoreRecorded on (jobId, agentId) to form a validation row.
    validityRecorded: {
      name: "ValidityRecorded",
      topic0: "0x9e90cd5e34c73b34fddfb534be16bf793d5cdf208814e5304378f3287de8545d",
    },
    // JobResolved(uint256 jobId, uint256 winnerAgentId, address provider, uint16 score,
    //   uint256 paidOut) — winner paid. jobId/winnerAgentId indexed.
    jobResolved: {
      name: "JobResolved",
      topic0: "0xb62c70cdc505593d69455190a97db971cd71bb996364450891b123f59c434693",
    },
  },
} as const;

/** Whether a Layer-2 escrow address is configured. When false the refresh loop skips Layer 2
 *  entirely, so default (production) config scans nothing beyond Layer 1. */
export const ESCROW_CONFIGURED = _escrowAddress.length > 0;

/** First block_timestamp at which ERC-8004 events appear on mainnet. */
export const HISTORY_START = "2026-01-28";

/** Window the materialized snapshot (analysis/*.csv) covers; also the default start for
 *  the live provenance queries. */
export const WINDOW = { start: "2026-05-14", end: "2026-06-12", days: 30 } as const;

/** Backfill floor for the refresh watermark when refresh_log is empty. Defaults to the mainnet
 *  history window (WINDOW.start) so production is unchanged; the demo overrides it with
 *  BQ_START=1970-01-01 so on-chain events emitted at any local-clock time are still captured. */
export const REFRESH_START = envVar("BQ_START") || WINDOW.start;

/** A counting query for one registry event since `start`. Used live (dry-run + execute). */
export function countSql(address: string, topic0: string, start: string): string {
  return `SELECT COUNT(*) AS n
FROM \`${LOGS_TABLE}\`
WHERE address = '${address}'
  AND topics[SAFE_OFFSET(0)] = '${topic0}'
  AND block_timestamp >= TIMESTAMP('${start}')`;
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

// ===========================================================================
// Materialized store — the user's own `honeycomb.*` dataset.
//
// Everything below is the SQL that stands up "the loop": a small dataset that
// INCREMENTALLY materializes the raw ERC-8004 events from the public mainnet
// logs and scores the Layer-1 trust directory as a SQL view. The expensive scan
// (raw logs) happens once on backfill and then only on the scheduled tail; all
// serving reads hit the small derived tables/view. See docs/bigquery-dashboard-plan.md.
//
// These are pure string builders (no node imports) so this file stays the single
// source of truth for addresses, topics, and SQL, importable from anywhere.
// ===========================================================================

/** The user's materialized dataset. Override with BQ_DATASET to target another. */
export const HONEYCOMB_DATASET =
  (typeof process !== "undefined" ? process.env.BQ_DATASET : undefined) || "honeycomb";

/** Decode `Registered` (Identity Registry) into the honeycomb.registrations shape.
 *  `where` is an extra predicate appended to the address/topic filter (e.g. the
 *  incremental watermark window). Mirrors docs plan §10.1. */
export function decodeRegisteredSql(where = ""): string {
  return `SELECT
      SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)       AS agent_id,
      CONCAT('0x', SUBSTR(topics[SAFE_OFFSET(2)], 27)) AS owner,
      SAFE_CONVERT_BYTES_TO_STRING(FROM_HEX(SUBSTR(
        data, 131,
        2 * SAFE_CAST(CONCAT('0x', SUBSTR(data, 67, 64)) AS INT64)
      )))                                              AS agent_uri,
      block_timestamp                                  AS registered_at,
      block_number,
      transaction_hash                                 AS tx_hash,
      log_index
    FROM \`${LOGS_TABLE}\`
    WHERE address = '${REGISTRIES.identity.address}'
      AND topics[SAFE_OFFSET(0)] = '${REGISTRIES.identity.topic0}'
      ${where}`;
}

/** Decode `NewFeedback` (Reputation Registry) into the honeycomb.feedback shape.
 *  Drops two's-complement negative values. Mirrors docs plan §10.2. */
export function decodeFeedbackSql(where = ""): string {
  return `SELECT
      SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)              AS agent_id,
      CONCAT('0x', SUBSTR(topics[SAFE_OFFSET(2)], 27))        AS client,
      SAFE_CAST(CONCAT('0x', SUBSTR(data,  67, 64)) AS INT64) AS raw_value,
      SAFE_CAST(CONCAT('0x', SUBSTR(data, 131, 64)) AS INT64) AS value_decimals,
      block_timestamp,
      block_number,
      transaction_hash                                       AS tx_hash,
      log_index
    FROM \`${LOGS_TABLE}\`
    WHERE address = '${REGISTRIES.reputation.address}'
      AND topics[SAFE_OFFSET(0)] = '${REGISTRIES.reputation.topic0}'
      AND SUBSTR(data, 67, 1) != 'f'
      ${where}`;
}

/** DDL for the three small derived tables. Idempotent (CREATE … IF NOT EXISTS). */
export function createTablesSql(ds = HONEYCOMB_DATASET): string {
  return `CREATE TABLE IF NOT EXISTS \`${ds}.registrations\` (
  agent_id INT64, owner STRING, agent_uri STRING,
  registered_at TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS \`${ds}.feedback\` (
  agent_id INT64, client STRING, raw_value INT64, value_decimals INT64, score FLOAT64,
  block_timestamp TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS \`${ds}.refresh_log\` (
  refreshed_at TIMESTAMP, scanned_from TIMESTAMP, scanned_through TIMESTAMP,
  registrations_added INT64, feedback_added INT64
);`;
}

/** Ingestion-lag buffer (minutes) for the scan watermark: each refresh re-scans this
 *  much recent time so events that land in the public table late aren't skipped.
 *  Idempotent MERGE makes the overlap free of duplicates. */
export const REFRESH_LAG_MINUTES = Number(
  (typeof process !== "undefined" ? process.env.BQ_REFRESH_LAG_MINUTES : undefined) || 120,
);

/** Compute the next refresh window from the log: scan_from = where we last scanned
 *  through (or the backfill floor when empty); scan_through = now minus the lag buffer,
 *  never going backwards. The MERGEs scan \`block_timestamp >= scan_from\` (no upper
 *  bound — clustering prunes the tail); recording scan_through advances the watermark
 *  even when the sparse feedback stream produced no new events, so scans stay cheap. */
export function refreshWindowSql(ds = HONEYCOMB_DATASET, lagMinutes = REFRESH_LAG_MINUTES, start = REFRESH_START): string {
  // Returned as clean second-precision ISO strings: a sub-second-precision literal in the
  // MERGE's WHERE defeats the optimizer's monthly-partition pruning (it would scan all
  // history). Block timestamps are second-granularity, so this loses nothing.
  return `SELECT
    FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', COALESCE(MAX(scanned_through), TIMESTAMP('${start}')), 'UTC') AS scan_from,
    FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', GREATEST(
      COALESCE(MAX(scanned_through), TIMESTAMP('${start}')),
      TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${lagMinutes} MINUTE)
    ), 'UTC') AS scan_through
  FROM \`${ds}.refresh_log\``;
}

/** Append one refresh-log row stamping the window scanned and rows added. */
export function refreshLogInsertSql(
  scanFromIso: string, scanThroughIso: string, regAdded: number, fbAdded: number, ds = HONEYCOMB_DATASET,
): string {
  return `INSERT \`${ds}.refresh_log\` (refreshed_at, scanned_from, scanned_through, registrations_added, feedback_added)
    VALUES (CURRENT_TIMESTAMP(), TIMESTAMP('${scanFromIso}'), TIMESTAMP('${scanThroughIso}'), ${regAdded}, ${fbAdded})`;
}

// --- the loop: idempotent upserts that append only new events -----------------
// One canonical MERGE per table, keyed on (tx_hash, log_index) so re-running never
// duplicates. Shared by the one-time backfill, the app refresh route, and the
// scheduled-query stored procedure below. The app runs these as DIRECT jobs, each
// with its own high `maximumBytesBilled`, because a project may set a low DEFAULT
// bytes-billed ceiling that script (`CALL`) child statements inherit but a direct
// job with an explicit cap overrides.

/** MERGE a decoded `Registered` source SELECT into the registrations table. */
export function mergeRegistrationsSql(source: string, ds = HONEYCOMB_DATASET): string {
  return `MERGE \`${ds}.registrations\` T
USING (
${source}
) S
ON T.tx_hash = S.tx_hash AND T.log_index = S.log_index
WHEN NOT MATCHED THEN
  INSERT (agent_id, owner, agent_uri, registered_at, block_number, tx_hash, log_index)
  VALUES (S.agent_id, S.owner, S.agent_uri, S.registered_at, S.block_number, S.tx_hash, S.log_index)`;
}

/** MERGE a decoded `NewFeedback` source SELECT into the feedback table (scoring the
 *  raw value at insert time: score = raw_value / 10^value_decimals). */
export function mergeFeedbackSql(source: string, ds = HONEYCOMB_DATASET): string {
  return `MERGE \`${ds}.feedback\` T
USING (
${source}
) S
ON T.tx_hash = S.tx_hash AND T.log_index = S.log_index
WHEN NOT MATCHED THEN
  INSERT (agent_id, client, raw_value, value_decimals, score, block_timestamp, block_number, tx_hash, log_index)
  VALUES (S.agent_id, S.client, S.raw_value, S.value_decimals,
          SAFE_DIVIDE(S.raw_value, POW(10, S.value_decimals)),
          S.block_timestamp, S.block_number, S.tx_hash, S.log_index)`;
}

/** Incremental (or backfill) MERGE for one table, run as a single direct job by the
 *  refresh route. `wmIso` is the table's current watermark (max event time) — pass
 *  WINDOW.start to backfill an empty table. Only events strictly newer are scanned,
 *  so after backfill this prunes to a cheap recent-partition tail. */
export function refreshRegistrationsSql(wmIso: string, ds = HONEYCOMB_DATASET): string {
  return mergeRegistrationsSql(decodeRegisteredSql(`AND block_timestamp >= TIMESTAMP('${wmIso}')`), ds);
}
export function refreshFeedbackSql(wmIso: string, ds = HONEYCOMB_DATASET): string {
  return mergeFeedbackSql(decodeFeedbackSql(`AND block_timestamp >= TIMESTAMP('${wmIso}')`), ds);
}

/** "The loop" as a BigQuery-native stored procedure — the zero-infra option: schedule
 *  it with a one-line scheduled query `CALL \`honeycomb.refresh\`()`. It reads each
 *  table's watermark, appends only newer events (literal-injected via EXECUTE IMMEDIATE
 *  so the source scan prunes to the tail), and writes a refresh-log row. Steady-state
 *  incremental runs scan little; a cold backfill via CALL needs the project's default
 *  bytes-billed ceiling raised (or use the app /api/refresh route, which sets its own). */
export function refreshProcedureSql(ds = HONEYCOMB_DATASET, start = REFRESH_START, lagMinutes = REFRESH_LAG_MINUTES): string {
  // The watermark is injected as a clean second-precision literal (%s) so partition
  // pruning holds; scan_through is truncated to the second so it stays clean when read back.
  const regMerge = mergeRegistrationsSql(decodeRegisteredSql("AND block_timestamp >= TIMESTAMP('%s')"), ds);
  const fbMerge = mergeFeedbackSql(decodeFeedbackSql("AND block_timestamp >= TIMESTAMP('%s')"), ds);
  const cleanFrom = "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', scan_from, 'UTC')";
  // Layer 2 runs in the same watermark window. Gated on a configured escrow so a production
  // proc generated with no escrow is byte-identical to the Layer-1-only version (no extra scan).
  // Counts aren't tracked separately — refresh_log keeps its Layer-1 schema; the shared
  // scanned_through watermark is what makes the next incremental run cheap.
  const wm = "AND block_timestamp >= TIMESTAMP('%s')";
  const ei = (sql: string) => `  EXECUTE IMMEDIATE FORMAT("""\n${sql}\n  """, ${cleanFrom});`;
  const layer2 = ESCROW_CONFIGURED
    ? "\n" +
      [
        ei(mergeBountiesSql(decodeBountiesSql(wm), ds)),
        ei(mergeSubmissionsSql(decodeSubmissionsSql(wm), ds)),
        ei(mergeValidationsSql(decodeValidationsSql(wm), ds)),
        ei(mergeSettlementsSql(decodeSettlementsSql(wm), ds)),
      ].join("\n") +
      "\n"
    : "";
  return `CREATE OR REPLACE PROCEDURE \`${ds}.refresh\`()
BEGIN
  DECLARE scan_from TIMESTAMP DEFAULT (
    SELECT COALESCE(MAX(scanned_through), TIMESTAMP('${start}')) FROM \`${ds}.refresh_log\`
  );
  DECLARE scan_through TIMESTAMP DEFAULT TIMESTAMP_TRUNC(GREATEST(
    (SELECT COALESCE(MAX(scanned_through), TIMESTAMP('${start}')) FROM \`${ds}.refresh_log\`),
    TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${lagMinutes} MINUTE)
  ), SECOND);
  DECLARE reg_added INT64 DEFAULT 0;
  DECLARE fb_added  INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT("""
${regMerge}
  """, ${cleanFrom});
  SET reg_added = @@row_count;

  EXECUTE IMMEDIATE FORMAT("""
${fbMerge}
  """, ${cleanFrom});
  SET fb_added = @@row_count;
${layer2}
  INSERT \`${ds}.refresh_log\` (refreshed_at, scanned_from, scanned_through, registrations_added, feedback_added)
  VALUES (CURRENT_TIMESTAMP(), scan_from, scan_through, reg_added, fb_added);
END;`;
}

/** The Layer-1 trust/sybil-resistance scoring, as a SQL view that reproduces
 *  analysis/erc8004_trust.csv (the deleted trust_score.py, docs plan §10.3). A
 *  client reviewing >= `ringBreadth` distinct agents is treated as a sybil/ring
 *  wallet; an agent's trust is its avg feedback score discounted by how few
 *  INDEPENDENT (non-ring) reviewers it has. name/services/x402 are decoded from the
 *  agent's on-chain ERC-8004 card (a base64 data: URI in agent_uri); for ipfs/https
 *  URIs they stay NULL until a Phase-4 off-chain resolver fetches the card. */
export function agentTrustViewSql(ds = HONEYCOMB_DATASET, ringBreadth = 10): string {
  return `CREATE OR REPLACE VIEW \`${ds}.agent_trust\` AS
WITH
  fb AS (
    SELECT agent_id, LOWER(client) AS client, score FROM \`${ds}.feedback\`
  ),
  breadth AS (
    SELECT client, COUNT(DISTINCT agent_id) AS breadth FROM fb GROUP BY client
  ),
  reg AS (  -- latest registration per agent (owner + uri)
    SELECT agent_id, LOWER(owner) AS owner, agent_uri
    FROM \`${ds}.registrations\`
    QUALIFY ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY block_number DESC, log_index DESC) = 1
  ),
  per_fb AS (  -- each feedback row tagged with its client's global breadth
    SELECT f.agent_id, f.client, f.score, b.breadth
    FROM fb f JOIN breadth b USING (client)
  ),
  agg AS (
    SELECT
      agent_id,
      COUNT(*)                                              AS feedback_count,
      COUNT(DISTINCT client)                                AS unique_clients,
      ROUND(AVG(score), 2)                                  AS avg_score,
      ROUND(AVG(breadth), 2)                                AS reviewer_ring,
      COUNT(DISTINCT IF(breadth < ${ringBreadth}, client, NULL)) AS independent_clients
    FROM per_fb
    GROUP BY agent_id
  ),
  scored AS (
    SELECT
      a.agent_id, a.feedback_count, a.unique_clients, a.avg_score,
      a.reviewer_ring, a.independent_clients, r.agent_uri, r.owner,
      IF(r.owner IS NOT NULL
         AND EXISTS(SELECT 1 FROM per_fb p WHERE p.agent_id = a.agent_id AND p.client = r.owner),
         1, 0) AS self_feedback
    FROM agg a
    LEFT JOIN reg r USING (agent_id)
  ),
  mult AS (
    SELECT
      base.*,
      IF(independent_clients >= 5, LEAST(1.0, base_mult * 1.3), base_mult) AS trust_mult_raw
    FROM (
      SELECT
        scored.*,
        ( IF(self_feedback = 1, 0.3, 1.0)
          * CASE WHEN independent_clients = 0 THEN 0.1
                 WHEN independent_clients < 3 THEN 0.5
                 ELSE 1.0 END
          * IF(reviewer_ring >= ${ringBreadth}, 0.5, 1.0) ) AS base_mult
      FROM scored
    ) base
  ),
  carded AS (  -- decode the agent's on-chain ERC-8004 card (base64 data: URI). NULL for
               -- ipfs/https URIs — those a Phase-4 off-chain resolver fetches instead.
    SELECT
      mult.*,
      IF(STARTS_WITH(agent_uri, 'data:application/json;base64,'),
         SAFE_CONVERT_BYTES_TO_STRING(SAFE.FROM_BASE64(
           SUBSTR(agent_uri, LENGTH('data:application/json;base64,') + 1))),
         NULL) AS card
    FROM mult
  )
SELECT
  agent_id,
  owner,                                                      -- on-chain agent owner (ERC-721)
  JSON_VALUE(card, '$.name')            AS name,              -- from the on-chain agent card
  avg_score,
  feedback_count,
  unique_clients,
  independent_clients,
  reviewer_ring,
  self_feedback,
  ROUND(trust_mult_raw, 3)              AS trust_mult,
  ROUND(avg_score * trust_mult_raw, 2)  AS trust_score,
  COALESCE(NULLIF(TRIM(CONCAT(
    IF(self_feedback = 1, 'self-feedback; ', ''),
    CASE WHEN independent_clients = 0 THEN 'ring-only reviewers; '
         WHEN independent_clients < 3 THEN CONCAT(FORMAT('%.1f', CAST(independent_clients AS FLOAT64)), ' independent client(s); ')
         ELSE '' END,
    IF(reviewer_ring >= ${ringBreadth}, CONCAT('reviewed by ring wallet (breadth ', CAST(CAST(TRUNC(reviewer_ring) AS INT64) AS STRING), '); '), ''),
    IF(independent_clients >= 5, 'broad independent client base; ', '')
  ), '; '), ''), 'clean')               AS flags,
  COALESCE(SAFE_CAST(JSON_VALUE(card, '$.x402') AS BOOL), FALSE) AS x402_resolved,  -- from the card
  (SELECT STRING_AGG(JSON_VALUE(s, '$.name'), ',')
     FROM UNNEST(JSON_EXTRACT_ARRAY(card, '$.services')) AS s)  AS services,        -- from the card
  agent_uri
FROM carded
ORDER BY trust_score DESC, unique_clients DESC`;
}

/** Serving read: the small trust directory. Scans the derived tables (~MB), not the
 *  raw logs — safe to put behind a short TTL cache and hit per request. */
export function agentTrustSelectSql(ds = HONEYCOMB_DATASET): string {
  return `SELECT
      agent_id, owner, name, avg_score, feedback_count, unique_clients,
      independent_clients, reviewer_ring, trust_mult, trust_score,
      flags, x402_resolved, services, agent_uri
    FROM \`${ds}.agent_trust\`
    ORDER BY trust_score DESC, unique_clients DESC`;
}

/** Freshness stamp for the serving layer: newest event block/timestamp in the store
 *  and the last refresh-loop run. Scans only INT64/TIMESTAMP columns of the small
 *  derived tables (~KB). */
export function storeMetaSql(ds = HONEYCOMB_DATASET): string {
  return `SELECT
    GREATEST(
      IFNULL((SELECT MAX(block_number) FROM \`${ds}.registrations\`), 0),
      IFNULL((SELECT MAX(block_number) FROM \`${ds}.feedback\`), 0)
    ) AS as_of_block,
    GREATEST(
      IFNULL((SELECT MAX(registered_at)  FROM \`${ds}.registrations\`), TIMESTAMP('1970-01-01')),
      IFNULL((SELECT MAX(block_timestamp) FROM \`${ds}.feedback\`),     TIMESTAMP('1970-01-01'))
    ) AS as_of,
    (SELECT MAX(refreshed_at) FROM \`${ds}.refresh_log\`) AS last_refresh`;
}

// ===========================================================================
// Layer 2 — the bounty market. Decoded from the Honeycomb escrow's events by the SAME
// BigQuery decode→MERGE loop as Layer 1 (no off-chain indexer in the production path): the
// /api/refresh route scans LOGS_TABLE for ESCROW.{event} and upserts into these tables, which
// reputation.ts reads to build the earned-reputation leaderboard. The demo points LOGS_TABLE +
// BQ_ESCROW_ADDRESS at a local mock so it exercises this identical SQL; the serving reads below
// stay identical whether the source is the mainnet public table or the demo fixture.
// ===========================================================================

/** DDL for the Layer-2 market tables. Idempotent (CREATE … IF NOT EXISTS). */
export function createMarketTablesSql(ds = HONEYCOMB_DATASET): string {
  return `CREATE TABLE IF NOT EXISTS \`${ds}.bounties\` (
  bounty_id INT64, requester STRING, category STRING, title STRING, reward_eth FLOAT64,
  created_at TIMESTAMP, deadline TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS \`${ds}.submissions\` (
  bounty_id INT64, agent_id INT64, submission_cid STRING, submitted_at TIMESTAMP,
  block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS \`${ds}.validations\` (
  bounty_id INT64, agent_id INT64, validator STRING, response INT64, valid BOOL,
  response_hash STRING, validated_at TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS \`${ds}.settlements\` (
  bounty_id INT64, winner_agent_id INT64, winner_score INT64, attestation_hash STRING,
  settled_at TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);`;
}

// --- Layer-2 decoders: raw escrow logs → the market-table shapes -------------------------
// Same offset math as Layer 1 (see decodeRegisteredSql + the handoff doc §7). `data` is the
// public-table STRING column ('0x'+hex, lowercase); SUBSTR is 1-indexed, so data word k
// (0-indexed) is SUBSTR(data, 3 + k*64, 64). Indexed params come from `topics`. JobCreated and
// Submitted each carry one trailing `string` (specCid / encCid); the verdict decoder joins the
// two fixed-width events ScoreRecorded + ValidityRecorded. The decoders preserve the original
// market-table column shapes so reputation.ts is unchanged across the contract refactor.

/** Decode `JobCreated` → honeycomb.bounties. Indexed: jobId (topic1), client (topic2). The data
 *  head is 5 words — token(w0), budget(w1, uint256 token base units), expiredAt(w2, uint64),
 *  testsHash(w3), specCid-offset(w4 = 0xa0). The new contract has no on-chain category/title, so
 *  `category` is the constant 'grading' and `title` is the specCid (the lone trailing string: its
 *  length sits at byte 160 = char 323, its bytes at char 387). `reward_eth` here is the reward in
 *  whole token units = budget / 1e6 (USDC is 6-decimal), NOT wei/1e18; budget fits INT64 for any
 *  realistic USDC reward (1e6 base units ~ 9.2e12 USDC ceiling), so a single SAFE_CAST suffices. */
export function decodeBountiesSql(where = ""): string {
  return `SELECT
      SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)        AS bounty_id,
      CONCAT('0x', SUBSTR(topics[SAFE_OFFSET(2)], 27))  AS requester,
      'grading'                                         AS category,
      SAFE_CONVERT_BYTES_TO_STRING(FROM_HEX(SUBSTR(
        data, 387,
        2 * SAFE_CAST(CONCAT('0x', SUBSTR(data, 323, 64)) AS INT64)
      )))                                               AS title,
      SAFE_CAST(CONCAT('0x', SUBSTR(data, 67, 64)) AS INT64) / 1e6 AS reward_eth,
      block_timestamp                                   AS created_at,
      TIMESTAMP_SECONDS(SAFE_CAST(CONCAT('0x', SUBSTR(data, 131, 64)) AS INT64)) AS deadline,
      block_number,
      transaction_hash                                  AS tx_hash,
      log_index
    FROM \`${LOGS_TABLE}\`
    WHERE address = '${ESCROW.address}'
      AND topics[SAFE_OFFSET(0)] = '${ESCROW.events.jobCreated.topic0}'
      ${where}`;
}

/** Decode `Submitted` → honeycomb.submissions. Indexed: jobId (topic1), agentId (topic2). encCid
 *  is the only non-indexed param (a trailing string at offset 0x20 — same layout as
 *  decodeRegisteredSql's agent_uri: length word at char 67, bytes at char 131). */
export function decodeSubmissionsSql(where = ""): string {
  return `SELECT
      SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64) AS bounty_id,
      SAFE_CAST(topics[SAFE_OFFSET(2)] AS INT64) AS agent_id,
      SAFE_CONVERT_BYTES_TO_STRING(FROM_HEX(SUBSTR(
        data, 131,
        2 * SAFE_CAST(CONCAT('0x', SUBSTR(data, 67, 64)) AS INT64)
      )))                                        AS submission_cid,
      block_timestamp                            AS submitted_at,
      block_number,
      transaction_hash                           AS tx_hash,
      log_index
    FROM \`${LOGS_TABLE}\`
    WHERE address = '${ESCROW.address}'
      AND topics[SAFE_OFFSET(0)] = '${ESCROW.events.submitted.topic0}'
      ${where}`;
}

/** Decode the validation verdict → honeycomb.validations. The live contract splits the old single
 *  ValidationRecorded into two per-agent events: ScoreRecorded (the grader enclave's execution
 *  score + scoreDigest) and ValidityRecorded (the AI attestor's valid flag). A validation row is
 *  their LEFT JOIN on (jobId, agentId): the score is the primary signal (reputation.ts reads
 *  `response`), so the row is keyed on the ScoreRecorded log's (tx_hash, log_index) for the MERGE
 *  dedup, and `valid` is pulled from the matching ValidityRecorded (defaulting TRUE when validity
 *  has not landed yet — an unjudged score isn't a failed attestation).
 *    ScoreRecorded data: score(uint16, w0 → char 3), scoreDigest(bytes32, w1 → char 67).
 *    ValidityRecorded data: valid(bool, w0 → char 3), validityAtt(bytes32, w1 → char 67).
 *  There is no per-event `validator` address (the attesterKey lives on the Job), so it is '' —
 *  the dashboard's validator label falls back gracefully. `where` is applied to the score side
 *  (the row's identity) only; the validity side is unfiltered so a late validity still joins. */
export function decodeValidationsSql(where = ""): string {
  return `SELECT
      s.bounty_id,
      s.agent_id,
      ''                                AS validator,
      s.response,
      COALESCE(v.valid, TRUE)           AS valid,
      s.response_hash,
      s.validated_at,
      s.block_number,
      s.tx_hash,
      s.log_index
    FROM (
      SELECT
        SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)              AS bounty_id,
        SAFE_CAST(topics[SAFE_OFFSET(2)] AS INT64)              AS agent_id,
        SAFE_CAST(CONCAT('0x', SUBSTR(data, 3, 64)) AS INT64)   AS response,
        CONCAT('0x', SUBSTR(data, 67, 64))                      AS response_hash,
        block_timestamp                                         AS validated_at,
        block_number,
        transaction_hash                                        AS tx_hash,
        log_index
      FROM \`${LOGS_TABLE}\`
      WHERE address = '${ESCROW.address}'
        AND topics[SAFE_OFFSET(0)] = '${ESCROW.events.scoreRecorded.topic0}'
        ${where}
    ) s
    LEFT JOIN (
      SELECT
        SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)              AS bounty_id,
        SAFE_CAST(topics[SAFE_OFFSET(2)] AS INT64)              AS agent_id,
        SAFE_CAST(CONCAT('0x', SUBSTR(data, 3, 64)) AS INT64) != 0 AS valid
      FROM \`${LOGS_TABLE}\`
      WHERE address = '${ESCROW.address}'
        AND topics[SAFE_OFFSET(0)] = '${ESCROW.events.validityRecorded.topic0}'
    ) v
    USING (bounty_id, agent_id)`;
}

/** Decode `JobResolved` → honeycomb.settlements. Indexed: jobId (topic1), winnerAgentId (topic2).
 *  Data is all fixed-width: provider(address, right-aligned in w0 → char 27..67), score(uint16,
 *  w1 → char 67), paidOut(uint256, w2 → char 131). The event carries no attestation digest, so
 *  `attestation_hash` holds the winner's provider address (the on-chain settlement provenance the
 *  closed-bounties panel shows); `winner_score` is the resolved leader's execution score. */
export function decodeSettlementsSql(where = ""): string {
  return `SELECT
      SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)             AS bounty_id,
      SAFE_CAST(topics[SAFE_OFFSET(2)] AS INT64)             AS winner_agent_id,
      SAFE_CAST(CONCAT('0x', SUBSTR(data, 67, 64)) AS INT64) AS winner_score,
      CONCAT('0x', SUBSTR(data, 27, 40))                     AS attestation_hash,
      block_timestamp                                        AS settled_at,
      block_number,
      transaction_hash                                       AS tx_hash,
      log_index
    FROM \`${LOGS_TABLE}\`
    WHERE address = '${ESCROW.address}'
      AND topics[SAFE_OFFSET(0)] = '${ESCROW.events.jobResolved.topic0}'
      ${where}`;
}

// --- Layer-2 MERGEs: idempotent on (tx_hash, log_index), mirroring mergeRegistrationsSql ----

/** MERGE a decoded `JobCreated` source SELECT into the bounties table. */
export function mergeBountiesSql(source: string, ds = HONEYCOMB_DATASET): string {
  return `MERGE \`${ds}.bounties\` T
USING (
${source}
) S
ON T.tx_hash = S.tx_hash AND T.log_index = S.log_index
WHEN NOT MATCHED THEN
  INSERT (bounty_id, requester, category, title, reward_eth, created_at, deadline, block_number, tx_hash, log_index)
  VALUES (S.bounty_id, S.requester, S.category, S.title, S.reward_eth, S.created_at, S.deadline, S.block_number, S.tx_hash, S.log_index)`;
}

/** MERGE a decoded `Submitted` source SELECT into the submissions table. */
export function mergeSubmissionsSql(source: string, ds = HONEYCOMB_DATASET): string {
  return `MERGE \`${ds}.submissions\` T
USING (
${source}
) S
ON T.tx_hash = S.tx_hash AND T.log_index = S.log_index
WHEN NOT MATCHED THEN
  INSERT (bounty_id, agent_id, submission_cid, submitted_at, block_number, tx_hash, log_index)
  VALUES (S.bounty_id, S.agent_id, S.submission_cid, S.submitted_at, S.block_number, S.tx_hash, S.log_index)`;
}

/** MERGE a decoded `ScoreRecorded`⋈`ValidityRecorded` source SELECT into the validations table. */
export function mergeValidationsSql(source: string, ds = HONEYCOMB_DATASET): string {
  return `MERGE \`${ds}.validations\` T
USING (
${source}
) S
ON T.tx_hash = S.tx_hash AND T.log_index = S.log_index
WHEN NOT MATCHED THEN
  INSERT (bounty_id, agent_id, validator, response, valid, response_hash, validated_at, block_number, tx_hash, log_index)
  VALUES (S.bounty_id, S.agent_id, S.validator, S.response, S.valid, S.response_hash, S.validated_at, S.block_number, S.tx_hash, S.log_index)`;
}

/** MERGE a decoded `JobResolved` source SELECT into the settlements table. */
export function mergeSettlementsSql(source: string, ds = HONEYCOMB_DATASET): string {
  return `MERGE \`${ds}.settlements\` T
USING (
${source}
) S
ON T.tx_hash = S.tx_hash AND T.log_index = S.log_index
WHEN NOT MATCHED THEN
  INSERT (bounty_id, winner_agent_id, winner_score, attestation_hash, settled_at, block_number, tx_hash, log_index)
  VALUES (S.bounty_id, S.winner_agent_id, S.winner_score, S.attestation_hash, S.settled_at, S.block_number, S.tx_hash, S.log_index)`;
}

// --- Layer-2 refresh wrappers: one incremental (or backfill) MERGE per table, each run as its
// own direct job by /api/refresh. `wmIso` is the scan watermark — pass REFRESH_START to backfill.
export function refreshBountiesSql(wmIso: string, ds = HONEYCOMB_DATASET): string {
  return mergeBountiesSql(decodeBountiesSql(`AND block_timestamp >= TIMESTAMP('${wmIso}')`), ds);
}
export function refreshSubmissionsSql(wmIso: string, ds = HONEYCOMB_DATASET): string {
  return mergeSubmissionsSql(decodeSubmissionsSql(`AND block_timestamp >= TIMESTAMP('${wmIso}')`), ds);
}
export function refreshValidationsSql(wmIso: string, ds = HONEYCOMB_DATASET): string {
  return mergeValidationsSql(decodeValidationsSql(`AND block_timestamp >= TIMESTAMP('${wmIso}')`), ds);
}
export function refreshSettlementsSql(wmIso: string, ds = HONEYCOMB_DATASET): string {
  return mergeSettlementsSql(decodeSettlementsSql(`AND block_timestamp >= TIMESTAMP('${wmIso}')`), ds);
}

/** Serving reads for the Layer-2 market (small decoded tables — never the raw logs). */
export function selectBountiesSql(ds = HONEYCOMB_DATASET): string {
  return `SELECT bounty_id, requester, category, title, reward_eth, tx_hash,
      FORMAT_TIMESTAMP('%Y-%m-%d', created_at) AS created_at,
      FORMAT_TIMESTAMP('%Y-%m-%d', deadline)   AS deadline
    FROM \`${ds}.bounties\` ORDER BY bounty_id`;
}
export function selectSubmissionsSql(ds = HONEYCOMB_DATASET): string {
  return `SELECT bounty_id, agent_id, submission_cid FROM \`${ds}.submissions\``;
}
export function selectValidationsSql(ds = HONEYCOMB_DATASET): string {
  return `SELECT bounty_id, agent_id, validator, response, valid, response_hash FROM \`${ds}.validations\``;
}
export function selectSettlementsSql(ds = HONEYCOMB_DATASET): string {
  return `SELECT bounty_id, winner_agent_id, winner_score, attestation_hash, tx_hash FROM \`${ds}.settlements\``;
}
/** Layer-2 agents = registered agents (id + owner) that are relevant to the market: they have
 *  on-chain reputation (appear in agent_trust) OR have participated (submitted / won a bounty).
 *  Avoids listing every registration as a zero-signal "unproven" row in the leaderboard. */
export function selectMarketAgentsSql(ds = HONEYCOMB_DATASET): string {
  return `WITH latest AS (
      SELECT agent_id, LOWER(owner) AS owner, agent_uri
      FROM \`${ds}.registrations\`
      QUALIFY ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY block_number DESC, log_index DESC) = 1
    )
    SELECT agent_id, owner, agent_uri FROM latest
    WHERE agent_id IN (SELECT agent_id FROM \`${ds}.agent_trust\`)
       OR agent_id IN (SELECT agent_id FROM \`${ds}.submissions\`)
       OR agent_id IN (SELECT winner_agent_id FROM \`${ds}.settlements\`)
    ORDER BY agent_id`;
}
