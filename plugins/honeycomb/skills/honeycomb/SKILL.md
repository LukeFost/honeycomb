---
name: honeycomb
description: Drive the Honeycomb bounty lifecycle through the honeycomb plugin (mcp__honeycomb__* tools). Open + fund bounties on Sepolia, monitor grading/settlement, read ERC-8004 reputation, and grade submissions through the real TEE grader. Use whenever the task is about Honeycomb bounties, jobs, grading, scoring, the honest-vs-cheat thesis, or the BountyEscrow contract.
---

# Honeycomb

Honeycomb is an on-chain bounty market for trading strategies. A maker posts a bounty
with a private price series + rubric; agents submit strategies; a TEE grader runs each
submission against the private data and produces a **score** (real backtested PnL,
0..10000) plus a **validity** verdict (did it genuinely compute, or cheat/hardcode?).
Only **valid** grades can win. The core thesis: an honest lower score beats a
cheating higher one.

Honeycomb exposes that whole lifecycle as 6 tools (the plugin also registers a 7th,
`get_skill`, which just returns this guide). This skill is how to use the 6.

## Prereq: how you reach the tools

There is **one front door**: the **Honeycomb Claude Code plugin** (`plugins/honeycomb`).
It ships a thin stdio MCP shim that forwards every tool call over HTTP to a hosted
`honeycomb-api` (`apps/honeycomb-api`), which owns the chain client, the grader venv, and
BigQuery. Install it with `/plugin install honeycomb@honeycomb`; it prompts for the API URL
(and an optional write token for the two write tools). The team runs the API locally and
points the plugin at `http://localhost:8787`; for everyone else you host it. Once enabled,
the tools appear as `mcp__honeycomb__*`.

This guide is served by the API itself at `GET /skill` (and the plugin's `get_skill` tool
returns it), read live from this file — so the docs never drift from the tools.

The plugin is the *agent's* way in. The *human* view of the same bounties, scores, and
reputation is the **dashboard** (`apps/web`) — one shared instance you host at its own URL,
not installed with the plugin. It reads the same on-chain + BigQuery data directly. Point a
person there; drive the tools here.

Secrets live **server-side** on the `honeycomb-api` host, never in the plugin. The backend's
`run-with-secrets.sh` loads them from the macOS keychain at launch (memory
`honeycomb-keychain-secrets`): `SEP_PRIVATE_KEY` (signs Sepolia txs), `INFERENCE_API_KEY_VAR`
(validity attestation), `SEPOLIA_RPC` (resolved by `packages/chain/sepolia.ts`). Read-only
tools need none; the two write tools need the API's `HONEYCOMB_API_TOKEN`.

## The 6 tools

| Tool | Use it to | Writes chain? |
| --- | --- | --- |
| `create_bounty` | Open + fund a bounty (hashes the private bundle, approves USDC, calls createBounty). | **Yes, broadcasts** |
| `get_job` | Read one job's full state: status, reward, deadline, best *valid* grade, settled, winner wallet. | no |
| `list_jobs` | Recent bounties, newest first. | no |
| `job_events` | Decoded `ScoreRecorded` / `ValidityRecorded` / `NewLeader` / `JobResolved` / `JobCreated` logs; watch grading + settlement. | no |
| `query_reputation` | Live ERC-8004 reputation from BigQuery: `counts` / `feedback` / `leaderboard`. | no |
| `grade_submission` | Run a submission through the REAL grader → score + validity + attestation digests. | no |

### Parameters (live schemas; `*` = required)

```
create_bounty      rewardUSDC:number  hoursToDeadline:number  bountyDir:string  specCid:string  privateFiles:string[]
get_job            jobId*:string
list_jobs          limit:integer
job_events         jobId:string  eventName:ScoreRecorded|ValidityRecorded|NewLeader|JobResolved|JobCreated  fromBlock:string
query_reputation   mode:counts|feedback|leaderboard  agentId:integer  limit:integer
grade_submission   submissionPath*:string  bounty:directional|lp  jobId:string  agentId:string
```

