# 🍯 Honeycomb — Pitch & Build Map

> Team-facing index. The full narrative lives in [`README.md`](./README.md).
> This doc is the "what are we building, who owns what, where does it stand" map.

---

## One sentence

A confidential bounty market where AI agents compete to find smart-contract
vulnerabilities, get graded blind by a secure enclave against hidden tests they
can't game, and get paid on-chain — without ever revealing their code.

**Shorthand:** Kaggle's private leaderboard, made trustless.

## Why it wins (the three judge questions, answered)

| Judge asks | Honeycomb's answer |
|---|---|
| "Agents won't share real exploits" | Submissions encrypted to the enclave. Nothing to steal — plaintext only exists inside, only during scoring, then discarded. |
| "Requesters can't verify the result" | Enclave emits a cryptographic attestation proving the *exact* scoring binary ran. Trust the logic, not the operator. |
| "Agents will game the rubric" | Hidden, mutation-injected tests + execution-based scoring. You can't hardcode answers to tests you can't see, and a fake PoC scores zero. |

## The 2-minute demo (this is what we build toward)

A requester posts a bounty against a **Uniswap v4 hook seeded with 3 vulnerabilities**.
Two agents submit encrypted — an honest Claude auditor and a hardcoding cheater.
At the deadline, **Chainlink** fires the sweep, the **enclave** scores both blind,
the honest agent is paid for its 3 executing PoCs, the cheater is zeroed, and the
attestation is verifiable on-chain.

**Closing line:** *Nobody saw the code. Nobody saw the tests. Everybody can verify the judge.*

## Sponsor tracks

- **Uniswap** — audit targets are real v4 hooks; scoring runs each exploit against a live v4 pool.
- **Chainlink** — Automation is the trustless referee; settles at the deadline, no human in the loop.
- **Google** — reputation + bounty history queryable in BigQuery (server-side); builds on ERC-8004 (extends A2A).

---

## Boundaries & ownership

Four boundaries, one per contributor (+ shared root/config/CI).

| Boundary | Owner | Stack | Status |
|---|---|---|---|
| `apps/web` (dashboard) | **Luke** | Next.js + BigQuery | 🟡 shell scaffolded, booting clean |
| `agent/` | **Luke** | TypeScript + viem | ⬜ not started |
| `contracts/` | TBD (Solidity owner) | Foundry + Uniswap v4 | ⬜ not started |
| `attestor/` | TBD (Go/Nitro owner) | Go + AWS Nitro enclave | ⬜ not started |

> **Luke's lane this session: `agent/` + `apps/web`.** Contracts and enclave are
> teammates'. We go deep on the TS slice and define clean interfaces to the others.

## The trust model, plainly

The **contract** only holds money, verifies the enclave's signature, and pays out.
The **enclave** only runs the published scoring code and proves it via attestation.
The **agent's** code is never seen by anyone, including operators.
Trust rests on the attestation (which code ran) and the contract (who got paid) —
both verifiable, neither requiring trust in us.

---

## Build plan (from the spec)

**P1 — the demo spine** (parallelizable across owners):
escrow contract · enclave attestor service · scoring harness + sandbox ·
reference agent's event listener + submission path · public test set per bounty.

**P2 — garnish:** Chainlink Automation wiring (cron fallback if it fights us) ·
BigQuery dashboard · proportional prize-split.

**P3 — roadmap:** ERC-8004 registry writes · staking/slashing · AI-generated tests · Hive mode.

## De-risk first (the classic 3am time sinks)

1. **v4 hook address mining** — a hook's permissions are encoded in its deployed
   address, so it must be deployed via CREATE2 with a mined salt (HookMiner).
2. **Go → Solidity signature compat** — enclave signs secp256k1; result must verify
   under Solidity `ecrecover`.

Both proven by smoke tests *before* any business logic. (Contracts/enclave owners.)

---

## Luke's slice — what `agent/` + `apps/web` actually need

**`agent/` (TS + viem) — the reference auditor:**
- Listen for `BountyPosted` over RPC (Sepolia)
- Pull the target v4 hook + 5–10 public Foundry tests; run a Claude audit loop
- Encrypt findings + PoCs to the enclave pubkey; submit on-chain
- Ships as a typed Node CLI

**`apps/web` (Next.js + BigQuery) — the dashboard:**
- Open bounties, submission counts, settlement history, agent reputation
- Server route handlers (BigQuery needs server-side service-account creds — can't live in browser)
- P2 priority per the spec; keep it small, don't let it balloon ahead of the spine

**Interfaces I need from teammates to not block:**
- Contracts: `BountyEscrow` ABI + event signatures (`BountyPosted`, `Settled`, `ReputationDelta`), Sepolia address
- Enclave: the public key format + the submission ciphertext shape (what to encrypt, how)

---

*Diagrams: [`diagrams/`](./diagrams/) — architecture, end-to-end flow, state machine (PlantUML sources + rendered PNGs).*
