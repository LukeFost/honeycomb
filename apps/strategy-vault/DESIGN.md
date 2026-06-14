# Autonomous Trading Vault via Chainlink CRE + Uniswap Trading API

**A trust-minimized "strategy box": fund it, give it a strategy (config or trained ML policy), and it autonomously trades through the Uniswap Trading API — execution integrity from a Chainlink CRE DON, blast radius bounded by an on-chain scoped vault.**

Status: build-ready design. Builds on `strategy-box-plan.md` (scoped-vault authority model, `onTick(obs)->action` interface, feature-oracle problem, model provenance by hash, strategy-as-WASM unification). All CRE SDK shapes below are pinned to what is actually installed in this repo's demo (`@chainlink/cre-sdk`, the templates in `cre-templates/`, and `chainlink-confidential-ai-attester-demo/`); items not demonstrated there are flagged as "confirm in `cre workflow simulate`."

---

## 1. TL;DR

- **Authority layer (the trust story):** a `StrategyVault` contract holds the funds and acts **only** when the canonical **Chainlink KeystoneForwarder** delivers a DON-signed report to it (`onReport(metadata, report)` guarded by `onlyForwarder`), and only within an on-chain policy (allowed tokens, spend cap, max slippage / `minOut`, expiry, rate limit). Trust comes from `msg.sender == forwarder` plus the forwarder's own report verification — **the vault does not do its own ECDSA check** and there is no `donSignature` argument. Worst case if the entire off-chain stack is malicious: a few capped, slippage-bounded swaps. No withdraw, no arbitrary approve, no bridge.
- **Execution layer:** a **Chainlink CRE workflow** (TypeScript host today — there is no Rust workflow SDK) runs on a DON, fetches features, calls the Uniswap Trading API (with the API key kept off plaintext logs), runs the strategy, and writes the DON-signed report the vault consumes.
- **The strategy is a deterministic Rust→WASM module** exporting `on_tick(obs) -> action`, linked into the workflow as a **Custom Rust Plugin** (`cre workflow custom-build` + `wasm32-wasip1`) that registers a **bare global function** the TS host calls. The *same* `on_tick` runs in offline backtest and live.
- **Two strategy tiers, one interface:** (v1) a declarative config interpreter; (headline) a quantized **Mamba-SSM + Dueling-Double-DQN** LP policy (arXiv 2511.22101) compiled to deterministic WASM, with **INT8 inference as the primary path** so the discrete argmax action is bit-identical across heterogeneous nodes and the DON's BFT consensus collapses every node to one identical action — no extra proof system. Model committed by `artifactHash` in a `StrategyRegistry`.
- **Privacy fallback:** for large/private weights, run inference in an **AWS Nitro TEE** (reuse the Confidential AI Attester) and verify the attestation before the vault acts.
- **Bounties:** primary Chainlink CRE & AI / DeFi (CRE + Data Streams + secrets, multi-service bonus); secondary Uniswap Foundation (v4 policy hook); optional Confidential Compute / x402.

---

## 2. How CRE custom builds + Rust change the picture

The plan's open question — "is the strategy just a config, or can it be real code, and can that code be *trustless*?" — is answered by two CRE facts from the research.

**(a) Custom builds let you own the compile step and link native Rust.** By default `cre workflow deploy`/`simulate` auto-compile Go or TypeScript to WASM. `cre workflow custom-build ./workflow` is an opt-in conversion: it rewrites `workflow.yaml` (sets `workflow-path` to `./wasm/workflow.wasm`) and generates a `Makefile` you now own — the CLI stops auto-compiling. The generated TS target is `bun cre-compile main.ts wasm/workflow.wasm`. This is the documented hook for **"Language/SDK extensions: integrate code from other languages or custom SDKs."** (Per the docs this is described as reversible — you can return to auto-build by restoring `workflow.yaml`/deleting the `Makefile`; treat it as a workflow change you commit, not a one-way door. Confirm against your installed CLI before relying on either claim.)

**(b) Rust is plugin-only, not a workflow language.** There is **no Rust CRE workflow SDK** — you cannot author a whole workflow in Rust today. Rust enters via **Custom Rust Plugins**: a `src/lib.rs` extension crate (a normal `lib`) that exposes `pub fn register(ctx: &Ctx<'_>)`, compiled to `wasm32-wasip1` and linked into a TypeScript workflow's WASM. `register` calls `extend_wasm_exports(&ctx, "name", Func::from(closure))` to install **global JS functions** (the same mechanism the SDK uses for `callCapability`, `getSecrets`); there is **no per-crate namespaced object**, so the TS code calls them as **bare globals** (declare them in a `.d.ts`). The generated host crate that links everything is `crate-type = ["cdylib"]`; your extension stays a `lib`. Two modes:
- **Mode 1 `--plugin`** consumes a prebuilt `.plugin.wasm` — **no Rust toolchain at build time**, shippable as an npm package.
- **Mode 2 `--cre-exports ./my-plugin`** compiles your crate at build time (needs stable Rust + `rustup target add wasm32-wasip1`).
Crate names use underscores. Wired through the custom-build Makefile, e.g. `CRE_SDK_JAVY_PLUGIN_HOME="$(JAVY_PLUGIN)" bun cre-compile --cre-exports ./my-plugin ./index.ts ./wasm/workflow.wasm`. The documented use cases are exactly ours: *"Rust running natively in WASM is significantly faster than interpreted JavaScript"* and *"verify ZK proofs, Risc-0 receipts, or other cryptographic attestations."*

**QuickJS, not Node.** The TS host runs in **QuickJS via Javy**. `node:crypto` and `process` are **unavailable**; do all hashing/ABI via `viem` and `@noble/*` as the templates do. A **`Buffer`/`atob`/`btoa`/`TextEncoder`/`TextDecoder`/`URL` shim *is* provided** by the runtime (the kv-store and custom-data-feed templates use `Buffer.from(...).toString(...)`), so `Buffer` is fine; the missing pieces are `node:crypto` and `process`.

**Marshalling across the QuickJS↔Rust boundary is by JS value, not raw linear-memory pointers.** Javy passes inputs as `ArgBytes` (Uint8Array / ArrayBuffer / Base64) and returns JS-native values (i32/i64/String/Uint8Array). The mental model is **not** a C `(*const u8, usize) -> u64` signature; pass `obs` as a `Uint8Array`/Base64 and return a small number or `Uint8Array`. NaN canonicalization at this boundary is a determinism hazard to test (see §2c).

**(c) Determinism is mandatory for DON consensus, and is *achievable* — but only with care.** Every DON node re-runs the identical WASM and, for an aggregation requiring identical bytes, outputs must match bit-for-bit. CRE neutralizes the usual nondeterminism sources: wall-clock `Date`/`now()` are host-provided and consensus-reconciled; **`Math.random` is not banned — it is *replaced* by a host-seeded deterministic CSPRNG (ChaCha8)**, so randomness is made deterministic rather than forbidden; unordered map iteration, ad-hoc concurrency, and direct network/FS/env are disallowed, and all external effects flow through capabilities (HTTP / Confidential HTTP / EVM read+write / secrets) reconciled by **Consensus**.

