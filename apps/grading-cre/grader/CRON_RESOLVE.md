# Autonomous CRON resolve (time-based settlement, no human resolve call)

Gap 3 replaces the maker's `resolveEarly(jobId)` shortcut with the **autonomous CRE
CRON resolution path**. Settlement happens via the grading workflow's CRON handler
(`onResolveTick`, trigger-index 1), which emits `onReport` action 2 = resolve once the
bounty deadline has passed. No human resolve transaction is sent.

## Contract timing windows (BountyEscrow.sol)

For a bounty with `expiredAt = deadline` and `SETTLE_GRACE = 1 hour`:

| Action                       | Status req | Time window (block.timestamp)         | Source            |
|------------------------------|------------|---------------------------------------|-------------------|
| `submit`                     | Funded     | `<= expiredAt`                        | line 294          |
| grading (score / validity)   | Funded     | `<= expiredAt + SETTLE_GRACE` (1h)    | line 340          |
| `_resolve` (CRON action 2)   | Funded     | `> expiredAt` (strictly after)        | line 407          |
| `claimRefund`                | Funded/Sub | `> expiredAt + SETTLE_GRACE`          | line 577          |

The two gates that shape the run:
- **Submissions must land BEFORE the deadline** (`<= expiredAt`).
- **Resolve must fire AFTER the deadline** (`> expiredAt`), but grading is still
  allowed for 1 hour after the deadline (the grace window). So grades may be
  recorded either before the deadline or in the grace window after it.

## Required sequence

1. **Create bounty with a SHORT deadline** (e.g. `now + 90s`) so the deadline can
   pass during a single run.
2. **Submit** both agents — must be `<= expiredAt`. With a 90s deadline, submit
   immediately after create.
3. **Let the deadline pass** — wait until `block.timestamp > expiredAt`.
4. **Grade within the grace window** — record score + validity for each submission.
   This is allowed after the deadline as long as `block.timestamp <= expiredAt + 1h`.
   (Grading can also be done before the deadline; either side of `expiredAt` works.)
5. **Fire the CRON resolve** — `block.timestamp > expiredAt` now holds, so
   `_resolve` passes. The maker -> forwarder -> `onReport(action 2)` declares the
   winner and pays out (or refunds).

> The CRON trigger carries no HTTP payload; it reads the bounty id from
> `grading-workflow/config.mainnet.json`'s `"jobId"` field. That file ships with a
> fixed `jobId`, so it MUST be rewritten to the live jobId before firing.

## Command sequence

From `apps/grading-cre`, with `CRE_ETH_PRIVATE_KEY` set to the maker key (no `0x`):

```bash
# 1. point the CRON resolver at the live bounty (rewrites config.mainnet.json jobId)
#    and print the resolve command. Does NOT broadcast.
bash grader/cron_resolve.sh "$JOB"

# 2. fire the autonomous CRON resolve (time-based; only valid once deadline passed).
#    trigger-index 1 = onResolveTick (CRON); action 2 = resolve.
cre workflow simulate grading-workflow \
  --non-interactive --target mainnet-settings \
  --trigger-index 1 --broadcast
```

The resolve tx routes maker -> KeystoneForwarder `0xa3d1ad4ac559a6575a114998affb2fb2ec97a7d9`
-> escrow `0x90058162D3d55542f39507d0328538824A24C9C3` `onReport`.

## Assert settlement

```bash
ESC=0x90058162D3d55542f39507d0328538824A24C9C3
cast call $ESC 'isSettled(uint256)(bool)'        "$JOB" --rpc-url "$ETH"   # expect true
cast call $ESC 'winnerWalletOf(uint256)(address)' "$JOB" --rpc-url "$ETH"  # expect honest agent wallet
```

## Race risk

Two real in-VM grades take ~3 minutes. Grading must complete inside the grace
window (`expiredAt + 1h`), which is generous — 3 min << 1h, so grading after a
90s deadline is safe. The tighter constraint is that **submissions must beat the
deadline** and **resolve must wait until after it**. With a 90s deadline, submit
right after create, then either:
- grade first (before the deadline) and resolve after the wait, or
- wait for the deadline, then grade in the grace window, then resolve.

Recommended deadline: **`now + 90s`** — short enough that the deadline passes
during the run, long enough that create + both submits (a handful of L1 txs) land
comfortably before `expiredAt`. If submits are slow on mainnet, bump to
`now + 180s` (still far inside the 1h grace window for grading).
