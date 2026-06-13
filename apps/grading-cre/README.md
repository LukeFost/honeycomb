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
| BountyEscrow | `0x12eA1Cc33445F1A1F75555d7B26255f25D87B479` |
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
ESC=0x12eA1Cc33445F1A1F75555d7B26255f25D87B479
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
cast send 0x12eA1Cc33445F1A1F75555d7B26255f25D87B479 "setRewardToken(address)" <USDC> \
  --private-key $SEP_PRIVATE_KEY --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

New bounties use the new token; already-funded ones keep theirs.

## Stubs / simplifications (not production)

- `grader/grade.ts` `executionGrade()` is a **STUB** (real scoring needs a compute
  enclave + Uniswap data); `attestValidity()` is real.
- HTTP trigger is open (`authorizedKeys: []`) — anyone can post a settlement.
- Reward token is `MockUSDC` (open mint). Deferred: reputation, CRON deadline
  trigger / sealed reveal, ERC-8004 Validation Registry.
