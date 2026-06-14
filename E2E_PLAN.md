# Honeycomb — Big E2E Scope ("does it all work together?")

Goal: drive one bounty through **every** component and prove the seams hold —
plugin front door + HTTP API + grading pipeline (contract/CRE/grader) + BigQuery
(both layers) + web dashboard + chain-verify. Written 2026-06-14 from a full repo
sweep. (Updated: the standalone `honeycomb-mcp` stdio server was retired — one
front door now, the plugin, forwarding to the API.)

## Components in scope
| Component | Role | Run |
|---|---|---|
| `plugins/honeycomb` | The ONE front door: stdio MCP shim forwarding the 6 tools (create_bounty, get_job, list_jobs, job_events, query_reputation, grade_submission) over HTTP | `/plugin install honeycomb@honeycomb`, point at the API |
| `apps/honeycomb-api` | The ONE backend: those 6 functions over HTTP (imports `honeycomb-mcp/tools/*`, the shared engine) | `bun apps/honeycomb-api/server.ts` |
| `apps/grading-cre` | BountyEscrow `0xce27EEDE` (ERC-8183) + CRE workflow + grader (demeter) | cast / `cre workflow simulate` |
| `apps/web` | Dashboard: Layer-1 trust (live BQ) + Layer-2 market | `pnpm --filter web dev` |
| `tools/chain-verify` | Proves dashboard reads only on-chain data (mock chain → BQ fixture → real SQL) | `./demo.sh up/seed/down` |
| `apps/x402-facilitator` | x402 payment facilitator: verify + settle EIP-3009 USDC | `bun apps/x402-facilitator/server.ts` |
| `apps/tee-runner/enclave` | Warm Confidential Space daemon: paid `/run` of buyer code in a hardened sandbox + attestation proof | `enclave_server.py` (Confidential Space VM; dev: `SANDBOX_ALLOW_UNSAFE=1`) |
| BigQuery | ERC-8004 reputation (mainnet public logs) + escrow events | via the above |

Canonical addresses (Sepolia): Escrow `0xce27EEDE3b033582e1Adec94F8679d3feEF142c2` (ERC-8183),
USDC `0x3211C5E4B4d57B673d67a976699121667f419e17`, attesterKey `0x5B57aF5e…`,
ERC-8004 Identity `0x8004A818…` (Sepolia) / `0x8004a169…` (mainnet, web BQ).

## Phase 0 — preflight (must pass before anything)
- [ ] `.env` has `SEP_PRIVATE_KEY`, `INFERENCE_API_KEY_VAR`; wallet has Sepolia ETH.
- [ ] `SEPOLIA_RPC` resolves (keychain or env); `cast block latest` works.
- [ ] BigQuery creds discoverable (`.secrets/gcp-key.json` or `GOOGLE_APPLICATION_CREDENTIALS`).
- [ ] `analysis/.venv` (google-cloud-bigquery) present → MCP `query_reputation`.
- [ ] `apps/grading-cre/grader/.venv` (zelos-demeter) present → `grade_submission`.
- [ ] typecheck all: mcp, api, web, grading-workflow.

## Phase 1 — the tools drive the chain (create + read)
> "MCP" / "MCP tool" below = the 6 `mcp__honeycomb__*` tools the plugin exposes, each
> forwarding to the API. They're one surface now, not a second server.
1. `create_bounty` (override `MAKER_PUBKEY` with a real X25519 key, not the `0x11…` placeholder) → real Sepolia tx → returns `jobId`.
2. `get_job(jobId)` → 21-field `getJobFull` struct, `attesterKey=0x5B57aF5e`, `makerPubKey` = the real key.
3. `list_jobs` → the new job appears, newest first.
4. **Pass:** the job created via MCP is readable via MCP, struct decodes, addresses match.

## Phase 2 — grading pipeline → settlement (the engine)
Drive the Architecture-A flow against the same `jobId` (this is the manual/keeper path):
1. Agent seal+`submit(jobId, agentId, encCid)` on-chain.
2. Grader: open submission → score → **KMS-sign** `keccak(jobId,agentId,score)` → `kind:"score"` callback → CRE → `recordScore` (contract `ecrecover` must pass = tx status 1).
3. AI attestor → `kind:"validity"` callback → CRE → `recordValidity`.
4. `get_job` → `bestAgentId` set (both gates in + valid).
5. CRON `resolve` after deadline → winner paid; `isSettled=true`.
6. Delivery: enclave re-seals winner → `deliverWinner` → `winnerDeliveryCidOf` set → maker decrypts.
7. **Pass:** the full create→submit→score→validity→resolve→deliver chain lands on-chain and `job_events` shows `ScoreRecorded/ValidityRecorded/JobResolved`.

## Phase 3 — plugin → API forwarding fidelity
1. `bun apps/honeycomb-api/server.ts`; hit `GET /jobs/:id`, `/events`, `/jobs?limit=` directly, then via the plugin's tools → byte-identical (the shim just forwards).
2. `POST /bounties` (with `HONEYCOMB_API_TOKEN`) → real tx, new jobId; same through `create_bounty`.
3. **Pass:** what the plugin returns == what the API returns; write route token-gated + loopback-only.

## Phase 4 — grader (demeter) thesis
1. `grade_submission` on `lp_submissions/{clean,tight,cheat}` → **4746 / 8806 / 10000**, cheat `valid=false`.
2. **Pass:** cheat scores highest but is invalid → loses; honest wins. (The thesis, observable.)

