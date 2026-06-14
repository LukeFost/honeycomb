# honeycomb-mcp — the bounty engine

> Historically this was a standalone stdio MCP server. That front door was
> removed: there is now **one** front door (the `plugins/honeycomb` Claude Code
> plugin) talking to **one** backend (`apps/honeycomb-api`). This package is what
> both of those ultimately run — the bounty logic, nothing more.

No server lives here anymore. This package is the shared **engine**: the tool
functions and the Sepolia chain client that every surface imports.

```
tools/createBounty.ts   hash private bundle -> approve USDC -> createBounty (broadcasts)
tools/monitor.ts        get_job / list_jobs / job_events (ScoreRecorded, ValidityRecorded,
                        NewLeader, JobResolved, JobCreated)
tools/grade.ts          run a submission through the real grader (score + validity + digests)
tools/reputation.ts     ERC-8004 reputation from BigQuery (counts / feedback / leaderboard)
chain.ts                BountyEscrow address + ABI, viem public/wallet clients, decodeJob
reputation.py           the BigQuery query reputation.ts shells to
```

## Who imports it

```
apps/honeycomb-api/server.ts   imports tools/* and exposes them as HTTP routes  ← the backend
        ▲
plugins/honeycomb/mcp/shim.ts  a thin stdio MCP that FORWARDS each tool to the API ← the front door (per-user)
```

So a change to a tool's logic happens **once, here**, and the front door picks it
up. (The tool *schemas* are still declared in both the API and the shim — keep
those in sync when you change a tool's params.)

`apps/web` (the shared dashboard humans look at) does **not** import this engine —
it reads the same on-chain + BigQuery data through its own client. It's a sibling
deployable on the same data, not a consumer of these functions.

## Secrets

The functions need secrets only when actually called:

| Var | Needed by | Notes |
| --- | --- | --- |
| `SEP_PRIVATE_KEY` | `createBounty` | Funds + signs the Sepolia tx. |
| `SEPOLIA_RPC` (or `RPC`) | all on-chain reads | Resolved via `@honeycomb/chain/sepolia`; public fallback if unset. |
| BigQuery auth | `queryReputation` | `analysis/.secrets/gcp-key.json` or `GOOGLE_APPLICATION_CREDENTIALS`; runs on `analysis/.venv` python. |
| `INFERENCE_API_KEY_VAR` | `gradeSubmission` validity half | Without it the score still computes; the validity attestation throws (surfaced). |

The backend loads these from the macOS keychain at launch via
`apps/honeycomb-api/run-with-secrets.sh`. See `apps/honeycomb-api/README.md` to
run the service, and `plugins/honeycomb/README.md` to install the plugin.

## grade_submission and demeter

Both scorers (`scorer.py` directional, `lp_scorer.py` LP) import `demeter`, which
lives in the grader's own venv (`apps/grading-cre/grader/.venv`, py3.12 +
`zelos-demeter`). `tools/grade.ts` prepends that venv's `bin` to `PATH` before
invoking `grade.ts`. Override the location with `HONEYCOMB_GRADER_VENV`.

## Typecheck

```sh
bun run --cwd apps/honeycomb-mcp typecheck
```
