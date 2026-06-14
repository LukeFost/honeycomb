# strategy-vault

A honeycomb app: a trust-minimized **"strategy box"** — fund it, give it a strategy (a config
algorithm or a trained ML policy), and it autonomously trades via the Uniswap Trading API. Execution
integrity comes from a Chainlink CRE DON; blast radius is bounded by an on-chain scoped vault.

Full architecture + design matrix: **[DESIGN.md](./DESIGN.md)**.

> Foundry app, excluded from the pnpm/turbo workspace (like `grading-cre`). The CRE workflow that
> writes reports into the vault is the next milestone; this directory currently holds the on-chain
> **authority layer** and its proof.

## Status — the load-bearing unknown is proven

This app proves DESIGN.md §9's #1 unknown: *can a DON-signed report drive ONE real Uniswap swap
through a scoped contract vault, end-to-end?* On a mainnet fork, a (simulated) KeystoneForwarder
report swaps **1000 USDC → ~0.595 WETH** through `StrategyVault`, and every policy guard rejects the
bad cases.

```
forge test  →  7 passed; 0 failed
  test_ForwarderSwapSucceeds       USDC in: 1000.000000  WETH out: 0.595421443377681211
  test_RevertWhen_NotForwarder         (only the forwarder can call onReport)
  test_RevertWhen_VaultMinOutNotMet    (balance-delta minOut floor enforced)
  test_RevertWhen_RouterNotAllowed     (to must == policy.router)
  test_RevertWhen_TokenNotAllowed      (tokenIn/tokenOut must be allowlisted)
  test_RevertWhen_NonceReplay          (each report nonce usable once)
  test_RevertWhen_Expired              (block.timestamp <= deadline)
```

## Layout

```
contracts/StrategyVault.sol          per-user vault: CRE receiver (ERC-165) + scoped policy
contracts/StrategyRegistry.sol       multi-user directory: users register their own vault + strategy
strategy-workflow/main.ts            CRE workflow: read registry -> fan out (quote->report) per vault
strategy-workflow/{config,workflow,secrets}  CRE config / targets / secret (project.yaml at app root)
script/DeployBase.s.sol              deploy a vault to Base (real broadcast)
script/DeployRegistry.s.sol          deploy registry + register vaults (real broadcast)
script/RealSwap.s.sol                gated real-money EOA smoke test (does NOT run by default)
run-loop.sh                          centralized loop runner (automatic until DON deploy)
test/*.t.sol                         vault fork swaps (mainnet/Base) + registry + decode (16 pass)
DESIGN.md                            full design: matrix, architecture, Uniswap + CRE integration
```

## `StrategyVault` in one paragraph

A Chainlink CRE *receiver*. `onReport(metadata, report)` is guarded by `onlyForwarder` (it trusts
`msg.sender == KeystoneForwarder`; the forwarder verifies the DON signature upstream, so the vault
does **not** re-check it). It decodes an `Action`, enforces the on-chain `Policy` (router allowlist,
token allowlist, per-epoch spend cap, rate limit, expiry, nonce replay), forwards one raw call to the
router, then verifies the result by **balance deltas**: `tokenIn spent <= amountIn` **and**
`tokenOut received >= minOut`. That post-condition makes the vault agnostic to the router's calldata
format and immune to a lying Trading API (output redirection → `received` short → revert; input
substitution → `spent > amountIn` → revert), so we never trust the API's opaque bytes.

## Multi-user (StrategyRegistry)

One workflow serves many users. Each user deploys their own `StrategyVault` and **self-registers** it
in `StrategyRegistry` with their per-vault strategy params (token pair, fee, amount, slippage) — gated
on `IOwned(vault).owner() == msg.sender`, so you can only register a vault you control. A user can
**pause** their strategy (`setActive(vault, false)` — keeps the config) or **remove** it
(`remove(vault)` — frees the row), both gated on the original registrant. Each tick the
workflow does **one** `listActive()` read and **fans out**: per registered vault it pulls a live quote,
builds the Action, and `writeReport`s to that vault — each in a try/catch so one failing vault never
blocks the others. Every user's funds stay isolated in their own policy-bounded vault.

**Live on Base:** registry `0xEe7162006cDbF88A07D18B21aD66285da4c7EFa2`, 2 vaults registered; simulate
logs `2 active vault(s)` and serves both with live quotes. Scale: ~1 HTTP + 1 write per vault/tick →
bounded by CRE per-run quotas; `maxVaults` caps the fan-out (shard across runs/workflows beyond it).
The registry is read at `LATEST` block (not finalized — Base finality lags ~minutes, which would hide
fresh registrations).

## Run the fork test

No API key needed — defaults to a public RPC:

```bash
forge test -vv --root .
# or pin your own archive node:
MAINNET_RPC_URL=https://your-rpc forge test -vv --root .
```

## Run the CRE workflow (simulate)

The off-chain half lives in `strategy-workflow/` (TypeScript → WASM). On each CRON tick it pulls a
**live quote from the real Uniswap Trading API** (`/quote`) in NODE mode, reaches DON **consensus on
the numeric min-out** (median), rebuilds the Universal Router calldata deterministically from that
floor, encodes the **flat** `Action`, DON-signs it (`runtime.report`), and writes it (`writeReport →
forwarder → vault.onReport`). **No fallback** — if the live quote fails / disagrees, the tick fails.