## Phase 5 — BigQuery Layer 1 (trust directory)
1. MCP `query_reputation` (counts/feedback/leaderboard) → real BQ result.
2. web `GET /api/health` (BQ reachable), `/api/agents` (live trust), `POST /api/bigquery` dry-run → scan bytes; live run → counts.
3. **Pass:** ERC-8004 reputation answers from BigQuery; MCP and web agree.

## Phase 6 — web dashboard + chain-verify
1. `pnpm --filter web dev` → dashboard renders Layer 1 (live) + Layer 2.
2. `tools/chain-verify/demo.sh up && seed` → mock chain emits ERC-8004 + escrow events → indexed to BQ fixture → dashboard shows them via the **real** bq.ts SQL → `assert-demo` golden checks pass.
3. **Pass:** dashboard data provably comes from on-chain (no stubs) in the chain-verify path.

## Phase 8 — x402 "summon the TEE" (standalone showcase)
Separate from the bounty pipeline today (`/api/summon` has no jobId/escrow link; GAPS Phase-3
roadmap is to make it spawn the per-bounty TEE). Test it as its own flow:
1. Run `apps/x402-facilitator` + the tee-runner enclave (Confidential Space VM, or `SANDBOX_ALLOW_UNSAFE=1` dev).
2. `POST /api/summon {code}` unpaid → **402** challenge (`nonce` + HMAC `nonceSig`).
3. Wallet signs EIP-3009 USDC `transferWithAuthorization` with `authorization.nonce == nonce`.
4. Paid re-POST (`X-PAYMENT`) → route enforces HMAC + nonce equality → facilitator **verify** → **settle** (real on-chain tx) → enclave **`/run`** → `{result, proof, x402Receipt}`.
5. `verify-attestation` / `teeProof.ts` validates the proof bundle; `/summon` UI does the round-trip.
- **Pass:** unpaid → 402; tampered nonce/code → 402; valid pay → settled tx + attested result; absent/bad attestation → surfaced, never faked.
- **Prereqs:** wallet with USDC (EIP-3009), facilitator+enclave reachable, `SUMMON_NONCE_HMAC_SECRET`, enclave id-token audience (if Confidential Space).

## Phase 7 — cross-consistency
- [ ] Escrow address identical across engine `chain.ts`, api, grading-cre, and docs — all `0xce27EEDE` (ERC-8183).
- [ ] Job struct field order matches on-chain (verify against `0xce27EEDE`'s `getJobFull` — the 21-field struct).
- [ ] Reputation formula parity (`web/reputation.ts` vs `analysis/honeycomb_reputation.sql`).

---

## ⚠️ Integration gaps that BREAK "all together" (decide before the run)

These are the seams where two components don't yet meet. The big e2e should either
pre-fix or explicitly flag each:

1. **A bounty created via MCP does NOT show on the web dashboard.** ✅ RESOLVED (2026-06-14).
   - Fix: the ERC-8183 escrow `0xce27EEDE` now **also emits the web-shaped alias events**
     `BountyCreated / SubmissionMade / ValidationRecorded / BountySettled` ALONGSIDE its native
     `JobCreated / ScoreRecorded / ValidityRecorded / JobResolved` (jobId == bountyId). The four
     alias topic0s were verified byte-equal to `web/src/lib/bq.ts` `ESCROW.events.*` (note
     `BountyCreated` uses **`uint64 deadline`** to match the web's topic0 `0x7181b860…`).
   - Remaining: set `BQ_ESCROW_ADDRESS=0xce27EEDE3b033582e1Adec94F8679d3feEF142c2` for the web
     `/api/refresh` loop (Layer-2 stays seed-CSV-only while unset — production default).

2. **`grade_submission` is a preview, not the on-chain record path.**
   - It emits the **combined** `{score, valid, scoreAttestation, validityAttestation}` (a content-commitment
     sha256), **not** the Arch-A split `kind:"score"` (with the **KMS `(v,r,s)` signature**) + `kind:"validity"`.
   - So Phase 2's on-chain `recordScore` needs the **enclave's** signed callback (kms_sign), which the MCP grade tool
     doesn't produce. Reconcile `grade.ts` to emit the signed split callbacks, or keep grade_submission as preview
     and drive Phase 2 from the enclave.

3. **Agent `submit` + winner delivery are not MCP/API tools.**
   - Phase 2 steps 1, 6 (seal+submit, deliver+decrypt) have no MCP tool yet — they're manual scripts.
     For an agent to drive the whole loop from Claude, add `submit` + `claim_winner` tools.

4. **`MAKER_PUBKEY` placeholder** — MCP create_bounty defaults to `0x11…`; with the placeholder, delivery can't
   be decrypted by a real maker. The maker keygen must feed a real key into create_bounty.

5. **Layer 2 escrow unconfigured** (`BQ_ESCROW_ADDRESS=""`) + Validation Registry not deployed → Layer-2 panels
   are seed/empty by design until wired.

## Suggested run order
Phases 1→2→3→4 prove the **grading engine + both front doors** end to end (this works today, manually).
Phases 5→6 prove **BigQuery + dashboard** (Layer 1 live; Layer 2 via chain-verify fixture).
Then tackle the **#1 gap** (web Layer-2 ↔ grading-escrow event schema) — that's what makes a bounty created in
Phase 1 actually appear on the dashboard, i.e. the true "all together."
