# Honeycomb Grading — CRE (end-to-end on Sepolia)

A bounty is an **ERC-8183 Job**. For each submission a grader produces **two TEE
outputs** — a **real execution score** (backtest against the private dataset) and a
**real AI validity attestation** (Chainlink Confidential AI Attester: "is this code
legit / not hardcoded?"). Both, with their attestation digests, are recorded on-chain.
A **CRE CRON (time-based) trigger** resolves the bounty after its deadline, paying the
best **valid** submission's **ERC-8004 agent** (or refunding the maker).

```
maker createBounty (USDC escrow, deadline, testsHash commitment)
per submission:
  grader → REAL execution score (+ scoreAttestation)   [scorer.py, sandboxed]
         → REAL AI validity      (+ validityAttestation) [Confidential AI Attester]
  CRE HTTP trigger → recordGrade → leaderboard (only valid grades can lead)
at deadline:
  CRE CRON trigger → resolve → pay best valid agent's wallet | else refund maker
all writes: KeystoneForwarder → BountyEscrow.onReport (action 0=recordScore, 1=recordValidity, 2=resolve, 3=deliverWinner)
effective score = valid ? executionScore : 0   ← a cheat that scores HIGHER but is
                                                  invalid loses to an honest lower score
```

> Excluded from the honeycomb pnpm/turbo workspace (uses **bun** + the CRE WASM
> toolchain + **foundry**). Run all commands from this directory.

## Deployed (Ethereum Sepolia)

| | Address |
|---|---|
| BountyEscrow (ERC-8183) | `0xce27EEDE3b033582e1Adec94F8679d3feEF142c2` |
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

`trigger-index 0` = grade (HTTP `recordGrade`), `trigger-index 1` = resolve (CRON).

```bash
# 1. (once) register a solver agent → prints an agentId. Wallet = your sender.
cast send 0x8004A818BFB912233c491871b3d84c89A494BD9e "register(string)" \
  "https://honeycomb.dev/agents/my-solver" --private-key $SEP_PRIVATE_KEY \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com

# 2. open + fund a bounty → prints jobId (set a SHORT deadline so resolve can fire;
#    for a quick demo create directly with a ~120s deadline via cast, or edit the script)
bun maker/create-bounty.ts 50 1 maker/bounties/uniswap-lp-trading-bot   # 50 mUSDC, +1h

# 3. grade EACH submission (REAL score + REAL AI attestation) and record on-chain
bun grader/grade.ts grader/submissions/clean.py     <jobId> <agentId> > /tmp/g.json
cre workflow simulate grading-workflow --non-interactive --trigger-index 0 \
  --http-payload /tmp/g.json --broadcast
#  (repeat for other submissions; only valid grades take the lead)

# 4. after the deadline, the CRON resolver settles + pays the best valid agent
cre workflow simulate grading-workflow --non-interactive --trigger-index 1 --broadcast
```

Verify:

```bash
ESC=0xce27EEDE3b033582e1Adec94F8679d3feEF142c2
cast call $ESC "isSettled(uint256)(bool)"        <jobId> --rpc-url https://ethereum-sepolia-rpc.publicnode.com
cast call $ESC "winnerWalletOf(uint256)(address)" <jobId> --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

A cheat (`hardcoded.py`) scores *higher* on execution but the attestor marks it
`valid=false`, so it never leads — the honest `clean.py` wins. If no submission is
valid, `resolve` refunds the maker.

## Local checks (no chain)

```bash
forge test                                                       # contract incl. payout/refund
cre workflow simulate grading-workflow --non-interactive \
  --trigger-index 0 --http-payload ./simulation/grade-callback.json    # grade handler
cre workflow simulate grading-workflow --non-interactive --trigger-index 1   # resolve handler
```

## Switching to real USDC

The reward token is per-bounty (snapshotted) with an owner-settable default:

```bash
cast send 0xce27EEDE3b033582e1Adec94F8679d3feEF142c2 "setRewardToken(address)" <USDC> \
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

## Status / simplifications

- **Execution grading is REAL** — `executionGrade()` runs `scorer.py` against the
  private series in a sandboxed subprocess (no network, timeout) and returns the real
  backtest PnL (0..10000). Stage-1 digest is a content commitment, not yet a hardware
  attestation; the Confidential Space enclave (`grader/enclave/`) is the Stage-2 path.
- **AI validity is REAL** — `attestValidity()` calls the Confidential AI Attester.
- **CRON time-based resolve is DONE** — `onResolveTick` settles after the deadline.
- Reward token is `MockUSDC` (open mint). Deferred: fix #2 (bind the attestation to
  job/winner — see above), reputation, sealed-score reveal, ERC-8004 Validation Registry.