Float determinism for NN inference is **the load-bearing risk and is not free**. Correcting the prior draft:

- **WASM core has NO `fma` instruction.** Fused multiply-add exists *only* in the **Relaxed-SIMD** proposal and is explicitly **non-deterministic** (hardware may single- or double-round). The core ops that *are* correctly-rounded round-to-nearest-ties-to-even IEEE-754 are `fadd/fsub/fmul/fdiv/fsqrt/fmin/fmax` — **`fma` is not among them.** Any earlier claim of a "correctly-rounded core `fma`" is wrong and is removed.
- **The compiler can silently break bit-identity** by contracting `a*b+c` to a hardware FMA (LLVM `contract` fast-math flag) or by autovectorizing to relaxed-SIMD `madd`. `f32::mul_add` / `num_traits::MulAdd` map explicitly to a fused op and **must never be used** on the hot path.
- **Therefore INT8 is the *primary* inference path, not optional.** Integer matmul with INT32 accumulation is genuinely bit-identical across hosts and sidesteps every float trap (no FMA double-rounding, no FTZ/DAZ denormal differences, no NaN canonicalization, no transcendental `exp`/`tanh`/`sigmoid` libm-vs-polynomial divergence). For a trustless headline this is mandatory.

So the determinism build rules (§5.1) are: **INT8/INT32 integer-only inference; single-threaded; relaxed-SIMD OFF; fp-contraction OFF (verify LLVM `contract` is not enabled); no `f32::mul_add`/std-SIMD madd; fixed reduction order; deterministic argmax tie-break (lowest index wins); finite activations.** With these, honest nodes return identical bytes and BFT consensus collapses all nodes to one identical action **with no extra proof system**. Crucially, **discrete-action consensus is all-or-nothing** — a median can't reconcile a flipped argmax — which is exactly why the float-determinism discipline above must be airtight; a single-ULP divergence near a decision boundary would break report consensus (a liveness loss), not get fuzzed away.

**(d) Hard quotas push heavy ML out of the WASM, not the decision.** Production quotas (per `docs.chain.link/cre/service-quotas`; confirm current numbers): WASM ≤ 100 MB (≤ 20 MB compressed), memory ≤ 100 MB, execution ≤ 5 min; **HTTP request payload ≤ 10 KB, HTTP response ≤ 100 KB, ≤ 5 HTTP calls/run; consensus observation ≤ 25 KB; on-chain report payload ≤ 5 KB**; ChainRead ≤ 15 calls; ChainWrite gas ≤ 5,000,000; secrets ≤ 27 KB. A *tiny* policy (sub-ms inference, a few-M params, content-hashed weights) fits comfortably; a large model does not — that one runs in a TEE and the workflow only ingests the attested result (the existing attester pattern). The **report payload limit is 5 KB, not 100 KB**: the report is the load-bearing artifact (the ABI blob carrying the opaque Router calldata + all fields), and a single classic swap's calldata fits 5 KB, but this rules out batching many swaps / large multicalls in one report.

**Why this makes "strategy as a custom WASM module" the load-bearing primitive.** Custom builds + Rust plugins turn the strategy from "config the runner trusts" into **native, deterministic, content-addressed code whose execution the DON verifies by consensus.** One interface — `on_tick(obs) -> action` — covers a 200-line declarative interpreter and a quantized RL policy with no change to the vault, the report format, or the workflow shell. The plan's "strategy-as-WASM unification" is concrete: a declarative v1 and an ML headline are the *same plugin slot*, so v1→ML is a drop-in upgrade, not a rewrite.

---

## 3. Design matrix

Scores are the **consensus** (mean of the three judges' 1–5 ratings, rounded to nearest 0.5). Disagreement flagged in notes. Dimensions: TM = trust-minimization, Det = determinism, Exp = expressiveness, Dev = dev-effort (5 = easiest), Priv = privacy, CL = Chainlink fit, UNI = Uniswap fit, C/L = cost-latency (5 = cheapest/fastest), SA = standalone-product.

| Approach | TM | Det | Exp | Dev | Priv | CL | UNI | C/L | SA | **Verdict** |
|---|---|---|---|---|---|---|---|---|---|---|
| **A1** Signed JSON config + one generic TS interpreter | 3.5 | 4.5 | 2 | 5 | 1 | 3.5 | 4.5 | 5 | 3.5 | **Build first — the eligible spine & shippable v1.** No-code "strategy box"; cleanest AMM (CLASSIC) swap path; zero alpha/privacy. |
| **A2** `when→then` predicate DSL in one workflow | 3.5 | 4.5 | 3 | 4 | 1 | 3.5 | 4.5 | 5 | 3.5 | **Cheap expressiveness bump.** Composable rules, still no arbitrary code; small parser-determinism risk vs A1. |
| **A3** Per-strategy hand-written Rust→WASM workflow | 3.5 | 4.5 | 4 | 1.5 | 2 | 3.5 | 4 | 4 | 2.5 | **Avoid as stated.** No Rust *workflow* SDK; per-strategy redeploy is a bad product + 36h-killer. Only the plugin kernel survives (→ A4). |
| **A4** Quantized Mamba+DDQN policy, deterministic Rust→WASM (INT8), **inference on the DON** | **4** | **5** | 4.5 | 2 | 2 | **5** | 4 | 4 | 4 | **Headline / win ceiling.** Honest Det=5 *only* with INT8 integer-only inference + deterministic argmax; trustless decentralized AI agent, no proof system. Risk = ML export pipeline lands in time. |
| **A5** ML in attested **Nitro TEE**, attestation verified before the vault acts | 3.5 | 3.5 | **5** | 3.5 | **5** | 4.5 | 4 | 3.5 | 4 | **Privacy champion / fallback.** Hides alpha, unbounded model; single-machine hardware trust, not BFT. Forkable from existing demo. |
| **A6** zkML proof `action=model(obs)` verified on-chain | 5 | 5 | 3 | 1 | 4 | 3.5 | 3 | 1 | 2.5 | **Right idea, wrong tool here.** Tightest trust but EZKL/Halo2 ~6–15s + ~1 GB RAM blows the 5-min/100 MB budget; DON already gives consensus. |
| **A7** Off-chain imperative Python runner | 2 | 1.5 | **5** | 4.5 | 3.5 | 1.5 | 5 | 4.5 | 3 | **Speed crutch only.** Max power/speed but sidesteps CRE (fails the eligibility gate) and is single-opaque-box — guts the thesis. |

**What the matrix reveals.** The field splits on **devEffort vs trust-novelty**, and the three judges agree on the shape even while disagreeing on the winner: the pragmatist tops **A1** (guaranteed ship), the purist tops **A4** (consensus-deterministic AI), the prize strategist tops **A5** (privacy + wow). A1 and A4 share one fact that resolves the tension — **identical `on_tick(obs)->action` interface**, so A4 drops into A1's plugin slot with no rewrite. **A3 is strictly dominated** (no Rust workflow SDK; its only buildable core *is* A4's plugin). **A6 is disqualified by latency** for a per-tick loop and is redundant against the DON's free consensus. **A7 fails the Chainlink eligibility gate.** **Chosen primary: A1 as the spine, A4 as the headline upgrade in the same slot. Fallback/companion: A5** when alpha must stay private or the ML export stalls. All three sit behind the identical §4 scoped-vault authority. Note the TM scores for A1/A4 are equal *and* the vault is shared, so trust-minimization here means **execution integrity of the runner**; worst-case *loss* is bounded identically for both by the §4 vault — the TM dimension does not separate them on capital risk, only on how little you must trust the decision producer.

