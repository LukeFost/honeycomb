# Grader Lane — Handoff

> Lane: the **execution-grading** harness (`apps/grading-cre/grader/`). Owner this
> session: Luke. This doc captures what is NOT obvious from the code. Assume zero
> memory of how it got built. Companion to `HARNESS_SPEC.md` (the design spec);
> this is the "what's true right now + why" layer on top.

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
  image, install `zelos-demeter` (needs py3.12 base, see §4), pass `BOUNTY=lp`.
- **Sample data is synthetic.** `prices_private.json` (40 bars) and `pool_private.csv`
  (72 hourly bars, see §4) are demo series, not a real WETH/USDC backtest. Riley's
  `analysis/` BigQuery pipeline is the eventual real feed. Out of the spine's critical path.

---

## 4. HARD-WON FACTS (cost real effort to find)

- **demeter needs Python 3.12.** `pip install zelos-demeter` (PyPI name; the import is
  `demeter`). It does NOT install on the system python3 (3.14) — it errors. `analysis/.venv`
  is also 3.14 and has no demeter (useless for LP). The working env is a throwaway venv at
  `apps/grading-cre/grader/.venv` built with `/opt/homebrew/bin/python3.12 -m venv .venv`.
  It is named `.venv` ON PURPOSE so the repo-root `.gitignore` `.venv/` rule covers it. Do
  NOT name it `.venv-lp` — that's not ignored and will show up untracked.
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
