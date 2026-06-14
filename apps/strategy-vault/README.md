# strategy-vault

A trust-minimized **autonomous trading box**. Fund a vault, register a strategy, and a Chainlink CRE
DON drives it: each tick it pulls a live Uniswap quote, decides whether to trade, and executes a swap
**through a scoped on-chain vault** that bounds the blast radius. Even a fully-malicious DON or Uniswap
API can only do capped, slippage-bounded, allowlisted swaps **to/from the vault** — no withdraw, no
arbitrary approve, no bridge.

> Foundry app, excluded from the pnpm/turbo workspace (like `grading-cre`). Run everything from this dir.

## What it does

```
CRE DON (every tick)                          on-chain
  read StrategyRegistry.listActive()
  per vault:
    fetch live Uniswap /quote  ─┐
    decide (accumulate rule)    │ consensus on median min-out
    build Universal Router call ─┘
    DON-sign report  ──────────────►  KeystoneForwarder ──► StrategyVault.onReport()
                                          (onlyForwarder)      ├ policy checks (allowlist, cap,
                                                               │  slippage, expiry, nonce)
                                                               ├ JIT Permit2 self-approve
                                                               ├ one raw call to the router
                                                               └ verify by BALANCE DELTAS
```

- **The vault is the trust anchor.** `onReport` decodes an `Action`, enforces the on-chain `Policy`
  (router allowlist, token allowlist, per-epoch spend cap, rate limit, expiry, nonce-replay), forwards
  **one** raw call to the router, then verifies the outcome by **balance delta**: `tokenIn spent ≤
  amountIn` **and** `tokenOut received ≥ minOut`. That makes it agnostic to the router's calldata and
  immune to a lying API (output redirected → `received` short → revert; input swapped → `spent >
  amountIn` → revert). It never trusts the API's opaque bytes.
- **Self-approving** — the vault grants its own Permit2 allowance just-in-time inside `onReport`
  (bounded by the policy that already ran), so there's no separate owner approval step.
- **The workflow decides** — it doesn't blindly swap. It fetches a recent price series, applies a
  declarative **accumulate** rule (buy only when price ≤ its recent average), and holds otherwise.
- **Multi-user** — `StrategyRegistry` lets each owner self-register their own vault + params (gated on
  `vault.owner() == msg.sender`). One workflow reads `listActive()` once and fans out per vault, each
  in a try/catch so one failure never blocks the others. Funds stay isolated per vault.

## Run it

**1. Fork test** (no key, no funds — proves the swap + every policy guard):
```bash
forge test -vv --root .            # 21 passed (incl. a swap with NO prior setupAllowance)
# pin your own node: MAINNET_RPC_URL=https://your-rpc forge test -vv --root .
```

**2. CRE workflow, simulate** (live Uniswap quote, no on-chain write):
```bash
cd strategy-workflow && bun install && cd ..
CRE_TARGET=staging-settings cre workflow simulate strategy-workflow \
  --non-interactive --trigger-index 0 -e ../../.env      # .env supplies UNISWAP_API_KEY
```
Logs the live quote + the accumulate decision (`strategy BUY/hold`) per registered vault.

**3. Run it for real** (centralized loop → real swaps on Base):
```bash
INTERVAL=300 ./run-loop.sh        # one real tick every 5 min, Ctrl-C to stop
```
Each tick is a full independent run: live quote → decide → DON-sign → forwarder → `onReport` → swap.

**4. Deploy a vault** (Base, real broadcast):
```bash
DEPLOYER_PK=0x<key> FUND_USDC=2000000 \
  forge script script/DeployBase.s.sol --rpc-url https://mainnet.base.org --broadcast
# then register it: registry.register(vault, tokenIn, tokenOut, fee, amountIn, slippageBps, strategyId)
```

## Live on Base

| | address |
|---|---|
| StrategyVault (self-approving) | `0xB17eBA5A27dC01a79DaAf753D3009d5b315FA92f` |
| StrategyRegistry | `0x3d60d8b40181aE80D16928563F71B77DE31C60E2` |
| KeystoneForwarder (Base mock) | `0x5E342a8438B4f5d39e72875FCee6f76B39CCE548` |
| Universal Router | `0x6fF5693b99212Da76ad316178A184AB56D299b43` |

Real end-to-end on-chain: CRE → live quote → forwarder → `onReport` → **real V3 swap** (USDC→WETH).
Deploy receipts in `broadcast/*/8453/run-latest.json`.

## Proven vs. next

| ✅ proven on Base mainnet | next |
|---|---|
| DON-signed report → forwarder → `onReport` → real Uniswap V3 swap | **DON-autonomous** (`cre workflow deploy`) — gated on Chainlink org access (`cre account access`) |
| Live `/quote` + median-consensus on min-out (real API, CRE secret) | swap the declarative accumulate rule for a real strategy / ML policy |
| Policy guards + balance-delta verification (21/21 fork tests) | follow the API's actual multi-hop route instead of the pinned single-hop V3 |
| Self-approving Permit2 (no external owner step) + multi-vault registry | `setExpectedWorkflowId` to bind the vault to the deployed workflow |

## Notes

- **DON-autonomous is gated, not missing.** The CRON trigger + deploy path are wired; flipping to a
  DON-fired loop needs Chainlink org deployment access. Until then `run-loop.sh` fires it from your box
  with your key — the swap + policy stay real and bounded; only the *trigger + report signing* are
  centralized. ⚠ each tick is a real swap, so pair it with a strategy that actually holds sometimes.
- **Permit2 is unavoidable.** The Universal Router always pulls ERC20 input via Permit2; a contract
  vault can't sign an EIP-712 permit, so it grants a standing allowance via `Permit2.approve` (now done
  JIT inside the vault). `x-permit2-disabled: true` only skips the *signature*, not Permit2 on-chain.
- **Route note:** Uniswap's best route is often mixed v4+v3; we take its live min-out as the floor but
  execute a proven single-hop V3 path. Following the exact multi-hop route is a later enhancement.

`Action` ABI tuple (for the workflow's `encodeAbiParameters`):
```
(address to, bytes data, uint256 value, uint256 minOut, uint64 deadline,
 address tokenIn, address tokenOut, uint256 amountIn, bytes32 nonce, bytes32 artifactHash)
```