---

## 4. Chosen architecture

### 4.1 Components

**`StrategyVault` (CRE receiver contract).** Holds user funds. Implements the CRE receiver interface so the **KeystoneForwarder** can deliver DON-signed reports:

```solidity
interface IReceiver { function onReport(bytes calldata metadata, bytes calldata report) external; }
```

The vault is constructed with the forwarder address for the target chain (Ethereum Sepolia mock `0x15fC6ae953E024d975e77382eEeC56A9101f9F88`; Ethereum Sepolia production `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`; **verify the forwarder exists and is the correct address for whichever chain you actually write to** — see §10). It enforces an on-chain `Policy`:

```solidity
struct Policy {
    address[] allowedTokens;     // tokenIn/tokenOut must be in set
    address   router;            // the single allowed call target (Universal Router for the pinned version)
    uint256   spendCapPerEpoch;  // budget cap per epoch (counts ERC20 amountIn AND native value)
    uint16    maxSlippageBps;    // ceiling; report.minOut must imply <= this vs an on-chain reference
    uint64    expiry;            // grant validity window
    uint32    maxSwapsPerEpoch;  // rate limit
    uint32    epochLength;
}
```

Key functions:
- `onReport(bytes metadata, bytes report) onlyForwarder` — the **only** entry the DON drives. It decodes `{to, data, value, minOut, deadline, tokenIn, tokenOut, amountIn, reportNonce}`, then enforces **all** policy/slippage/replay/expiry checks here: `to == Policy.router`; `tokenIn/tokenOut ∈ allowedTokens`; `amountIn + value` within `spendCapPerEpoch`; `minOut` implies ≤ `maxSlippageBps`; `block.timestamp ≤ deadline` and `≤ expiry`; `reportNonce` not seen before; swap count within `maxSwapsPerEpoch`. **It then validates the opaque calldata does what was approved** — it must decode/inspect enough of `data` to confirm the swap's **recipient is the vault** and the **input pull == amountIn of tokenIn** (so a malicious API cannot redirect output or substitute the input token; `minOut` alone does **not** protect against tokenIn substitution or recipient redirection). Only then does it forward one raw call to `to` with `data`/`value`. Reverts on any breach.
- `setPolicy(...)`, `deposit(...)`, `revoke()` — owner-only.
- **Replay protection:** the vault keeps a `mapping(bytes32 => bool) usedNonce`. **Open question:** the KeystoneForwarder may already provide per-report idempotency; if so the vault nonce is belt-and-suspenders. Confirm whether the forwarder dedups before relying solely on the vault check (§10).
- Optional `PolicyProtected` wrapper (Chainlink ACE) for venue/recipient allowlist + sanctions screening (second Chainlink surface).

The vault is a **contract account**, which is why it uses the AMM/Universal-Router path (it cannot produce an EOA EIP-712 Permit2 signature). ERC-4337/EIP-7702 smart-account features are **optional decoration**, not load-bearing, and are out of MVP scope.

**`StrategyRegistry` (contract).** Maps `vault -> StrategyRef { bytes32 artifactHash, uint8 kind, string cid }` where `kind ∈ {DECLARATIVE_CONFIG, ML_POLICY}`. `artifactHash` = SHA-256 of the config blob (A1) or of the quantized weights file (A4); `cid` = IPFS/Arweave content address. The workflow reads this to know *which* strategy/model to run; the hash is also emitted on-chain with each action for provenance. CRE commits to the workflow-WASM hash (pinning the *code*); the registry pins the *weights/config*.

**CRE workflow (TypeScript host + Rust plugin).**
- **Trigger:** `CRON` (the "run continuously" loop) — or an EVM-log trigger for event-driven rebalances. (The attester demo uses an HTTP trigger; for an autonomous loop, CRON is the right primitive, per `cre.capabilities.CronCapability`.)
- **Capabilities:** `EVMClient` read (positions/balances, registry, Data Feeds), HTTP / **Confidential HTTP** (Uniswap Trading API), `runtime.getSecret` (the `x-api-key`), the Rust-plugin global `on_tick`, **Consensus** aggregation (on the numeric quote fields), and `EVMClient.writeReport` (→ forwarder → vault).

**Feature oracle.** The observation vector `obs` for `on_tick` is assembled from **Chainlink Data Streams** / **Data Feeds via EVM Read** plus the vault's on-chain position/balances. These are oracles every node sees identically, so feature assembly is deterministic — features do **not** come from each node independently scraping a time-varying source. **Note on A4 fidelity:** arXiv 2511.22101 trains on **28 subgraph-derived features**, not Chainlink feeds. To run on-DON we must **retrain/snapshot the model against the oracle-available feature set** (the subset reproducible from Data Streams/Feeds + on-chain state); the published weights are not directly reusable. This is a real A4 task, not a config swap.

**Runner for the WASM strategy.** The TS host marshals `obs` (fixed-width, canonical little-endian byte order, as a `Uint8Array`) into the Rust plugin's `on_tick`, which returns a packed action (`HOLD` or `{ side, tokenIn, tokenOut, amountIn }`). The host then turns a non-`HOLD` action into a Uniswap quote→swap round-trip and packs the report.

### 4.2 Data-flow diagram

