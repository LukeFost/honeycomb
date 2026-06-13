# ERC-8004 + Honeycomb — analysis reference

> The frozen snapshot CSVs that used to live here have been **removed** — the dashboard now reads
> **only live on-chain data**, no stubs. Layer 1 (the trust directory) is materialized in the
> `honeycomb.*` BigQuery store from real mainnet ERC-8004 events; Layer 2 (the bounty market) is
> decoded from the escrow's events. To see the whole pipeline run empty → populated from contracts
> you control on a local chain, use [`../tools/chain-verify`](../tools/chain-verify/README.md)
> (`./demo.sh up` then `./demo.sh seed`).

All extraction / scoring logic lives in the web app (the single source of truth):

- **Registry constants + the exact BigQuery SQL:** `apps/web/src/lib/bq.ts`
- **Live query API (dry-run + execute against mainnet):** `apps/web/src/app/api/bigquery/route.ts`
- **Layer-1 trust loader:** `apps/web/src/lib/snapshot.ts` · **Layer-2 scorer:** `apps/web/src/lib/reputation.ts`

## Registries (Ethereum mainnet — the production defaults)

- Identity Registry `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432` → `Registered` topic0 `0xca52e62c…449bc4a`
- Reputation Registry `0x8004baa17c55a88189ae136b182e5fda19de9b63` → `NewFeedback` topic0 `0x6a4a6174…5e58febc`
- Validation Registry — no EF mainnet deployment yet; set `BQ_VALIDATION_REGISTRY` to read it live.

Each is overridable (`BQ_IDENTITY_REGISTRY`, `BQ_REPUTATION_TOPIC0`, …) to point the pipeline at
mock contracts for the demo. The public logs table is partitioned by month and clustered on
`block_timestamp` only — filtering by contract address does **not** reduce bytes scanned.

## What's left here

- `honeycomb_reputation.sql` — the earned-reputation scoring reference
  (`enclave × valid-attestation × (1 − self-dealing) × independent-demand`), mirrored in
  `reputation.ts`.

## The thesis

Raw ERC-8004 reputation is gameable: a single wallet can mass-review a ring of agents, and an
agent can fund + "win" its own bounties. The sybil-discounted **trust score** (Layer 1) and the
**earned, participation-scoped reputation** (Layer 2 — which collapses self-dealt wins to ~0
despite perfect enclave scores) are the gates that keep a bounty market from paying the ring.
