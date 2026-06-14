# honeycomb-api

The **one backend** behind every Honeycomb front door. It exposes the full
bounty lifecycle — open + fund a bounty, watch it grade and settle, read
ERC-8004 reputation, run a submission through the real grader — as HTTP routes.

There is a single front door for *agents*: the installable [`plugins/honeycomb`](../../plugins/honeycomb/)
Claude Code plugin, a thin stdio MCP shim that **forwards every tool call to
these routes**. The plugin can't ship the grader's demeter venv, the BigQuery
creds, or the Sepolia keys, so the heavy, repo-bound work lives here, server-side.
The team runs this service locally and points the plugin at `http://localhost:8787`;
for everyone else you host it.

*Humans* don't go through this API at all — they use the **dashboard**
([`apps/web`](../web/)), a separate app you host at its own URL that reads the same
on-chain + BigQuery data **directly** (its own BigQuery client, not these routes).
One shared dashboard for everyone — devs and users alike. So Honeycomb has two
deployables sitting on one data substrate: this API (what the per-user plugin calls)
and the dashboard (what humans look at).

`server.ts` imports the tool functions directly from `../honeycomb-mcp/tools/*`
(the shared bounty engine), so the bounty logic lives in exactly one place.

TypeScript + [bun](https://bun.sh) (`Bun.serve`, zero extra deps), `viem` for
on-chain reads/writes against **BountyEscrow on Sepolia**.

## Routes

**Live base URL:** `https://honeycomb-api-tykk6w3mfa-uc.a.run.app`
(stable alias `https://honeycomb-api-912224428574.us-central1.run.app`). Both are
permanent — only the Cloud Run revision tag changes across deploys.

**Auth in one line:** reads need nothing; **writes require the shared token** via
either `Authorization: Bearer <token>` or `X-Honeycomb-Token: <token>`. The token
lives in Secret Manager (`honeycomb-api-token`) and is mounted in prod; ask a
maintainer for the value. Three failures, all loud:
`401 unauthorized` (wrong/missing token) · `503 write routes are disabled`
(server has no `HONEYCOMB_API_TOKEN`) · `400` (token OK, body bad — this is the
signal your token works).

### Reads — no token

| Method | Path | What it does | Secrets |
| --- | --- | --- | --- |
| GET | `/` | Health: `{name, status, port}`. | none |
| GET | `/skill` | The usage guide (markdown) — the canonical `/honeycomb` skill, read live so the docs never drift. The plugin's `get_skill` tool returns this. | none |
| GET | `/jobs?limit=N` | Recent bounties, newest first. | none |
| GET | `/jobs/:id` | One job's full state: status, reward, deadline, best *valid* grade, `settled`, winner wallet. | none |
| GET | `/events?eventName=&jobId=&fromBlock=` | Decoded `ScoreRecorded` / `ValidityRecorded` / `NewLeader` / `JobResolved` / `JobCreated` logs (page-safe under the Goldsky 1k-block cap). | none |
| GET | `/spec?...` | Resolve a bounty's spec. | none |
| GET | `/gcs` | Off-chain content index (specs / sealed submissions) from Neon `gcs_objects`. | `DATABASE_URL` |
| GET | `/reputation?mode=&agentId=&limit=` | ERC-8004 reputation from BigQuery: `counts` / `feedback` / `leaderboard`. | BigQuery auth |
| POST | `/snapshot?jobs=N&lookback=N` | Reconcile live chain → Neon (jobs upsert + events append). Reads public chain, writes our own DB — no money, no signature, so **not token-gated**. Driven every 15m by Cloud Scheduler (`honeycomb-snapshot`) as a safety net behind the WS subscriber. | `DATABASE_URL` |

### Writes — token required (spends money or signs a tx)

| Method | Path | What it does | Required body | Secrets |
| --- | --- | --- | --- | --- |
| POST | `/bounties` | Open + fund a bounty. **BROADCASTS a real Sepolia tx.** | optional `rewardUSDC`, `hoursToDeadline`, `bountyDir` (repo-relative) | `SEP_PRIVATE_KEY` |
| POST | `/bounties/draft` | Gasless funding step 1: compute the commitment, return an x402 402-challenge to sign. **No USDC spent.** | same as `/bounties` | `SEP_PRIVATE_KEY` |
| POST | `/bounties/finalize` | Gasless funding step 2: settle the signed EIP-3009 auth (relayer pays gas), then broadcast `createBounty`. | `draftId`, `signature`, `authorization` (object) | `SEP_PRIVATE_KEY`, facilitator |
| POST | `/bounties/:id/resolve-early` | Maker closes a contest early (`resolveEarly`); escrow enforces caller = client. | none | `SEP_PRIVATE_KEY` |
| POST | `/grade` | Run a submission through the **real grader** → score + validity + attestation digests. | `submissionPath` (repo-relative) | demeter venv, `INFERENCE_API_KEY_VAR` |
| POST | `/submit` | Solver one-call front door: read bounty → grade → record both gates on-chain (CRE) → plain-English verdict. | `jobId`, `submissionPath` (repo-relative) | grade deps + CRE relay/CLI |
| POST | `/agents/register` | Mint an ERC-8004 agent identity (real on-chain tx; pre-checks signer gas). | optional `tokenURI` | `SEP_PRIVATE_KEY` |

Errors surface faithfully as JSON `{error}` with a 4xx/5xx status — no silent
fallback. `submissionPath` / `bountyDir` must be **repo-relative**: an absolute
path (leading `/`) is rejected `400` over HTTP — the absolute-path escape is
local-operator-only.

`jobId` is a string everywhere (ERC-8183 ids can exceed 2^53). The query/body
shapes mirror the plugin's tool params exactly; see [`GET /skill`](#run) for the
canonical parameter reference.

Example write call:

```sh
curl -s -X POST https://honeycomb-api-tykk6w3mfa-uc.a.run.app/grade \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"submissionPath": "submissions/clean.py"}'
```

## Run

```sh
# read routes only (no secrets needed):
bun apps/honeycomb-api/server.ts                 # listens on http://localhost:8787

# all routes, secrets from the macOS keychain (write + grade):
bash apps/honeycomb-api/run-with-secrets.sh

bun run --cwd apps/honeycomb-api typecheck
```

`PORT` (or `HONEYCOMB_API_PORT`) overrides the port; default `8787`.

The server binds **loopback (`127.0.0.1`) by default** — the write routes broadcast
funded txs and spawn the grader, so they must not be reachable from the LAN. All
write routes (every `POST` above) are **disabled unless `HONEYCOMB_API_TOKEN` is
set**, and then require it on every call via `Authorization: Bearer <token>` or
the `X-Honeycomb-Token` header. To expose
beyond loopback (don't, unless you mean it), set `HOST=0.0.0.0` AND a token.

```sh
curl localhost:8787/jobs?limit=3
curl localhost:8787/jobs/2
curl "localhost:8787/events?eventName=JobResolved&jobId=1"
curl localhost:8787/skill
```

## Env

The engine's secrets ([honeycomb-mcp](../honeycomb-mcp/README.md#secrets)), needed
only by the routes that use them:

| Var | Needed by | Notes |
| --- | --- | --- |
| `SEP_PRIVATE_KEY` | `POST /bounties` | Funds + signs the Sepolia tx. Read routes work without it. |
| `SEPOLIA_RPC` (or `RPC`) | all on-chain routes | Resolved via `@honeycomb/chain/sepolia` (keychain `honeycomb_sepolia_rpc`, else a public fallback). |
| BigQuery auth | `GET /reputation` | `analysis/.secrets/gcp-key.json`, runs on `analysis/.venv` python. |
| `INFERENCE_API_KEY_VAR` | `POST /grade` validity half | Without it the score still computes; the validity attestation throws (surfaced). |

`run-with-secrets.sh` reads `SEP_PRIVATE_KEY` + `INFERENCE_API_KEY_VAR` from the
keychain at launch (gitignored, machine-specific). On another machine, stock the
keychain with those service names or set the env vars another way and run
`bun server.ts` directly.

## Addresses (Sepolia)

Defaults from the engine's `chain.ts`, all overridable via env:

- BountyEscrow `0xce27EEDE3b033582e1Adec94F8679d3feEF142c2` (ERC-8183, 7-arg)
- USDC `0x3211C5E4B4d57B673d67a976699121667f419e17`
- ERC-8004 Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`