```
 USER (off-chain)            ON-CHAIN                         CRE DON (in-DON)              EXTERNAL
 ───────────────            ──────────                        ───────────────              ────────
   deposit ───────────────► StrategyVault (CRE receiver)
   setPolicy ─────────────► (Router-only, capped, expiring,
   register strategy ─────► StrategyRegistry(hash, cid)         slippage-bound, replay-guarded)
                                   ▲  │
                                   │  └── EVM read: which strategy / artifactHash ──┐
                                   │                                                 │
                            CRON tick ──────────────────────────────────────────────┤
                                   │   EVM Read  ◄── position, balances, registry    │
                                   │   EVM Read  ◄── Data Feeds (price) ─────────────┤
                                   │   NODE mode ◄── Data Streams (per-node fetch) ──┼──► Data Streams
                                   │   → consensus(features)  [DON mode]             │
                                   │                                                 │
                                   │   obs = assemble(features)  [deterministic]     │
                                   │   action = on_tick(obs)     [Rust plugin, INT8] │
                                   │                                                 │
                                   │   if action != HOLD:                            │
                                   │     NODE mode: /quote (protocols V2/V3/V4) ─────┼──► Uniswap Trading API
                                   │       consensus over NUMERIC fields only        │    (x-api-key = secret)
                                   │     build Router calldata from agreed route+minOut
                                   │       → {to=UniversalRouter, data, value, minOut}│
                                   │                                                 │
                                   │   report = encode(to, data, value, minOut,      │
                                   │            deadline, tokenIn,tokenOut,amountIn,  │
                                   │            nonce, artifactHash)  [<= 5 KB]       │
                                   │   runtime.report(prepareReportRequest(report))  │
                                   │   EVMClient.writeReport(receiver=VAULT) ─────────┐
                                   ▼                                                  │
   monitor/revoke ◄─ events  KeystoneForwarder ──► StrategyVault.onReport(meta,report)
                                   │   (onlyForwarder; policy+calldata checks; raw call)
                                   └── confirm via EVM Read of receipt / balance delta ─► Universal Router → pool
```

### 4.3 On-chain vs in-DON vs off-chain; trust boundaries

| Where | What lives there | Trust boundary |
|---|---|---|
| **On-chain** | `StrategyVault` (funds, policy, calldata validation, Router call), `StrategyRegistry` (hashes/CIDs), emitted `artifactHash`/`reportNonce`, forwarder address | **Hard boundary.** Even a fully malicious DON + API can only trigger capped, slippage-bounded, allowlisted swaps **to/from the vault** within `[start, expiry]`. No withdraw/approve/bridge. This is the whole trust story. |
| **In-DON (WASM, replicated)** | Workflow shell, feature assembly, `on_tick` (Rust plugin, INT8), quote-numeric consensus, report build, `writeReport` | **BFT consensus boundary.** A1/A2/A4 are *deterministic* (INT8 for A4), so honest nodes return identical bytes; a minority of malicious nodes cannot move the signed output. Content-hashed WASM + weights pin code/model. Disagreement = consensus failure = **no report = liveness loss** (not theft). |
| **Off-chain (external)** | Uniswap Trading API, Data Streams endpoint, IPFS/Arweave artifact store, the user's UI | **Soft, bounded.** A lying Uniswap API yields bad `route`/`minOut`, but the vault rebuilds calldata and `minOut`+policy bound the loss; a withheld quote yields liveness loss, not theft. The API key is kept off plaintext logs via secrets / Confidential HTTP. |
| **Off-DON (TEE, A5 only)** | Large/private model inference in a Nitro Enclave | **Hardware-attestation boundary.** Single machine; attestation proves *which* binary ran; the workflow gates on the attestation before writing. Weaker than BFT (no replication) but bounded by the same vault. |

---

## 5. Strategy encoding

### 5.1 One interface, two tiers

Every strategy is a Rust extension crate compiled to `wasm32-wasip1` and linked as a Custom Rust Plugin. Its `register` installs a **bare global** the TS host calls:

```rust
// src/lib.rs — crate is a normal `lib`; crate name uses underscores.
// The generated HOST crate (cdylib) links this and calls register().
use cre_sdk_javy_plugin::{Ctx, extend_wasm_exports /*, Func */};

pub fn register(ctx: &Ctx<'_>) {
    // Installs a GLOBAL JS function `on_tick` (no per-crate namespace object).
    // Input arrives as ArgBytes (Uint8Array/ArrayBuffer/Base64); return is JS-native.
    extend_wasm_exports(ctx, "on_tick", /* Func::from( */ |obs: Vec<u8>| -> i64 {
        // obs: fixed-width canonical little-endian layout produced by the TS host.
        // INT8/INT32 integer-only inference -> deterministic argmax -> packed action.
        // Returns a packed Action: HOLD or { side, token_in_idx, token_out_idx, amount_in }.
        run_strategy_int8(&obs)
    } /* ) */);
}
// NOTE: exact extend_wasm_exports / Func signature is illustrative —
// confirm against the installed cre-sdk-javy-plugin before building.
```

```ts
// strategy-plugin.d.ts — declare the bare global so TS can call it.
declare function on_tick(obs: Uint8Array): bigint; // packed action
```

Determinism rules enforced at build for *both* tiers, and **mandatory for A4**:
- **INT8 weights, INT32 accumulation, integer-only non-linears** (no floats on the hot path).
- single-threaded; **relaxed-SIMD OFF**; **fp-contraction OFF** (verify LLVM `contract` is not enabled; Rust does not contract by default but confirm with the build flags actually used); **no `f32::mul_add` / `num_traits::MulAdd` / std-SIMD madd**; one fixed reduction/accumulation order in every dot-product.
- **deterministic argmax tie-break: lowest index wins on exact equality** (with INT8 Q-values, exact ties are well-defined and identical across nodes).
- finite activations; avoid transcendental `exp`/`tanh`/`sigmoid` (use integer/polynomial approximations baked into the quantized graph) so there is no libm-vs-build divergence.

Validate with `cre workflow simulate` (same WASM environment as production).

**Tier A1/A2 — declarative.** `obs` + a parsed, bounded config AST (DCA / TWAP / threshold-rebalance / grid / `when→then` predicates). Pure integer/comparison logic → trivially bit-identical. `artifactHash` = SHA-256 of the config blob, stored in `StrategyRegistry`.

**Tier A4 — trained ML policy (arXiv 2511.22101, Mamba-SSM + Dueling-Double-DQN, Uniswap-V3 LP management).** Pipeline:
1. **Retrain/snapshot against the oracle feature set.** The paper uses 28 subgraph features; reproduce the subset derivable from Data Streams/Feeds + on-chain state and retrain (or fine-tune) on that feature vector. *(This is a real task, not a swap.)*
2. **Export the recurrent-step weights, not the parallel scan.** Mamba's selective-scan is a Triton kernel with **no ONNX op**, so emit the per-timestep RNN form `h_t = Ā⊙h_{t-1} + B̄·x_t`, `y_t = C·h_t (+ D·x_t)` plus `conv1d`, input/gate projections, and the dueling value+advantage heads as plain tensors.
3. **Implement `on_tick` as a per-timestep loop** of integer matmul + elementwise ops in pure Rust (no C deps; e.g. hand-authored INT8 kernels, or `tract`/`burn-ndarray` configured for integer paths). Avoid `ort`/`onnxruntime` (C++ ABI) and `wonnx` (WebGPU — no GPU in DON nodes). **Do not rely on any runtime FMA.**
4. **Quantize to INT8 (primary path, not optional):** INT8 matmul accumulated to INT32 (Jacob et al. 1712.05877), integer-only non-linears (I-BERT-style). Integers can't be NaN and can't double-round, so the inference is **bit-identical across heterogeneous nodes** — this is what makes A4's Det=5 honest. **Validate that PTQ/QAT preserves the DDQN argmax** on a held-out trajectory set; the action is `argmax` over Q-values and is robust to small quantization error *only because* the argmax is exact and tie-broken deterministically.
5. **Commit by hash:** `artifactHash` = SHA-256 of the quantized weights file; store the IPFS/Arweave CID in `StrategyRegistry`; emit `artifactHash` on-chain with each action. **The plugin must assert that the loaded-weights hash == the registry `artifactHash`** so the running WASM provably used the committed weights (the WASM hash pins the *code* but not necessarily the *weights blob* it reads).

