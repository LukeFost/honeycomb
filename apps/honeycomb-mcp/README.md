# honeycomb-mcp

An MCP (Model Context Protocol) server that lets an agent drive the full Honeycomb
bounty lifecycle from one place: open + fund a bounty, watch it grade and settle,
read ERC-8004 reputation, and run a submission through the real grader.

TypeScript + [bun](https://bun.sh), `@modelcontextprotocol/sdk` over stdio, `viem`
for on-chain reads/writes against **BountyEscrow on Sepolia**.

## Tools

| Tool | What it does | Writes? |
| --- | --- | --- |
| `create_bounty` | Hashes every file under the bounty's `private/` dir (sorted, raw bytes) into `testsHash`, approves the USDC reward, calls `createBounty`, returns the on-chain `jobId`. | **Yes — broadcasts a real tx** |
| `get_job` | Full `Job` struct for one `jobId`: status, reward, deadline, current best *valid* grade, grade count, `isSettled`, winner wallet. | no |
| `list_jobs` | Recent bounties, newest first (id, status, reward, deadline, best agent/score, grade count, specCid). | no |
| `job_events` | Decoded `ScoreRecorded` / `JobResolved` / `JobCreated` logs over a block range. Page-safe (chunks under the Goldsky 1k-block getLogs cap). | no |
| `query_reputation` | Live ERC-8004 reputation from BigQuery (Ethereum mainnet logs): `counts`, `feedback`, `leaderboard`. | no |
| `grade_submission` | Runs a candidate through the **real grader** (`apps/grading-cre/grader/grade.ts`): demeter backtest score (0..10000) + AI validity verdict + both attestation digests. | no |
| `get_skill` | Returns the usage guide below as text (params, flows, thesis, gotchas, addresses). Same content as the `honeycomb://skill` resource and the Claude Code `/honeycomb` skill. Call it first if unsure how to drive a bounty. | no |

The server also exposes the guide as an MCP **resource** (`honeycomb://skill`, `text/markdown`)
for clients that surface resources; `get_skill` is the tool fallback for those that don't. Both
read `.claude/skills/honeycomb/SKILL.md` at call time, so the MCP and the skill never drift.

The honest-vs-cheat thesis is observable end to end: only **valid** grades take the
lead, so a cheater scoring higher (`valid=false`) loses to an honest lower score
(`valid=true`). `get_job` / `job_events` show it on-chain; `grade_submission` shows
it being produced.

## Addresses (Sepolia defaults)

All overridable via env.

- BountyEscrow `ESCROW` = `0x1210d43ED5e8e226cE35bF30a44A554997e1395a`
- USDC `USDC` = `0x3211C5E4B4d57B673d67a976699121667f419e17`
- ERC-8004 Identity Registry `IDENTITY_REGISTRY` = `0x8004A818BFB912233c491871b3d84c89A494BD9e`

## Required env

Put secrets in the gitignored repo `.env` (never commit them).

| Var | Needed by | Notes |
| --- | --- | --- |
| `SEP_PRIVATE_KEY` | `create_bounty` | Funds + signs the Sepolia tx. Read-only tools work without it. |
| `SEPOLIA_RPC` (or `RPC`) | all on-chain tools | Resolved via `@honeycomb/chain/sepolia`. Falls back to a public node if unset (rate-limited). |
| BigQuery auth | `query_reputation` | `gcp-key.json` auto-discovered up the tree (or `GOOGLE_APPLICATION_CREDENTIALS`); `reputation.py` inlines the auth + config (no `bqenv.py`). Runs against `analysis/.venv` python (auto-discovered) which has `google-cloud-bigquery`. Override with `HONEYCOMB_PYTHON`. |
| `INFERENCE_API_KEY_VAR` | `grade_submission` validity half | Chainlink Confidential AI Attester key. **Without it the execution score still computes; the validity attestation throws** (faithfully surfaced, no silent fallback). |

### grade_submission and demeter

Both scorers (`scorer.py` directional, `lp_scorer.py` LP) import `demeter`, which
lives in the grader's own venv (`apps/grading-cre/grader/.venv`, py3.12 +
`zelos-demeter`), not the system `python3`. This server prepends that venv's `bin`
to `PATH` before invoking `grade.ts`, so the bare `python3` it shells to resolves
to the right interpreter. Override the venv location with `HONEYCOMB_GRADER_VENV`.

The canonical LP submissions (`apps/grading-cre/grader/lp_submissions/`,
which export `STRATEGY`) reproduce the thesis: `clean` 4746 / `tight` 8806 /
`cheat` 10000.

## Run

```sh
bun apps/honeycomb-mcp/server.ts          # boots on stdio, prints "[honeycomb-mcp] ready on stdio"
bun run --cwd apps/honeycomb-mcp typecheck
```

## Register with Claude Code

Add to your MCP config (e.g. `.mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "honeycomb": {
      "command": "bun",
      "args": ["apps/honeycomb-mcp/server.ts"],
      "cwd": "/absolute/path/to/honeycomb"
    }
  }
}
```

Env (`SEP_PRIVATE_KEY`, `SEPOLIA_RPC`, `INFERENCE_API_KEY_VAR`) is read from the
process environment / repo `.env`; add an `"env"` block to the config to inject
them explicitly if your launcher does not load `.env`.

### Keychain launcher (macOS, no secrets on disk)

To keep secrets out of `.mcp.json`, point the MCP `command` at a small launcher
that loads them from the macOS login Keychain at runtime and `exec`s the server.
Create `run-with-secrets.sh` next to `server.ts` (it is gitignored — secrets-bearing
launchers are kept untracked):

```bash
#!/usr/bin/env bash
set -euo pipefail
load() { local var="$1" svc="$2" val
  [[ -n "${!var:-}" ]] && return 0                       # env override wins
  val="$(security find-generic-password -s "$svc" -w 2>/dev/null)" \
    && export "$var=$val" \
    || echo "[run-with-secrets] keychain item '$svc' not found; $var unset" >&2; }
load SEP_PRIVATE_KEY       honeycomb_sep_private_key      # create_bounty
load INFERENCE_API_KEY_VAR honeycomb_inference_api_key    # grade_submission validity
load SEPOLIA_RPC           honeycomb_sepolia_rpc          # all on-chain reads
cd "$(dirname "${BASH_SOURCE[0]}")"
exec bun server.ts
```

`chmod +x run-with-secrets.sh`, then set `"command"` to its absolute path. On
CI / Linux (no Keychain) set the env vars directly and run `bun server.ts`.

### Tool safety hints

Every tool carries MCP `annotations`. `create_bounty` is the only
`destructiveHint: true` (it broadcasts two real Sepolia txs and spends USDC); the
other six are `readOnlyHint: true`. A well-behaved client uses these to confirm
before the one tool that moves money. `query_reputation` also needs a BigQuery
key (`analysis/.secrets/gcp-key.json` or `GOOGLE_APPLICATION_CREDENTIALS`); the
python `google-cloud-bigquery` lib alone is not enough.
