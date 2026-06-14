-- ============================================================================
-- Neon Postgres schema for persisted Honeycomb MCP monitor data.
--
-- Three tables, mirroring the read tools in tools/monitor.ts + tools/grade.ts:
--   jobs    current state, UPSERTED per snapshot (one row per jobId)
--   events  append-only chain log (ScoreRecorded / ValidityRecorded / NewLeader
--           / JobCreated / JobResolved), deduped on (tx_hash, log_index)
--   grades  append-only grader output (score + validity + digests), one row per
--           grade_submission call
--
-- All bigint-ish chain values (job ids, agent ids, budgets) are stored as TEXT
-- because they can exceed 2^53 / bigint range; numeric mirrors are kept where
-- they fit and are useful for ordering/aggregation (budget_usdc, score).
--
-- Idempotent: safe to re-run. The snapshot script applies this on every run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS jobs (
  job_id              TEXT PRIMARY KEY,         -- ERC-8183 job id (can exceed 2^53)
  status              SMALLINT,
  status_name         TEXT,
  client              TEXT,
  provider            TEXT,
  evaluator           TEXT,
  budget              TEXT,                     -- raw uint256 (USDC base units)
  budget_usdc         NUMERIC,                  -- budget / 1e6, convenient for math
  expired_at          BIGINT,                   -- unix seconds
  expired_at_iso      TIMESTAMPTZ,
  token               TEXT,
  tests_hash          TEXT,
  spec_cid            TEXT,
  attester_key        TEXT,
  maker_pubkey        TEXT,
  enclave_enc_pub     TEXT,
  hook                TEXT,
  is_contest          BOOLEAN,
  best_agent_id       TEXT,
  best_score          INTEGER,
  best_score_att      TEXT,
  best_validity_att   TEXT,
  grade_count         INTEGER,
  winner_delivery_cid TEXT,
  settled             BOOLEAN,
  winner_wallet       TEXT,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_updated_idx ON jobs (updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  event_name   TEXT NOT NULL,                   -- ScoreRecorded | ValidityRecorded | NewLeader | JobCreated | JobResolved
  job_id       TEXT,
  agent_id     TEXT,                            -- ScoreRecorded / ValidityRecorded / NewLeader / JobResolved(winner)
  payload      JSONB NOT NULL,                  -- full decoded args (bigints as strings)
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, log_index)              -- a single chain log is globally unique here
);

CREATE INDEX IF NOT EXISTS events_job_idx ON events (job_id);
CREATE INDEX IF NOT EXISTS events_name_idx ON events (event_name);
CREATE INDEX IF NOT EXISTS events_block_idx ON events (block_number DESC);

CREATE TABLE IF NOT EXISTS grades (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id             TEXT,
  agent_id           TEXT,
  bounty             TEXT,                       -- directional | lp
  score              INTEGER,
  valid              BOOLEAN,
  score_digest       TEXT,
  validity_att       TEXT,
  attestation_source TEXT,                       -- 'confidential-space' when enclave-graded, else null/local
  signer             TEXT,
  local_score        INTEGER,                    -- enclave path keeps the local score for comparison
  callback           JSONB NOT NULL,             -- full grade_submission return (minus graderLog)
  graded_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grades_job_idx ON grades (job_id);
CREATE INDEX IF NOT EXISTS grades_agent_idx ON grades (agent_id);

-- tool_calls: append-only telemetry of every MCP tool invocation forwarded
-- through honeycomb-api. One row per HTTP request the API handles (every plugin
-- tool call lands here). Captures the FULL request body + response per the
-- "log everything" decision — submission source and specs included, so this DB
-- is a complete replay log. Written fire-and-forget; a telemetry failure must
-- never fail the underlying call.
CREATE TABLE IF NOT EXISTS tool_calls (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool        TEXT NOT NULL,                  -- logical tool name (get_job, grade_submission, ...)
  method      TEXT NOT NULL,                  -- HTTP method (GET/POST)
  path        TEXT NOT NULL,                  -- request pathname (/jobs/1, /grade, ...)
  query       JSONB,                          -- query params (read routes)
  request     JSONB,                          -- full request body (write routes) — may hold submission source
  response    JSONB,                          -- full response payload (or {error} on failure)
  status      INTEGER NOT NULL,               -- HTTP status returned
  ok          BOOLEAN NOT NULL,               -- status < 400
  latency_ms  INTEGER NOT NULL,               -- wall-clock handler latency
  caller      TEXT,                           -- x-honeycomb-caller / user-agent, best effort
  remote_addr TEXT,                           -- client IP if surfaced by the runtime
  called_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_calls_tool_idx ON tool_calls (tool);
CREATE INDEX IF NOT EXISTS tool_calls_time_idx ON tool_calls (called_at DESC);
CREATE INDEX IF NOT EXISTS tool_calls_ok_idx ON tool_calls (ok);

-- gcs_objects: the off-chain content layer index. One row per content-addressed
-- blob written to GCS — the bytes the on-chain specCid / encCid pointers resolve
-- into (see apps/honeycomb-mcp/storage/gcs.ts). The on-chain pointer says WHERE the
-- content lives; this table is the DB's mirror of WHAT was put there, so a job's
-- spec and every sealed submission are queryable (and re-verifiable) without a
-- chain read. Keyed by (bucket, sha256): the key IS the content hash, so the same
-- bytes uploaded twice collapse to one row (ON CONFLICT DO NOTHING — idempotent).
-- Written fire-and-forget from the put paths; a telemetry failure must never fail a
-- bounty create or a submission.
CREATE TABLE IF NOT EXISTS gcs_objects (
  bucket       TEXT NOT NULL,                  -- honeycomb-specs | honeycomb-submissions
  sha256       TEXT NOT NULL,                  -- content-address key (== object name in GCS)
  uri          TEXT NOT NULL,                  -- gcs://<bucket>/<sha256> (== on-chain specCid/encCid)
  kind         TEXT NOT NULL,                  -- 'spec' | 'submission' (what the blob is)
  content_type TEXT,                           -- advisory MIME (text/markdown, application/octet-stream)
  byte_len     INTEGER,                        -- ciphertext/markdown length in bytes
  job_id       TEXT,                           -- the bounty this blob belongs to (NULL if pre-create)
  agent_id     TEXT,                           -- submitting agent (submissions only)
  submit_tx    TEXT,                           -- on-chain submit() tx that registered an encCid (submissions)
  sealed       BOOLEAN NOT NULL DEFAULT FALSE, -- true for sealed-box submission ciphertext
  stored_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, sha256)                 -- content-addressed: identical bytes are one row
);

CREATE INDEX IF NOT EXISTS gcs_objects_job_idx ON gcs_objects (job_id);
CREATE INDEX IF NOT EXISTS gcs_objects_kind_idx ON gcs_objects (kind);
CREATE INDEX IF NOT EXISTS gcs_objects_time_idx ON gcs_objects (stored_at DESC);