The DON's BFT consensus then collapses all nodes to one identical action with **no median/tolerance fuzzing** — the headline trust property — and discrete-action consensus is all-or-nothing, which the INT8 path makes safe.

### 5.2 Same `on_tick` for backtest and live

The Rust crate compiles twice from the same source: once to `wasm32-wasip1` (the plugin) and once to the host target as a library used by an offline backtest harness that replays historical `obs` vectors through `on_tick`. **The backtest must use the same INT8 integer path and the same determinism flags (relaxed-SIMD OFF, no FMA/contraction)** or it will not faithfully reproduce live behavior. Identical code path → the backtest is a faithful simulation, and the same content-hash proves it.

### 5.3 TEE-attested path (documented extension, A5)

When weights are large (> WASM quotas) or must stay private, run inference in an **AWS Nitro Enclave** reusing the **Confidential AI Attester** scaffolding (`chainlink-confidential-ai-attester-demo`). The enclave returns the action plus an attestation document; the workflow ingests it (the demo uses an HTTP-trigger callback exactly like its loan decision), verifies the attestation (a Rust plugin can verify the Nitro signature natively in-WASM), and only then builds/writes the report. **A5 hides the model; it does not protect the user's private *inputs* end-to-end** unless the obs are also sent into the enclave confidentially — scope that explicitly if claimed. Trade: input/weight privacy + unbounded model size, at the cost of single-machine hardware trust instead of BFT.

---

## 6. Uniswap Trading API integration

Base URL `https://trade-api.gateway.uniswap.org/v1`; **`x-api-key` on every request** (free key from the Uniswap developer dashboard; default **3 req/s**). The key is a secret → fetched via `runtime.getSecret`, and the call is made over **Confidential HTTP** so the key/body stay off plaintext logs. The API also requires a **consistent `x-universal-router-version` header** (e.g. `1.22.0` / `2.0` / `2.1.1`) across `/check_approval`, `/quote`, and `/swap`; **each testnet has its own Universal Router address**, and the vault's `Policy.router` must be pinned to exactly that version's address. A version/address mismatch reverts. **Pin one UR version for the whole demo.**

**We use the AMM (CLASSIC) path via the Universal Router, not UniswapX.** UniswapX fills are done by an external off-chain filler against a *user-signed* order — our contract vault cannot sign or have it filled — and it carries ~300 USDC (mainnet) / ~1000 USDC (L2) minimums. Only the AMM path yields calldata our vault can submit. **To force it, restrict the request `protocols` array to `["V2","V3","V4"]` (omit `UNISWAPX`) — do NOT set `routingPreference: "CLASSIC"`, which is not a valid request value** (`routingPreference` accepts `BEST_PRICE` / `FASTEST`; `CLASSIC` is the *response* `routing` discriminator). Optionally set `routingPreference: "BEST_PRICE"`. Then **assert `response.routing === "CLASSIC"`** before building the report; reject anything else.

**Approval reality for a CONTRACT account (spell out the exact path).** A smart-account vault cannot produce an EOA EIP-712 Permit2 signature, so commit to **one** approval mode and make it explicit:
- **Permit2-disabled mode (chosen default):** pass **`x-permit2-disabled: true` on BOTH `/check_approval` AND `/swap`**. `/check_approval` then returns an approval whose spender is the **Universal Router** directly; the owner submits that one-time `ERC20.approve(UniversalRouter, …)`. **Verify the returned `approval.to`/spender is actually the Universal Router (not Permit2) before submitting** — this is the only mode in which a direct UR approval is correct.
- **Default (Permit2) mode — NOT chosen:** `/check_approval` by default approves the **Permit2** contract, and the Router pulls funds via Permit2, which additionally requires a **`Permit2.approve(token, UniversalRouter, amount, expiration)`** call (a normal non-EIP712 contract call, separate from `ERC20.approve`). If you ever switch to this mode you need **both** `ERC20→Permit2` and `Permit2→UniversalRouter` allowances.

Do not mix the two; a hybrid (approve UR directly but let `/swap` route through Permit2) reverts on insufficient Permit2 allowance.

**Flow per non-`HOLD` action.**
1. **(prerequisite, off the hot path)** `POST /check_approval { walletAddress: vault, token, amount, chainId }` with `x-permit2-disabled: true` and the pinned `x-universal-router-version`. If it returns a non-null approval, the owner submits the returned approve tx **after confirming the spender is the Universal Router**.
2. `POST /quote { type: "EXACT_INPUT", amount, tokenIn, tokenOut, tokenInChainId, tokenOutChainId, swapper: vault, slippageTolerance, protocols: ["V2","V3","V4"] }`. **`swapper` must equal the vault address.** Response carries `routing` (assert `=== "CLASSIC"`), a `quote` object (input/output amounts, `gasUseEstimate`, `route`, `priceImpact`, the slippage-adjusted minimum-out, `quoteId`), and `permitData` (ignored, Permit2 disabled). **The minimum-out field name is not `minOut`** — it is the API's `minimumAmountOut`/`amountOutMin`-style field; **pin the exact field name + casing from a real captured response during the spike** and assert it is present and `> 0` before encoding. **Slippage units:** the request `slippageTolerance` is in **percent** (e.g. `0.5` = 50 bps); `Policy.maxSlippageBps` is **basis points** — reconcile (`0.5% → 50 bps`) so the on-chain ceiling matches the value sent.
3. **Build the Router calldata from `route` + agreed `minOut`** (see "Determinism" below). For the **MVP we may forward the API's opaque `/swap` `data`**, but the consensus-safe default is to take the **numeric** quote (route descriptor + `minimumAmountOut`) through consensus and **encode the Universal Router command deterministically** — this removes the "trust the API's calldata" assumption *and* makes the bytes consensus-stable. Pass an explicit `deadline` to `/swap` and **read back the exact value the API baked into the calldata, then pack THAT same deadline into the report** (two divergent deadlines = policy passes but on-chain revert, or vice-versa). If forwarding `/swap` output, **pass the entire quote response envelope** (`{ quote: quoteResponse }`, including `routing`/`permitData`), not just the inner `quote.quote`, and confirm the `/swap` response `from` == vault.
4. The workflow packs `{ to, data, value, minOut, deadline, tokenIn, tokenOut, amountIn, reportNonce, artifactHash }` (≤ **5 KB**). The **vault** runs the policy + calldata-shape checks (§4.1) and then forwards the call. **Native ETH:** `/swap` returns a `value` for native-input swaps; the vault must hold/forward ETH and `Policy.spendCapPerEpoch` must count `value`, not just ERC20 `amountIn`. **Gas:** check the API-returned `gasUseEstimate`/`gasLimit` against the **5,000,000 ChainWrite cap** before signing the report; a V4 multi-hop UR swap can exceed a simple swap, and exceeding the cap means the write fails.
5. **Confirm execution on-chain** via EVM Read of the swap event / vault balance delta. **There is no `GET /swaps` status endpoint** in the Trading API (the documented endpoints are POST `/quote`, `/swap`, `/check_approval`, `/swap_5792`, `/swap_7702`, and `/order(s)` for UniswapX); since the DON broadcasts the swap, confirmation comes from the chain, not the API.

