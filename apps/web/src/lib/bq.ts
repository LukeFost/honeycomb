// ERC-8004 on-chain constants + the exact BigQuery SQL the dashboard runs against
// Ethereum mainnet. Pure strings only (no node imports) so this is safe to import from
// both the server (the /api/bigquery route) and the client (the live-query panel that
// renders the SQL).

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

/** Window the materialized snapshot (analysis/*.csv) covers; also the default start for
 *  the live provenance queries. */
export const WINDOW = { start: "2026-05-14", end: "2026-06-12", days: 30 } as const;

/** A counting query for one registry event since `start`. Used live (dry-run + execute). */
export function countSql(address: string, topic0: string, start: string): string {
  return `SELECT COUNT(*) AS n
FROM \`${DATASET}\`
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
    FROM \`${DATASET}\`
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
    FROM \`${DATASET}\`
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
export function refreshWindowSql(ds = HONEYCOMB_DATASET, lagMinutes = REFRESH_LAG_MINUTES, start = WINDOW.start): string {
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
export function refreshProcedureSql(ds = HONEYCOMB_DATASET, start = WINDOW.start, lagMinutes = REFRESH_LAG_MINUTES): string {
  // The watermark is injected as a clean second-precision literal (%s) so partition
  // pruning holds; scan_through is truncated to the second so it stays clean when read back.
  const regMerge = mergeRegistrationsSql(decodeRegisteredSql("AND block_timestamp >= TIMESTAMP('%s')"), ds);
  const fbMerge = mergeFeedbackSql(decodeFeedbackSql("AND block_timestamp >= TIMESTAMP('%s')"), ds);
  const cleanFrom = "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', scan_from, 'UTC')";
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

  INSERT \`${ds}.refresh_log\` (refreshed_at, scanned_from, scanned_through, registrations_added, feedback_added)
  VALUES (CURRENT_TIMESTAMP(), scan_from, scan_through, reg_added, fb_added);
END;`;
}

/** The Layer-1 trust/sybil-resistance scoring, as a SQL view that reproduces
 *  analysis/erc8004_trust.csv (the deleted trust_score.py, docs plan §10.3). A
 *  client reviewing >= `ringBreadth` distinct agents is treated as a sybil/ring
 *  wallet; an agent's trust is its avg feedback score discounted by how few
 *  INDEPENDENT (non-ring) reviewers it has. name/services/x402 are off-chain
 *  enrichment (Phase 4) and stay NULL until resolved; agent_uri is on-chain. */
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
      a.reviewer_ring, a.independent_clients, r.agent_uri,
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
  )
SELECT
  agent_id,
  CAST(NULL AS STRING)                  AS name,            -- off-chain enrichment (Phase 4)
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
  FALSE                                 AS x402_resolved,   -- off-chain enrichment (Phase 4)
  CAST(NULL AS STRING)                  AS services,        -- off-chain enrichment (Phase 4)
  agent_uri
FROM mult
ORDER BY trust_score DESC, unique_clients DESC`;
}

/** Serving read: the small trust directory. Scans the derived tables (~MB), not the
 *  raw logs — safe to put behind a short TTL cache and hit per request. */
export function agentTrustSelectSql(ds = HONEYCOMB_DATASET): string {
  return `SELECT
      agent_id, name, avg_score, feedback_count, unique_clients,
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
