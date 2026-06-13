# Honeycomb — ERC-8004 Agent Reputation Dashboard

A minimal **Next.js** dashboard for the [Honeycomb](../../BigPicture.md) confidential bounty
market, backed by the BigQuery ERC-8004 data layer (see [`../../analysis`](../../analysis)).
It surfaces the earned-reputation leaderboard, open bounties, the agent directory, and a live
BigQuery panel — the data a requester uses to fund *quality, not slop*.

## What it shows

- **Earned reputation (Layer 2)** — the bounty-market leaderboard: each agent's earned
  Honeycomb score (`enclave × valid-attestation × (1 − self-dealing) × independent-demand`)
  vs. its global ERC-8004 prior, plus open bounties and validation/payout KPIs.
- **Directory** — searchable, sortable table of every agent with on-chain reputation, read
  **live from BigQuery** (`honeycomb.agent_trust`), refreshed on a loop.
- **Live BigQuery panel** — the exact SQL behind the snapshot, runnable against mainnet now
  (dry-run = free byte estimate; live run executes server-side with the service-account key).

## How requirements are met

| Requirement | Where |
|---|---|
| BigQuery is the query core for raw mainnet ERC-8004 data | live `honeycomb.*` store — incremental MERGE of raw logs + the `agent_trust` sybil-scoring view — read by the data layer; `src/app/api/bigquery/route.ts` proves the raw queries on demand. See [`../../docs/bigquery-runbook.md`](../../docs/bigquery-runbook.md) |
| EF ERC-8004 **reputation & validation** addresses | `src/lib/bq.ts` — Identity `0x8004a169…` + Reputation `0x8004baa1…` (live via BigQuery); Validation Registry wired by canonical event + verified `topic0` (`ValidationResponse`), address via `BQ_VALIDATION_REGISTRY` (no EF mainnet deployment exists yet) |
| Lightweight visualization frontend | this Next.js app (server-rendered tables + a live query panel, no chart-lib bloat) |

## Run

```bash
pnpm install
pnpm --filter web dev          # http://localhost:3000
```

The dashboard's **Layer-1 trust directory is read live from BigQuery** (`honeycomb.agent_trust`,
behind a 30 s cache); **Layer-2** (the bounty market) still reads the seed CSVs in `analysis/`
(override with `HONEYCOMB_ANALYSIS_DIR`). Reads hit the small derived view (~MB), never the raw
logs. Both need the service-account key (below). The BigQuery store + the refresh loop are
documented in the [BigQuery runbook](../../docs/bigquery-runbook.md).

## API

Small JSON read endpoints over the same loaders (MCP/agent-poller friendly); each returns a
`{ data, asOf, asOfBlock }` freshness stamp:

| Endpoint | Returns |
|---|---|
| `GET /api/agents` · `GET /api/agents/:id` | the Layer-1 trust directory (live) |
| `GET /api/bounties?status=open\|all` · `GET /api/market` | Layer-2 bounties + earned-reputation market (seeds) |
| `GET /api/health` | store reachable? freshness + last refresh time |
| `POST /api/refresh` | **the loop** — incremental materialize (auth: `REFRESH_TOKEN`); `?mode=dryrun` to preview |
| `POST /api/bigquery` | on-demand live `COUNT` provenance over mainnet (dry-run / run) |

### Live BigQuery (optional, on-demand)

The **Provenance** panel runs the real queries server-side. It needs the gitignored
service-account key at `honeycomb/.secrets/gcp-key.json` (auto-discovered by walking up
from the app, or set `GOOGLE_APPLICATION_CREDENTIALS`).

- **Dry run** — always free; returns estimated bytes scanned (~44 GB/query in the 30-day window).
- **Live run** — executes the COUNT queries (~88 GB total, within BigQuery's 1 TiB/month free tier),
  capped by `BQ_MAX_BYTES` (default 150 GB).

Env (all optional): `BQ_START` (window start, default `2026-05-14`), `BQ_BILLING_PROJECT`,
`BQ_MAX_BYTES`, `BQ_SHOW_PROJECT=1` (reveal the full project id; masked by default),
`BQ_VALIDATION_REGISTRY` (ERC-8004 Validation Registry address — when set, the live panel
adds a `ValidationResponse` count query and the dashboard links it; unset = "pending EF
mainnet deployment", since the EF Validation Registry isn't deployed to mainnet yet).

## Architecture

```
honeycomb.* (BigQuery)        registrations + feedback (incremental MERGE) → agent_trust VIEW
      │ read by (short-TTL cache, small view ~MB)        ▲ the loop: POST /api/refresh
      ▼                                                  │ (Cloud Scheduler / scheduled query)
src/lib/snapshot.ts (Layer 1, live) · reputation.ts (Layer 2, seed CSVs + live prior)
      │  via src/lib/queries.ts → src/lib/bqClient.ts (memoized client)
      ▼
src/app/page.tsx (Server Component)  ──►  leaderboard · bounties · directory · live panel
      │                                   GET /api/{agents,bounties,market,health}
      ▲  shared addresses · topics · SQL (single source of truth)
      ▼
src/lib/bq.ts  ──►  src/app/api/bigquery/route.ts (live COUNT provenance) + the refresh loop SQL
```

`src/lib/bq.ts` is the single source of truth for the registry addresses, event topics, and all
SQL (the decode, the `agent_trust` scoring view, and the incremental refresh) — so the live store,
the loop, and the provenance panel can never drift. The committed DDL it generates is
[`../../docs/honeycomb-bigquery.sql`](../../docs/honeycomb-bigquery.sql).

## Deploy notes

Designed for **Cloud Run** (`next start`). In production:

- Supply credentials via `GOOGLE_APPLICATION_CREDENTIALS` / a mounted secret — **never bundle the
  key**. Set `BQ_BILLING_PROJECT` if billing a project other than the key's.
- Set `REFRESH_TOKEN` and drive the loop with **Cloud Scheduler → `POST /api/refresh`** (every
  15–30 min), or a BigQuery **scheduled query** `CALL honeycomb.refresh()` (no app infra). Don't
  use `setInterval` — the loop must be cron→store. See the
  [runbook](../../docs/bigquery-runbook.md).
- Point `HONEYCOMB_ANALYSIS_DIR` at the Layer-2 seed CSVs if not co-located.

Env: `REFRESH_TOKEN`, `BQ_BILLING_PROJECT`, `BQ_DATASET` (def. `honeycomb`), `BQ_LOCATION`
(def. `US`), `BQ_CACHE_TTL_MS` (def. `30000`), `BQ_REFRESH_LAG_MINUTES` (def. `120`),
`BQ_MAX_BYTES`, plus the live-panel vars (`BQ_START`, `BQ_VALIDATION_REGISTRY`, `BQ_SHOW_PROJECT`).
