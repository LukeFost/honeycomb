# 🍯 Honeycomb — Pitch & Build Map

> Team-facing map: what we're building, who owns what, where it stands.
> Narrative in [`README.md`](./README.md). Interfaces in [`INTERFACES.md`](./INTERFACES.md).
> TEE choice for the scorer in [`TEE_RESEARCH.md`](./TEE_RESEARCH.md). Original brief in [`BigPicture.md`](./BigPicture.md).

---

## One sentence

A confidential bounty market where AI agents compete to build models (Uniswap LP
strategies). A confidential AI tester validates each one, a secure enclave grades it
blind on hidden backtest data they can't game, and it gets paid on-chain — without
ever revealing its code.

**Shorthand:** Kaggle's private leaderboard, made trustless.

## Why it wins

| Judge asks | Our answer |
|---|---|
| "Agents won't share real models" | Submissions are encrypted; the winning code goes only to the paying requester. Plaintext exists only inside a TEE, only during validation/scoring, then it's discarded. |
| "Requesters can't verify the result" | The enclave emits a cryptographic attestation proving the exact scoring binary ran. Trust the logic, not the operator. |
| "Agents will game the rubric" | Hidden private dataset + a confidential AI tester that flags code hardcoded to the public set. You can't fit data you can't see, and an invalid submission loses reputation. |

## The 2-minute demo (what we build toward)

A requester posts a bounty: **build a Uniswap LP strategy for a pair**. Two agents
compete — an honest Claude builder and a hardcoding cheater. Each sends code to the
**AI tester** first (honest = valid, cheater = invalid). At the deadline, **Chainlink**
fires the sweep and the **enclave** scores the valid model blind on hidden backtest
data. The honest agent gets paid; the cheater is zeroed and loses reputation; the
attestation is verifiable on-chain.

**Closing line:** *Nobody saw the code. Nobody saw the tests. Everybody can verify the judge.*

## The two confidential services (the part people conflate)

- **AI Tester** — **Chainlink Confidential AI** (a hosted LLM-in-a-TEE Chainlink runs).
  We POST encrypted code to `/v1/inference`; it judges "real model, not hardcoded" and
  posts the result to a **CRE workflow**, which signs it via the CRE DON and writes a
  valid/invalid + code-hash verdict on-chain through the KeystoneForwarder
  (`onReport`). Runs per submission during the open window. We have the API key.
  Reference shape: [chainlink-confidential-ai-attester-demo](https://github.com/smartcontractkit/chainlink-confidential-ai-attester-demo).
- **Confidential Scorer** — our own Go enclave, **leaning Google Cloud Confidential
  Space** (see [`TEE_RESEARCH.md`](./TEE_RESEARCH.md)). At the deadline it queues every
  submission CID, keeps only those the tester marked valid, runs them in a sandbox
  against the hidden test data, signs scores via a Cloud KMS HSM secp256k1 key released
  only to the attested image (contract verifies with `ecrecover`), and discards plaintext.

We don't operate the AI Tester's internals — Chainlink hosts it; we send ciphertext and
it writes the verdict on-chain. The Scorer is ours to build.

## Sponsor tracks

- **Uniswap** — bounty targets are LP strategies; scoring backtests each model on real pool data.
- **Chainlink** — Automation settles at the deadline (no human in the loop), and the AI tester runs as a Chainlink API endpoint writing verdicts on-chain.
- **Google** — job discovery, reputation, and bounty history in BigQuery (server-side), indexing on-chain events; builds on ERC-8004 (extends A2A).

---

## Boundaries & ownership

| Boundary | Owner | Stack | Status |
|---|---|---|---|
| `apps/web` (dashboard + MCP) | **Luke** | Next.js + BigQuery | 🟡 shell scaffolded, boots clean |
| `agent/` | **Luke** | TypeScript + viem | ⬜ not started |
| `contracts/` | TBD (Solidity owner) | Foundry | ⬜ not started |
| AI Tester (CRE workflow + verdict path) | **Alex** | Chainlink Confidential AI + CRE (TS) | ⬜ not started |
| `attestor/` + grading (Confidential Scorer) | TBD | Go + **Google Confidential Space** | ⬜ not started |

> **AI Tester is Chainlink-hosted, owned by Alex** (CRE workflow + the contract's
> verdict-receiving path). The **Confidential Scorer** is our own Go enclave, leaning
> Google Confidential Space — owner TBD. Luke's slice stays `agent/` + `apps/web`.
> Clean interfaces to all of these in [`INTERFACES.md`](./INTERFACES.md).

## The trust model

- The **contract** holds money, records the tester's verdicts, checks the enclave's signature, and pays out.
- The **enclave** runs the published scoring code and proves it via attestation.
- The **AI tester** confidentially validates legitimacy and signs a verdict.
- The **agent's** code is never seen by anyone, including operators.

Trust rests on the attestation (which code ran) and the contract (who got paid, which
submissions were valid). Both are verifiable. Neither requires trusting us.

---

## Build plan

**P1 — the demo spine** (parallel across owners): escrow contract with `JobDeployed` ·
BigQuery indexer + job-discovery read · enclave scorer + sandbox · AI tester legitimacy
endpoint · reference agent's build + submit path · public test set per bounty.

**P2 — garnish:** Chainlink Automation wiring (cron fallback if it fights us) · BigQuery
dashboard · proportional prize-split.

**P3 — roadmap:** ERC-8004 registry writes · staking/slashing · AI-generated tests · Hive mode.

## De-risk first (the 3am time sinks)

1. **Go → Solidity signature compat** — the scorer signs secp256k1 via a Cloud KMS HSM
   key (released only to the attested image); the result must verify under Solidity
   `ecrecover`. KMS returns lower-S sigs, so derive Ethereum's `v`. Prove the full path
   (attested image → KMS sign → `ecrecover`) before any backtest logic — see
   [`TEE_RESEARCH.md`](./TEE_RESEARCH.md). The AI Tester's verdict comes via the CRE
   forwarder (`onReport`), a separate path Alex owns.
2. **Key handling** — the agent wraps the symmetric model key to the scorer key (for
   grading) and the requester key (for winner release). Pin the wrapping scheme early (INTERFACES §1).

Prove both with smoke tests *before* any business logic.

---

## Luke's slice — what `agent/` + `apps/web` need

**`agent/` (TS + viem) — the reference competitor:**
- Register per ERC-8004; poll **BigQuery** `jobs` for open bounties.
- Pull the public dataset + tests; run a Claude build loop; self-score locally.
- Send code to the AI tester; encrypt the model to the enclave key; upload to storage.
- Submit `(bountyId, cid, wrappedKey, attestation)` on-chain.
- Ships as a typed Node CLI.

**`apps/web` (Next.js + BigQuery) — the dashboard:**
- Open bounties, submission counts, settlement history, agent reputation.
- Server route handlers (BigQuery needs server-side service-account creds — can't live in the browser).
- P2 priority. Keep it small; don't let it balloon ahead of the spine.

**Interfaces I need from teammates to not block** (full detail in [`INTERFACES.md`](./INTERFACES.md)):
- Contracts: `BountyEscrow` ABI + event signatures (`JobDeployed`, `SubmissionMade`, `Settled`), Sepolia address.
- Enclave: scorer public key format + the submission ciphertext shape.
- AI tester: the endpoint contract (what to send, what verdict it writes).
- Indexer owner: confirm the BigQuery schema + who runs it.

---

*Diagrams: [`diagrams/`](./diagrams/) — architecture, end-to-end flow, state machine (PlantUML sources + rendered PNGs).*
