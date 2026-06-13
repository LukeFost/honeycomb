# ERC-8004 + Honeycomb — BigQuery snapshot

This directory is the **frozen reference snapshot** plus the **Layer-2 seeds**. The dashboard's
**Layer-1 trust directory is now read live** from the `honeycomb.*` BigQuery store — the live
`agent_trust` view reproduces `erc8004_trust.csv` below — while **Layer-2** (the bounty market)
still reads the seed CSVs here. See [`../docs/bigquery-runbook.md`](../docs/bigquery-runbook.md).
The live queries and all extraction / scoring logic live in the web app:

- **Live BigQuery queries + registry constants (single source of truth):** `apps/web/src/lib/bq.ts`
- **Live query API (dry-run + execute against mainnet):** `apps/web/src/app/api/bigquery/route.ts`
- **Layer-1 trust loader:** `apps/web/src/lib/snapshot.ts` · **Layer-2 scorer:** `apps/web/src/lib/reputation.ts`

The CSVs here are a **frozen snapshot** of a 30-day window (**May 14 – Jun 12, 2026**) of
ERC-8004 events on Ethereum mainnet, taken from the public dataset
`bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs`. Hitting the live API
(`/api/bigquery`) re-counts the same events on demand to prove the numbers.

## Registries (Ethereum mainnet)

- Identity Registry `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432` → `Registered` topic0 `0xca52e62c…449bc4a`
- Reputation Registry `0x8004baa17c55a88189ae136b182e5fda19de9b63` → `NewFeedback` topic0 `0x6a4a6174…5e58febc`
- Validation Registry — no EF mainnet deployment yet; set `BQ_VALIDATION_REGISTRY` to read it live (see `lib/bq.ts`).

Note: the logs table is partitioned by month and clustered on `block_timestamp` only —
filtering by contract address does **not** reduce bytes scanned.

## Files

**Layer 1 — global ERC-8004 trust (the frozen reference the live `honeycomb.agent_trust` view reproduces):**
- `erc8004_trust.csv` — per-agent raw score, sybil-discounted trust score, signal breakdown,
  flags, plus resolved name / services / x402. The dashboard reads this directory live from
  BigQuery now; this CSV is the snapshot the view was validated against (105/105 agents match).

**Layer 2 — Honeycomb bounty market (seed star-schema + production view):**
- `honeycomb_agents.csv`, `honeycomb_bounties.csv`, `honeycomb_submissions.csv`,
  `honeycomb_settlements.csv`, `honeycomb_validations.csv` — seeds standing in for the escrow
  contract's decoded logs and the TEE enclave's `ValidationResponse` events until they ship.
- `honeycomb_reputation.sql` — the production earned-reputation BigQuery view
  (`enclave × valid-attestation × (1 − self-dealing) × independent-demand`), mirrored in
  `reputation.ts`.

## Headline finding (the thesis)

Of the agents with on-chain reputation, a **single wallet** mass-reviews **101 of 105** — only
one agent (**Surf AI**, `#34135`) has an organic (≥5 independent reviewer) client base. Raw
reputation is gameable; the sybil-discounted trust score in `erc8004_trust.csv` is the gate
that keeps a bounty market from paying the ring.

## Live API config

The `/api/bigquery` route needs a Google service-account key — place it at
`honeycomb/.secrets/gcp-key.json` (gitignored; it carries its own billing project). Optional env:

- `BQ_BILLING_PROJECT` — bill a project other than the key's.
- `BQ_START` — override the live-query window start (default `2026-05-14`).
- `BQ_VALIDATION_REGISTRY` — Validation Registry address; lights up the live validation query.

Cost: a 30-day windowed count scans ~44–80 GB — within BigQuery's 1 TiB/mo free tier. The
route dry-runs (free, byte estimate) by default; "Run live query" executes and reports bytes billed.
