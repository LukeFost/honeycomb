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
contracts/StrategyVault.sol          the CRE receiver + scoped policy (the authority layer)
test/StrategyVaultForkSwap.t.sol     mainnet-fork proof (forwarder simulated via vm.prank)
script/RealSwap.s.sol                gated real-money smoke test (does NOT run by default)
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
| Forwarder→`onReport`→Universal Router swap on a fork | Live CRE workflow `writeReport` → real KeystoneForwarder → vault (testnet/fork) |
| Policy guards (forwarder, minOut, router, token, nonce, expiry) | The TS workflow encoding the `Action` ABI tuple to match `abi.decode` here |
| Contract-account Permit2 approval path | Quote-consensus across DON nodes (numeric-fields aggregation) — still the open risk |
| Balance-delta enforcement bounds a malicious router/API | A strategy driving the decision (A1 declarative interpreter, then A4 ML policy) |

### `Action` ABI tuple (for the CRE TS workflow's `encodeAbiParameters`)

```
(address to, bytes data, uint256 value, uint256 minOut, uint64 deadline,
 address tokenIn, address tokenOut, uint256 amountIn, bytes32 nonce, bytes32 artifactHash)
```
