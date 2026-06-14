# Honeycomb

A thin Claude Code plugin for the Honeycomb bounty lifecycle. It does **not** run the
grader, the chain client, or BigQuery on your machine. It ships a stdio MCP server (a
shim) that forwards the 7 bounty-lifecycle tools to a hosted `honeycomb-api` over HTTP.
All the heavy work (viem, the Demeter venv, the TEE grader, BigQuery) stays server-side.

The plugin's only runtime dependencies are `@modelcontextprotocol/sdk` and `zod`.

## Tools

| Tool | What it does | API route |
| --- | --- | --- |
| `create_bounty` | Open + fund a bounty on Sepolia (hashes the private bundle, approves USDC, calls createBounty). Write route. | `POST /bounties` |
| `get_job` | Read one job's full state: status, reward, deadline, best valid grade, settled, winner wallet. | `GET /jobs/{jobId}` |
| `list_jobs` | Recent bounties, newest first. | `GET /jobs?limit=` |
| `job_events` | Decoded `GradeRecorded` / `JobResolved` / `JobCreated` logs. | `GET /events?eventName=&jobId=&fromBlock=` |
| `query_reputation` | Live ERC-8004 reputation: `counts` / `feedback` / `leaderboard`. | `GET /reputation?mode=&agentId=&limit=` |
| `grade_submission` | Run a submission through the real TEE grader: score + validity + attestation digests. Write route. | `POST /grade` |
| `get_skill` | Return the Honeycomb usage guide as markdown. | `GET /skill` |

## Install

```
/plugin marketplace add <owner/repo or local path to this marketplace>
/plugin install honeycomb@honeycomb
```

On enable, the plugin **prompts** for two `userConfig` values:

- **Honeycomb API URL** (required) — the base URL of the hosted `honeycomb-api`.
- **Write token** (optional) — bearer token for the two write routes.

Point `HONEYCOMB_API_URL` at `http://localhost:8787` to drive a locally-run
`honeycomb-api` (see `apps/honeycomb-api`).

## Configuration

| Env var | Required | Used by |
| --- | --- | --- |
| `HONEYCOMB_API_URL` | Yes | All tools. Base URL of the hosted `honeycomb-api`, e.g. `http://localhost:8787`. The shim fails loud if unset. |
| `HONEYCOMB_API_TOKEN` | Write routes only | Sent as `Authorization: Bearer <token>` on `create_bounty` and `grade_submission`. Without it those two return `401`/`503`. Read tools work without it. |

## How it works

`plugin.json` declares a single stdio MCP server: `mcp/shim.ts`, run via `bun`. Each
registered tool handler `fetch`es the matching `honeycomb-api` route, sends the bearer
token on the two write routes, and returns the response as MCP text content (JSON routes
are pretty-printed; `/skill` is raw markdown). On a non-2xx response the handler throws
with the HTTP status and the body `{error}` text, so the failure surfaces as an MCP error
rather than a fake success. `${CLAUDE_PLUGIN_ROOT}` resolves the shim path at runtime.

## Relationship to `apps/honeycomb-mcp`

This plugin and the in-repo `apps/honeycomb-mcp` expose the **same 7 tools** with the same
names and input schemas. The difference is where the logic runs: `honeycomb-mcp` executes
it in-repo (viem, the grader venv, BigQuery), while this plugin forwards each call to the
hosted `honeycomb-api`. One contract, two front doors.
