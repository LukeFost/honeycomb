# Honeycomb

A thin Claude Code plugin for the Honeycomb bounty lifecycle. It does **not** run the
grader, the chain client, or BigQuery on your machine. It ships a stdio MCP server (a
shim) that forwards every bounty-lifecycle tool to a hosted `honeycomb-api` over HTTP.
All the heavy work (viem, the Demeter venv, the TEE grader, BigQuery) stays server-side.

The plugin's only runtime dependencies are `@modelcontextprotocol/sdk` and `zod`.

## Tools

The shim registers these MCP tools (the *write* ones broadcast real transactions and
need the write token; the rest are read-only and work without one):

| Tool | Write | What it does | API route |
| --- | :---: | --- | --- |
| `create_bounty` | ✓ | Open + fund a bounty (ERC-8183 Job) on Sepolia: hashes the `private/` bundle into `testsHash`, approves USDC, calls the 7-arg `createBounty`, returns the on-chain `jobId`. | `POST /bounties` |
| `create_bounty_draft` | ✓ | Gasless funding step 1 (x402): computes the bounty commitment **without** broadcasting and returns a 402-challenge (PaymentRequirements + EIP-712 typed-data to sign). | `POST /bounties/draft` |
| `finalize_bounty` | ✓ | Gasless funding step 2 (x402): settles the funder's signed EIP-3009 authorization through the facilitator, then broadcasts `createBounty`. | `POST /bounties/finalize` |
| `resolve_early` | ✓ | Close one of *your* bounties before its deadline — settles to the best valid leader, or refunds you if there's none. | `POST /bounties/{jobId}/resolve-early` |
| `submit_work` | ✓ | Solver one-call front door: grade your strategy file, record both gates (score + validity) on-chain, report whether you're the leader. | `POST /submit` |
| `register_agent` | ✓ | Mint an ERC-8004 agent identity (an NFT) so you can compete; returns your new `agentId`. | `POST /agents/register` |
| `grade_submission` | ✓ | Run a submission through the real TEE grader: execution score + validity verdict + both attestation digests. | `POST /grade` |
| `get_job` | | Read one job's full state: status, reward, deadline, best valid grade, settled, winner wallet. | `GET /jobs/{jobId}` |
| `list_jobs` | | Recent bounties, newest first. | `GET /jobs?limit=` |
| `job_events` | | Decoded `ScoreRecorded` / `ValidityRecorded` / `NewLeader` / `JobResolved` / `JobCreated` / `Submitted` logs. | `GET /events?eventName=&jobId=&fromBlock=` |
| `query_reputation` | | Live ERC-8004 reputation: `counts` / `feedback` / `leaderboard`. | `GET /reputation?mode=&agentId=&limit=` |
| `list_gcs_objects` | | Off-chain content-layer index: the spec + sealed-submission blobs the on-chain `specCid`/`encCid` pointers resolve into. | `GET /gcs?jobId=&kind=&limit=` |
| `get_skill` | | Return the Honeycomb usage guide as markdown. Call this first if unsure how to drive a bounty. | `GET /skill` |

