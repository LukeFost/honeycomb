# honeycomb-uniswap-lp

A **generalized Uniswap LP execution capability**: give it an abstract strategy
decision, get back a real onchain liquidity position via the
[Uniswap Developer Platform LP API](https://developers.uniswap.org/docs/liquidity/overview).

It is a reusable feature, not a one-off pipeline step. A grader (or any caller)
imports `executeLPDecision` and hands it a decision; this module renders that
decision into a signed, broadcastable Uniswap V3 `mint` transaction. The
decision shape is the seam that keeps "the LP and the trader and etc" all
flowing through one executor.

## Why this exists (the integration)

The strategy a grader scores is a chain-agnostic **decision**, e.g. "provide
full-range liquidity into WETH/USDC 0.3% with this much capital." That decision
is worthless until it becomes a real position onchain. This module is the bridge:

```
LPDecision  ──►  executeLPDecision()  ──►  POST /lp/create  ──►  unsigned tx
   (what the          (this module)         (Uniswap LP API)        │
    strategy                                                        ▼
    decided)                                          sign + broadcast = real tx hash
```

The unsigned transaction the API returns is the prize's qualifying artifact:
sign it, broadcast it, and the resulting hash is a real onchain transaction ID.

## Verified working (live, against the real API)

`bun demo.ts` calls the live LP API and prints the real unsigned transaction.
Confirmed HTTP 200 with a decoded `mint(...)` on two testnets:

| Chain | chainId | `create.to` (V3 PositionManager) | Status |
|---|---|---|---|
| **Unichain Sepolia** | 1301 | `0xB7F724d6dDDFd008eFf5cc2834edDE5F9eF0d075` | 200, `mint()` decoded |
| **Ethereum Sepolia** | 11155111 | `0x1238536071E1c677A632429e3655c799b22cDA52` | 200, `mint()` decoded |

Calldata decodes to selector `0x88316456` = V3 `NonfungiblePositionManager.mint`.

## Run it

```bash
# from repo root, after `pnpm install`
cd apps/uniswap-lp

bun demo.ts            # Unichain Sepolia (1301), the default
bun demo.ts 11155111  # Ethereum Sepolia
```

Output is the real unsigned LP-mint transaction: `to`, `value`, full-range
ticks, calldata length, and the decoded function. Nothing is signed or
broadcast — this is simulate-only by design.

The Uniswap API key is read from the macOS Keychain (`uniswap_api_key`) and
never printed. Store it with the `keychain-secret` skill.

## Files

- `decision.ts` — `LPDecision`, the generalized strategy-output shape, plus
  tick-spacing / full-range helpers. The seam every caller targets.
- `executor.ts` — `executeLPDecision(decision, opts)`. Maps a decision to the
  verified `/lp/create` body, POSTs, returns the unsigned tx with a viem
  decode. `mode: "execute"` (sign + broadcast) is guarded off until a testnet
  signing key is supplied.
- `pools.ts` — registry of REAL, probe-confirmed pools per testnet (the API
  requires a real `poolReference`, not just a token pair).
- `demo.ts` — runnable proof: one decision → one real unsigned tx.

## API ground truth (the docs get two things wrong)

- **Host is `https://liquidity.api.uniswap.org`**, not `api.uniswap.org` (which
  403s).
- The price range field is **`tickBounds: {tickLower, tickUpper}`**, not the
  `priceBounds` the docs example shows. Ticks must be multiples of the pool's
  tick spacing (full-range for fee 3000/spacing 60 is ±887220).
- `existingPool` requires a real `poolReference` (the pool contract address);
  `{token0, token1, fee}` alone is rejected (HTTP 400).
- Auth: header `x-api-key`.

## From decision to a broadcast tx (next step)

`mode: "execute"` is intentionally disabled. To produce a real qualifying tx:

1. Fund a throwaway wallet on the target testnet (Unichain Sepolia faucet).
2. Supply its key as `uniswap_testnet_pk` in the Keychain.
3. Wire the sign + broadcast block in `executor.ts` (viem
   `privateKeyToAccount` + `walletClient.sendTransaction`).
4. The broadcast hash is the prize's qualifying onchain transaction ID.
