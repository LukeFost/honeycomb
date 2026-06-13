# Honeycomb — BigQuery Dashboard: Implementation Plan (agent handoff)

> **Goal of this work:** make **BigQuery the live query core** for the dashboard's Layer-1
> ERC-8004 data (identity + reputation), refreshed on a loop into a small materialized store,
> and expose it through **small, separated read endpoints** that the dashboard (and a future
> MCP server) consume. Today the dashboard reads frozen CSVs; we are replacing that with a
> BigQuery → materialized-results → read-API pipeline, while keeping BigQuery visibly central
> for the sponsor track.

This doc is self-contained: read it plus the files in §1 and you have everything needed.

---

## 0. TL;DR

- Stand up the user's own BigQuery dataset (`honeycomb.*`) that **incrementally materializes**
  raw ERC-8004 events from the public mainnet logs table and computes the trust/reputation
  read models as **SQL views**.
- A **scheduled (cron) BigQuery query** is "the loop" — it pulls only new events since the last
  watermark, so per-refresh scans stay cheap. Serving reads hit the **small results
  table/view**, never the raw logs.
- Refactor the Next.js data layer into **small GET endpoints** (`/api/agents`, `/api/bounties`,
  `/api/market`, …) backed by that store, and point the dashboard at them.
- **Out of scope right now:** the Validation Registry / validator / enclave (built later — leave
  it stubbed), making Layer-2 bounties live (stays on seed CSVs), and the MCP server itself
  (just make the endpoints MCP-ready).

---

## 1. Read these first (authoritative sources, do not guess)

| File | Why |
|---|---|
| `BigPicture.md` | product vision — the confidential bounty market |
| `analysis/README.md` | what the `analysis/` snapshot is + the EF addresses/topics + cost notes |
| `apps/web/README.md` | the dashboard, how it's wired, run/deploy notes |
| `apps/web/src/lib/bq.ts` | **single source of truth** for registry addresses, event topics, and the SQL builders. Reuse this; do not hardcode addresses elsewhere |
| `apps/web/src/lib/snapshot.ts` | Layer-1 loader + the `TrustAgent` shape the UI expects |
| `apps/web/src/lib/reputation.ts` | Layer-2 scorer + the `Market` shape; also the model for porting scoring logic |
| `apps/web/src/app/api/bigquery/route.ts` | the existing live-query route (dry-run + execute, key discovery, graceful-degrade) — copy its BigQuery client setup |
| `analysis/honeycomb_reputation.sql` | the Layer-2 earned-reputation SQL **view** — the template for writing Layer-1 scoring as a SQL view |
| `analysis/erc8004_trust.csv` | the exact columns/shape your new `honeycomb.agent_trust` view must reproduce |
| git `d87d0b3~1:analysis/trust_score.py` | the **deleted** Layer-1 trust-scoring algorithm. Recover with `git show d87d0b3~1:analysis/trust_score.py`. Spec is also in §10.3 |

---

## 2. Context: Honeycomb in two layers

Honeycomb is a confidential bounty market on ERC-8004: agents compete on bounties, get graded
blind by a TEE enclave, and are paid on-chain. This repo is the **read & trust layer** — it
indexes on-chain data via BigQuery and serves a dashboard.

- **Layer 1 (live, real):** ERC-8004 mainnet events — **Identity Registry** (`Registered`) and
  **Reputation Registry** (`NewFeedback`) — queried in BigQuery, scored for sybil resistance.
  **This is what we're making live + looped.**
- **Layer 2 (scaffold, stubbed):** the bounty market (bounties / submissions / settlements /
  validations) + earned reputation. The escrow contract and enclave don't exist yet, so it runs
  on seed CSVs. **Keep it on seeds for now.** It swaps to BigQuery later with no API change.

**The one invariant:** BigQuery only *indexes/serves* what's on-chain. It never grades or
validates. Do **not** build a validator or grading logic here.

---

## 3. Hard constraints

**Sponsor track (do not break):**
1. **BigQuery must be the core** for querying raw mainnet ERC-8004 data. The raw-event
   extraction + the trust scoring live in BigQuery SQL. Don't move the Layer-1 query path to a
   raw-RPC indexer — that would sideline BigQuery.
