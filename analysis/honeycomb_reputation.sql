-- honeycomb_reputation.sql  ·  Layer 2: earned, participation-scoped agent reputation
-- ===========================================================================
-- The global ERC-8004 reputation is gameable — erc8004_trust.csv shows 101 of 105
-- agents are a single sybil wallet. For deciding payouts we don't want unsourced
-- feedback; we want *demonstrated outcomes on funded bounties*. Every input below is an
-- escrow-backed, TEE-graded settlement, so the only residual attack is self-dealing
-- (fund your own bounty, win it with your own agent) — neutralized by the collusion
-- discount here.
--
-- Tables (`honeycomb.*`) are what BigQuery materializes from the escrow contract's
-- decoded logs — BountyPosted / SubmissionReceived / Settled — decoded from mainnet logs
-- the same way the ERC-8004 registries are (see apps/web/src/lib/bq.ts). Until the
-- contract ships, the same star schema is seeded by analysis/honeycomb_{agents,bounties,
-- submissions,settlements}.csv and scored identically in apps/web/src/lib/reputation.ts.
--
-- PROVENANCE of the grade fields — this is how we utilize the ERC-8004 VALIDATION address:
--   validations.response (score) / .valid (attestation) are the ERC-8004 Validation Registry's
--   ValidationResponse(address validator, uint256 agentId, bytes32 requestHash, uint8 response,
--   string responseURI, bytes32 responseHash, string tag) — topic0
--   0xafddf629e874ccc3963b6a888c477bd464a6c8525024fc88759ea3b2326349ae — where Honeycomb's TEE
--   enclave is the `validator` and `response` (uint8) is the score. settlements.* come from the
--   escrow's Settled event; bounty metadata from BountyPosted. The EF Validation Registry has no
--   mainnet deployment yet (under TEE-community discussion); set BQ_VALIDATION_REGISTRY to read it
--   live — see apps/web/src/lib/bq.ts (VALIDATION_REGISTRY).
--
-- The cold-start blend (fall back to the global ERC-8004 trust score for agents with no
-- Honeycomb wins yet) is applied at the serving layer, NOT here — this view is the pure
-- "earned" signal. Replace `honeycomb` with your real project.dataset.
-- ===========================================================================

CREATE OR REPLACE VIEW `honeycomb.reputation` AS
WITH
  agents AS (
    SELECT agent_id, name, LOWER(owner) AS owner FROM `honeycomb.agents`
  ),

  -- one row per enclave ValidationResponse on a SETTLED bounty (the agent's graded work):
  -- `response` is the score, `valid` the attestation. Honeycomb's TEE enclave is the validator.
  graded AS (
    SELECT
      v.agent_id,
      v.bounty_id,
      v.valid    AS attestation_ok,
      v.response AS enclave_score
    FROM `honeycomb.validations` v
    JOIN `honeycomb.bounties` b USING (bounty_id)
    WHERE b.status = 'settled'
  ),

  -- one row per win, tagged self_dealt when the requester funds its own agent
  wins AS (
    SELECT
      w.winner_agent_id AS agent_id,
      w.bounty_id,
      LOWER(b.requester) AS requester,
      b.reward_eth,
      (LOWER(b.requester) = a.owner) AS self_dealt
    FROM `honeycomb.settlements` w
    JOIN `honeycomb.bounties` b USING (bounty_id)
    JOIN agents a ON a.agent_id = w.winner_agent_id
  ),

  quality AS (
    SELECT
      agent_id,
      COUNT(DISTINCT bounty_id)                       AS bounties_entered,
      ROUND(AVG(enclave_score), 1)                    AS avg_enclave_score,
      ROUND(AVG(CAST(attestation_ok AS INT64)), 3)    AS valid_attestation_rate
    FROM graded
    GROUP BY agent_id
  ),

  demand AS (
    SELECT
      agent_id,
      COUNT(*)                                              AS bounties_won,
      COUNTIF(self_dealt)                                   AS self_dealt_wins,
      COUNT(DISTINCT IF(NOT self_dealt, requester, NULL))   AS independent_requesters,
      ROUND(SUM(reward_eth), 3)                             AS value_won_eth
    FROM wins
    GROUP BY agent_id
  )

SELECT
  a.agent_id,
  a.name,
  COALESCE(q.bounties_entered, 0)         AS bounties_entered,
  COALESCE(d.bounties_won, 0)             AS bounties_won,
  COALESCE(d.independent_requesters, 0)   AS independent_requesters,
  COALESCE(d.self_dealt_wins, 0)          AS self_dealt_wins,
  q.avg_enclave_score,
  q.valid_attestation_rate,
  COALESCE(d.value_won_eth, 0)            AS value_won_eth,

  -- ---- earned reputation: NULL until the agent has won a funded bounty ----
  CASE WHEN COALESCE(d.bounties_won, 0) = 0 THEN NULL ELSE
    ROUND(LEAST(100.0, GREATEST(0.0,
        q.avg_enclave_score
      * q.valid_attestation_rate                                                   -- caught cheating hurts
      * (1 - 0.9 * SAFE_DIVIDE(COALESCE(d.self_dealt_wins, 0), d.bounties_won))     -- self-dealing discount
      * CASE                                                                        -- organic demand multiplier
          WHEN COALESCE(d.independent_requesters, 0) = 0 THEN 0.10
          WHEN d.independent_requesters = 1 THEN 0.50
          WHEN d.independent_requesters = 2 THEN 0.80
          ELSE 1.20
        END
    )), 1)
  END AS honeycomb_score,

  ARRAY_TO_STRING([
    IF(COALESCE(d.self_dealt_wins, 0) > 0,                          'self-dealing',                  NULL),
    IF(q.valid_attestation_rate < 1.0,                             'failed attestations',           NULL),
    IF(COALESCE(d.independent_requesters, 0) >= 3,                 'broad independent demand',      NULL),
    IF(COALESCE(d.independent_requesters, 0) = 1,                  'single-requester concentration', NULL),
    IF(COALESCE(d.bounties_won, 0) = 0,                            'cold-start (no wins yet)',       NULL)
  ], '; ') AS flags

FROM agents a
LEFT JOIN quality q USING (agent_id)
LEFT JOIN demand   d USING (agent_id)
ORDER BY honeycomb_score DESC NULLS LAST;
