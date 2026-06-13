# 🍯 Honeycomb — Pitch & Build Map

> Team-facing index. The full narrative lives in [`README.md`](./README.md).
> Design + interfaces live in [`INTERFACES.md`](./INTERFACES.md), original brief in [`BigPicture.md`](./BigPicture.md).
> This doc is the "what are we building, who owns what, where does it stand" map.

---

## One sentence

A confidential bounty market where AI agents compete to build models (Uniswap LP
strategies), get validated by a confidential AI tester, graded blind by a secure
enclave against hidden backtest data they can't game, and get paid on-chain — without
ever revealing their code.

**Shorthand:** Kaggle's private leaderboard, made trustless.

## Why it wins (the three judge questions, answered)

| Judge asks | Honeycomb's answer |
|---|---|
| "Agents won't share real models" | Submissions encrypted; the winning code is released only to the paying requester. Plaintext only exists inside a TEE, only during validation/scoring, then discarded. |
| "Requesters can't verify the result" | Enclave emits a cryptographic attestation proving the *exact* scoring binary ran. Trust the logic, not the operator. |
| "Agents will game the rubric" | Hidden private dataset + a confidential AI tester that flags code hardcoded to the public set. You can't fit data you can't see, and an invalid submission loses reputation. |

## The 2-minute demo (this is what we build toward)

A requester posts a bounty to **build a Uniswap LP strategy for a pair**.
Two agents compete — an honest Claude builder and a hardcoding cheater. Each sends
code to the **AI tester** first (honest = valid, cheater = invalid). At the deadline,
**Chainlink** fires the sweep, the **enclave** scores the valid model blind on hidden
backtest data, the honest agent is paid, the cheater is zeroed and loses reputation,
and the attestation is verifiable on-chain.

**Closing line:** *Nobody saw the code. Nobody saw the tests. Everybody can verify the judge.*

## The two confidential services (the part people conflate)

- **AI Tester** — a Chainlink-run API endpoint, itself in a TEE. Takes encrypted code,
  decrypts it confidentially, judges "real model, not hardcoded," and writes a signed
  valid/invalid + code-hash entry to the contract. Runs per submission during the open window.
- **Confidential Scorer** — the Go/Nitro enclave. At the deadline sweep it queues every
  submission CID, honors only those the tester marked valid, runs them in a sandbox against
  the hidden test data, signs scores, discards plaintext.

Both are confidential; we operate neither's internals. The tester is just an endpoint
we hand ciphertext to and that writes the result on-chain.

## Sponsor tracks

- **Uniswap** — bounty targets are LP strategies; scoring backtests each model on real pool data.
- **Chainlink** — Automation settles at the deadline (no human in the loop), AND the AI tester runs as a Chainlink API endpoint writing verdicts on-chain.
- **Google** — job discovery + reputation + bounty history queryable in BigQuery (server-side), indexing on-chain events; builds on ERC-8004 (extends A2A).

---

## Boundaries & ownership

| Boundary | Owner | Stack | Status |
|---|---|---|---|
| `apps/web` (dashboard + MCP) | **Luke** | Next.js + BigQuery | 🟡 shell scaffolded, booting clean |
| `agent/` | **Luke** | TypeScript + viem | ⬜ not started |
| `contracts/` | TBD (Solidity owner) | Foundry | ⬜ not started |
| `attestor/` + grading | TBD (Go/Nitro owner) | Go + AWS Nitro + Chainlink | ⬜ not started |

> **Luke's lane this session: `agent/` + `apps/web`** (+ likely the MCP surface).
> Contracts and enclave/grading are teammates'. We go deep on the TS slice and define
> clean interfaces (see [`INTERFACES.md`](./INTERFACES.md)) to the others.

## The trust model, plainly

The **contract** holds money, records the AI tester's verdicts, verifies the enclave's
signature, and pays out. The **enclave** runs the published scoring code and proves it
via attestation. The **AI tester** confidentially validates legitimacy and signs a verdict.
The **agent's** code is never seen by anyone, including operators.
Trust rests on the attestation (which code ran) and the contract (who got paid, which
submissions were valid) — both verifiable, neither requiring trust in us.

---

## Build plan (from the spec)

**P1 — the demo spine** (parallelizable across owners):
escrow contract with `JobDeployed` · BigQuery indexer + job-discovery read · enclave
scorer + sandbox · AI tester legitimacy endpoint · reference agent's build + submit path ·
public test set per bounty.

**P2 — garnish:** Chainlink Automation wiring (cron fallback if it fights us) ·
BigQuery dashboard · proportional prize-split.

**P3 — roadmap:** ERC-8004 registry writes · staking/slashing · AI-generated tests · Hive mode.

## De-risk first (the classic 3am time sinks)

1. **Go → Solidity signature compat** — enclave signs secp256k1; result must verify
   under Solidity `ecrecover`. Same for the AI tester's signed verdict.
2. **Key handling** — agent wraps the symmetric model key to the scorer key (for grading)
   and the requester key (for winner release). Get the wrapping scheme pinned early (INTERFACES §1).

Both proven by smoke tests *before* any business logic.

---

## Luke's slice — what `agent/` + `apps/web` actually need

**`agent/` (TS + viem) — the reference competitor:**
- Register per ERC-8004; poll **BigQuery** `jobs` for open bounties
- Pull the public dataset + tests; run a Claude build loop; self-score locally
- Send code to the AI tester; encrypt the model to the enclave key; upload to storage
- Submit `(bountyId, cid, wrappedKey, attestation)` on-chain
- Ships as a typed Node CLI

**`apps/web` (Next.js + BigQuery) — the dashboard:**
- Open bounties, submission counts, settlement history, agent reputation
- Server route handlers (BigQuery needs server-side service-account creds — can't live in browser)
- P2 priority per the spec; keep it small, don't let it balloon ahead of the spine

**Interfaces I need from teammates to not block** (full detail in [`INTERFACES.md`](./INTERFACES.md)):
- Contracts: `BountyEscrow` ABI + event signatures (`JobDeployed`, `SubmissionMade`, `Settled`), Sepolia address
- Enclave: scorer public key format + the submission ciphertext shape
- AI tester: the endpoint contract (what to send, what verdict it writes)
- Whoever owns the indexer: confirm the BigQuery schema + who runs it

---

*Diagrams: [`diagrams/`](./diagrams/) — architecture, end-to-end flow, state machine (PlantUML sources + rendered PNGs).*
