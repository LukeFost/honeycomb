# x402-gated grader VM spawn (Gap 4)

Spawning the per-bounty **grader Confidential Space VM** is gated behind a **real
x402 USDC payment**. The maker pays USDC via EIP-3009
`transferWithAuthorization`; the self-hosted x402 facilitator verifies + settles
it on-chain; and **only a successful settle authorizes the VM launch**.

This is the grader analogue of the web "Summon a TEE" flow
(`apps/web/src/app/api/summon/route.ts`), but the resource being unlocked is the
launch of a fresh single-shot grader VM (`enclave/grade_in_vm.sh` ->
`enclave/deploy.sh`), not a warm `tee-runner` `/run`.

## Files

| File | Role |
|---|---|
| `summon_enclave.sh` | Drop-in wrapper. Same positional args + same STDOUT contract as `grade_in_vm.sh`. Picks `bun` (preferred) or `node --experimental-strip-types`. |
| `summon_enclave.ts` | The maker side: mint+HMAC-bind the 402 nonce, sign EIP-3009, `/verify`, `/settle`, and **only on success** run `grade_in_vm.sh`. |
| `enclave/grade_in_vm.sh` | Unchanged. Launches the grader VM, polls serial for the in-enclave KMS-signed grade, deletes the VM, prints one JSON line. |
| `apps/x402-facilitator/server.ts` | Unchanged, generic. `POST /verify`, `POST /settle` (EIP-3009 USDC). |

## Why the facilitator stays generic (the minimal server-side change)

The facilitator only verifies + settles EIP-3009 payments; it never touches
grader infra. The grader VM spawn needs `gcloud` + the attested workload SA on
the orchestrator box — privileges the facilitator must **not** hold. So the
"settlement triggers the GRADER spawn" coupling lives in `summon_enclave.ts`,
where the call to `grade_in_vm.sh` is **literally the next statement after a
verified `settle.success === true` with a real tx hash**. That is the smallest
honest wiring: no new route, no grader coupling in the payment layer, and the
spawn is impossible without an on-chain settle.

> Unlike `/api/summon`, the maker is BOTH the buyer and the challenger here (it
> owns the resource = the VM spawn). It mints the nonce and HMAC-binds it with
> the same `SUMMON_NONCE_HMAC_SECRET`, so the wire shape is identical to the web
> flow and a future server-side challenger could be dropped in unchanged.

## The flow

1. **Mint + HMAC-bind the 402 nonce** — `nonce = random bytes32`,
   `nonceSig = HMAC-SHA256(SUMMON_NONCE_HMAC_SECRET, nonce)`.
2. **Sign EIP-3009** `transferWithAuthorization` with
   `authorization.nonce === nonce` (the on-chain USDC replay field), using the
   maker key. Pure local signing — no RPC. The facilitator **relayer** (a
   different EOA) is the one that broadcasts and pays gas.
3. **`POST /verify`** — require `isValid:true`, else **abort, no spawn**.
4. **`POST /settle`** — require `success:true` + a real tx hash, else **abort,
   no spawn**. This is the on-chain USDC transfer.
5. **On success only** — run `grade_in_vm.sh <submission> <jobId> <agentId>
   [digest]`. The signed-grade JSON line goes to **STDOUT** (orchestrator
   captures it exactly as before); the settlement receipt goes to **STDERR**.

Honest failure: the VM is **never** spawned unless settlement returned success
with a valid tx hash.

## Chain + USDC + cost

- **Chain:** ETH mainnet, `eip155:1` (default `SUMMON_NETWORK`). The facilitator
  must be started with `NETWORKS=eip155:1`.
- **USDC:** `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (EIP-712 domain name
  `"USD Coin"`, version `"2"`). 6 decimals.
- **Cost per summon:** `SUMMON_PRICE_ATOMIC` atomic units, default `10000` =
  **0.01 USDC**. Paid maker -> `SUMMON_PAY_TO`. The facilitator **relayer** also
  pays ETH L1 gas for the `transferWithAuthorization` tx (a few $ at mainnet gas).
- Base Sepolia (`eip155:84532`, USDC `0x036CbD…CF7e`, domain `"USDC"`) is wired
  for a free testnet rehearsal.

## Services + env to run

**1. Facilitator** (`apps/x402-facilitator`), the gas-paying settler:

```
PORT=4021
NETWORKS=eip155:1
RELAYER_PRIVATE_KEY=0x...        # the relayer EOA; needs ETH L1 gas (NOT the maker key)
RPC_URL_EIP155_1=https://eth-mainnet.g.alchemy.com/v2/<ALCHEMY_API_KEY>
# then:  bun run server.ts
```

**2. summon_enclave.sh** env (maker side):

| Env | Required | Default | Meaning |
|---|---|---|---|
| `SUMMON_PAY_TO` | yes | — | USDC recipient (0x..20 bytes), e.g. the grader operator treasury |
| `SUMMON_NONCE_HMAC_SECRET` | yes (>=16) | — | binds the 402 nonce to the payment |
| `MAKER_PK` or `REAL_MONEY_PKEY` | yes | from `ENVF` | maker (buyer) key; `'z'` obfuscation chars are stripped |
| `SUMMON_NETWORK` | no | `eip155:1` | CAIP-2 settlement net (must match facilitator `NETWORKS`) |
| `SUMMON_PRICE_ATOMIC` | no | `10000` | USDC atomic units (0.01 USDC) |
| `FACILITATOR_URL` | no | `http://localhost:4021` | facilitator base URL |
| `ENVF` | no | `/home/thegnome/ethny2026/.env` | .env path for `REAL_MONEY_PKEY` |
| `SUMMON_DRY_RUN=1` / `--dry-run` | no | off | build+sign+verify only; **no settle, no spawn** |

`grade_in_vm.sh` additionally needs `GOOGLE_APPLICATION_CREDENTIALS` +
`gcloud` SDK on PATH (already set in `e2e-mainnet.sh`).

## Usage

```bash
# Real (settles 0.01 USDC, then spawns the VM):
SUMMON_PAY_TO=0x... SUMMON_NONCE_HMAC_SECRET=... \
  ./summon_enclave.sh accumulate.py 12345 34570 sha256:9536...229dd

# Dry-run (build + sign + /verify only; NO broadcast, NO VM):
SUMMON_DRY_RUN=1 ./summon_enclave.sh accumulate.py 12345 34570 --dry-run
```

## What was verified locally (no real settle)

- **Dry-run** builds + signs the EIP-3009 payload, runs the nonce-binding
  self-check (HMAC + `authorization.nonce == challenge nonce`), and stops before
  `/settle` and the spawn. ✅
- The constructed signature **recovers to the maker address** via
  `recoverTypedDataAddress` against the mainnet USDC EIP-712 domain. ✅
- The x402 wire shape decodes to `{x402Version:2, accepted, payload:{signature,
  authorization}}` (matches the web flow). ✅
- The **real facilitator on `eip155:1` (mainnet, real USDC)** ran its full
  `ExactEvmScheme.verify` against the constructed payload (signature, amount,
  asset, payTo, time bounds, on-chain `authorizationState`) and returned
  **`isValid:true`** — i.e. the payment is genuinely settleable. ✅
- A **tampered** requirement (amount) -> facilitator `isValid:false`
  (`invalid_exact_evm_authorization_value`) -> script aborts, no spawn. ✅

**Not exercised (requires a real broadcast):** `POST /settle` (the on-chain USDC
transfer) and the subsequent `grade_in_vm.sh` VM launch. Those are deliberately
the last two steps and run only in the real (non-dry-run) path.