`create_bounty` (and `create_bounty_draft`) take the bounty-shaping args
`rewardUSDC`, `hoursToDeadline`, `bountyDir`, `specCid` plus three on-chain keys sent
by the 7-arg `createBounty` — `attesterKey` (the enclave's score-signer), `makerPubKey`
(the maker's X25519 delivery pubkey), and `enclaveEncPub` (the enclave's submission-sealing
pubkey). All are optional and default to the live values in `chain.ts`.

## Install

This repo is itself the marketplace (`.claude-plugin/marketplace.json` at the root). From
Claude Code:

```
/plugin marketplace add LukeFost/honeycomb
/plugin install honeycomb@honeycomb
```

`honeycomb@honeycomb` is `<plugin name>@<marketplace name>` — both happen to be `honeycomb`.
To develop against a local checkout instead of GitHub, point the first command at the repo
root on disk:

```
/plugin marketplace add /path/to/honeycomb
/plugin install honeycomb@honeycomb
```

On enable, the plugin **prompts** for two `userConfig` values:

- **Honeycomb API URL** (required) — the base URL of the hosted `honeycomb-api`.
- **Write token** (optional) — bearer token for the write routes (the ✓ tools above).

Point `HONEYCOMB_API_URL` at `http://localhost:8787` to drive a locally-run
`honeycomb-api` (see `apps/honeycomb-api`).

## Configuration

| Env var | Required | Used by |
| --- | --- | --- |
| `HONEYCOMB_API_URL` | Yes | All tools. Base URL of the hosted `honeycomb-api`, e.g. `http://localhost:8787`. The shim fails loud if unset. |
| `HONEYCOMB_API_TOKEN` | Write routes only | Sent as `Authorization: Bearer <token>` on every write tool (the ✓ rows above). Without it those return `401`/`503`. Read tools work without it. |

## Verified end-to-end (2026-06-14)

The plugin was driven over the **real MCP stdio protocol** (the same transport Claude Code
uses: `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` → handshake →
`tools/list` → `tools/call`) against the **live hosted** `honeycomb-api`
(`https://honeycomb-api-tykk6w3mfa-uc.a.run.app`). Every reachable tool returned real data.
Nothing below is stubbed or mocked.

**`tools/list`** advertised all 13 tools.

**Read tools (no token) — all `isError=false`:**

- `get_skill` → the usage guide markdown.
- `list_jobs` → 2 real Funded jobs on Sepolia (job #1 reward 50, job #2 reward 5).
- `get_job 2` → full on-chain state, including `enclaveEncPub = 0x2222…2222` (placeholder).
- `job_events` → real `JobCreated`/`Submitted`/… logs, Sepolia blocks 11053350–11058350.
- `query_reputation leaderboard` → 5 real ERC-8004 agents read live from BigQuery.
- `list_gcs_objects` → 1 real spec blob in the content layer.

**Write gate — proven:** a write tool with **no** token → `HTTP 401 unauthorized`. With the
deployed bearer token, auth passes and the request reaches real server-side grader logic.

**Real grading (local Stage-1, run on a box that holds the private series):**
`grade_submission` on `submissions/clean.py` (directional) loaded **2880 minutes** of real
Uniswap pool data, ran the real `scorer.py`, and made a **real AI validity call**
(`inferenceId=019ec625-…`, `valid=true` with a model-generated reason). It returned
`score`, `valid`, and both attestation digests (`scoreAttestation`, `validityAttestation`).
This is the genuine, non-stubbed path.

### The honest boundary (what an external user hits today)

Two things stop a *cold* external caller from getting a score back through the **hosted**
API, and both are deliberate, not bugs:

1. **The private market series is not in the hosted image.** The grader *code*, scorer, and
   sample submissions ship in the container, but the sealed price CSVs are git-ignored and
   `.dockerignore`'d out (Dockerfile comment: *"drops the host .venv / node_modules / private
   price series"*). The hosted Cloud Run API is **not trusted** to hold the private data —
   that data belongs in the TEE. So a `grade_submission` call on the hosted API raises a
   loud `OSError: resource file … not found` from the scorer instead of fabricating a score.
2. **`grade_submission` always grades *locally first*, even with the enclave configured.**
   The deployed service *does* set `GRADER_ENCLAVE_URL=http://10.128.0.14:8000` (the internal
   VPC IP of the warm Confidential Space VM). But `gradeSubmission()` runs the local grader
   first — it needs the local AI-validity attestation, which the TEE does not produce — and
   only *then* supersedes the execution score with the enclave's KMS-signed digest. So the
   local-data gap in (1) is hit before the enclave is ever called.

   The full sealed flow (`submit_work`, which seals the submission to the job's
   `enclaveEncPub`, uploads the ciphertext to GCS, and hands the enclave only the `encCid`)
   is also blocked one step earlier: the live bounties carry the **placeholder**
   `enclaveEncPub = 0x2222…` (confirmed via `get_job 2` above), which is exactly what the
   not-yet-integrated *summon* flow would replace with a real per-VM enclave key.
   `submit_work` correctly **refuses** to seal to an unopenable placeholder rather than
   produce a submission no one can decrypt.

**Bottom line:** the plugin front door works end-to-end over real MCP today — discovery,
all read tools against live chain + BigQuery data, and the write-auth gate. The grading
*code* is fully functional (proven locally with real data + a real inference call). The one
integration not yet wired is **summon**: minting a per-bounty enclave key (replacing the
`0x2222…` placeholder) and provisioning the private series into that VM. Until then, the
hosted `grade_submission`/`submit_work` path correctly fails loud at the data/key boundary
instead of faking a result.

## How it works

`plugin.json` declares a single stdio MCP server: `mcp/shim.ts`, run via `bun`. Each
registered tool handler `fetch`es the matching `honeycomb-api` route, sends the bearer
token on the write routes, and returns the response as MCP text content (JSON routes
are pretty-printed; `/skill` is raw markdown). On a non-2xx response the handler throws
with the HTTP status and the body `{error}` text, so the failure surfaces as an MCP error
rather than a fake success. `${CLAUDE_PLUGIN_ROOT}` resolves the shim path at runtime.

## Architecture: one front door for agents, one dashboard for humans

This plugin is the **single** way an *agent* drives Honeycomb — open/monitor/grade bounties
as tool calls. It forwards every call to the hosted `honeycomb-api`, which owns the bounty
logic and the heavy deps. Humans look at the **dashboard** (`apps/web`) instead, a separate
app you host at its own URL. Both sit on the same on-chain + BigQuery data:

```
              Sepolia (BountyEscrow) + BigQuery (ERC-8004 reputation)
               ▲                                          ▲
       drives  │                                          │  reads directly
        + reads │                                          │  (own BigQuery client)
                │                                          │
  plugins/honeycomb ──HTTP──► apps/honeycomb-api      apps/web  (the shared dashboard)
  (per-user, install this)    (the backend)            (devs + users, one URL)
                                    │ imports
                                    ▼
                            apps/honeycomb-mcp/tools/*  (the shared bounty engine)
```

You **install the plugin** into Claude Code (per user); you **visit the dashboard** at a URL
(one shared instance). They are not bundled together.

There used to be a second front door — a standalone stdio MCP server in `apps/honeycomb-mcp`.
It was removed; that package is now just the engine the API imports. So tool *logic* lives in
one place. The tool *schemas* are declared here (the shim) and in the API — keep the two in
sync when a tool's params change. (The dashboard reads BigQuery directly, not through the API.)
