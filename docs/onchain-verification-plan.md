# Honeycomb — On-Chain Read Verification: Implementation Plan (agent handoff)

> **Goal of this work:** prove that the service reads **on-chain ERC-8004 data correctly** —
> end to end, against bytes we control — instead of trusting a hand-frozen CSV snapshot. We do
> this by feeding the **real BigQuery decode + scoring + serve path** from a small **fixture
> logs table**, sourced either from captured real mainnet logs or from a **minimal smart
> contract** we deploy locally. No production behavior changes; default config is untouched.

This doc is a **testing/verification companion** to `docs/bigquery-dashboard-plan.md`. It does not
alter the pipeline that doc describes — it adds a way to *assert* that pipeline is correct.

---

## 0. TL;DR

- The only window onto the chain in production is `bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs`
  — **mainnet only.** A contract deployed to Anvil/Sepolia will never appear in it. So we don't
  "watch a test contract flow through BigQuery"; we **bridge a chain we control into a small
  fixture table** shaped like the public one, and point the real decode SQL at it.
- One tiny enabler unlocks everything: make the **source logs table configurable**
  (`BQ_LOGS_TABLE`, defaulting to the real public table), mirroring how `BQ_DATASET` already
  overrides the derived dataset. Default (unset) = identical production behavior.
- With that, setting `BQ_LOGS_TABLE=…test.logs` + `BQ_DATASET=honeycomb_test` runs the **entire
  real SQL pipeline** (`decode* → merge* → agent_trust view → serving read`) over fixtures we
  define, so we can assert exact decoded fields, trust scores, and flags.
- A **minimal smart contract** is the right tool specifically for the **Validation Registry**
  (no EF deployment exists — we own it; event signatures are already pinned *and verified*) and
  as a prototype for **Layer-2 escrow**. For Layer-1 (identity/reputation) we use **real captured
  bytes**, not a mock, because the real event layouts are non-obvious (see §4).

---

## 1. Read these first

| File | Why |
|---|---|
| `docs/bigquery-dashboard-plan.md` | the pipeline this verifies; its constraints bind here too |
| `apps/web/src/lib/bq.ts` | **single source of truth** for addresses/topics/SQL. The enabler in §6 edits this file only; the decode/score/serve builders we exercise all live here |
| `apps/web/src/app/api/bigquery/route.ts` | BigQuery client setup + service-account key discovery — reuse it for the test runner |
| `apps/web/src/lib/snapshot.ts` | the `TrustAgent` shape the serving read must reproduce — the assertion target |
| `analysis/erc8004_trust.csv` | reference values to assert against for the real-bytes Layer-1 test |

---

## 2. The one structural fact that shapes everything

BigQuery's public dataset (`DATASET`, `bq.ts:7`) covers **Ethereum mainnet only**. There is no
maintained public BigQuery dataset for Sepolia/Holesky, and certainly none for a local Anvil
chain. Consequences:

- "Deploy a contract and assert the dashboard shows it via BigQuery" only works on **mainnet**
  (real gas, hours of ingest lag, and the EF registries already exist there — nothing to prove).
- Therefore we **decouple the source table**. The decode SQL is a pure function of log bytes; it
  doesn't care whether those bytes came from the public table or a fixture we filled. We make the
  source table a config value and feed it fixtures.

This splits "test the pipeline" into three separable claims, each with its own harness.

---

## 3. Three claims, three harnesses

| # | Claim to assert | Source of truth | Mock contract? |
|---|---|---|---|
| 1 | Decode SQL turns **real** ERC-8004 bytes into the right fields | **Real captured mainnet logs** in a fixture table | No — use real bytes |
| 2 | Trust/sybil **scoring** is correct for designed scenarios | **Synthetic** registration/feedback fixtures | No (optional) |
| 3 | The service reads what's actually on a **live chain we control** | **Minimal contract on Anvil** → indexer → fixture table | **Yes** — for Validation / Layer-2 |

Because every `bq.ts` builder is parameterized by dataset (`ds`) and (after §6) source table,
Claims 1 + 2 collapse into one mechanism: **load fixture rows → run the real
`decode* → merge* → agent_trust → serving read` in an isolated `honeycomb_test` dataset → assert
the output.** That single mechanism already exercises ~the entire production SQL path. Claim 3
adds a live chain in front of it.

---

## 4. What's already verified (don't re-derive)