The min-out is the only value crossing consensus; we never consensus the raw API calldata (each node
gets a different `quoteId`/route). The Uniswap key is a **CRE secret** (`secrets.yaml` maps
`UNISWAP_API_KEY` → the env var). Simulate reads it from the repo-root `.env`; a deployed workflow
stores it in the **Vault DON** via `cre secrets create secrets.yaml`.

```bash
cd strategy-workflow && bun install && cd ..              # CRE SDK + WASM toolchain
CRE_TARGET=staging-settings cre workflow simulate strategy-workflow \
  --non-interactive --trigger-index 0 -e ../../.env       # .env supplies UNISWAP_API_KEY
```

A passing run logs the live quote (e.g. `minOut=0.5924 WETH` for 1000 USDC) and returns the Action
summary. The on-chain write shows a "capability not found" / no-`txHash` note — expected in simulate
(no `--broadcast`, and the local simulator has no mainnet write capability). `config.*.json` targets
**mainnet** (where the API has deep liquidity); set a real deployed `vault` before broadcasting.

> Route note: Uniswap's best route is often mixed v4+v3 through an intermediary. We take its live
> min-out as the on-chain floor but execute our proven single-hop V3 path. Following the API's exact
> multi-hop route is a later enhancement.

## Automatic (loop) mode — runs today; DON-autonomous is gated

Fully-decentralized autonomy = `cre workflow deploy` so the **DON** fires the CRON itself. That needs
Chainlink **org deployment access** (`cre account access`), which is currently *not enabled* — a
Chainlink-side gate, not a code gap (the CRON trigger + deploy path are already wired).

Until then the box runs **automatically via a centralized runner**: loop `cre workflow simulate
--broadcast` on a schedule. Each tick is a full, independent run (fresh live quote → report →
forwarder → `onReport` → real swap). See **`run-loop.sh`**:

```bash
INTERVAL=300 ./run-loop.sh     # one real tick every 5 min (Ctrl-C to stop)
```

**Trust trade-off (honest):** the on-chain swap + vault policy stay real and bounded; only the
*trigger and report signing* run on your box with your key instead of a decentralized DON. The DON
version lights up the moment access lands (then also `setExpectedWorkflowId`). ⚠ Each tick is a real
swap spending real funds — pair this with the A1 strategy (so ticks *decide*, often doing nothing)
before running it unattended.

## Finding: the approval model (resolves a DESIGN.md open question)

The Universal Router **always pulls ERC20 input via Permit2**. So a *contract* vault must, one-time:
`USDC.approve(PERMIT2, …)` then `Permit2.approve(USDC, UniversalRouter, amount, expiration)` (both in
`StrategyVault.setupAllowance`). The Trading API's `x-permit2-disabled: true` only means "don't expect
an EIP-712 Permit2 *signature*" (a contract can't sign one) — it does **not** bypass Permit2 on-chain.

## Real-money script (DOES NOT RUN BY DEFAULT)

`script/RealSwap.s.sol` deploys the vault, funds it with a small USDC amount, and drives one real swap
via `onReport`, with the forwarder slot set to the caller EOA as a KeystoneForwarder stand-in — i.e.
it exercises the **exact production contract path** with real funds.

Safety: the repo-root `REAL_MONEY_PKEY` is intentionally corrupted (invalid hex) so `vm.envUint`
reverts before anything broadcasts. To actually run it, create a local `.env` here (gitignored; see
`.env.example`) with a valid key + `MAINNET_RPC_URL`, fund the address with ≥ `AMOUNT_IN` USDC + gas,
then:

```bash
forge script script/RealSwap.s.sol --rpc-url $MAINNET_RPC_URL --broadcast
```

## Proven vs. next

**✅ LIVE ON BASE MAINNET.** Real end-to-end ran on-chain: CRE workflow → live Uniswap quote → report
→ KeystoneForwarder `0x5E342a…CCE548` → `StrategyVault` `0xaeb453fF…23b64a` → **real V3 swap, 1 USDC →
0.000593575 WETH** ([tx](https://basescan.org/tx/0x3156936711b00b8189057bd14bed93a88e95bd1ab05bad7d1bc26f07b6cc02ec)).

| Proven here | Next |
|---|---|
| **Real on-chain end-to-end on Base** (forwarder → onReport → Uniswap V3 swap) via `simulate --broadcast` | **DON-autonomous** (`cre workflow deploy`) — gated on Chainlink org access (`cre account access`) |
| Live Uniswap `/quote` + median-consensus on min-out (real API, CRE secret) | A real strategy driving the decision (A1 interpreter, then A4 ML policy) |
| ERC-165 receiver + policy guards (forwarder, minOut, router, token, nonce, expiry, settable forwarder) | `setExpectedWorkflowId` to bind the vault to the registered workflow (after deploy) |
| Automatic via centralized loop (`run-loop.sh`) today | Follow the API's actual route (multi-hop) instead of the pinned single-hop V3 |

### `Action` ABI tuple (for the CRE TS workflow's `encodeAbiParameters`)

```
(address to, bytes data, uint256 value, uint256 minOut, uint64 deadline,
 address tokenIn, address tokenOut, uint256 amountIn, bytes32 nonce, bytes32 artifactHash)
```
