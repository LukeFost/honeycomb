# Grader Lane — Handoff

> Lane: the **execution-grading** harness (`apps/grading-cre/grader/`). Owner this
> session: Luke. This doc captures what is NOT obvious from the code. Assume zero
> memory of how it got built. Companion to `HARNESS_SPEC.md` (the design spec);
> this is the "what's true right now + why" layer on top.
>
> NOTE: §0–§5 are the canonical, team-shared handoff (covers BOTH bounties + the
> live-prod TEE facts). §6 is an appendix documenting a SECOND, parallel LP scorer
> Luke built on the `luke/demeter-lp-scorer` branch — different trust model, different
> data. Read §6.0 before assuming there is only one LP grader.

---

## 0. One-paragraph orientation

A submission (`signal()` for directional, a Demeter `Strategy` for LP) is graded by
`grade.ts`, which runs TWO independent gates and POSTs both results to the CRE
workflow: (1) **execution** — real backtested PnL, an honest number even when it
flatters a cheat; (2) **validity** — a Chainlink Confidential AI call that flags
cheats. The contract combines them: `effective = valid ? score : 0`. The scorer is
NOT the cheat detector. That separation is the whole design, and it is load-bearing
(see §1).

---

## 1. KEY DECISION: two gates, and WHY the scorer must stay "dumb"

The cheat OUT-SCORES the honest strategy on raw execution in BOTH bounties:

| bounty       | honest                    | cheat              |
|--------------|---------------------------|--------------------|
| directional  | clean.py **2282**         | hardcoded.py **3081** |
| LP (Demeter) | clean **4746** / tight **8806** | cheat.py **10000** (clamp) |

If the scorer tried to reject cheats, it would duplicate and fight the validity gate.
So it doesn't. It reports the honest number; `attestValidity()` (REAL, already owned by
the CRE side) marks the cheat invalid; the contract zeroes it. **Do not add
cheat-detection to the scorer.** This is stated in `HARNESS_SPEC.md §1` and proven live.

### Sub-decision: the LP worker-agreement check does NOT catch in-process cheats — by design
`lp_scorer.py` spawns `lp_worker.py` (untrusted) to run the strategy, then RE-RUNS the
same deterministic backtest in the trusted parent and requires the two `net_value`s to
AGREE. That catches a worker that lies about a number the strategy didn't produce
(channel tampering). It does NOT catch `cheat.py`, which monkeypatches
`UniLpMarket.get_market_balance` to forge `net_value` IN-PROCESS — both worker and parent
import the patch, both inflate, they agree. That is correct: in-process strategy-level
gaming is a VALIDITY problem, not a scorer problem. Same split as directional. The
validity gate caught cheat.py live (`valid=false`, reason cited the monkeypatch).

---

## 2. VERIFIED — exact commands + expected numbers

All run from `apps/grading-cre/grader/`. The LP path needs the demeter venv (see §4).

### Directional grader (standalone scorer)
```
python3 scorer.py submissions/clean.py        # -> 2282
python3 scorer.py submissions/hardcoded.py     # -> 3081  (cheat, scores HIGHER)
```

### LP grader (standalone scorer, needs .venv)
```
.venv/bin/python lp_scorer.py lp_submissions/clean.py   # -> 4746
.venv/bin/python lp_scorer.py lp_submissions/tight.py   # -> 8806
.venv/bin/python lp_scorer.py lp_submissions/cheat.py   # -> 10000
```

### LP grader END-TO-END through grade.ts (both gates, real AI call)
```
INFERENCE_API_KEY_VAR="$(security find-generic-password -a "$USER" -s honeycomb_chainlink_api_key -w)" \
BOUNTY=lp PATH="$PWD/.venv/bin:$PATH" \
  bun grade.ts lp_submissions/clean.py 7 22
```
Expected callback JSON:
```
clean.py 7 22 -> score 4746,  valid true
tight.py 7 23 -> score 8806,  valid true
cheat.py 7 24 -> score 10000, valid FALSE   <-- the money shot
```
Each emits jobId, agentId, status:"completed", score, valid, scoreAttestation,
validityAttestation. Directional e2e is identical without `BOUNTY=lp` and uses
`submissions/` + system python3.