- **Foundry is installed** (`cast`, `forge`, `anvil` on PATH). No tooling setup needed.
- **Event signatures** (computed with `cast keccak`, matched against the topic0 constants in `bq.ts`):

  | Event | Canonical signature | topic0 | Status |
  |---|---|---|---|
  | Identity `Registered` | `Registered(uint256,string,address)` | `0xca52e62c…` | ✅ confirmed |
  | Validation `ValidationResponse` | `ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)` | `0xafddf629…` | ✅ confirmed |
  | Validation `ValidationRequest` | `ValidationRequest(address,uint256,string,bytes32)` | `0x530436c3…` | ✅ confirmed |
  | Reputation `NewFeedback` | *non-obvious* (naive `(uint256,address,uint256,uint8)` → `0xd2e2…`, **wrong**) | `0x6a4a6174…` | ⚠️ recover from spec |

  **Gotcha:** `Registered`'s URI string is the **middle** param, not last — the obvious ordering
  produces a different topic0. `NewFeedback` did not fall out of 250+ candidate signatures; its
  `data` has one 32-byte word **before** `value` (decode reads `value` at the 2nd data word,
  `value_decimals` at the 3rd — `bq.ts:146-147`). **Do not hand-roll a Layer-1 mock from the
  comments** — the byte layout will be subtly wrong. Use real captured bytes (Claim 1), or recover
  the exact `NewFeedback` signature from the ERC-8004 spec/ABI and verify it with `cast keccak`
  before relying on it.

---

## 5. Hard constraints

Inherits everything in `docs/bigquery-dashboard-plan.md §3`, plus:

1. **The test indexer is a fixture loader, NOT a production path.** Sponsor constraint §3 forbids
   replacing the Layer-1 BigQuery-over-public-dataset path with an RPC indexer. The indexer here
   exists only to populate `honeycomb_test.logs`. Production Layer-1 still reads mainnet via BigQuery.
2. **Default config must be byte-for-byte unchanged.** With `BQ_LOGS_TABLE` unset, every query
   targets the real mainnet public table exactly as today. The live-provenance panel must still
   prove real mainnet liveness in the demo (never set `BQ_LOGS_TABLE` in prod).
3. **`bq.ts` stays the single source of truth.** The only production-file edit in this whole plan
   is the §6 enabler in `bq.ts`. Everything else is new test-only files.
4. **No mainnet writes.** We never deploy to or transact on mainnet. All owned contracts go to Anvil.
5. Commits: no Claude/Co-Authored-By attribution (repo convention).

---

## 6. The single enabler (the only production-file change)

Make the **source logs table** overridable, mirroring `HONEYCOMB_DATASET`/`BQ_DATASET` (`bq.ts:116`):

```ts
/** Source logs table. Defaults to the real mainnet public table; override with BQ_LOGS_TABLE
 *  to point the decode/count SQL at a fixture table for verification. Guarded like
 *  HONEYCOMB_DATASET so the client bundle always renders the canonical mainnet table. */
export const LOGS_TABLE =
  (typeof process !== "undefined" ? process.env.BQ_LOGS_TABLE : undefined) || DATASET;
```

Then point the three builders that currently hardcode `` `${DATASET}` `` at `LOGS_TABLE`:
`countSql` (`bq.ts:72`), `decodeRegisteredSql` (`bq.ts:134`), `decodeFeedbackSql` (`bq.ts:152`).
Keep `DATASET` exported as the canonical mainnet constant (labels/display).

**Why this is safe:** unset → `LOGS_TABLE === DATASET` → no behavior change. On the client
(`process` undefined) it always falls back to `DATASET`, so the rendered SQL in `LiveQueryPanel`
always shows the real mainnet table. Only server-side execution with the env var set is redirected.

**Acceptance:** `tsc`/`eslint` clean; with `BQ_LOGS_TABLE` unset, `/api/bigquery` dry-run reports
the same scan bytes against the mainnet table as before.

---

## 7. Phases

### Phase 0 — Enabler + isolated test dataset
1. Apply the §6 `LOGS_TABLE` change.
2. Create an isolated dataset `honeycomb_test` (same region/project as the real `honeycomb`).
3. Create `honeycomb_test.logs` with the public-table subset the decode reads (§10.2).

**Acceptance:** `honeycomb_test.logs` exists; default (unset) queries still hit mainnet.

### Phase 1 — Layer-1 fixture E2E with **real** bytes (Claims 1 + 2, real path)
1. Capture a handful of real mainnet `Registered` + `NewFeedback` logs (§10.3) into
   `honeycomb_test.logs` — include the known organic agent (Surf AI `#34135`) and a sybil-ring
   client so the directory has signal.
