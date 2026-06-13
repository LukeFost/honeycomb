# chain-verify — drive the dashboard from on-chain data

Proves the Honeycomb dashboard reads **only on-chain data** — no stubbed CSVs. Mock contracts on
a local Anvil chain emit ERC-8004 + bounty-market events; the indexer lands them in a BigQuery
dataset (`honeycomb_demo`); the **real `apps/web` pipeline** (SQL decode → `agent_trust` scoring
→ serving reads) renders them. Contracts live in the repo-root `contracts/` Foundry project.

## The self-contained demo

```bash
cd tools/chain-verify
pnpm install            # once
./demo.sh up            # anvil + an EMPTY honeycomb_demo + the dashboard on http://localhost:3000
#   → open it: 0 agents, 0 bounties
./demo.sh seed          # deploy mock contracts, emit a scenario, index → refresh the page
#   → Directory + bounty market populate entirely from the on-chain events
./demo.sh down          # stop anvil + server, drop honeycomb_demo
```

`up` always resets `honeycomb_demo` to empty; `seed` deploys `MockErc8004` + `MockHoneycombEscrow`
(deterministic addresses on a fresh anvil) and emits a scenario built to show the thesis:

- a **10-wallet sybil ring** → those agents are flagged `sybil` (high raw score, ~0 trust);
- an **organic agent (#11)** reviewed by 6 independent clients → tops the earned leaderboard;
- a **self-dealer (#3)** that funds + "wins" its own bounty at enclave 97 → earns ~1.0;
- a **cheater (#7)** that fails attestation → flagged, never earns.

## How it works

- **Layer 1 (Directory):** `MockErc8004` emits `Registered` (topic0 `0xca52…`, identical to the EF
  contract) + a decode-compatible `NewFeedback`. `demo.sh` points `BQ_IDENTITY_REGISTRY` /
  `BQ_REPUTATION_REGISTRY` / `BQ_REPUTATION_TOPIC0` (and `BQ_LOGS_TABLE` / `BQ_DATASET`) at the
  mock + `honeycomb_demo`, so the **real `bq.ts` SQL** decodes/scores it. Raw logs → `src/indexer.ts`
  → `scripts/materialize.ts` (`MERGE` + `agent_trust` view).
- **Layer 2 (market):** `MockHoneycombEscrow` emits the bounty lifecycle; `src/marketIndexer.ts`
  decodes it (viem) into `honeycomb_demo.{bounties,submissions,validations,settlements}`, which
  `reputation.ts` reads.
- **Defaults unchanged:** with none of the `BQ_*` overrides set, `bq.ts` targets the real EF
  mainnet contracts + public dataset exactly as in production.

## Lower-level pieces (used by `demo.sh`)

| File | Role |
|---|---|
| `../../contracts/src/MockErc8004.sol`, `MockHoneycombEscrow.sol` | the mock contracts |
| `../../contracts/script/DeployAndSeed.s.sol` | deploys + emits the scenario (`forge script … --broadcast`) |
| `src/indexer.ts <addr>` | raw logs → `honeycomb_demo.logs` (Layer-1 SQL-decode source) |
| `src/marketIndexer.ts <escrow>` | escrow events → Layer-2 tables (viem decode) |
| `scripts/setup-test-dataset.ts` / `teardown-test-dataset.ts` | (re)create / drop the dataset |
| `scripts/materialize.ts` | `MERGE` raw logs → `registrations`/`feedback` + `agent_trust` view |
| `scripts/inspect-db.ts` | list datasets/tables/row-counts |
| `pnpm run contracts:test` | offline topic0/layout assertions for the contracts |

## Guardrails

- These indexers are **fixture loaders for the demo, not production ingestion** (sponsor §3:
  production Layer-1 reads mainnet via BigQuery's public dataset). The `e2e:*` scripts refuse to
  run if `BQ_LOGS_TABLE` resolves to the mainnet table and cap `maximumBytesBilled` at 1 GB.
- No `bq`/`gcloud` CLI needed — everything uses the `@google-cloud/bigquery` SDK + the SA key
  found by walking up to `honeycomb/.secrets/gcp-key.json`.

## Promote later (optional)

Move to `packages/chain-verify` (a workspace package); long-term, hoist `bq.ts` into a shared
package both `apps/web` and this harness import (drops the `../../../apps/web` path in `src/sql.ts`).
