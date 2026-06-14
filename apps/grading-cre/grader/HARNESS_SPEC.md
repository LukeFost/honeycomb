# Grader Harness Spec — Execution Grading Enclave

> **Owner:** Luke. **Lane:** the execution-grading enclave (Google Confidential Space).
> Alex owns the CRE workflow + `BountyEscrow.sol` (both pushed). Riley owns the dashboard.
> This doc specs the one seam Alex left for me: turn `executionGrade()` from a STUB into
> a real enclave that runs a submission against the private dataset and returns a real,
> signed score.

---

## 0. What I'm replacing

`grader/grade.ts:31-34` today:

```typescript
function executionGrade(code: string): { score: number; attestationDigest: string } {
  const score = 1 + (parseInt(sha256hex(code).slice(0, 4), 16) % 10000); // STUB score
  return { score, attestationDigest: sha256hex("STUB-EXECUTION:" + code) };
}
```

It hashes the code into a fake number. The signature is what I keep; the body is what I make real.

**Pinned contract (do not change — Alex's CRE + contract decode this):**
- Input: the submission source (a Python file exposing `signal(prices: list[float]) -> "buy"|"sell"|"hold"`).
- Output: `{ score: int 0..10000, attestationDigest: string }` where `attestationDigest` is a
  32-byte hex digest the workflow maps to `scoreAttestationHash` in the settlement tuple.
- `grade.ts` then emits `execution: { score, attestation: { digest } }` →
  CRE workflow → ABI tuple → `BountyEscrow.onReport`.

The number must be the **real backtested PnL** from `private/scoring.py`, not a hash.

---

## 1. The real grading logic already exists

`maker/bounties/uniswap-lp-trading-bot/private/scoring.py` IS the grader. It:
1. Imports `signal` from the submission file (`importlib.exec_module`).
2. Loads the **private** series `prices_private.json` (40 bars, WETH/USDC 1h).
3. Walks bar-by-bar from `warmup=20`, holds long while latest signal is `"buy"`, flat on `"sell"`,
   keeps position on `"hold"`; sums per-bar returns.
4. Scales PnL `* 100000`, clamps to `0..10000`.

Verified locally (real numbers, not stubs):

| submission | real score | note |
|---|---|---|
| `clean.py` (SMA crossover) | **2282** | genuine strategy |
| `hardcoded.py` (canned list) | **3081** | cheat — scores HIGHER |

**This is the whole design in one row:** the cheat out-scores the honest strategy on execution
alone. My harness must report `3081` for the cheat **honestly** — it does NOT reject cheats.
The AI validity gate (Alex's `attestValidity()`, already REAL) marks `hardcoded.py` invalid, and
`effective = valid ? executionScore : 0` zeroes it on-chain. **Two independent gates; mine is the
honest-number gate, not the cheat-detection gate.** If I try to be clever and reject cheats in the
scorer, I duplicate (and fight) the validity gate. Don't.

So the harness is mostly: **run `scoring.py` in a hardened way, then attest the result.**

---

## 2. The one real bug to fix while wrapping it (Fusion C6)

`scoring.py` does `importlib.exec_module(submission)` — it executes **arbitrary submitted Python
in the same process that holds `prices_private.json`**. A malicious `signal()` can read the private
series, exfiltrate it, loop forever, or fork-bomb the enclave. "A TEE is not a sandbox against the
*submitted* code" — the enclave protects the data from the outside world, not from the code I run
inside it.

The enclave's value is confidentiality of the private dataset. Running untrusted code in-process
with that dataset throws that value away. So sandboxing is **not gold-plating — it's the core
correctness property of the grader.**

Minimum viable isolation for the demo (not full VPC-SC, just don't be reckless):
- Run the submission in a **subprocess**, not in-process.
- **No network** egress from the scoring subprocess (the model never needs it; the spec forbids it).
- **CPU + wall-clock timeout** (e.g. 10s) → a non-finishing `signal` scores 0, doesn't hang the enclave.
- **Memory cap** → no fork-bomb / OOM the host.
- Submission sees only what it needs: the `prices` list passed in. It must NOT get a readable path
  to `prices_private.json`. (`scoring.py` currently reads the file itself and passes slices to
  `signal()`, which is the right shape — the submission gets *data*, never the *file*. Preserve that:
  the file is read by the harness, never reachable by the submitted code.)

This is the only behavioral change from `scoring.py`'s current logic. The scoring math stays identical.

---

## 3. Harness shape (build order)

### Stage 1 — real local scorer (today, no GCP)
Replace the stub with a real local run. Two clean options:

- **Option A (fastest):** `grade.ts` shells out to `python3 scoring.py <submission>` (subprocess +
  timeout + `env -i` no-network) and parses the integer from stdout. Zero new languages.
- **Option B:** port the ~15 lines of `scoring.py` into the grader and run the submission in a
  locked-down subprocess. More control, more work.

Recommendation: **A**. `scoring.py` is already the source of truth and already prints the score.
Wrapping it keeps one grading implementation, not two that can drift.

The `attestationDigest` at this stage = a real hash over the **graded inputs+output** so it's
meaningful and reproducible, NOT over the code text like the stub:
`sha256(bountyId || submissionHash || privateSeriesHash || score)`. This proves "this exact code,
graded against this exact private series, produced this exact score" — verifiable later against the
on-chain `scoreAttestationHash`.

> At Stage 1 the digest is a plain hash, not a TEE attestation. That's honest: it's a content
> commitment, not a hardware attestation. Label it as such; don't claim enclave provenance yet.

### Stage 2 — Google Confidential Space (the real enclave)
Put the Stage-1 scorer in a container, run it in **Google Confidential Space**:
- Image pinned by digest; private series baked in (or CMEK-released — roadmap).
- The score is signed by **Cloud KMS HSM `EC_SIGN_SECP256K1`** so the contract can `ecrecover` the
  signer (see `pitch/TEE_RESEARCH.md` Option C). `attestationDigest` becomes the digest the enclave
  signs over.
- **KMS smoke test first** (it's the trust anchor and the riskiest unknown): confirm an
  `EC_SIGN_SECP256K1` signature is accepted by `ecrecover` end-to-end on Sepolia BEFORE building
  anything around it. If that doesn't work, the whole signed-score design changes.

### Stage 3 — attestation-gated signing (Fusion C2, roadmap)
Release the KMS signing key ONLY to the attested Confidential Space workload (Workload Identity
Federation + IAM condition on the image digest). Until then, Stage 2 signs without the attestation
gate — flag this as the known gap. It's the difference between "a server with a key" and "an enclave
whose key only exists when the right image runs."

---

## 4. Interfaces I must not break

| Seam | Contract | Source of truth |
|---|---|---|
| Submission | `def signal(prices: list[float]) -> "buy"\|"sell"\|"hold"` — pure, deterministic | `spec.md` |
| Scoring | walk from `warmup=20`, long on buy / flat on sell / hold keeps, PnL×100000 clamp 0..10000 | `private/scoring.py` |
| `executionGrade()` return | `{ score: int 0..10000, attestationDigest: hex }` | `grade.ts:31` |
| Callback field | `execution: { score, attestation: { digest } }` | `grade.ts:101`, `grading-callback.json` |
| On-chain | `scoreAttestationHash` (bytes32) in the 6-tuple | `BountyEscrow.onReport`, `main.ts:74` |
| Validity (NOT mine) | `attestValidity()` is REAL and owns cheat-rejection | `grade.ts:39` |

**Effective score = `valid ? executionScore : 0`** is enforced in the contract/callback path, not in
my scorer. My scorer always returns the honest execution number.

---

## 5. Definition of done (demo spine)

1. `executionGrade()` returns the **real** `scoring.py` number, not a hash.
   - `clean.py → 2282`, `hardcoded.py → 3081` reproduced through `grade.ts`, not just standalone.
2. Submitted code runs **sandboxed**: subprocess, no network, timeout, mem cap; cannot read
   `prices_private.json` directly; a hanging/forking submission scores 0 without taking down the harness.
3. `attestationDigest` is a real commitment over `(bountyId, submissionHash, privateSeriesHash, score)`.
4. End-to-end: `grade.ts <submission>` → callback JSON → CRE simulate → on-chain settlement on Sepolia,
   with the cheat correctly paid **0** (validity gate) and the honest strategy's real score recorded.

Stage 2/3 (Confidential Space + KMS signing + attestation-gated key) are the hardening path after the
spine is green.

---

## 6. Open questions (mine to close)

- **KMS `ecrecover` smoke test** — does `EC_SIGN_SECP256K1` round-trip through Solidity `ecrecover`?
  (low-s normalization + recovery id). Blocks Stage 2. **Test in isolation first.**
- **Real dataset** — `prices_private.json` is 40 sample bars. Demo-fine, but if we want a credible
  WETH/USDC backtest, where does the real series come from, and does Riley's `analysis/` BigQuery
  pipeline feed it? (Out of my critical path for the spine; flag for the data owner.)
- **Determinism across enclave runs** (Fusion gap) — pin Python + lib versions in the image so the
  same submission always scores the same. Cheap; do it when containerizing.
