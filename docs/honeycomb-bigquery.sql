-- ===========================================================================
-- honeycomb.* — the live ERC-8004 trust store (BigQuery)
-- ===========================================================================
-- Stands up "the loop": a small dataset that incrementally materializes the raw
-- ERC-8004 identity + reputation events from the public Ethereum mainnet logs and
-- scores the Layer-1 trust directory as a SQL view. The expensive raw-log scan
-- happens once on backfill, then only on the scheduled tail; all serving reads hit
-- the small derived tables/view.
--
-- GENERATED from apps/web/src/lib/bq.ts (the single source of truth for addresses,
-- topics, and SQL). Regenerate after editing bq.ts with:
--   cd apps/web && npx tsc src/lib/bq.ts --outDir /tmp/bq --module commonjs --skipLibCheck \
--     && node -e 'const b=require("/tmp/bq/bq.js");console.log(b.createTablesSql(),b.refreshProcedureSql(),b.agentTrustViewSql())'
--
-- Run order: schema → tables → procedure → view → backfill (see docs/bigquery-runbook.md).
-- Run every statement in the US region (to match the public source dataset).
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS `honeycomb` OPTIONS(location = 'US');

-- ---- decoded raw events (append-only) + refresh telemetry ----------------------
CREATE TABLE IF NOT EXISTS `honeycomb.registrations` (
  agent_id INT64, owner STRING, agent_uri STRING,
  registered_at TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS `honeycomb.feedback` (
  agent_id INT64, client STRING, raw_value INT64, value_decimals INT64, score FLOAT64,
  block_timestamp TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS `honeycomb.refresh_log` (
  refreshed_at TIMESTAMP, scanned_from TIMESTAMP, scanned_through TIMESTAMP,
  registrations_added INT64, feedback_added INT64
);

-- ---- Layer 2: the bounty market (decoded from the Honeycomb escrow's events) -----
-- reputation.ts reads these. Empty until the escrow ships on mainnet; populated by the
-- indexer in the local demo (tools/chain-verify). Generated from createMarketTablesSql in bq.ts.
CREATE TABLE IF NOT EXISTS `honeycomb.bounties` (
  bounty_id INT64, requester STRING, category STRING, title STRING, reward_eth FLOAT64,
  created_at TIMESTAMP, deadline TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS `honeycomb.submissions` (
  bounty_id INT64, agent_id INT64, submission_cid STRING, submitted_at TIMESTAMP,
  block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS `honeycomb.validations` (
  bounty_id INT64, agent_id INT64, validator STRING, response INT64, valid BOOL,
  response_hash STRING, validated_at TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);
CREATE TABLE IF NOT EXISTS `honeycomb.settlements` (
  bounty_id INT64, winner_agent_id INT64, winner_score INT64, attestation_hash STRING,
  settled_at TIMESTAMP, block_number INT64, tx_hash STRING, log_index INT64
);

-- ---- the loop: incremental MERGE from the watermark (schedule `CALL honeycomb.refresh()`) ----
CREATE OR REPLACE PROCEDURE `honeycomb.refresh`()
BEGIN
  DECLARE scan_from TIMESTAMP DEFAULT (
    SELECT COALESCE(MAX(scanned_through), TIMESTAMP('2026-05-14')) FROM `honeycomb.refresh_log`
  );
  DECLARE scan_through TIMESTAMP DEFAULT TIMESTAMP_TRUNC(GREATEST(
    (SELECT COALESCE(MAX(scanned_through), TIMESTAMP('2026-05-14')) FROM `honeycomb.refresh_log`),
    TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 120 MINUTE)
  ), SECOND);
  DECLARE reg_added INT64 DEFAULT 0;
  DECLARE fb_added  INT64 DEFAULT 0;

  -- watermark injected as a clean second-precision literal so monthly-partition pruning holds
  EXECUTE IMMEDIATE FORMAT("""
MERGE `honeycomb.registrations` T
USING (
SELECT
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
    FROM `bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs`
    WHERE address = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432'
      AND topics[SAFE_OFFSET(0)] = '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a'
      AND block_timestamp >= TIMESTAMP('%s')
) S
ON T.tx_hash = S.tx_hash AND T.log_index = S.log_index
WHEN NOT MATCHED THEN
  INSERT (agent_id, owner, agent_uri, registered_at, block_number, tx_hash, log_index)
  VALUES (S.agent_id, S.owner, S.agent_uri, S.registered_at, S.block_number, S.tx_hash, S.log_index)
  """, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', scan_from, 'UTC'));
  SET reg_added = @@row_count;

  EXECUTE IMMEDIATE FORMAT("""
MERGE `honeycomb.feedback` T
USING (
SELECT
      SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)              AS agent_id,
      CONCAT('0x', SUBSTR(topics[SAFE_OFFSET(2)], 27))        AS client,
      SAFE_CAST(CONCAT('0x', SUBSTR(data,  67, 64)) AS INT64) AS raw_value,
      SAFE_CAST(CONCAT('0x', SUBSTR(data, 131, 64)) AS INT64) AS value_decimals,
      block_timestamp,
      block_number,
      transaction_hash                                       AS tx_hash,
      log_index
    FROM `bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs`
    WHERE address = '0x8004baa17c55a88189ae136b182e5fda19de9b63'
      AND topics[SAFE_OFFSET(0)] = '0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc'
      AND SUBSTR(data, 67, 1) != 'f'
      AND block_timestamp >= TIMESTAMP('%s')
) S
ON T.tx_hash = S.tx_hash AND T.log_index = S.log_index
WHEN NOT MATCHED THEN
  INSERT (agent_id, client, raw_value, value_decimals, score, block_timestamp, block_number, tx_hash, log_index)
  VALUES (S.agent_id, S.client, S.raw_value, S.value_decimals,
          SAFE_DIVIDE(S.raw_value, POW(10, S.value_decimals)),
          S.block_timestamp, S.block_number, S.tx_hash, S.log_index)
  """, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', scan_from, 'UTC'));
  SET fb_added = @@row_count;

  INSERT `honeycomb.refresh_log` (refreshed_at, scanned_from, scanned_through, registrations_added, feedback_added)
  VALUES (CURRENT_TIMESTAMP(), scan_from, scan_through, reg_added, fb_added);
END;

-- ---- trust scoring view: reproduces analysis/erc8004_trust.csv -------------------
CREATE OR REPLACE VIEW `honeycomb.agent_trust` AS
WITH
  fb AS (
    SELECT agent_id, LOWER(client) AS client, score FROM `honeycomb.feedback`
  ),
  breadth AS (
    SELECT client, COUNT(DISTINCT agent_id) AS breadth FROM fb GROUP BY client
  ),
  reg AS (  -- latest registration per agent (owner + uri)
    SELECT agent_id, LOWER(owner) AS owner, agent_uri
    FROM `honeycomb.registrations`
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
      COUNT(DISTINCT IF(breadth < 10, client, NULL))        AS independent_clients
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
          * IF(reviewer_ring >= 10, 0.5, 1.0) ) AS base_mult
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
    IF(reviewer_ring >= 10, CONCAT('reviewed by ring wallet (breadth ', CAST(CAST(TRUNC(reviewer_ring) AS INT64) AS STRING), '); '), ''),
    IF(independent_clients >= 5, 'broad independent client base; ', '')
  ), '; '), ''), 'clean')               AS flags,
  FALSE                                 AS x402_resolved,   -- off-chain enrichment (Phase 4)
  CAST(NULL AS STRING)                  AS services,        -- off-chain enrichment (Phase 4)
  agent_uri
FROM mult
ORDER BY trust_score DESC, unique_clients DESC;

-- ---- backfill + schedule ---------------------------------------------------------
-- Backfill once (cold run scans ~85 GB/table; set a high bytes-billed cap as the
-- project default ceiling is low). The app does this via POST /api/refresh; or run
-- `CALL honeycomb.refresh()` with the bytes-billed limit raised. Then schedule the
-- loop every 15-30 min as a scheduled query whose body is:
--   CALL `honeycomb`.refresh();
