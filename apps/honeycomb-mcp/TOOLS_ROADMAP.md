# Honeycomb MCP — tool roadmap (covering the full e2e lifecycle)

The MCP today exposes the **maker/observer** slice. The e2e (`apps/grading-cre/e2e-mainnet.sh`)
drives the rest directly via `cast`/`cre`/`python`. This scopes the tools that would let a
Claude session drive the **whole** lifecycle through the MCP front door — each wraps an engine
helper that ALREADY exists, so it's wiring, not new mechanism.

Architecture: shim (`plugins/honeycomb/mcp/shim.ts`) → API (`apps/honeycomb-api/server.ts`) →
engine (`apps/honeycomb-mcp/tools/*` + `apps/grading-cre/*`). New tools = a `tools/*` fn + an
API route + a shim entry (keep the schema in sync in both). Network via `HONEYCOMB_CHAIN`.

## Existing (6)
| tool | role | notes |
|---|---|---|
| `create_bounty` | maker | hash private bundle → approve → createBounty (7-arg) |
| `get_job` / `list_jobs` / `job_events` | observer | `getJobFull` + decoded events |
| `query_reputation` | observer | ERC-8004 from BigQuery (mainnet) |
| `grade_submission` | operator | now fetches the real KMS-signed bundle (preview; not relayed on-chain) |

## New (6) — to cover the e2e

| # | tool | role | wraps (engine) | inputs | output | secrets/infra |
|---|---|---|---|---|---|---|
| 1 | `submit_solution` | agent | `grader/deliver.py seal` + escrow `submit(jobId,agentId,encCid)` | jobId, agentId, submissionPath, agentKey | encCid, tx | agent key |
| 2 | `summon_grader` | maker | `grader/summon_enclave.sh` `SUMMON_SETTLE_ONLY=1` | jobId | x402 settle tx, payer | facilitator, maker key, USDC |
| 3 | `grade_onchain` | operator | `grader/enclave/grade_in_vm.sh` + `grader/attest.ts` + CRE relay (action 0/1) | jobId, agentId, submissionName | score, valid, recordScore tx, recordValidity tx | gcloud+KMS, INFERENCE key, CRE key |
| 4 | `resolve_bounty` | maker/keeper | `grader/cron_resolve.sh` + `cre … --trigger-index 1` (CRON) OR escrow `resolveEarly` | jobId, mode=cron\|early | winner, paidOut, settle tx | CRE key (cron) / maker key (early) |
| 5 | `claim_winner` | maker | `grader/deliver.py reseal` + CRE delivery (action 3) + `deliver.py open` | jobId, makerSecret | deliveryCid, recovered-code path, verified=bool | enclave+maker X25519 secrets, CRE key |
| 6 | `run_strategy` | maker | registry `register` + strategy-vault workflow (`cre simulate --broadcast`) | jobId, vault, direction | swap tx, vault balance delta | UNISWAP key, maker key (Base) |

## Design notes / honest caveats
- **These are operator/backend tools, not light per-user calls.** #2–#6 need privileged
  secrets (GCP+KMS for the VM, the x402 facilitator + maker key, `CRE_ETH_PRIVATE_KEY`,
  Uniswap key). They belong on the **API backend** (loaded via secrets at launch), with the
  per-user shim forwarding — never put these secrets in the shim.
- **`grade_onchain` is long-running** (~75s VM launch + CRE broadcasts). Make it async: return
  a handle immediately and add a `grade_status` poll, or set a generous timeout.
- **Role split:** `submit_solution` is agent-side (agent key); `summon_grader`/`resolve_bounty`/
  `claim_winner`/`run_strategy` are maker/operator-side. The shim/API should gate writes
  (loopback + `HONEYCOMB_API_TOKEN`, as today).
- **`grade_onchain` supersedes `grade_submission`** as the real path (the latter stays a
  read-only preview).
- **Two-chain:** #1–#5 are L1 (the grading escrow); #6 is Base (the strategy-vault). The
  `HONEYCOMB_CHAIN` selector + a Base RPC env handle this.
- Each tool already has a verified CLI helper in the repo, so implementation is: thin tool fn
  → API route → shim schema. No new on-chain mechanism required.