**Determinism handling for time-varying quotes (the hard part — not yet proven, treat as open risk).** Quotes carry a `quoteId`, gas, and price that differ **per call and per second**. In a CRE DON each node executes the workflow independently; an HTTP/Confidential-HTTP call is generally made **per node** and the *responses* are reconciled by **Consensus** — there is **not** a single shared outbound call whose one body is fanned to all nodes. Two distinct `/quote` responses (different `quoteId`, gas, opaque `data`) **cannot be median-aggregated into one valid calldata blob**. The resolution:
- **Aggregate only the NUMERIC quote fields.** Run the fetch in **NODE mode** (`runtime.runInNodeMode(fn, aggregation)()`), and aggregate with `ConsensusAggregationByFields` over `route`-derived numerics + `minimumAmountOut` (e.g. **median** of `minimumAmountOut`, identical-required `route` descriptor), **never over `quoteId`/opaque `data`**. Then **build the Router calldata deterministically in-WASM** from the agreed `route` + `minOut`. This is the only path that is both deterministic and consensus-safe; it is also the §6 "trust-minimization" path, promoted to default for A4.
- **If `route` itself diverges across nodes**, consensus fails → no report → liveness loss (acceptable; retry next tick). The vault's `minOut`+`deadline`+`maxSlippageBps` remain the on-chain backstop.
- **Rate-limit interaction:** with N nodes each calling `/quote` (+ approval check), that is **N (or 2N) requests/tick against a 3 req/s key**, easily exceeded for N>3. **Confirm whether Confidential HTTP de-duplicates to a single gateway-side egress or fans out per node** (unverified — see §10); if it fans out, request a higher Uniswap rate limit or use a **designated-fetcher** Consensus mode (one node fetches, others attest) — and state plainly that the designated-fetcher mode weakens calldata trust toward **1-of-N**, with `minOut`+policy as the real bound.

Testnets the API lists: Ethereum Sepolia (11155111), Unichain Sepolia (1301), Base Sepolia (84532). **Testnet routing frequently returns "No quotes available"**, and end-to-end `/swap` *calldata generation* on these testnets is **unverified**. **Primary demo plan: a mainnet fork** (same Universal Router address/version, real liquidity); treat live-testnet `/swap` as best-effort, not the dependency.

---

## 7. CRE workflow skeleton