2. Use the **specific EF ERC-8004 addresses** (already in `bq.ts`): Identity
   `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432`, Reputation
   `0x8004baa17c55a88189ae136b182e5fda19de9b63`. (Validation is deferred — see §6.)
3. Pair BigQuery with a **lightweight frontend** — the existing Next.js app (deploy on **Cloud
   Run** to match the sponsor example).

**Project invariants:**
- Don't naively poll the raw logs table per request or on a tight loop — see §9 (cost).
  Separate the **expensive periodic scan** (scheduled, incremental) from the **cheap frequent
  serve** (small results table + short cache).
- `bq.ts` stays the single source of truth for addresses/topics/SQL. Server-only modules (that
  touch fs/BigQuery/keys) must never be imported into client components.
- Repo conventions: pnpm + Turborepo monorepo, Next.js 16 App Router, TypeScript, Tailwind.
- **Commits: no Claude/Co-Authored-By attribution.** Author is the repo user. Branch off `main`
  if needed; current work branch is `feat/bigquery-dashboard`.
- Auth/secrets: service-account key at `honeycomb/.secrets/gcp-key.json` (gitignored); optional
  `BQ_BILLING_PROJECT` (else falls back to the key's project). Never commit the key.

---

## 4. Current state (what exists today)

- **Data:** `analysis/` is a **frozen CSV snapshot** (the Python pipeline was deleted). The app
  reads: `erc8004_trust.csv` (Layer-1 directory) and `honeycomb_{agents,bounties,submissions,
  settlements,validations}.csv` (Layer-2 seeds). `honeycomb_reputation.sql` is the Layer-2 view.
- **One HTTP endpoint:** `POST /api/bigquery?mode=dryrun|run` — runs live `COUNT(*)` queries
  against mainnet (identity + reputation; validation gated off). Returns counts + scan/cost
  metadata. **Queries BigQuery on every call.** Keep this as on-demand provenance.
- **Data loaders (server-only, NOT endpoints):** `loadSnapshot()` (reads `erc8004_trust.csv` →
  `TrustAgent[]`) and `loadMarket()` (reads `honeycomb_*.csv` + `loadSnapshot().agents` →
  `Market`). Both use a **module-level `cached` singleton → load once per process, never
  refresh.** This in-memory cache must become a short-TTL cache (see §7) once data is live.
- **Dashboard:** `apps/web/src/app/page.tsx` is a Server Component that calls the loaders
  directly and renders: bounty market (Layer 2), agent directory (Layer 1), live BigQuery panel.

---

## 5. Target architecture

```
Ethereum mainnet ERC-8004 logs  (EF identity + reputation addresses)   ← raw data
        │
        │  SCHEDULED, INCREMENTAL BigQuery query   ← "the loop" (runs in BigQuery, cron)
        │  WHERE block_timestamp > <watermark>     (cheap: clustered tail scan)
        ▼
   honeycomb.* dataset (user's project)
     honeycomb.registrations, honeycomb.feedback        ← decoded raw events (append-only)
     honeycomb.agent_trust  (SQL VIEW)                  ← scored directory = erc8004_trust.csv
        │
        │  serving read: SELECT * FROM honeycomb.agent_trust   (small: ~MB, ~free)
        ▼
   Next.js data layer (loaders, short-TTL cache)
        ├── dashboard Server Components (read loaders directly)
        └── GET /api/agents /api/agents/:id /api/bounties /api/market   ← MCP/agents poll these
   POST /api/bigquery  (kept: on-demand live provenance over mainnet)
```

Principle: **BigQuery is both the raw-query core and the system of record.** The loop does the
one expensive thing (scan raw logs incrementally) on a schedule; everything else reads the small
derived table.

---

## 6. Scope of THIS work

**In scope (build now):**
- BigQuery: `honeycomb.*` dataset, incremental materialization of identity + reputation events,
  `agent_trust` SQL view, scheduled refresh ("the loop").
- A Next.js **data-access layer** that reads `agent_trust` (with a short TTL cache) instead of
  the CSV.
- **Separated GET read endpoints** over the loaders (`/api/agents`, `/api/agents/:id`,
  `/api/bounties`, `/api/market`, `/api/health`), each returning a freshness stamp.
- Point the dashboard at the new data layer; keep it rendering identically.
- (Recommended) Cloud Run deploy notes.

**Out of scope (leave as-is / defer):**
- **Validation Registry / validator / enclave** — keep `BQ_VALIDATION_REGISTRY` unset; the
  validation query stays gated off; Layer-2 `honeycomb_validations.csv` stays a seed. The
  validator is a separate component built later.
- **Layer-2 bounties going live** — bounties/submissions/settlements stay on the seed CSVs
  (no escrow contract yet). `/api/bounties` + `/api/market` serve the seeds for now.
- **The MCP server itself** — just make the endpoints clean + documented so MCP can wrap them.
- **Off-chain metadata enrichment** (agent name/services/x402) is **secondary** — it needs a
  non-BigQuery network fetch (HTTP/IPFS), so do the pure-BigQuery trust directory first and add
  enrichment as an optional Phase 4. `agent_uri` itself is decodable in SQL.

---

## 7. Implementation plan (phases)

### Phase 1 — BigQuery dataset + incremental materialization ("the loop")
**Tasks**
1. Create dataset `honeycomb` in the billing project (US, to match the public dataset region).
2. Backfill raw tables once from the public logs (use the decode SQL in §10.1–10.2):
   - `honeycomb.registrations(agent_id, owner, agent_uri, registered_at, block_number, tx_hash)`
   - `honeycomb.feedback(agent_id, client, raw_value, value_decimals, score, block_timestamp, block_number, tx_hash)`
   Backfill from `WINDOW.start` (2026-05-14) first (cheaper, ~50–80 GB); full history from
   `HISTORY_START` (2026-01-28) is optional and ~191 GB — **dry-run before running.**
3. Write an **incremental** insert/MERGE that appends rows where
   `block_timestamp > (SELECT MAX(block_timestamp) FROM <table>)`. Dry-run it to confirm the
   tail scan is small (clustering on `block_timestamp` should prune to recent storage blocks).
4. Schedule it: a **BigQuery scheduled query** every 15–30 min (recommended — no extra infra).
   *Alternative:* Cloud Scheduler → an authenticated `POST /api/refresh` route that runs the
   same SQL (use this only if refresh logic must live in app code).

**Acceptance:** `honeycomb.registrations` / `honeycomb.feedback` exist and a manual scheduled-run
appends only new rows; an incremental run's dry-run reports a small (single-digit GB or less)
scan.

### Phase 2 — Trust scoring as a SQL view
**Tasks**
1. Port the Layer-1 trust algorithm (§10.3, or `git show d87d0b3~1:analysis/trust_score.py`) into
   a BigQuery view `honeycomb.agent_trust`. Model it on `analysis/honeycomb_reputation.sql`.
2. Its columns must cover what `snapshot.ts` reads: `agent_id, name, avg_score, trust_score,
   trust_mult, feedback_count, unique_clients, independent_clients, reviewer_ring, flags`
   (+ `x402_resolved, services, agent_uri` — may be null until Phase 4).
3. Validate it reproduces `analysis/erc8004_trust.csv` (compare order-independently by
   `agent_id`; small numeric drift is fine, the chain advances).

**Acceptance:** `SELECT * FROM honeycomb.agent_trust ORDER BY trust_score DESC` returns rows whose
headline metrics match the committed CSV (e.g., the single sybil wallet feeding ~101/105 agents,
Surf AI #34135 the lone organic agent).

### Phase 3 — Next.js data-access layer + read endpoints
**Tasks**
1. Add a server-only `lib/bqClient.ts` (factor the BigQuery client + key discovery out of
   `route.ts`) and `lib/queries.ts` with parameterized read queries.
2. Refactor `loadSnapshot()` to query `honeycomb.agent_trust` instead of the CSV, returning the
   same `TrustAgent[]`. Keep `loadMarket()` reading the Layer-2 seed CSVs (+ `loadSnapshot()`).
3. Replace the forever `cached` singleton with a **short-TTL cache** (e.g., 30–60 s) so the loop's
   updates surface. Cache the small result, not per-request scans.
4. Add thin **GET** endpoints returning JSON `{ data, asOf, asOfBlock }`:
   - `GET /api/agents` (the trust directory) · `GET /api/agents/:id`
   - `GET /api/bounties` (`?status=open|all`) · `GET /api/market`
   - `GET /api/health` (store reachable? last refresh time?)
   Keep `POST /api/bigquery` as-is.

**Acceptance:** each endpoint returns JSON with a freshness stamp; reads cost ~0 (hit the small
view/cache, never the raw logs); `tsc` + `eslint` clean.

### Phase 4 — Dashboard wiring + (optional) off-chain enrichment + deploy
**Tasks**
1. Confirm the dashboard renders from the live data layer (Server Components keep calling the
   loaders; no UI change needed). The Directory may show empty name/services/x402 until enrichment.
2. *(Optional)* off-chain metadata resolver: a worker step that fetches each `agent_uri`
   (HTTP/IPFS) for name/services/x402 and writes `honeycomb.agent_meta`, joined into
   `agent_trust`. This is the one non-BigQuery piece — keep it isolated.
3. Deploy on **Cloud Run**; provide the SA key via a mounted secret /
   `GOOGLE_APPLICATION_CREDENTIALS` (never bundle it). Document env (`BQ_BILLING_PROJECT`,
   `BQ_START`, `BQ_MAX_BYTES`).

**Acceptance:** dashboard live on Cloud Run reading BigQuery-backed data; refresh loop running on
schedule; the "Verify it yourself" panel still proves live mainnet queries.

---

## 8. Open decisions (recommended defaults)

| Decision | Recommended default | Notes |
|---|---|---|
| Refresh mechanism | **BigQuery scheduled query** | least infra; most BigQuery-native. Use Cloud Scheduler→`/api/refresh` only if logic must live in app code |
| Refresh cadence | **15–30 min** | ERC-8004 events are low-volume; tune to budget after dry-running the incremental scan |
| Serving store | **read `honeycomb.agent_trust` directly + 30–60 s TTL cache** | it's small (~MB); avoids introducing a DB. Upgrade to Postgres/SQLite/Redis only if you need multi-instance shared state or sub-ms reads |
| Deploy target | **Cloud Run** (long-running) | a real refresh worker is fine here. If you ever go serverless/Vercel, the loop must be cron→store, not `setInterval` |
| Scoring location | **BigQuery SQL view** | keeps the analytical core in BigQuery (sponsor). `reputation.ts` is the TS reference if you need it |

---

## 9. Cost discipline (don't blow the free tier)

- Public table: **1 TiB/month free**, then ~$6.25/TiB. A full-window `COUNT` scans ~44 GB; full
  extraction more. The table is partitioned by **month**, clustered on **block_timestamp only**
  (filtering by address does **not** reduce bytes).
- Therefore: **never re-scan raw logs per request or on a tight loop.** Do the big scan once
  (backfill), then **incremental tail** scans on a schedule; serve from the small derived table.
- **❌ The specific footgun to avoid:** do **not** make a read endpoint run the full
  extraction/scoring SQL against the raw logs on each cache-miss and "just cache it." A TTL cache
  over a *live 44 GB+ scan* still scans 44 GB every time it expires — a 10-min TTL on an always-on
  app ≈ 6 × 44 GB/hour ≈ **blows the 1 TiB/month free tier in an afternoon.** The cache must sit
  in front of the **small materialized `agent_trust` view**; the **scheduled query** is the only
  thing that ever touches the raw logs.
- **Always `dryRun` first** (see `route.ts` `scanBytes()`), set `maximumBytesBilled`
  (`BQ_MAX_BYTES`, default 150 GB), and log scanned bytes per refresh. If an incremental run
  scans more than a few GB, narrow the window / verify the `block_timestamp` watermark filter is
  actually pruning.

---

## 10. Appendix — BigQuery building blocks

`DATASET = bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs`
Identity `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432`, topic0
`0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a` (`Registered`).
Reputation `0x8004baa17c55a88189ae136b182e5fda19de9b63`, topic0
`0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc` (`NewFeedback`).

### 10.1 Decode `Registered` (Identity Registry)
```sql
SELECT
  SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)       AS agent_id,
  CONCAT("0x", SUBSTR(topics[SAFE_OFFSET(2)], 27)) AS owner,
  SAFE_CONVERT_BYTES_TO_STRING(FROM_HEX(SUBSTR(
    data, 131,
    2 * SAFE_CAST(CONCAT("0x", SUBSTR(data, 67, 64)) AS INT64)
  )))                                              AS agent_uri,
  block_timestamp AS registered_at, block_number, transaction_hash AS tx_hash
FROM `bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs`
WHERE address = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"
  AND topics[SAFE_OFFSET(0)] = "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a"
  AND block_timestamp >= TIMESTAMP("2026-05-14")   -- or > watermark for incremental
```

### 10.2 Decode `NewFeedback` (Reputation Registry)
```sql
SELECT
  SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)              AS agent_id,
  CONCAT("0x", SUBSTR(topics[SAFE_OFFSET(2)], 27))        AS client,
  SAFE_CAST(CONCAT("0x", SUBSTR(data,  67, 64)) AS INT64) AS raw_value,
  SAFE_CAST(CONCAT("0x", SUBSTR(data, 131, 64)) AS INT64) AS value_decimals,
  block_timestamp, block_number, transaction_hash AS tx_hash
FROM `bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs`
WHERE address = "0x8004baa17c55a88189ae136b182e5fda19de9b63"
  AND topics[SAFE_OFFSET(0)] = "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc"
  AND block_timestamp >= TIMESTAMP("2026-05-14")
  AND SUBSTR(data, 67, 1) != "f"    -- drop negative (two's-complement) values
-- score = raw_value / POW(10, value_decimals)
```

### 10.3 Layer-1 trust-scoring spec (for `honeycomb.agent_trust`)
Per agent that has ≥1 feedback event (`score = raw_value / 10^value_decimals`):
- `avg_score = AVG(score)`, `feedback_count = COUNT(*)`, `unique_clients = COUNT(DISTINCT client)`.
- `client_breadth(client) = COUNT(DISTINCT agent_id)` that client reviewed (global).
  **Ring wallet** = client with `client_breadth >= 10`.
- `independent_clients` = distinct clients of this agent that are **not** ring wallets.
- `reviewer_ring` = AVG over this agent's clients of their `client_breadth`.
- `self_feedback` = 1 if the agent's `owner` is among its clients.
- **Multiplier** (start `mult = 1.0`):
  - `self_feedback` → `mult *= 0.3`
  - `independent_clients == 0` → `mult *= 0.1` (flag `ring-only reviewers`)
  - else if `independent_clients < 3` → `mult *= 0.5`
  - `reviewer_ring >= 10` → `mult *= 0.5`
  - `independent_clients >= 5` → `mult = LEAST(1.0, mult * 1.3)` (flag `broad independent client base`)
- `trust_score = ROUND(avg_score * mult, 2)`, `trust_mult = ROUND(mult, 3)`, `flags` = `;`-joined.
- UI `category` (computed client-side in `snapshot.ts`, leave as-is): `organic` if
  `independent_clients >= 5`, `sybil` if flags contain `ring-only`, else `thin`.

### 10.4 Layer-2 seed schemas (keep reading these CSVs for now)
- `honeycomb_agents.csv`: `agent_id,name,owner`
- `honeycomb_bounties.csv`: `bounty_id,requester,category,title,reward_eth,status,created_at,deadline`
- `honeycomb_submissions.csv`: `bounty_id,agent_id,submission_cid,submitted_at`
- `honeycomb_settlements.csv`: `bounty_id,winner_agent_id,winner_score,attestation_hash,settled_at`
- `honeycomb_validations.csv`: `bounty_id,agent_id,validator,response,valid,response_hash,validated_at`
  *(stub for the enclave's `ValidationResponse`; stays seeded until the validator ships)*

When Layer 2 goes live later, these become BigQuery tables decoded from the escrow + enclave
events — the `/api/bounties` and `/api/market` contracts stay identical.