### TEE (directional, Stage 2) — proven live in prod, NOT re-run here
Confidential Space SEV VM graded clean.py and signed 2282 in-enclave with the KMS HSM
key; signature recovered to the KMS signer `0x5B57aF5eBAd44bEEfdfCcd71F33359d74Ec0e86F`
via Solidity ecrecover. See `enclave/deploy.sh` + memory `grader-stage2-live-prod`.

---

## 3. OPEN / KNOWN GAPS

- **Stage 3 (attestation-gated key release).** The enclave signs with a KMS key that
  exists independently of the attestation. Stage 3 binds key release to the attested
  image digest (Workload Identity Federation + IAM condition on the digest). Until then
  the enclave is "a server with a key," not "a key that only exists when the right image
  runs." Honest gap, flagged as such — do not claim the stronger property.
- **LP is NOT containerized / NOT run in the enclave yet.** Directional is proven live in
  Confidential Space; LP is proven live LOCALLY (the .venv). Same grade.ts, same callback,
  so it's a deploy not a redesign — but the LP scorer has not run inside the TEE. To
  containerize: add `lp_engine/lp_scorer/lp_worker.py` + `pool_private.csv` to the enclave
  image, install `zelos-demeter` (works on a py3.12 OR py3.14 base, see §4), pass `BOUNTY=lp`.
- **Sample data is synthetic.** `prices_private.json` (40 bars) and `pool_private.csv`
  (72 hourly bars, see §4) are demo series, not a real WETH/USDC backtest. Riley's
  `analysis/` BigQuery pipeline is the eventual real feed. Out of the spine's critical path.
  (§6 documents a parallel branch that DID wire real BigQuery WETH/USDC data — different scorer.)

---

## 4. HARD-WON FACTS (cost real effort to find)

- **demeter runs on BOTH Python 3.12 and 3.14 — it is NOT 3.12-only.** `pip install
  zelos-demeter` (PyPI name; the import is `demeter`). CORRECTION to an earlier note in
  this doc that said "needs 3.12 / errors on 3.14": the FULL LP harness (`verify_lp.py`,
  all 5 checks, 4746/8806/10000) runs GREEN on python **3.14.3** — verified directly.
  There are TWO working venvs on this machine:
    - `apps/grading-cre/grader/.venv` -> **python3.12** (the local one, created at commit time).
    - `/tmp/demeter-probe/bin/python` -> **python3.14** (the probe venv; `/tmp` is ephemeral).
  Either scores identically. The repo `.gitignore` now has `.venv*/` so any `.venv*` name is
  ignored — but keep it `.venv` for the root `.venv/` rule too. (`analysis/.venv` is a
  separate env with NO demeter — useless for LP.) For the enclave image, base on 3.12 OR
  3.14; do not block on a 3.12 base.
- **grade.ts shells literal `"python3"` from PATH** (not a configurable interpreter). So for
  LP you MUST prepend `.venv/bin` to PATH at call time, or it'll grab system 3.14 and fail.
- **LP private data window:** `pool_private.csv` = WETH/USDC, **72 hourly bars**, the run
  walks from 2024-01-03 23:00:00 (visible in the Actuator progress log). Public-tests mirror
  is `uniswap-lp-range-bot/public-tests/pool_public.csv`. Generator: `private/make_pool_data.py`.
- **Env vars:** `INFERENCE_API_KEY_VAR` (Chainlink Confidential AI key, keychain service
  `honeycomb_chainlink_api_key`); `BASE_URL` defaults to the confidential-ai dev preview;
  `BOUNTY=lp` selects the LP path (default `directional`); `PRIVATE_POOL_CSV` overrides the
  LP data path (lp_scorer reads it so the same code runs unmodified in the baked enclave image).
- **The LP scorer prints ONE int to stdout, logs to stderr** — same CLI contract as the
  directional scorer. demeter's Actuator logs are noisy on stderr; that's expected, grade.ts
  reads stdout only.

---

## 5. SHARED FILES I TOUCHED (merge collision points)

- **`grade.ts`** — TWO regions:
  - **lines 30–39**: LP-vs-directional scorer/data selection (`BOUNTY`, `IS_LP`, `SCORER`,
    `PRIVATE_SERIES`). Self-contained, low collision risk.
  - **lines 138–147**: the callback JSON emission. THIS is the merge-sensitive one — it must
    stay in lockstep with the CRE `onGrade` handler's `GradeCallback` shape and
    `BountyEscrow._recordGrade`'s decode. Current shape (verified zero-drift vs the contract):
    `{ jobId, agentId, status, score (0..10000), valid, scoreAttestation, validityAttestation }`.