2. With `BQ_LOGS_TABLE=honeycomb_test.logs` and `BQ_DATASET=honeycomb_test`, run the real builders
   in order: `createTablesSql` → `refreshRegistrationsSql(WINDOW.start)` → `refreshFeedbackSql(WINDOW.start)`
   → `agentTrustViewSql` → `agentTrustSelectSql` (drive them from a small script, §10.5 — does not
   require the `/api/refresh` route from the main plan to exist yet).
3. Assert: decoded `agent_id`/`owner`/`agent_uri`/`score` match the source events (cross-checked on
   Etherscan), and the served directory's headline metrics match `analysis/erc8004_trust.csv`
   order-independently by `agent_id` (small numeric drift OK).

**Acceptance:** the real decode→score→serve path, run over real captured on-chain bytes in an
isolated dataset, reproduces the committed snapshot's headline rows.

### Phase 2 — Scoring scenarios with synthetic fixtures (Claim 2, edge cases)
1. Append hand-crafted rows to `honeycomb_test.logs` encoding scenarios the sparse real data may
   not cover: a ring wallet reviewing ≥10 distinct agents (`ring-only reviewers`), an agent with
   ≥5 independent clients (`broad independent client base`/`organic`), a self-feedback case
   (`owner` among its own clients), an agent with `<3` independent clients (`thin`).
2. Re-run the view; assert `trust_mult`, `trust_score`, `flags`, and `snapshot.ts` `category`
   match the §10.3 spec for each designed scenario.

**Acceptance:** each scenario produces the exact multiplier/flags the algorithm prescribes.

### Phase 3 — Live-chain E2E with a contract we own (Claim 3) — **the "minimal smart contract"**
Target the **Validation Registry** first: EF hasn't deployed it, so we own the address
(`BQ_VALIDATION_REGISTRY`, `bq.ts:38`) and the event signatures are pinned + verified (§4).
1. Write a minimal `MockValidationRegistry.sol` emitting `ValidationResponse(...)` with the exact
   verified signature (§10.4). `forge create` it on a local `anvil`; `cast send` a few verdicts.
2. Run the tiny indexer (§10.4) to copy Anvil's logs into `honeycomb_test.logs` (public-table shape).
3. Set `BQ_LOGS_TABLE=honeycomb_test.logs` and `BQ_VALIDATION_REGISTRY=<mock address>`; call the
   live route's validation count path (`liveQueries` now includes it) and assert the count equals
   the number of verdicts emitted.

**Acceptance:** a contract we deployed → indexed → BigQuery → the service's count reflects exactly
what we emitted on the (local) chain. This is the literal "service reads on-chain data correctly"
proof, against a chain we fully control.

### Phase 4 — (Optional) Layer-2 escrow prototype + CI
- **Layer-2 escrow mock** (larger): a minimal escrow emitting `BountyCreated`/`SubmissionMade`/
  `Settled`, indexed the same way. Requires **new Layer-2 decode SQL** (doesn't exist yet — this
  is the future "Layer-2 goes live" work from the main plan), so treat it as a prototype, not a
  same-PR deliverable.
- **CI:** Phases 1–3 hit a real BigQuery test dataset (there is no viable local BQ emulator — see
  §8). Either gate them behind a `pnpm test:chain` local script using the repo SA key, or run them
  in CI with the key as a secret against the disposable `honeycomb_test` dataset (cost ≈ free; the
  fixture tables are KB).

---

## 8. Open decisions (recommended defaults)

| Decision | Recommended default | Notes |
|---|---|---|
| Test runner | **`tsx` script** or **vitest** | repo has no runner yet; a plain script importing `bq.ts` builders + the route's BQ client is lowest-friction |
| Fixture load mechanism | **`INSERT … VALUES` with literal arrays** for a few rows; client `table.insert()` for indexer batches | avoids file plumbing for golden rows (§10.5) |
| Real-bytes capture | **`cast receipt` over a public RPC** (zero BQ cost) | alternative: one pinned-window BQ `SELECT` — dry-run first (§10.3) |
| Local chain | **Anvil** | already installed; instant, free, deterministic dev keys |
| Layer-1 mock contract | **avoid** — use real bytes | `NewFeedback` layout is non-obvious (§4); a mock risks silently-wrong bytes |
| CI hermeticity | **integration tests hit real BQ test dataset** | no local BQ emulator exists; isolate in `honeycomb_test`, keep fixtures tiny |

---

## 9. Non-goals

- Deploying to mainnet, or replacing the production Layer-1 BigQuery path (sponsor §3).
- Building the real validator/TEE enclave — the mock only emits the event *shape*.
- Making Layer-2 bounties live — escrow mock is an optional prototype, not this deliverable.
- A local BigQuery emulator — none is viable; tests use a disposable real test dataset.