jobId is a STRING everywhere (ERC-8183 ids can exceed 2^53). Defaults: list_jobs limit 25,
query_reputation mode counts, grade_submission bounty `directional` / jobId `1` / agentId `22`.

## Common flows

**See what's live.** `list_jobs` for the board, then `get_job {jobId}` for one bounty's full
state. `job_events {jobId, eventName:"ScoreRecorded"}` to see every grade posted against it.

**Open a bounty.** `create_bounty {rewardUSDC, hoursToDeadline, bountyDir}`. This BROADCASTS a
real Sepolia tx (needs `SEP_PRIVATE_KEY`); confirm with Luke before calling unless told to
proceed. It returns the on-chain `jobId` recovered from the `JobCreated` event. `bountyDir`
relative paths resolve under `apps/grading-cre`; default is the uniswap-lp-trading-bot bounty.

**Grade a submission.** `grade_submission {submissionPath, bounty}`. Returns
`{score, valid, scoreAttestation, validityAttestation}`. Two bounty types:
- `directional` → `scorer.py` over a price series (signal()→label).
- `lp` → `lp_scorer.py`, a Demeter Strategy over a pool CSV.

**Watch a bounty settle.** Poll `job_events {jobId, eventName:"JobResolved"}` (or `get_job` and
check `settled` / `winnerWallet`). Cross-reference the winner with `query_reputation`.

## The honest-vs-cheat thesis (what to demo)

The canonical LP submissions live in `apps/grading-cre/grader/lp_submissions/`
(they export `STRATEGY`, the contract `lp_engine.py` reads). Grading them reproduces:

| submission | score | valid | outcome |
| --- | --- | --- | --- |
| `clean.py` | 4746 | true | honest, modest, **eligible to win** |
| `tight.py` | 8806 | true | aggressive but real, valid |
| `cheat.py` | 10000 | false | highest score, **but valid=false → loses** |

So `grade_submission {submissionPath:".../lp_submissions/cheat.py", bounty:"lp"}` shows the
cheater scoring 10000 yet losing, because only valid grades take the lead on-chain. This is
the whole pitch in one call.

## Gotchas (verified)

- **Use `lp_submissions/`, not `submissions/`.** The `grader/submissions/*_lp.py` samples are
  STALE (old `on_bar` contract) and fail with `no attribute STRATEGY`. The directional
  `prices_private.json` is a 456-byte stub that scores everything 0. LP is the live path.
- **grade_submission needs demeter.** Both scorers import it. The grader code prepends the
  venv (`apps/grading-cre/grader/.venv/bin`, py3.12 + zelos-demeter) to PATH automatically.
  If you run the grader by hand, do the same or set `HONEYCOMB_GRADER_VENV`.
- **Validity needs the inference key.** Without `INFERENCE_API_KEY_VAR` the execution SCORE
  still computes, but the validity call throws (faithfully surfaced, no silent fallback).
  The `honeycomb-api` host supplies it (keychain via `run-with-secrets.sh`).
- **job_events pages under 1000 blocks.** Goldsky caps eth_getLogs (~500 ok). The tool pages a
  ~5000-block lookback automatically; pass `fromBlock` for deeper history.
- **query_reputation needs BigQuery auth** (`analysis/.secrets/gcp-key.json`) and runs on the
  `analysis/.venv` python (auto-discovered). It reads Ethereum **mainnet** ERC-8004 logs.

## Addresses (Sepolia)

BountyEscrow `0xce27EEDE3b033582e1Adec94F8679d3feEF142c2` (ERC-8183) · USDC
`0x3211C5E4B4d57B673d67a976699121667f419e17` · ERC-8004 Identity Registry
`0x8004A818BFB912233c491871b3d84c89A494BD9e`. See `apps/honeycomb-api/README.md` to run the
backend, `plugins/honeycomb/README.md` to install the plugin, and `apps/honeycomb-mcp/` for
the shared engine.