- **`apps/grading-cre/.gitignore`** — added `.venv*/` + `__pycache__/`.
- **`.gitignore` (root)** — `goals/` ignore (chore commit `ac4c7d5`).

I did NOT touch `main.ts`, `BountyEscrow.sol`, or any strategy-vault/web file.

---

## 6. APPENDIX — Luke's parallel LP scorer (branch `luke/demeter-lp-scorer`)

### 6.0 What this is and how it relates to §1–§5

Separately from the `lp_scorer.py` path above, Luke built a SECOND LP grader on the
`luke/demeter-lp-scorer` branch. Both now live in this directory after merge. They are
NOT the same implementation — do not conflate their score numbers.

| | §1–§5 path (`lp_scorer.py`, canonical) | this appendix (`scorer.py`/`worker.py` LP build) |
|---|---|---|
| Trust model | worker runs strategy, scorer RE-RUNS + agreement-checks net_value | action-verbs over a pipe; scorer REPLAYS verbs into the market (no-peek by construction) |
| Private data | `pool_private.csv` synthetic, 72 bars, 2024-01-01 | real BigQuery WETH/USDC 0.05%, Jun 3-4 2025, 1-min bars (GITIGNORED) |
| Submission API | a demeter `Strategy` subclass | `on_bar(snapshot)->action`, snapshot = `{price,tick,i}` (current bar only) |
| Fixtures | `lp_submissions/{clean,tight,cheat}.py` | `submissions/{clean_lp,hardcoded_lp,stateful_lp}.py` |
| Scores | clean 4746 / tight 8806 / cheat 10000 | clean 902 / hardcoded(cheat) 1281 / stateful 908 |
| Verify | `verify_lp.py` | `verify_split.py` |

