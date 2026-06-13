# Honeycomb Grading — CRE (end-to-end on Sepolia)

A bounty is an **ERC-8183 Job**: the maker funds USDC escrow; a grader scores each
submission (stub) + **attests validity with a real TEE LLM** (Chainlink Confidential
AI Attester); a **CRE** workflow settles it on-chain through the KeystoneForwarder;
the escrow pays the winning **ERC-8004 agent**.

```
maker createBounty (USDC escrow)
agent registered (ERC-8004 Identity → agentId)
grader: stub score + REAL AI validity attestation  →  settlement payload
CRE workflow (HTTP trigger) → KeystoneForwarder → BountyEscrow.onReport
   valid winner → pay agent's wallet | else → refund maker
```

> Excluded from the honeycomb pnpm/turbo workspace (uses **bun** + the CRE WASM
> toolchain + **foundry**). Run all commands from this directory.

## Deployed (Ethereum Sepolia)

| | Address |
|---|---|
| BountyEscrow | `0x8b7d8Af7C6b051828f385fD53446266d6fCc3023` |
| MockUSDC (6dp) | `0x3211C5E4B4d57B673d67a976699121667f419e17` |
| ERC-8004 Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| KeystoneForwarder (sim, `--broadcast`) | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |

## Setup

```bash
cd grading-workflow && bun install && cd ..      # CRE deps + WASM toolchain
forge build                                       # contracts
# .env at repo root needs: SEP_PRIVATE_KEY, INFERENCE_API_KEY_VAR
set -a; . ../../../.env; set +a
export CRE_ETH_PRIVATE_KEY="${SEP_PRIVATE_KEY#0x}" CRE_TARGET=staging-settings
```

## Run the full loop

```bash
# 1. (once) register a solver agent → prints an agentId. Wallet = your sender.
cast send 0x8004A818BFB912233c491871b3d84c89A494BD9e "register(string)" \
  "https://honeycomb.dev/agents/my-solver" --private-key $SEP_PRIVATE_KEY \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com

# 2. open + fund a bounty (50 mUSDC, +1h) → prints jobId
bun maker/create-bounty.ts 50 1 maker/bounties/uniswap-lp-trading-bot

# 3. grade a submission: stub score + REAL AI attestation → settlement payload
bun grader/grade.ts grader/submissions/clean.py <jobId> <agentId> > /tmp/settle.json

# 4. settle on-chain (CRE → forwarder → escrow pays the winner)
cre workflow simulate grading-workflow --non-interactive --trigger-index 0 \
  --http-payload /tmp/settle.json --broadcast
```

Verify:

```bash
ESC=0x8b7d8Af7C6b051828f385fD53446266d6fCc3023
cast call $ESC "isSettled(uint256)(bool)" <jobId> --rpc-url https://ethereum-sepolia-rpc.publicnode.com
cast call $ESC "winnerWalletOf(uint256)(address)" <jobId> --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

`hardcoded.py` instead of `clean.py` → attestor returns `valid=false` → escrow
refunds the maker instead of paying.

## Local checks (no chain)

```bash
forge test                                                       # contract incl. payout/refund
cre workflow simulate grading-workflow --non-interactive \
  --trigger-index 0 --http-payload ./simulation/grading-callback.json   # workflow only
```

## Switching to real USDC

The reward token is per-bounty (snapshotted) with an owner-settable default:

```bash
cast send 0x8b7d8Af7C6b051828f385fD53446266d6fCc3023 "setRewardToken(address)" <USDC> \
  --private-key $SEP_PRIVATE_KEY --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

New bounties use the new token; already-funded ones keep theirs.

## Security posture

**Trigger auth (fix #1, done):** `config.production.json` sets `authorizedKeys` to the
grader's address, so a **deployed** workflow only accepts settlements signed by the
grader (the DON enforces it). `config.staging.json` is left **open** (`[]`) because
local `cre workflow simulate` feeds the payload directly and can't sign it — gating
staging makes the simulator reject the run. So: sim = open by necessity; deployment =
gated. Combined with the KeystoneForwarder (which binds the exact job/winner/score the
DON signed), this makes a deployed settlement bound to an authenticated grader.

**Not yet fixed (#2 — bind the attestation):** the TEE proof only certifies "code is
valid", not *which job/winner/score*. `grade.ts` takes `jobId`/`winnerAgentId` from the
CLI and the workflow signs them verbatim; `reason` is an opaque `bytes32`. A genuine
proof could be reused on a different job/winner. Real fix needs the enclave to **sign
`(jobId, winnerAgentId, score, valid, submissionHash, testsHash)`** with an
attestation-bound key, register that key on-chain (`BountyEscrow.attesterKey`), and have
`onReport` verify the signature + input commitments. Requires running our own enclave
(the beta Confidential AI Attester won't sign an arbitrary tuple). See the project
memory note for details.

## Stubs / simplifications (not production)

- `grader/grade.ts` `executionGrade()` is a **STUB** (real scoring needs a compute
  enclave + Uniswap data); `attestValidity()` is real.
- Reward token is `MockUSDC` (open mint). Deferred: reputation, CRON deadline
  trigger / sealed reveal, ERC-8004 Validation Registry, and fix #2 above.
