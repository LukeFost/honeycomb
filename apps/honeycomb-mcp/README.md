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
| `job_events` | Decoded `GradeRecorded` / `JobResolved` / `JobCreated` logs over a block range. Page-safe (chunks under the Goldsky 1k-block getLogs cap). | no |
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

- BountyEscrow `ESCROW` = `0xC0543ac495B24948Ad84cD15d8488d7Af2F9ca90`
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