**Language reality:** the workflow host is **TypeScript** (no Rust workflow SDK exists). The *strategy* is the **Rust plugin** linked via `cre workflow custom-build` + `--cre-exports`. The skeleton below uses the **verified installed SDK surface** (from this repo's `chainlink-confidential-ai-attester-demo/.../main.ts` and `cre-templates/`): `Runner.newRunner`, `cre.handler`, `cre.capabilities.{CronCapability,EVMClient,HTTPClient}`, `runtime.getSecret(...).result()`, `runtime.runInNodeMode(fn, agg)()`, `consensus*Aggregation` / `ConsensusAggregationByFields`, `prepareReportRequest`, `runtime.report(...).result()`, `EVMClient.writeReport(runtime, { receiver, report, gasConfig:{gasLimit} }).result()`. Confidential HTTP (`ConfidentialHTTPClient`, capability `confidential-http@1.0.0-alpha`, with `vault_don_secrets` + `encrypt_output`) **exists in the SDK protos but is not demonstrated end-to-end in these templates** — the working secret pattern shown is `getSecret` + plain `HTTPClient`; **confirm Confidential HTTP runs in `cre workflow simulate` before relying on it** (the plain `getSecret` + `HTTPClient` path is the fallback).

```ts
// main.ts — host TS (QuickJS/Javy: no node:crypto/process; Buffer/atob/TextEncoder ARE shimmed; viem does ABI+hashing).
// Rust plugin global `on_tick` is registered via custom-build (--cre-exports ./strategy-plugin); see strategy-plugin.d.ts.
import {
  Runner, cre, getNetwork, type Runtime, type NodeRuntime, type CronPayload,
  HTTPClient, consensusMedianAggregation, ConsensusAggregationByFields, median,
  prepareReportRequest,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { z } from "zod";

const configSchema = z.object({
  schedule: z.string(), vault: z.string(), dataFeed: z.string(), registry: z.string(),
  chainSelectorName: z.string(), gasLimit: z.string(), tradeApi: z.string(), urVersion: z.string(),
});
type Config = z.infer<typeof configSchema>;

type QuoteNumerics = { minOut: bigint; routeId: string; deadline: bigint }; // numeric/identical fields ONLY

const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  const net = getNetwork({ chainFamily: "evm", chainSelectorName: runtime.config.chainSelectorName, isTestnet: true })!;
  const evm = new cre.capabilities.EVMClient(net.chainSelector.selector);

  // 1) FEATURES (deterministic oracles + on-chain state). Generated bindings read the vault/feed/registry.
  const obs = packObs(/* readVault(evm), readFeed(evm), readRegistry(evm) */); // Uint8Array, canonical layout

  // 2) STRATEGY (Rust plugin global; INT8; deterministic argmax)
  const action = on_tick(obs); // declared in strategy-plugin.d.ts
  if (isHold(action)) return JSON.stringify({ action: "HOLD" });

  // 3) QUOTE in NODE mode, consensus over NUMERIC fields only (never quoteId/opaque data)
  const apiKey = runtime.getSecret({ id: "UNISWAP_API_KEY" }).result();
  const q = runtime.runInNodeMode(
    (nodeRuntime: NodeRuntime<Config>): QuoteNumerics => {
      const http = new HTTPClient(); // (use ConfidentialHTTPClient once confirmed in simulate)
      const resp = http.sendRequest(nodeRuntime, {
        url: `${runtime.config.tradeApi}/quote`, method: "POST",
        headers: { "x-api-key": apiKey, "x-universal-router-version": runtime.config.urVersion },
        body: JSON.stringify({ type: "EXACT_INPUT", /* amount, tokenIn, tokenOut, chainIds, */
          swapper: runtime.config.vault, slippageTolerance: 0.5, protocols: ["V2","V3","V4"] }),
      }).result();
      const r = JSON.parse(new TextDecoder().decode(resp.body));
      if (r.routing !== "CLASSIC") throw new Error("non-CLASSIC route");
      return { minOut: BigInt(r.quote.minimumAmountOut /* PIN exact field from a real response */),
               routeId: routeDescriptor(r.quote.route), deadline: BigInt(r.quote.deadline) };
    },
    ConsensusAggregationByFields<QuoteNumerics>({ minOut: median, routeId: /*identical*/ undefined as any, deadline: median }),
  )().result();

  // 4) BUILD ROUTER CALLDATA DETERMINISTICALLY from agreed route+minOut (consensus-safe), then encode report (<=5 KB)
  const { to, data, value } = buildUniversalRouterCall(q.routeId, q.minOut, runtime.config); // in-WASM, deterministic
  const report = encodeAbiParameters(
    parseAbiParameters("address to, bytes data, uint256 value, uint256 minOut, uint64 deadline, bytes32 nonce, bytes32 artifactHash"),
    [to as `0x${string}`, data as `0x${string}`, value, q.minOut, q.deadline, nonceFor(obs), ARTIFACT_HASH],
  );

  // 5) SIGN + WRITE → KeystoneForwarder → vault.onReport(metadata, report)
  const signed = runtime.report(prepareReportRequest(report)).result();
  const reply = new cre.capabilities.EVMClient(net.chainSelector.selector)
    .writeReport(runtime, { receiver: runtime.config.vault as `0x${string}`, report: signed,
                            gasConfig: { gasLimit: runtime.config.gasLimit } }).result();
  return JSON.stringify({ action: "SWAP", txHash: reply.txHash ?? null });
};

export const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};
export async function main() { const r = await Runner.newRunner<Config>(); await r.run(initWorkflow); }
```

`Makefile` (generated by `custom-build`, then edited):
`CRE_SDK_JAVY_PLUGIN_HOME="$(JAVY_PLUGIN)" bun cre-compile --cre-exports ./strategy-plugin ./main.ts ./wasm/workflow.wasm` (Mode 2), or `--plugin ./strategy.plugin.wasm` (Mode 1, no Rust toolchain — ship the plugin as npm).

> **SDK / CLI version note (separate axes):** use the **installed** `@chainlink/cre-sdk` — the attester demo pins it and the `cre-templates/` here range `^1.1.2`–`^1.6.0`; the Rust-plugin tooling (`cre-compile`, `--cre-exports`, Javy plugin, `generate-host-crate`) ships in `@chainlink/cre-sdk-javy-plugin`; the **CRE CLI is a separate version** (the attester demo verifies with **v1.19.0**). Earlier drafts asserted a hard "SDK ≥ 1.6.0 required for Rust plugins" floor — that minimum is **unverified**; confirm the minimum `--cre-exports`-capable SDK version against the changelog before relying on it, and confirm every symbol above (especially `ConfidentialHTTPClient`, `ConsensusAggregationByFields` field semantics, and the plugin global binding) with `cre workflow simulate`.

---

## 8. Bounty mapping

| Bounty | Min to win | What satisfies it here |
|---|---|---|
| **Chainlink — primary (CRE & AI, or DeFi & Tokenization)** | A CRE workflow used as an orchestration layer integrating ≥1 blockchain with an external API/data/AI, **causing a real on-chain state change**; README linking all Chainlink files; 3–5 min video; successful `cre workflow simulate` **or** live deploy. | The workflow runs the strategy and writes a DON-signed report (via the forwarder) that drives `StrategyVault.onReport` → a real swap (the on-chain state change). **A4** makes the ML-on-DON story the headline; **A1** guarantees eligibility. |
| **Chainlink — multi-service bonus** | Use ≥2–3 Chainlink services meaningfully. | **CRE** (orchestration) + **Data Streams** (strategy input) + **secrets** (Uniswap key). Optional **ACE** (`PolicyProtected` vault) and **CCIP** (cross-chain rebalance) add 4th/5th — note these are **substantial integrations**, not bolt-ons; scope them as stretch. |
| **Chainlink — Privacy / Confidential Compute** (optional) | Confidential compute / attested inference verified on-chain. | **A5** Nitro-TEE inference + on-chain attestation gate; reuses the Confidential AI Attester. Also targets Oasis ROFL / Phala if present. |
| **Uniswap Foundation — v4 hooks** (secondary) | Ship a genuine **v4 hook** (not just routing through the Trading API); bonus for deploying on **Unichain**. | Add a **policy-enforcing v4 hook** that applies the vault's risk limits (slippage/size/cooldown) at swap time, gated on the DON-signed report. *Without a hook, Uniswap is integration color, not a target.* |
| **x402 / Coinbase agentic payments** (optional, additive) | Pay-per-call USDC gating an agent action. | A pay-per-run CRE trigger: caller pays USDC via HTTP 402, the workflow verifies the EIP-712 authorization, then runs the strategy. Maps to the strategy-marketplace deferral in the plan. |

**Honesty on 2026 specifics:** the **Convergence** hackathon structure and the recurring ETHGlobal Chainlink/Uniswap bounty *patterns* are confirmed, but the exact sponsor roster and prize sizes for the specific 2026 event are **not** confirmed by the research. **First action: open the live prizes page and confirm which of Chainlink / Uniswap / Coinbase-x402 / Oasis / Phala are actually sponsoring and their sizes before locking the build.**

---

## 9. MVP scope & milestones

**v1 (demoable in a hackathon) — A1 declarative spine.** Simplest approach that still clears every hard gate: a signed-config interpreter, one CRE TS workflow on the default auto-build, AMM Uniswap path, scoped vault as a CRE receiver. **The single most important early proof is: get ONE contract-vault swap executing end-to-end** (forwarder → `onReport` → Universal Router) on a mainnet fork (or testnet if `/swap` calldata is available there). That is the load-bearing unknown; prove it before anything else.

**Headline stretch — A4 ML policy** dropped into the *same* plugin slot (identical `on_tick`), winning the AI/CRE narrative. **Privacy stretch — A5** TEE path. **Bounty stretch — Uniswap v4 policy hook.**

**Ordered task list:**
1. **Confirm the live bounty page** (sponsors + prize sizes) and target track.
2. `StrategyVault` as a **CRE receiver**: `onReport(metadata, report) onlyForwarder`, constructor-injected forwarder address; `Policy` struct; decode + **all** policy/slippage/replay/expiry checks + **calldata-shape validation** (recipient==vault, input==amountIn of tokenIn) + unmodified Router forward. Deploy + one-time `ERC20.approve(UniversalRouter,…)` under `x-permit2-disabled:true` (verify spender). **Prove ONE swap end-to-end here.**
3. `StrategyRegistry`: `artifactHash` + `cid` + `kind`; wire `artifactHash` emission; plugin asserts loaded-weights hash == registry hash.
4. CRE TS workflow (default auto-build first): CRON → EVM Read features → quote (NODE mode, `protocols:["V2","V3","V4"]`, key via `getSecret`, `x-permit2-disabled:true`, pinned `x-universal-router-version`) → build calldata from route+minOut → report → `writeReport`. Verify with `cre workflow simulate`.
5. **A1 interpreter** (DCA / threshold-rebalance) — ship as a tiny Rust plugin OR inline TS first. **← demoable MVP.**
6. Add **Data Streams** + **secrets** explicitly for the multi-service bonus; assemble `obs` deterministically.
7. **Quote-consensus:** NODE-mode fetch + `ConsensusAggregationByFields` over numeric fields; enforce `minOut` + `deadline` + `maxSlippageBps` on-chain; reconcile slippage units.
8. **Confirm Confidential HTTP** runs in `cre workflow simulate`; if not, keep `getSecret` + `HTTPClient`.
9. Minimal UI: fund + setPolicy + register + watch (events, vault balance).
10. **Stretch A4:** retrain on oracle feature set → export recurrent-step weights → INT8 quantize + validate argmax → pure-Rust `on_tick` → `cre workflow custom-build` + `--cre-exports` → swap the plugin in. Content-hash weights → registry.
11. **Stretch:** Uniswap v4 policy hook (Unichain) and/or A5 TEE attestation path.
12. Record the 3–5 min video; README linking every Chainlink/Uniswap file.

---

## 10. Risks & open questions

**Load-bearing unknowns to resolve first:**
1. **Forwarder availability + replay semantics.** Confirm a **KeystoneForwarder is deployed on the exact chain you write to** (Sepolia mock `0x15fC…9F88` / prod `0xF834…4482`; per-chain addresses for Unichain/Base Sepolia are **unverified** — no forwarder on the chosen chain = no `writeReport`). Confirm whether `EVMClient.SUPPORTED_CHAIN_SELECTORS` / `getNetwork` actually support your target testnet for writes. Confirm whether the forwarder already provides **per-report idempotency** (if so, the vault nonce is redundant). *Resolve before writing the vault.*
2. **Exact SDK symbols** for `ConfidentialHTTPClient` (and whether the secret backend is the **Vault DON** product vs standard workflow secrets), the `ConsensusAggregationByFields` field semantics for a designated-fetcher mode, and the Rust-plugin global binding — confirm against the installed package and `cre workflow simulate`, not docs alone. The minimum `--cre-exports`-capable SDK version is **unverified**.
3. **Quote consensus is unproven.** N nodes diverge on `quoteId`/`data`; the design aggregates **numeric fields only** and **rebuilds calldata in-WASM**. Until validated in simulate, this is an **open risk, not a mitigation**. Fallback: designated-fetcher (weakens calldata trust to 1-of-N; `minOut`+policy still bound loss).
4. **Live Uniswap route/liquidity and `/swap` calldata on testnets** are unverified; **mainnet fork is the primary demo plan.**

**Determinism gotchas (A4):** INT8 integer-only inference is **mandatory** (not optional); build single-threaded, relaxed-SIMD OFF, **fp-contraction OFF**, **no `f32::mul_add`/std-SIMD madd**, fixed reduction order, **deterministic argmax tie-break (lowest index)**, finite activations, no libm transcendentals. Mamba selective-scan **will not** ONNX-export (use the recurrent step form). **Reproducible builds:** the Javy plugin's bit-canonical artifact comes from its **Docker build**; local host builds *can* differ in bytecode across OS/LLVM/rustc. Since the trust story content-hashes the WASM, pin `rust-toolchain.toml`, build the plugin in the canonical Docker image (`javy init-plugin` deterministic mode), and content-hash **both** the WASM and the weights blob. The backtest must use the same flags.

**Quote-consensus:** see #3 above. The on-chain `minOut`+`deadline`+`maxSlippageBps` are the real bound regardless.

**Rust SDK readiness:** there is **no Rust workflow SDK** — do not port the workflow to Rust; Rust is plugin-only. `custom-build` is a committed workflow change (docs say reversible; confirm). Prefer **Mode 1** (prebuilt `.plugin.wasm` as npm) so contributors don't need a Rust toolchain; Mode 2 needs stable Rust + `wasm32-wasip1` + Bun. The ML-export pipeline (retrain on oracle features + recurrent-step weights + INT8 quantization + argmax validation) is the real time sink and the chief A4 risk — **keep A1 as the always-working fallback.** *(Target is `wasm32-wasip1` everywhere; there is no `wasip2` in the toolchain — any `wasip2`/component-model note is forward-looking only, not the build target.)*

**Gas/latency & MEV:** per-tick DON round-trip + one quote round-trip suits rebalance/DCA cadence, **not** HFT; check API-returned `gasUseEstimate`/`gasLimit` against the **5,000,000** cap before signing; the **5-HTTP/run** quota and **3 req/s key** (× node fan-out) cap quotes per tick. The gap between off-chain `/quote` and on-chain `executeReport` spans **multiple blocks** (consensus + report write), so the quote can go **stale and the swap is sandwich/MEV-exposed**; set a **max staleness window** via `deadline` and a tight `maxSlippageBps`, and accept that a too-tight bound trades reverts (liveness) for safety. Reverts are bounded loss-of-gas, not loss-of-funds.

**Model gameability:** an adversary who sees the public weights (A4) can attempt to feed adversarial features or front-run. Mitigations: features come from oracles (Data Streams/Feeds), not attacker-controlled inputs; the vault's calldata-shape + `minOut` + policy checks bound any induced bad trade; if alpha secrecy is essential, switch to **A5** (weights never leave the TEE). Worst-case loss is *always* bounded by the §4 vault.

**Funding/ops:** the vault must hold gas/ETH for native-input swaps and `value` must be counted against the spend cap; the **infinite `ERC20.approve(UniversalRouter, max)`** is a standing drain surface if the Router/version is ever mis-pinned — prefer per-epoch finite approvals, and always pin `Policy.router` to the exact UR version address.

**Privacy vs consensus tension (the core tradeoff):** A4 is consensus-deterministic but its weights are public/reproducible (alpha auditable); A5 hides the alpha but collapses to single-machine hardware trust. Both sit behind the identical vault, so the choice is about *how little you must trust the runner*, not about how much you can lose — and on capital risk the two are equal because the vault custody is shared.
