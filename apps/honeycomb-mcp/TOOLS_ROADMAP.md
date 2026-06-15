# Honeycomb MCP — tool roadmap

The MCP/API/plugin stack is now the front door for the useful Honeycomb lifecycle:
makers create and observe bounties; solvers grade/submit work directly and receive a
user-owned receipt. The current submit path is intentionally off-chain and does not use
Chainlink CRE or pretend to mutate the escrow leaderboard.

Architecture: shim (`plugins/honeycomb/mcp/shim.ts`) → API (`apps/honeycomb-api/server.ts`)
→ engine (`apps/honeycomb-mcp/tools/*` + `apps/grading-cre/grader/*`). New tools = a
`tools/*` fn + an API route + a shim entry (keep the schema in sync in all three).

## Existing

| tool | role | notes |
|---|---|---|
| `create_bounty` | maker | hash private bundle → approve → createBounty |
| `create_bounty_draft` / `finalize_bounty` | maker | gasless/x402 funding flow |
| `resolve_early` | maker | close one of your bounties before deadline |
| `submit_work` | solver | direct grade + `submission.sha256` receipt; `recordedOnChain:false` |
| `register_agent` | solver | mint an ERC-8004 agent identity |
| `get_job` / `list_jobs` / `job_events` | observer | `getJobFull` + decoded events |
| `query_reputation` | observer | ERC-8004 from BigQuery |
| `grade_submission` | operator/solver | score + validity metadata + receipt digests; direct by default |

## Direct submit boundary

`submit_work` should stay honest:

- returns the exact work receipt (`submission.sha256`) and grade result;
- computes `wouldBeLeader` against live chain state;
- sets `recordedOnChain:false` and `isLeader:false` unless a future explicit recording path
  is implemented and verified;
- does not require CRE, a relay key, an enclave signature, or the `cre` CLI.

`grade_submission` defaults to `validityMode:"direct-unattested"`. Optional legacy/advanced
backends must be explicit feature flags, not ambient env-var surprises:

- `HONEYCOMB_ENABLE_CONFIDENTIAL_AI=1` + `INFERENCE_API_KEY_VAR` for the legacy AI validity check.
- `HONEYCOMB_ENABLE_ENCLAVE_GRADING=1` + `GRADER_ENCLAVE_URL` for enclave execution grading.

## Possible next tools

| # | tool | role | wraps | inputs | output | infra |
|---|---|---|---|---|---|---|
| 1 | `grade_status` | solver/operator | async job table | handle | state, logs, grade | DB |
| 2 | `record_grade` | operator | future explicit recording path | jobId, agentId, grade receipt | tx or rejection | signer + verified authority model |
| 3 | `resolve_bounty` | maker/keeper | escrow `resolveEarly` or a future keeper | jobId, mode | winner, paidOut, settle tx | maker/keeper key |
| 4 | `claim_winner` | maker | future delivery/open flow | jobId, makerSecret | recovered-code path, verified=bool | delivery storage + maker secret |
| 5 | `run_strategy` | maker | strategy-vault workflow | jobId, vault, direction | swap tx, vault delta | Uniswap/Base keys |

## Design notes / honest caveats

- Operator/backend tools need privileged secrets and belong on the API backend, never in the
  per-user shim.
- Any future `record_grade` path must first define its authority model. Do not silently re-add
  a relay/oracle/attestation layer under the direct submit API.
- Long-running work should be async: return a handle immediately and add status polling.
- Keep the user-visible boundary plain: direct receipts are useful even before settlement is
  wired back in.
