# Honeycomb — ERC-8004 Agent Reputation Dashboard

A lightweight **Next.js** visualization frontend for the BigQuery-backed ERC-8004 trust
layer (see [`../../analysis`](../../analysis)). It tells the project's thesis in one screen:
**raw on-chain reputation is gameable; a sybil-resistant trust score, computed from
Ethereum mainnet data in BigQuery, is not.**

This is the Google-track deliverable for the [Honeycomb](../../BigPicture.md) confidential
bounty market — the dashboard a requester uses to fund *quality, not slop*.

## What it shows

- **KPIs** — agents registered, agents with reputation, organic vs. sybil-ring, x402-payable.
- **The thesis (slope chart)** — every agent's raw score → trust score. 101 of 105 agents,
  all fed by a single wallet, collapse; only the one organic agent (Surf AI) survives.
- **Adoption** — daily/cumulative registrations from the Identity Registry.
- **Directory** — searchable, sortable table of every agent with on-chain reputation.
- **Live BigQuery panel** — the exact SQL behind the snapshot, runnable against mainnet now
  (dry-run = free byte estimate; live run executes server-side with the service-account key).

## How requirements are met

| Requirement | Where |
|---|---|
| BigQuery is the query core for raw mainnet ERC-8004 data | `../../analysis` pipeline + `src/app/api/bigquery/route.ts` (live) |
| EF ERC-8004 registry addresses | `src/lib/bq.ts` — Identity `0x8004a169…`, Reputation `0x8004baa1…` |
| Lightweight visualization frontend | this Next.js app (hand-rolled SVG charts, no chart-lib bloat) |

## Run

```bash
pnpm install
pnpm --filter web dev          # http://localhost:3000
```

The dashboard reads the **materialized snapshot** (the `analysis/*.csv` outputs) for instant,
free, deterministic loads — it walks up from the app to find `analysis/erc8004_trust.csv`
(override with `HONEYCOMB_ANALYSIS_DIR`). Regenerate the snapshot via the
[analysis pipeline](../../analysis/README.md).

### Live BigQuery (optional, on-demand)

The **Provenance** panel runs the real queries server-side. It needs the gitignored
service-account key at `honeycomb/.secrets/gcp-key.json` (auto-discovered by walking up,
same convention as `analysis/bqenv.py`).

- **Dry run** — always free; returns estimated bytes scanned (~44 GB/query in the 30-day window).
- **Live run** — executes the COUNT queries (~88 GB total, within BigQuery's 1 TiB/month free tier),
  capped by `BQ_MAX_BYTES` (default 150 GB).

Env (all optional): `BQ_START` (window start, default `2026-05-14`), `BQ_BILLING_PROJECT`,
`BQ_MAX_BYTES`, `BQ_SHOW_PROJECT=1` (reveal the full project id; masked by default).

## Architecture

```
analysis/  ──(Python + BigQuery)──►  *.csv snapshot
   │                                      │
   │  (shared SQL, addresses, topics)     ▼
src/lib/bq.ts ◄───────────────────  src/lib/snapshot.ts  (server-only CSV loader)
   │                                      │
   ▼                                      ▼
src/app/api/bigquery/route.ts        src/app/page.tsx  (Server Component)
   (live mainnet queries)                 │
                                          ▼
                         charts · directory · live panel  (client components)
```

`src/lib/bq.ts` is the single source of truth for the registry addresses, event topics, and
SQL — shared by both the offline pipeline's intent and the live route, so the dashboard can
never drift from the data.

## Deploy notes

Designed for `next start` or Cloud Run. In production, supply credentials via
`GOOGLE_APPLICATION_CREDENTIALS` / a mounted secret (never bundle the key), and point
`HONEYCOMB_ANALYSIS_DIR` at the snapshot location.