Both files coexist on disk without collision (`lp_scorer.py` and `scorer.py` LP-build
are distinct names; the directional `scorer.py` was NOT overwritten in the merged tree —
an earlier worry in Luke's draft that it had been was wrong, confirmed against the merge).
**Neither LP scorer is "the" canonical one yet** — a human picks (or unifies) before the
LP path is deployed to the enclave. The §1–§5 path is the one already wired through
grade.ts `BOUNTY=lp` and proven e2e; this appendix path documents an alternative with
real onchain data, relevant if the prize requires real data (memory
`uniswap-prize-requirements`).

CORRECTION carried over: Luke's original draft of this doc claimed "demeter is 3.12-only,
errors on 3.14." That is WRONG — see §4: it runs green on 3.14.3. The 3.12 claim came from
only ever having a 3.12 `.demeter-venv` on hand, never testing 3.14.

### 6.1 Verified — action-verb LP scorer

From `apps/grading-cre/grader/` (this path's scorer lives at `scorer.py`/`worker.py` on
the LP branch; needs `.demeter-venv` py3.12 OR system demeter on 3.14):
```
python3 verify_split.py
#   1. clean_lp.py     split = 902    (honest)
#   2. hardcoded_lp.py split = 1281   (cheat, > honest)
#   3. stateful_lp.py  split = 908    (non-zero, deterministic across two runs)
#   4. per-bar-spawn   = 1329 != 908  (persistent-worker property has teeth)
```
Rejection paths all return honest 0: on_bar raises; bad action verb; add_by_tick with
lower>=upper; no on_bar function. HANGING on_bar -> 0 in ~10.6s (BAR_DEADLINE_S=10,
killpg's the worker group, no orphans). NO-PEEK probe (submission asserting
`set(snapshot) <= {price,tick,i}`) PASSES — the worker never sees more than the 3-key snapshot.

### 6.2 Design decisions + WHY (action-verb path)

- **Action-verbs over the wire, NOT the whole backtest in the worker.** demeter's native
  model runs the strategy IN the actuator loop, which would put untrusted code in the
  process holding the private series (HARNESS_SPEC.md:64). Resolution: worker emits one
  action per bar (`add_by_tick | remove_all | rebalance | hold`); trusted scorer replays
  it. (The §1–§5 path chose differently — worker runs the whole backtest, scorer re-runs +
  agreement-checks. Both are valid; they are different.)
- **FINAL net value, not PEAK.** First attempt used a Jun 4-5 window (-6.8% WETH dump) where
  every LP strategy ends below start (both fixtures score 0 on final value). Briefly switched
  to PEAK to separate them — that is lookahead-flavored and deviates from the spec's "net
  value from final_status." DECISION (user-chosen): re-pick the window, keep final_status.
  Jun 3-4 is ranging (+0.10% net), so final net value separates honest from cheat without a
  directional confound.
- **Window = Jun 3-4 2025.** Surveyed per-day drift from on-disk CSVs (free) not BigQuery
  ($0.21-0.42/survey). Jun 1 +0.41 / Jun 2 +2.74 / Jun 3 -0.50 / Jun 4 +0.58 / Jun 5 -7.41%.
  Jun 5 was the sole dump; excluding it gives a flat 2-day window.
- **Venv re-exec shim in scorer.py.** grade.ts calls bare `python3 scorer.py`; this build's
  scorer detects the missing demeter import and re-execs under `.demeter-venv/bin/python`
  (guarded by `DEMETER_REEXEC=1`). grade.ts needs no change. (The §1–§5 path instead requires
  prepending `.venv/bin` to PATH — see §4.)

### 6.3 Hard-won facts (action-verb path)

- **Pool:** WETH/USDC 0.05% mainnet `0x88e6a0c2dDD26FEEb64F039a2c41296FcB3f5640`. In
  `UniV3Pool(token0=USDC, token1=WETH, fee=0.05, quote_token=USDC)`, `fee=0.05` -> tick_spacing
  10, so all add_by_tick ticks MUST be multiples of 10.
- **Tick ranges:** Jun 3-4 private window closeTick 197397..197742 (intrabar 197395..197752).
  Cheat band `hardcoded_lp.py` = [197390, 197760] brackets it exactly — the overfit. Re-tune if
  the window changes.
- **CSV format (demeter load_data):** header
  `timestamp,netAmount0,netAmount1,closeTick,openTick,lowestTick,highestTick,inAmount0,inAmount1,currentLiquidity`.
  TICKS ARE FLOATS in the file (`197661.0`) — parse `int(float(x))`. load adds derived
  `close`/`price`/`volume0`/`volume1`. Amounts are atomic units.
- **Initial portfolio:** 5000 USDC + 2 WETH (~50/50 at window open ~2500 USDC/WETH).
- **Env vars this scorer honors:** `PRIVATE_DATA_DIR` (dir of private CSVs, default
  `data/private`), `PRIVATE_SERIES` (the FILE grade.ts/enclave hashes for the digest),
  `DEMETER_REEXEC` (venv-shim guard).
- **BigQuery:** project `honeycomb-499305` via `bq-script@honeycomb-499305.iam.gserviceaccount.com`,
  demeter-fetch backend. Naive day-survey query is 41-83 GB / $0.21-0.42 — survey from CSVs.
- **Real held-out data is GITIGNORED:** `data/private/` (Jun 3-4) + `data/_unused/` (Jun 5)
  are never committed; `data/public/` (Jun 1-2) IS committed as the sample. Fetcher:
  `fetch_data.py`.

### 6.4 grade.ts reconciliation note

This appendix path's scorer expects `PRIVATE_DATA_DIR`/`PRIVATE_SERIES` env; the canonical
grade.ts (`BOUNTY=lp`) hardcodes `pool_private.csv` for the §1–§5 path. If the action-verb
scorer is ever adopted as the LP path, grade.ts's SCORER + PRIVATE_SERIES selection must be
reconciled. No change was landed to grade.ts from the appendix branch (a local repoint was
stashed and abandoned in favor of the canonical `BOUNTY=lp` version).

---

## 7. Memory

Load-bearing facts in auto-memory (`~/.claude/projects/.../memory/`):
- `grader-lp-e2e-green.md` — the §1–§5 canonical LP path (worker re-run + agreement check).
- `demeter-scorer-groundwork.md` — the §6 action-verb path (real BigQuery, scores 902/1281/908).
- `grader-stage2-live-prod.md` — the live-prod directional TEE recovery (§2).
- `uniswap-prize-requirements.md` — prize wants REAL onchain data (relevant to §6 vs §1–§5).
