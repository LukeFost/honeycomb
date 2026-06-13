# Honeycomb Grading — CRE Workflow (simplest version)

The on-chain settlement half of Honeycomb's bounty grading. A grader (TEE enclave
/ MCP) scores a bounty's submissions and POSTs the result to this CRE workflow's
HTTP trigger; the workflow ABI-encodes the winner + TEE attestation digest and
writes it on-chain to `BountyEscrow` through the KeystoneForwarder.

```
Grader (TEE / MCP)
   │  POST { bountyId, status, winner, score, attestation.digest }
   ▼
CRE workflow (grading-workflow/main.ts)   ← HTTP trigger
   │  parse → ABI-encode (bytes32,address,uint256,bytes32)
   │  runtime.report(...) → EVMClient.writeReport(...)
   ▼  (KeystoneForwarder)
contracts/BountyEscrow.sol   ← onReport, onlyForwarder
   • settlementByBounty[keccak256(bountyId)] = {winner, score, attestationHash, ...}
   • winnerOf(bountyId) / isSettled(bountyId)
```

This is intentionally minimal: **no secrets, no Confidential HTTP, no x402, no
key-reveal yet** — it mirrors the proven pattern from
`chainlink-confidential-ai-attester-demo`. The sealed-score / CRE-Vault key-reveal
mechanism and incremental grading are planned follow-ups.

## Two TEE jobs per submission (`grader/grade.ts`)

The winner is decided off-chain from two **attested** jobs — kept separate on
purpose, because only one of them is the AI Attester:

| Job | What | Tool | Status here |
|-----|------|------|-------------|
| `executionGrade()` | run the code against the test datasets → **score** | a compute enclave (Google Confidential Space) — *not* the LLM Attester | **STUB** (placeholder score), clearly marked |
| `attestValidity()` | LLM judges code valid / not hardcoded → **verdict** | Chainlink Confidential AI Attester (`/v1/inference`, `qwen3.6`) | **REAL** |

```bash
# needs INFERENCE_API_KEY_VAR (real key) for the validity call
INFERENCE_API_KEY_VAR=<key> bun grader/grade.ts grader/submissions/clean.py
INFERENCE_API_KEY_VAR=<key> bun grader/grade.ts grader/submissions/hardcoded.py
# → prints a grading-callback JSON; pipe it to the workflow:
bun grader/grade.ts grader/submissions/clean.py > /tmp/cb.json
CRE_TARGET=staging-settings cre workflow simulate grading-workflow \
  --non-interactive --trigger-index 0 --http-payload /tmp/cb.json
```

Verified: `clean.py` → `valid=true`, `hardcoded.py` → `valid=false`, each with a
real TEE `response_digest` as the validity attestation.

> Excluded from the honeycomb pnpm/turbo workspace (it uses **bun** + the CRE WASM
> toolchain). Run all commands from this directory.

## Prerequisites

- CRE CLI (`cre`) ≥ v1.19.0
- Bun ≥ 1.2.21
- Foundry (`forge`, `cast`) — only for deploying/querying `BountyEscrow`
- A funded Ethereum Sepolia wallet — only for `--broadcast`

## Setup

```bash
cd grading-workflow
bun install      # runs `bun x cre-setup` (WASM toolchain) via postinstall
cd ..
```

## Scenario 1 — local simulation (no keys needed)

Replays the recorded grading callback into the HTTP trigger. Run from this dir
(the one with `project.yaml`):

```bash
CRE_TARGET=staging-settings cre workflow simulate grading-workflow \
  --non-interactive \
  --trigger-index 0 \
  --http-payload ./simulation/grading-callback.json
```

The on-chain write is skipped gracefully (logged) without `--broadcast`.

## Scenario 2 — real on-chain write to Sepolia

1. Deploy `BountyEscrow` with the **MockKeystoneForwarder** (what `--broadcast`
   writes through):

   ```bash
   forge create contracts/BountyEscrow.sol:BountyEscrow --broadcast \
     --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
     --private-key $CRE_ETH_PRIVATE_KEY \
     --constructor-args 0x15fC6ae953E024d975e77382eEeC56A9101f9F88
   ```

2. Put the deployed address in `grading-workflow/config.staging.json`
   (`consumerAddress`), set `CRE_ETH_PRIVATE_KEY` (raw 64-hex, no `0x`), then:

   ```bash
   CRE_TARGET=staging-settings cre workflow simulate grading-workflow \
     --non-interactive --trigger-index 0 \
     --http-payload ./simulation/grading-callback.json --broadcast
   ```

3. Verify (note `bountyId` is `keccak256` of the string id):

   ```bash
   cast call <ESCROW> "isSettled(bytes32)(bool)" \
     $(cast keccak "uniswap-lp-trading-bot-round-1") \
     --rpc-url https://ethereum-sepolia-rpc.publicnode.com
   ```

## KeystoneForwarder addresses (Ethereum Sepolia)

| Use        | Address                                      |
|------------|----------------------------------------------|
| Simulation | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` (Mock, with `--broadcast`) |
| Production | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` (KeystoneForwarder) |

Pass the forwarder matching how you write to the `BountyEscrow` constructor, or
`onReport` reverts with `UnauthorizedForwarder`.
