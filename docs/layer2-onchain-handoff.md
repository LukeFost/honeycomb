# Honeycomb — Layer-2 on-chain ingestion: implementation handoff (agent)

> **The ask:** make **Layer 2** (the bounty market — escrow + enclave validation) flow through
> the *production* BigQuery refresh path **exactly like Layer 1 already does**, so that when the
> real contracts are deployed and `/api/refresh` runs periodically, BigQuery decodes the events,
> they land in the store, and they appear on the dashboard — with **no off-chain indexer in the
> production path**. Then make the **demo prove that same path** end-to-end, and verify it.
>
> **⚠️ NOTHING HERE IS SET IN STONE.** The design below is *one coherent way*, grounded in how
> Layer 1 works today. If you see a better data model, a cleaner ingestion mechanism, better
> event shapes, a better demo structure — **do that instead.** §3 spells out the few things that
> are actually firm vs. everything you're free to change. Prefer the better design over fidelity
> to this doc.

---

## 0. TL;DR

- **Today:** Layer 1 (identity + reputation → Directory) is fully live — `/api/refresh` decodes
  mainnet logs in BigQuery SQL → MERGEs into `honeycomb.{registrations,feedback}` → `agent_trust`
  view → dashboard. **This is the pattern to copy.**
- **The gap:** Layer 2 has **no production ingestion**. `/api/refresh` only does Layer 1. The
  dashboard's bounty market is served by `reputation.ts` from `honeycomb.{bounties,submissions,
  validations,settlements}`, but **nothing fills those tables in production** — in the *demo* they
  were filled by a **viem indexer** (`tools/chain-verify/src/marketIndexer.ts`), which is a demo
  fixture loader, not the BigQuery/refresh path.
- **The job:** add Layer-2 SQL decoders + MERGEs to `bq.ts`, wire them into `/api/refresh`, switch
  the demo to use that same SQL path (drop the viem decode), and prove it end-to-end.

---

## 1. Read first

| File | Why |
|---|---|
| `apps/web/src/lib/bq.ts` | **single source of truth** for addresses/topics/SQL. Has the Layer-1 `decode*Sql` / `merge*Sql` / `refresh*Sql` to mirror, the env-overridable `REGISTRIES` + `LOGS_TABLE`, and (already) `createMarketTablesSql` + `select*Sql` for Layer 2 |
| `apps/web/src/app/api/refresh/route.ts` | "the loop" — currently Layer-1 only. You'll add Layer-2 merges here |
| `apps/web/src/lib/reputation.ts` | Layer-2 **serving** — reads the market tables, builds the leaderboard. Already done; change it if you change the data model |
| `contracts/src/MockHoneycombEscrow.sol`, `MockErc8004.sol`, `MockValidationRegistry.sol` | the demo's mock events. Redesign freely (see §3) |
| `contracts/script/DeployAndSeed.s.sol` | the seed scenario (sybil ring, organic agent, self-dealer, cheater) |
| `tools/chain-verify/` | the demo harness: `demo.sh`, `indexer.ts` (raw logs), `marketIndexer.ts` (viem — **this is the shortcut to replace**), `materialize.ts`, `setup`/`teardown`, `sql.ts` (re-exports the real `bq.ts`) |
| git history (docs were cleared) | prior plans: `git show 59dfafe~1:docs/bigquery-dashboard-plan.md`, `…/onchain-verification-plan.md`, `…/bigquery-runbook.md`, `…/honeycomb-bigquery.sql` |

---

## 2. Current state — what works, what's missing

**Works (Layer 1, production, proven):** `/api/refresh` → `refreshRegistrationsSql` + `refreshFeedbackSql`
(decode from `LOGS_TABLE` `WHERE address=REGISTRIES.x.address AND topic0=…`) → idempotent MERGE on
`(tx_hash, log_index)` → `honeycomb.{registrations,feedback}` → `agent_trust` view → `snapshot.ts`
→ Directory. Live now: 2,216 registrations, 105 scored agents.

**Missing (Layer 2):** there is **no** `decodeBountiesSql`/`mergeBountiesSql`/… and `/api/refresh`
never touches the market tables. `honeycomb.{bounties,submissions,validations,settlements}` exist
(empty) and `reputation.ts` reads them, but production has no path to fill them. The demo filled
them out-of-band with `marketIndexer.ts` (viem `parseEventLogs`), so the demo's bounty market did
**not** exercise the production ingestion path. That's the gap to close.

**Key enabler already in place:** `LOGS_TABLE` (env `BQ_LOGS_TABLE`) and `REGISTRIES` /
`VALIDATION_REGISTRY` addresses+topics are **env-overridable**, defaulting to real EF mainnet. The
demo points them at mock contracts + a fixture logs table; production uses the defaults. This
mainnet↔fixture swap is **already proven for Layer 1** — reuse it for Layer 2.

---

## 3. Firm constraints vs. open to redesign

**Firm (don't break these):**
1. **BigQuery stays the core.** Layer-2 *production* ingestion must be BigQuery-native (decode in
   the warehouse), not an always-on RPC/viem indexer. (You may use a one-shot indexer to *capture*
   real bytes for tests — see §6 — but not as the production path.) If you believe a different
   BigQuery-native mechanism beats "SQL decode in `/api/refresh`" (e.g. a scheduled query, an
   external/temp table, a stored proc), that's fair game — justify it.
2. **Don't regress Layer 1 or production.** Default config (no `BQ_*` overrides) must keep
   targeting real EF mainnet + the `honeycomb` dataset exactly as today.
3. **Dashboard reads only on-chain data — no stubs.** (The seed CSVs are gone; keep it that way.)
4. **The demo must prove the *production* path** (raw events → BigQuery SQL decode → refresh →
   tables → dashboard), starting empty and populating on seed. A demo that only proves a shortcut
   isn't done.
5. **Commits: no Claude / Co-Authored-By trailer** (repo convention). Branch `feat/bigquery-dashboard`.

**Open — change anything here if it's better (this is the point of the handoff):**
- **The Layer-2 data model.** Table schemas, normalization, how a *validation* links to a *bounty*
  and an *agent*, whether "open vs settled" is derived or stored, what columns the leaderboard
  needs. The current 4-table shape is a starting point, not a requirement.
- **The contract event shapes.** We control the Honeycomb escrow, so design its events to be
  whatever makes ingestion clean + correct (see §5 on the multi-string-decode trap). The mock
  contracts should mirror whatever the real ones will emit.
- **`reputation.ts` / the earned-reputation formula** and what the dashboard shows.
- **The demo + harness structure** (`demo.sh`, the scripts, the indexers).
- **How the committed schema is produced** — ideally *generate* it from `bq.ts` rather than
  hand-maintaining it (the old hand-synced `docs/honeycomb-bigquery.sql` drifted; a `gen:sql`
  script that emits it from the SSOT is a good improvement to fold in).
- Even Layer-1 details, *if* you find a clear win — but it works today, so change it only with
  reason and re-verify.

When in doubt, optimize for: **correct, BigQuery-native, demonstrably-proven, simple.**

---

## 4. Recommended approach (a starting point — mirror Layer 1)

1. **Decoders** — add `decodeBountiesSql / decodeSubmissionsSql / decodeValidationsSql /
   decodeSettlementsSql` to `bq.ts`, each reading `LOGS_TABLE WHERE address=<escrow/validator>
   AND topics[0]=<event topic0>` and decoding fields with the offset math in §7. Append the
   incremental watermark predicate like Layer 1 (`AND block_timestamp >= TIMESTAMP('%s')`).
2. **MERGEs** — `mergeBountiesSql` etc., idempotent on `(tx_hash, log_index)`, mirroring
   `mergeRegistrationsSql`. Add `refreshBountiesSql(wmIso)` … wrappers like the Layer-1 ones.
3. **Wire into the loop** — in `apps/web/src/app/api/refresh/route.ts`, run the 4 Layer-2 merges
   alongside the 2 Layer-1 merges (each as its own direct job with `maximumBytesBilled`, per the
   existing cost note). Record counts in the refresh-log response.
4. **Demo swap** — in `tools/chain-verify`, stop using `marketIndexer.ts` (viem decode). Instead
   index the escrow's **raw logs** into the fixture logs table (the existing `indexer.ts` already
   does this for any address — `demo.sh seed` already calls it for the escrow), and let
   `/api/refresh` (or `materialize.ts`, but prefer hitting the real route) SQL-decode them into the
   market tables. Now the demo runs the identical production code path.
5. **Schema** — extend `createMarketTablesSql` if the model changes; regenerate the committed
   DDL from `bq.ts` (see §3, the generator idea). Ensure the tables exist in `honeycomb` (there's
   already `scripts/create-market-tables.ts`).

Keep `reputation.ts` working against whatever schema you land on.

---

## 5. The hard parts / decisions to make

- **Multi-dynamic-string SQL decode is the real difficulty.** Decoding one trailing `string` in
  BigQuery is fine (`decodeRegisteredSql` does it for `agent_uri`). Decoding an event with *two*
  strings (the mock `BountyCreated(…, string category, string title, …)`) means reading two offset
  pointers and slicing two length-prefixed blobs — fiddly and error-prone. **Strong recommendation:
  design the escrow events to be SQL-friendly** — fixed-width fields + at most one trailing
  `string`. e.g. make `category` a small enum/`bytes32`, keep `title` as the single trailing
  string, or move human text to off-chain metadata (resolved later, like agent names). You control
  this contract — use that freedom.
- **For events you don't control** (EF `ValidationResponse(address,uint256,bytes32,uint8,string,
  bytes32,string)` — two strings), you usually only need the *fixed* fields (response, agentId,
  validator). Those sit at deterministic head offsets and decode **without touching the strings**.
- **The bounty↔validation link is a modeling decision, not just decode.** The EF
  `ValidationResponse` carries `agentId` + `response` but **no `bounty_id` and no "valid" flag**,
  which the leaderboard needs. Decide how a verdict ties to a bounty: most likely your escrow emits
  its own bounty-linked validation event (the mock's `ValidationRecorded(bountyId, agentId,
  validator, response, valid, responseHash)` is a reasonable shape), rather than relying on the
  bare EF event. Settle this when you design the real contracts; mirror it in the mock.
- **Match real ABIs.** When the real contracts exist, the decoders + the configured
  `topic0`/address must match the *actual* event definitions. Verify every topic0 with
  `cast keccak "Event(types…)"` (the `NewFeedback` layout was non-obvious — don't assume). §7 has
  the values verified so far.

---

## 6. How to be SURE (verification)

1. **Make the mock events match the real ABIs.** For EF validation, emit the exact
   `ValidationResponse` signature (topic0 `0xafddf629…`, already verified). For the Honeycomb
   escrow, the mock and the real contract should share one ABI. Then the demo decodes them with the
   **same SQL production runs on mainnet**.
2. **Demo proves the loop:** `./demo.sh up` (empty) → `./demo.sh seed` → the seed should
   deploy + emit → index **raw logs** → **POST the real `/api/refresh`** → assert the market tables
   + the dashboard match the known scenario (golden values: organic agent #11 leads; self-dealer #3
   ≈ 0 despite a 97 enclave score; cheater #7 flagged; sybil ring flagged in the Directory). If it
   populates via the real loop, production will too — the only difference is the source table
   (fixture vs mainnet), already proven to swap cleanly via `LOGS_TABLE`.
3. **`forge test`** asserts each event's topic0 + data layout match the decoders (extend the
   existing tests in `contracts/test/`; they use an inline `Vm` interface, no forge-std).
4. **Real-bytes check** (when contracts are live): capture a real mainnet log for each event
   (`cast receipt <tx> --rpc-url <mainnet>`, or one tight-window BigQuery `SELECT`), run the
   decoder over those exact bytes, and assert. This is the only thing the demo can't prove (that
   real on-chain bytes match the assumed layout) — close it here.
5. **Don't regress:** `forge test`, `apps/web` + harness `tsc`, `eslint`, and a prod-mode smoke
   (default env → `/api/agents` ~105, `/api/market` 200, homepage 200) must all stay green.

**Definition of done:** with the real (or mock) contracts emitting events, a periodic
`/api/refresh` decodes them in BigQuery, fills `honeycomb.{bounties,…}`, and the dashboard's bounty
market populates — proven by the demo running that exact path empty→populated, with golden
assertions and green tests. No off-chain indexer in the production path. No stubbed data.

---

## 7. Appendix — verified facts & building blocks

**Tooling (already set up):** Foundry (`forge`/`anvil`/`cast`, solc 0.8.27 cached, offline). **No
`bq`/`gcloud` CLI** — all BigQuery via the `@google-cloud/bigquery` SDK + the key at
`honeycomb/.secrets/gcp-key.json` (auto-discovered by walking up). Harness installs with
`pnpm install --ignore-workspace`; run scripts via `pnpm exec tsx …`. Demo: `./demo.sh {up|seed|down|reset}`.

**Verified event signatures / topic0s (via `cast keccak`):**
| Event | topic0 | Notes |
|---|---|---|
| `Registered(uint256,string,address)` | `0xca52e62c…449bc4a` | EF identity **and** mock; URI is the middle (sole non-indexed) param |
| `NewFeedback` (real EF) | `0x6a4a6174…5e58febc` | layout non-obvious: `value` at 2nd data word, `decimals` at 3rd; a field precedes `value` |
| `NewFeedback(uint256,address,bytes32,uint256,uint8)` (mock) | `0x464064d0…dc78be894` | designed so the real `decodeFeedbackSql` reads value@word2, decimals@word3 |
| `ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)` | `0xafddf629…326349ae` | EF Validation Registry; verified |
| `ValidationRequest(address,uint256,string,bytes32)` | `0x530436c3…0a48a5059` | verified |
| `ValidationRecorded(uint256,uint256,address,uint8,bool,bytes32)` (mock escrow) | `0x4c9b4b2b…7a60fd43` | bounty-linked verdict |
| `BountyCreated(uint256,address,string,string,uint256,uint64)` (mock) | `0xb8b9b2f4…53170771` | **two strings** — see §5 |
| `SubmissionMade(uint256,uint256,string)` (mock) | `0xfbc293ba…5002b22d` | one string |
| `BountySettled(uint256,uint256,uint32,bytes32)` (mock) | `0xb6f53784…e5782d40` | all fixed |

**Addresses:** EF identity `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432`, EF reputation
`0x8004baa17c55a88189ae136b182e5fda19de9b63`. Deterministic fresh-anvil deploys (acct0 nonce 0/1):
`MockErc8004` `0x5FbDB2315678afecb367f032d93F642f64180aa3`, `MockHoneycombEscrow`
`0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`. Anvil dev key #0:
`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`.

**BigQuery decode offset math** (the public `logs` schema: `topics ARRAY<STRING>`, `data` STRING,
both `0x`-prefixed lowercase hex; `SUBSTR` is 1-indexed):
- indexed `uint256`: `SAFE_CAST(topics[SAFE_OFFSET(n)] AS INT64)`.
- indexed `address`: `CONCAT('0x', SUBSTR(topics[SAFE_OFFSET(n)], 27))` (last 40 hex chars).
- non-indexed `data` word *k* (0-indexed): `SUBSTR(data, 3 + k*64, 64)` → `0x`-prefix → cast.
  (word0 = chars 3–66, word1 = 67–130, word2 = 131–194, …). uint: `SAFE_CAST(CONCAT('0x',…) AS INT64)`;
  `uint8`/`bool` live in their own 32-byte word (right-aligned).
- single trailing dynamic `string`: head word = byte offset → length word at that offset →
  bytes follow. See `decodeRegisteredSql` for the one-string pattern
  (`SUBSTR(data, 131, 2 * SAFE_CAST(CONCAT('0x', SUBSTR(data,67,64)) AS INT64))` then
  `FROM_HEX` + `SAFE_CONVERT_BYTES_TO_STRING`). Two strings = two offset words; compute each.
- drop two's-complement negatives like `decodeFeedbackSql` does (`SUBSTR(data, <word>, 1) != 'f'`)
  if a signed value is possible.

**Cost discipline (firm):** never re-scan the raw mainnet logs per request or on a tight loop. The
public table is partitioned by month, clustered on `block_timestamp` only (address filters do NOT
reduce bytes). Incremental MERGE from the watermark + `maximumBytesBilled` cap per job (see
`route.ts`); `dryRun` first. The demo's fixture table is tiny, so demo runs are ~free.

**`reputation.ts` scoring (current, change if you change the model):**
`honeycombScore = clamp(avgEnclaveScore × validAttestationRate × (1 − 0.9·selfDealtShare) ×
demandMultiplier(independentRequesters))`; effective = earned, else cold-start (global trust × 0.5),
else 0. Self-dealing = bounty.requester == agent.owner. The committed demo scenario is the golden
fixture to assert against.