---

## 10. Appendix — building blocks

### 10.1 Verify any event signature
```bash
cast keccak "Registered(uint256,string,address)"   # => 0xca52e62c…  (matches bq.ts)
# Recover NewFeedback: iterate candidate signatures from the ERC-8004 ABI/spec until the
# output equals 0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc
```

### 10.2 Fixture logs table (subset of the public schema the decode reads)
```sql
CREATE TABLE IF NOT EXISTS `honeycomb_test.logs` (
  address          STRING,
  topics           ARRAY<STRING>,   -- [topic0, topic1=agentId, topic2=owner/client]
  data             STRING,          -- 0x-prefixed lowercase hex
  block_timestamp  TIMESTAMP,
  block_number     INT64,
  transaction_hash STRING,
  log_index        INT64
);
```
Bytes **must** match the public format: `address`/`data`/`topics` lowercase, `0x`-prefixed, or the
`SUBSTR` offsets in the decode break.

### 10.3 Capture real mainnet bytes (zero BigQuery cost)
```bash
# 1. Find a real event tx (Etherscan on the registry address, or one pinned-window BQ SELECT
#    of transaction_hash+log_index — dry-run first; pin block_timestamp tightly so clustering
#    prunes the scan to ~MB).
# 2. Pull the raw log with cast over a public mainnet RPC:
cast receipt <TX_HASH> --rpc-url "$ETH_RPC_URL"   # prints logs: address, topics[], data
# 3. INSERT the (address, topics, data, …) verbatim into honeycomb_test.logs.
```

### 10.4 Mock Validation Registry + Anvil + indexer (Claim 3)
```solidity
// MockValidationRegistry.sol — types must match the verified signature exactly (names don't matter)
contract MockValidationRegistry {
  event ValidationResponse(
    address validator, uint256 agentId, bytes32 dataHash,
    uint8 response, string uri, bytes32 tag, string extra
  );
  function emitResponse(
    address v, uint256 a, bytes32 d, uint8 r, string calldata u, bytes32 t, string calldata e
  ) external { emit ValidationResponse(v, a, d, r, u, t, e); }
}
```
```bash
anvil &                                                            # local chain + dev keys
forge create MockValidationRegistry --rpc-url http://127.0.0.1:8545 \
  --private-key <anvil-dev-key-0> --broadcast
cast send <ADDR> "emitResponse(address,uint256,bytes32,uint8,string,bytes32,string)" \
  <v> <a> <d> <r> "<u>" <t> "<e>" --rpc-url http://127.0.0.1:8545 --private-key <anvil-dev-key-0>
```
```ts
// indexer.ts — copy Anvil logs into the fixture table (≈20 lines). NOT a production path.
import { createPublicClient, http } from "viem";
import { BigQuery } from "@google-cloud/bigquery";
const chain = createPublicClient({ transport: http("http://127.0.0.1:8545") });
const logs = await chain.getLogs({ address: MOCK_ADDR, fromBlock: 0n, toBlock: "latest" });
const rows = await Promise.all(logs.map(async (l) => {
  const block = await chain.getBlock({ blockNumber: l.blockNumber });
  return {
    address: l.address.toLowerCase(),
    topics: l.topics,                                   // 0x-prefixed lowercase already
    data: l.data,
    block_timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
    block_number: Number(l.blockNumber),
    transaction_hash: l.transactionHash,
    log_index: l.logIndex,
  };
}));
await new BigQuery({ keyFilename: KEY }).dataset("honeycomb_test").table("logs").insert(rows);
```

### 10.5 Run the Layer-1 E2E (Phase 1) without depending on app routes
```ts
// test:chain — import the real builders; reuse route.ts's BigQuery client + key discovery.
process.env.BQ_LOGS_TABLE = "honeycomb_test.logs";
process.env.BQ_DATASET = "honeycomb_test";
const { createTablesSql, refreshRegistrationsSql, refreshFeedbackSql,
        agentTrustViewSql, agentTrustSelectSql, WINDOW } = await import("@/lib/bq");
// run, in order: createTablesSql() → refreshRegistrationsSql(WINDOW.start)
//   → refreshFeedbackSql(WINDOW.start) → agentTrustViewSql() → agentTrustSelectSql()
// then assert served rows vs analysis/erc8004_trust.csv (by agent_id) and the §10.3 flags.
```
Each builder takes the dataset as its `ds` arg / via `BQ_DATASET`; the decode reads `BQ_LOGS_TABLE`.
The whole real SQL pipeline thus runs in `honeycomb_test`, isolated from production data.
</content>
</invoke>
