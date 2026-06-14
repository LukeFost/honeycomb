# 🍯 Honeycomb — Knowledge Gaps & Build-Out Plan

> **Purpose:** Surface what we don't yet know, propose a build sequence, and record
> what the Luke+Alex design call resolved. Annotate anything: mark it RESOLVED with the
> answer, WRONG if I misread the design, or add the missing detail. Goal is to leave
> this doc with zero open `?` before we parallelize.

---

## 0. RESOLVED by the Luke+Alex design call

> The architecture is settled. README is the source of truth, the diagram
> (`diagrams/honeycomb_architecture.png`) matches it, and `honeycomb-architecture-truth`
> in memory captures the full model.

**Two SEPARATE confidential services (TEEs), NOT nested. Plus the CRE as a thin write-callback.**

- **AI Tester** = **Chainlink Confidential AI** — a hosted LLM-in-TEE that Chainlink
  operates. Validates code is real / not hardcoded → legitimacy verdict. We have the API
  key. **Alex exposes/implements it** (calls the sponsor's enclave; does NOT build one).
  Reference: `chainlink-confidential-ai-attester-demo` (POST `/v1/inference`, CRE callback,
  `onReport` behind KeystoneForwarder).
- **Grading / Confidential Scorer TEE** = **Google Confidential Space** (Go enclave).
  Runs the submission's code + backtest vs hidden tests → score. Signs via **Cloud KMS HSM
  secp256k1** → contract verifies with `ecrecover` (see `TEE_RESEARCH.md`). **Alex owns
  this.** Currently a STUB.
- **Chainlink CRE** = **NOT a TEE.** Its only job: take the verdict/score out of the TEE
  and write it on-chain (the callback + KeystoneForwarder). **Luke owns the CRE callback.**

**Flow INVERTED (key correction):** OLD = CRE calls the testers, batched at the deadline.
NEW = agent submits to the scorer TEE → scorer checks legitimacy with the AI Tester
**directly, off-chain** → scorer runs + scores it blind → fires the CRE callback → CRE
writes verdict + score on-chain. **Per submission, not batched.** Scores stay sealed until
the deadline, when settlement fires.

**Two gates the agent must pass:** AI Tester (legitimacy) AND grading TEE (scorer/backtest).

**The two TEEs coordinate DIRECT, off-chain — but the AI Tester's formal verdict STILL
lands on-chain via the CRE + KeystoneForwarder.** Both true; different legs, not a conflict.

**Encryption: DEFERRED.** Both agreed — connect the pipes first, encrypt-to-enclave-key
comes later. Plaintext lives only inside each enclave, then is discarded.

**NO MOCKS rule (call decision):** "If anything is mocked or fake, remove it. Burn it."
Acceptable: a smart contract emitting real on-chain data. Not acceptable: hardcoded fakes
in the app. The stubbed open bounties must be made real.

---

## 1. Lanes (resolved on the call)

- **Luke** — BigQuery indexing + Next.js dashboard + **the CRE callback**.
- **Alex** — **grading/scorer TEE** (Google Confidential Space, currently stub) AND
  **exposes the AI Tester** (Chainlink Confidential AI).
- **Riley (lil_bicep)** — currently BLOCKED, unsure what to do with the TEEs. Needs a jobs
  path to index via BigQuery. Unblocked once Alex pushes the jobs path.

**Alex's immediate next step:** push scorer/CRE code with the TEE stub, test locally
against contracts, then add the jobs path so Riley can index.

---

## 2. Credentials — we have them, where do they go?

Shared in Discord:
- **Chainlink API key** (from Alex) — unlocks Chainlink Confidential AI / CRE.
- **BigQuery creds** (from Riley / lil_bicep).

- **?** Secret store: proposed `.env` gitignored + macOS keychain; NEVER committed.
  Confirm the deploy target.
- **?** BigQuery: which GCP project, which service account, what dataset name?

---

## 3. Still-open questions

### 3.1 AI Tester API contract — the #1 unknown
Request shape (base64 code? CID? + bounty context), response shape (signed valid/invalid
+ code-hash), host URL, how the verdict reaches the CRE. Whoever wires it (Alex): pin it.

### 3.2 Harness interface — agent's #1 output contract
What does a submitted model expose? `predict(state) -> lpAction` + a replay loop is
proposed, unconfirmed. Without it the agent can't build anything graded.

### 3.3 ERC-8183 — real spec or shorthand?
No such ERC was found. If it's just "the job-posting step," we define our own
`JobDeployed` and move on. Confirm.

### 3.4 Submission = code, weights, or both?
Leaning code+weights, grader runs inference only. Unconfirmed. Affects grading cost AND the
"not hardcoded" check.

### 3.5 Cloud KMS HSM smoke test
Confirm `EC_SIGN_SECP256K1_SHA256` produces a signature `ecrecover` accepts end-to-end
(see `TEE_RESEARCH.md` Option C). Alex owns the scorer; this is on his path.

---

## 4. The data we don't have yet

The product grades models on Uniswap LP backtests. Do we have the data?

- **?** Public + private datasets (pool/OHLCV for a pair) staged anywhere? README says
  "~10x larger private set" — does it exist or is it TODO?
- **?** What pair(s) and time range for the demo?
- **?** Is Riley's existing ERC-8004 BigQuery pipeline (`/analysis`) reusable here, or
  unrelated to the LP backtest data?

---

## 5. Proposed build sequence (the spine)

**Phase 0 — unblock (today):**
1. ✅ Reconcile docs to the resolved model (memory + diagram + README + this doc).
2. ✅ Consolidate pitch docs to the minimal set (README + GAPS + TEE_RESEARCH +
   BigPicture + one architecture diagram); deleted the stale PITCH/INTERFACES drafts and
   the batched-flow lifecycle/state diagrams.
3. Pin the AI Tester API contract (§3.1) — highest-leverage unknown.
4. Land the data (§4) somewhere both agent and grader can read.
5. Pin the harness `predict(state) -> lpAction` interface (§3.2) — agent's #1 blocker.
6. Alex pushes the jobs path → unblocks Riley.

**Phase 1 — the demo spine (parallel):**
- `contracts/` — `BountyEscrow.sol`: escrow + `JobDeployed` + store verdict + accept
  signed score + pay winner. (Solidity owner)
- Scorer TEE — Google Confidential Space: run hidden tests, sign via KMS HSM, return
  verdict + score. (Alex — stub made real)
- AI Tester — expose Chainlink Confidential AI, called by the scorer off-chain. (Alex)
- CRE callback — write verdict + score on-chain via KeystoneForwarder. (Luke)
- BigQuery indexer — mirror events → `jobs`/`submissions`/`settlements` tables. (Luke/Riley)
- `agent/` — register → poll BigQuery → build LP model → self-score on public set →
  submit to scorer → get verdict. (Luke)
- public test set per bounty. (data owner §4)

**Phase 2 — garnish:**
- `apps/web` dashboard (BigQuery-backed). (Luke)
- Settlement trigger at the deadline (cron fallback if Chainlink fights us).
- MCP server/skill so Claude Code drives the agent + bounty-creation flows. (Luke)

**Phase 3 — roadmap:**
- **x402-spawned per-bounty Google Confidential Space** — the aspirational target the stub
  grows into: requester (via Claude+MCP) → x402 spins up a Confidential Space loaded with
  private tests/data → tells the contract "spawn the job" → agent submits to that spawned
  TEE → it scores + signs. (NOT the demo spine; the demo uses Alex's stub.)
- ERC-8004 reputation writes beyond the event hook; staking/slashing; AI-generated tests;
  Hive mode.

---

## 6. The single most important question

If we could only answer one thing right now:

**What is the exact API contract of the AI Tester (Chainlink Confidential AI)?**
Request shape (base64 code? CID? + bounty context), response shape (signed verdict + code
hash), where it's hosted, how the verdict reaches the CRE. The agent submit path, scorer
gating, and CRE wiring all hang off this one interface. Alex owns it — pin it.
