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
contracts/StrategyVault.sol          the CRE receiver (ERC-165) + scoped policy (authority layer)
test/StrategyVaultForkSwap.t.sol     mainnet-fork proof (forwarder simulated via vm.prank)
test/DecodeWorkflowPayload.t.sol     proves the workflow's viem payload decodes in the vault
script/RealSwap.s.sol                gated real-money smoke test (does NOT run by default)
strategy-workflow/main.ts            the CRE workflow: CRON -> Action -> report -> writeReport
strategy-workflow/{workflow,config,…}  CRE targets + config (project.yaml is at the app root)
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

## Run the fork test

No API key needed — defaults to a public RPC:

```bash
forge test -vv --root .
# or pin your own archive node:
MAINNET_RPC_URL=https://your-rpc forge test -vv --root .
```

## Run the CRE workflow (simulate)

The off-chain half lives in `strategy-workflow/` (TypeScript, compiled to WASM by the CRE
toolchain). On each CRON tick it builds the Universal Router calldata deterministically, encodes
the **flat** `Action`, DON-signs it (`runtime.report`), and writes it (`writeReport → forwarder →
vault.onReport`). v1 has no live quote — calldata is built from config so every DON node is
byte-identical and consensus is trivial.

```bash
cd strategy-workflow && bun install && cd ..       # CRE SDK + WASM toolchain
CRE_TARGET=staging-settings cre workflow simulate strategy-workflow \
  --non-interactive --trigger-index 0
```

Passing run logs the tick, attempts the write (no `txHash` without `--broadcast`/a deployed vault —
expected), and returns the Action summary. `config.staging.json` carries placeholder Sepolia
addresses + a placeholder `vault`; set the real `vault`/`router` before a `--broadcast` run.

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

| Proven here | Next |
|---|---|
| Forwarder→`onReport`→Universal Router swap on a fork (9 tests green) | Live `writeReport` → REAL KeystoneForwarder → deployed vault (needs DON workflow registration + `--broadcast`) |
| ERC-165 receiver + policy guards (forwarder, minOut, router, token, nonce, expiry) | Live Uniswap quote + quote-consensus across DON nodes (the open risk) |
| CRE workflow passes `cre workflow simulate` (CRON→Action→report→writeReport) | A real strategy driving the decision (A1 interpreter, then A4 ML policy) |
| viem→Solidity `Action` encoding cross-checked by a decode test | Deploy to Sepolia, set `expectedWorkflowId`, broadcast end-to-end |

### `Action` ABI tuple (for the CRE TS workflow's `encodeAbiParameters`)

```
(address to, bytes data, uint256 value, uint256 minOut, uint64 deadline,
 address tokenIn, address tokenOut, uint256 amountIn, bytes32 nonce, bytes32 artifactHash)
```
