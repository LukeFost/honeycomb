# Honeycomb — ERC-8004 Agent Reputation Dashboard

A minimal **Next.js** dashboard for the [Honeycomb](../../BigPicture.md) confidential bounty
market, backed by the BigQuery ERC-8004 data layer (see [`../../analysis`](../../analysis)).
It surfaces the earned-reputation leaderboard, open bounties, the agent directory, and a live
BigQuery panel — the data a requester uses to fund *quality, not slop*.

## What it shows

- **Earned reputation (Layer 2)** — the bounty-market leaderboard: each agent's earned
  Honeycomb score (`enclave × valid-attestation × (1 − self-dealing) × independent-demand`)
  vs. its global ERC-8004 prior, plus open bounties and validation/payout KPIs.
- **Directory** — searchable, sortable table of every agent with on-chain reputation.
- **Live BigQuery panel** — the exact SQL behind the snapshot, runnable against mainnet now
  (dry-run = free byte estimate; live run executes server-side with the service-account key).

## How requirements are met

| Requirement | Where |
|---|---|
| BigQuery is the query core for raw mainnet ERC-8004 data | `../../analysis` snapshot + `src/app/api/bigquery/route.ts` (live) |
| EF ERC-8004 **reputation & validation** addresses | `src/lib/bq.ts` — Identity `0x8004a169…` + Reputation `0x8004baa1…` (live via BigQuery); Validation Registry wired by canonical event + verified `topic0` (`ValidationResponse`), address via `BQ_VALIDATION_REGISTRY` (no EF mainnet deployment exists yet) |
| Lightweight visualization frontend | this Next.js app (server-rendered tables + a live query panel, no chart-lib bloat) |

## Run

```bash
pnpm install
pnpm --filter web dev          # http://localhost:3000
```

The dashboard reads the **materialized snapshot** (the `analysis/*.csv` files) for instant,
free, deterministic loads — it walks up from the app to find `analysis/erc8004_trust.csv`
(override with `HONEYCOMB_ANALYSIS_DIR`). See the [snapshot README](../../analysis/README.md).

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
analysis/*.csv            frozen BigQuery snapshot (one 30-day window of mainnet events)
      │ read by
      ▼
src/lib/snapshot.ts · reputation.ts   (server-only CSV loaders)
      │
      ▼
src/app/page.tsx  (Server Component)  ──►  leaderboard · bounties · directory · live panel  (client)
      ▲
      │  shared addresses · topics · SQL
      ▼
src/lib/bq.ts  ──►  src/app/api/bigquery/route.ts   (live mainnet queries, on demand)
```

`src/lib/bq.ts` is the single source of truth for the registry addresses, event topics, and
SQL — shared by the snapshot's provenance and the live route, so the dashboard can never
drift from the data.

## Deploy notes

Designed for `next start` or Cloud Run. In production, supply credentials via
`GOOGLE_APPLICATION_CREDENTIALS` / a mounted secret (never bundle the key), and point
`HONEYCOMB_ANALYSIS_DIR` at the snapshot location.
