# HANDOFF — demeter-backed LP backtest scorer (Luke's lane)

Branch: `luke/loving-kare-ee259d`. Lane: grader / LP scorer. Written for a reader
with zero memory of the session. Read §0 FIRST — there is a parallel implementation.

---

## 0. THE BIG FORK — read before touching anything

There are now TWO LP grading implementations in this directory. They were built
independently, in parallel, and BOTH are present after the merge:

| | THIS lane (mine) | origin/main (a teammate's, commit `9b3fda2`) |
|---|---|---|
| Scorer file | `scorer.py` (OVERWRITES the directional grader in place) | `lp_scorer.py` (NEW file; directional `scorer.py` left untouched) |
| Worker | `worker.py` | `lp_worker.py` + `lp_engine.py` |
| Private data | real BigQuery WETH/USDC 0.05%, Jun 3-4 2025, 1-min bars | `pool_private.csv` (synthetic, 72 bars, dated 2024-01-01) |
| Bounty dir | reuses `uniswap-lp-trading-bot` | new `uniswap-lp-range-bot` |
| Trust model | action-verbs over the wire; scorer REPLAYS verbs into the market | worker computes net_value, scorer RE-RUNS and agreement-checks |
| grade.ts | (my repoint was stashed + abandoned) | `BOUNTY=lp` env switch selects lp_scorer.py; this is canonical |

**Do not assume mine is canonical.** origin/main's `BOUNTY=lp` path is already wired
into grade.ts and the CRE callback contract. My memory note `grader-lp-e2e-green`
documents THEIR path as green. A human needs to pick one (or merge the best of both)
before collapse. See §5 for the exact overlap points.

The two do not collide on disk (different filenames) EXCEPT that mine overwrites the
directional `scorer.py`/`worker.py`. If both LP paths are kept, my overwrite of the
directional grader must be reverted or re-homed to `lp_scorer.py`-style new files.

---

## 1. What this lane built (the four delegated subtasks)

A drop-in replacement for the toy-PnL `scorer.py`. Same spine contract:
- prints ONE int 0..10000 to stdout (logs to stderr),
- the digest `sha256(bountyId|submissionHash|privateSeriesHash|score)` is unchanged,
- enclave signing and the CRE callback shape are NOT touched by the scorer.

Pieces:
1. **DATA** — `fetch_data.py` pulls WETH/USDC 0.05% (`0x88e6a0c2…f5640`) mainnet
   from BigQuery via demeter-fetch into demeter `load_data` CSV format. Split:
   `data/public/` = Jun 1-2 (sample, committed), `data/private/` = Jun 3-4 (held-out,
   GITIGNORED), `data/_unused/` = Jun 5 (discarded, gitignored — see §3).
2. **SUBMISSION INTERFACE** — submission exposes `on_bar(snapshot) -> action`.
   `snapshot = {"price": float, "tick": int, "i": int}` (current bar only).
   `action ∈ {add_by_tick(lower_tick,upper_tick), remove_all, rebalance, hold}`.
   Fixtures in `submissions/`: `clean_lp.py` (honest ±300-tick recentering band),
   `hardcoded_lp.py` (band overfit to the held-out tick range = cheat),
   `stateful_lp.py` (tick-EMA, exercises the persistent-worker property).
3. **SCORER** — `scorer.py` builds `UniLpMarket` + `Actuator`, runs the backtest,
   reads FINAL net value from `actuator.account_status[-1].net_value`, scales
   `ret*100000` clamped 0..10000.
4. **NO-PEEK** — by construction. The untrusted `on_bar` runs in `worker.py`, a
   separate OS process that only ever receives the 3-key snapshot. The demeter
   DataFrame and all future bars live only in the trusted parent.

---

## 2. Key design decisions and WHY

- **Action-verbs over the wire, NOT "run the whole demeter backtest in the worker."**
  demeter's native model runs the strategy IN the actuator loop, which would put
  untrusted code in the process holding the private series — violating the split
  (HARNESS_SPEC.md:64). Resolution: worker emits one action per bar; trusted scorer
  replays it. (origin/main's lane chose differently — worker runs the whole backtest
  then the scorer RE-RUNS it and checks agreement. Both are valid; they are different.)

- **FINAL net value, not PEAK.** First attempt used the Jun 4-5 window, which was a
  -6.8% WETH dump where every LP strategy ends below start (both fixtures score 0 on
  final value). The build briefly switched to PEAK net value to separate them — that
  is a lookahead-flavored metric and deviates from the spec's "net value from
  final_status." DECISION (user-chosen): re-pick the window, keep final_status. New
  window Jun 3-4 is RANGING (+0.10% net), so final net value separates honest from
  cheat WITHOUT a directional confound. Scoring is honest final-status again.

- **Window = Jun 3-4 2025.** Surveyed per-day drift from CSVs already on disk (free)
  rather than re-querying BigQuery ($0.21-0.42/survey). Jun 5 was the sole -7.4% dump;
  excluding it gives a flat 2-day window. Jun 1 +0.41%, Jun 2 +2.74%, Jun 3 -0.50%,
  Jun 4 +0.58%, Jun 5 -7.41%.

- **Venv re-exec shim in scorer.py.** grade.ts calls bare `python3 scorer.py`. demeter
  is NOT in the system python (it needs 3.12; system default is 3.14). scorer.py detects
  the missing import and re-execs itself under `.demeter-venv/bin/python` (guarded by
  DEMETER_REEXEC=1 so it fires once). grade.ts needs no change.

- **grade.ts PRIVATE_SERIES repoint — ABANDONED.** The old const pointed at a deleted
  `maker/.../prices_private.json`, which would throw. I made it env-overridable locally,
  but origin/main's `BOUNTY=lp` grade.ts supersedes this entirely. My change is in
  `git stash@{0}` and is NOT being landed. If my scorer path is kept, the privateSeries
  pointer must be reconciled with origin's grade.ts (see §5).

---

## 3. What is verified — exact commands + expected numbers

All run from `apps/grading-cre/grader/`.

```
# Core gate — all four checks must say OK:
python3 verify_split.py
#   1. clean_lp.py     split = 902    (honest)
#   2. hardcoded_lp.py split = 1281   (cheat, > honest)
#   3. stateful_lp.py  split = 908    (non-zero, deterministic across two runs)
#   4. per-bar-spawn   = 1329 != 908  (persistent-worker property has teeth)

# Direct scores (stderr is demeter's progress bar; the int on stdout is the score):
python3 scorer.py submissions/clean_lp.py      2>/dev/null   # -> 902
python3 scorer.py submissions/hardcoded_lp.py  2>/dev/null   # -> 1281
python3 scorer.py submissions/stateful_lp.py   2>/dev/null   # -> 908
```

Rejection paths (all return honest 0, verified ad hoc this session):
- on_bar raises -> 0; bad action verb -> 0; add_by_tick with lower>=upper -> 0;
  no on_bar function -> 0.
- HANGING on_bar -> 0 in ~10.6s: hits BAR_DEADLINE_S=10, killpg's the worker process
  group, leaves NO orphan processes.
- NO-PEEK probe: a submission asserting `set(snapshot.keys()) <= {"price","tick","i"}`
  PASSES (scored 15) — proves the worker never sees more than the 3-key snapshot.

grade.ts executionGrade half (real demeter score + genuine digest) was verified e2e
with bun (no API key needed for the exec half): digest CHANGES when the private file
changes (Jun3 vs Jun4), proving the commitment covers the held-out data. NOTE: this
was against MY (stashed) grade.ts; re-verify against origin's grade.ts before relying.

---

## 4. Hard-won facts (would cost real time to rediscover)

- **demeter venv:** `.demeter-venv/` at the grader root, python 3.12.12
  (`/opt/homebrew/bin/python3.12`). Matches the enclave Dockerfile `python:3.12-slim`.
  Packages: `zelos-demeter==1.3.0`, `demeter-fetch==1.3.10`. demeter does NOT import
  under python 3.13/3.14. The venv is gitignored — recreate with those two pins.
- **demeter API (verified on the installed package):** `from demeter import TokenInfo,
  Actuator, Strategy, Asset`; `from demeter.uniswap import UniV3Pool, UniLpMarket,
  load_uni_v3_data, get_price_from_data`; `from demeter.broker import MarketInfo`.
  Market mutators: `add_liquidity_by_tick(lower,upper)`, `remove_all_liquidity()`,
  `even_rebalance(price)`. Final value: `actuator.account_status[-1].net_value`.
- **Pool:** WETH/USDC 0.05% mainnet `0x88e6a0c2dDD26FEEb64F039a2c41296FcB3f5640`.
  In `UniV3Pool(token0=USDC, token1=WETH, fee=0.05, quote_token=USDC)`, `fee=0.05`
  yields tick_spacing=10. So all ticks in add_by_tick MUST be multiples of 10.
- **Tick ranges:** Jun 3-4 private window closeTick = 197397..197742 (intrabar
  low/high 197395..197752). The cheat band `hardcoded_lp.py` = [197390, 197760]
  brackets exactly that — it is the overfit. Re-tune it if the window ever changes.
- **CSV format (demeter load_data):** header
  `timestamp,netAmount0,netAmount1,closeTick,openTick,lowestTick,highestTick,inAmount0,inAmount1,currentLiquidity`.
  TICKS ARE FLOATS in the file (e.g. `197661.0`) — parse with `int(float(x))`.
  Price = USDC/WETH; load adds derived `close`/`price`/`volume0`/`volume1` columns.
  Amounts are atomic units.
- **Initial portfolio:** 5000 USDC + 2 WETH (≈50/50 at the window open ~2500 USDC/WETH).
- **Env vars scorer.py honors:** `PRIVATE_DATA_DIR` (dir of the private CSVs, default
  `data/private`), `PRIVATE_SERIES` (the FILE grade.ts/enclave hashes for the digest,
  default the Jun-03 CSV), `DEMETER_REEXEC` (internal venv-shim guard).
- **BigQuery:** authed to project `honeycomb-499305` via
  `bq-script@honeycomb-499305.iam.gserviceaccount.com`. demeter-fetch BigQuery backend.
  A naive day-survey query is 41-83 GB / $0.21-0.42 — survey from on-disk CSVs instead.

---

## 5. OVERLAP / DIVERGENCE FLAGS (the collision points for collapse)

1. **`scorer.py` + `worker.py` — I OVERWROTE THE DIRECTIONAL GRADER IN PLACE.**
   origin/main keeps directional `scorer.py`/`worker.py` AND adds separate
   `lp_scorer.py`/`lp_worker.py`/`lp_engine.py`. My commit `84fcc6a` replaces the
   directional `scorer.py`/`worker.py` with the LP versions. THIS IS THE PRIMARY
   CONFLICT. If both bounty types must survive, my LP code should be re-homed to new
   files (lp_scorer.py-style) rather than overwriting directional. Needs a human call.

2. **`grade.ts` — SHARED, contract-bearing.** I did NOT commit any change (my repoint is
   stashed/abandoned). origin's version is canonical: it has a `BOUNTY=lp` switch
   (`SCORER = lp_scorer.py` when BOUNTY=lp), string `jobId`/`agentId` (can exceed 2^53),
   and a callback payload with split `scoreAttestation` + `validityAttestation`. If my
   scorer.py path is adopted, grade.ts's PRIVATE_SERIES / SCORER selection must be
   reconciled — my scorer expects `PRIVATE_DATA_DIR`/`PRIVATE_SERIES` env, theirs hard-
   codes `pool_private.csv`.

3. **TWO LP SCORERS, DIFFERENT SCORE VALUES.** Mine: clean=902, cheat=1281 on real
   BigQuery Jun 3-4 data. Theirs (`verify_lp.py`, per memory `grader-lp-e2e-green`):
   clean=4746 / tight=8806 / cheat=10000 on synthetic `pool_private.csv`. DO NOT assume
   any number is "the" score — they are different scorers over different data.

4. **PRIVATE DATA FORMAT — same columns, different provenance.** Both use the demeter
   CSV schema, BUT mine is real BigQuery (Jun 3-4 2025, gitignored) and theirs is
   synthetic `pool_private.csv` (72 bars, 2024-01-01, COMMITTED in the repo). Their file
   has extra derived columns appended (`open,price,low,high,volume0,volume1`). If the
   real-data path is preferred for the prize ("real onchain", per memory
   `uniswap-prize-requirements`), the synthetic file is the thing to replace.

5. **`.gitignore` (grader) — SHARED, additive.** My commit `9e8c4cc` adds
   `data/_unused/` and the demeter-data/venv ignores. Teammate's `ac4c7d5` also touched
   grader venv gitignore. Likely trivially mergeable but flag it.

6. **CRE callback / ABI — NOT touched by this lane.** scorer.py emits only the int;
   the callback shape lives entirely in grade.ts (origin's) and main.ts. No ABI change
   from me. The collision surface is grade.ts (item 2), not the contract.

---

## 6. Memory

Load-bearing facts saved to auto-memory (survive session loss), in
`~/.claude/projects/.../memory/`:
- `demeter-scorer-groundwork.md` — venv/python 3.12, demeter API, the Jun 3-4 window +
  source, scoring=final_status, the verified numbers (902/1281/908), env vars, and the
  enclave-still-Stage-2 gap.
- `grader-lp-e2e-green.md` — documents the OTHER (origin/main) LP path. Cross-check
  against this handoff so the two implementations are not confused.
- `uniswap-prize-requirements.md` — the prize wants REAL onchain data (relevant to the
  real-vs-synthetic data divergence in §5.4).

## 7. Known-open / gaps

- **Enclave is still Stage-2 (toy PnL).** `enclave/` bakes the OLD scorer.py/worker.py/
  submissions + `prices_private.json` (hand-copied snapshot, no build.sh). To run the
  demeter scorer in Confidential Space: install demeter in the image, COPY the private
  CSVs in, re-sync scorer/worker/submissions, set PRIVATE_DATA_DIR+PRIVATE_SERIES,
  rebuild + redeploy. enclave_grade.py SIGNING is fine (digest formula identical).
  Deferred — needs a GCP rebuild/redeploy and a human go-ahead.
- **The two-LP-scorer fork (§0/§5) is unresolved.** No human has chosen mine vs theirs.
- **No automated tests** (hackathon posture). Verification is the `verify_split.py` gate
  + the ad-hoc rejection-path checks in §3.
