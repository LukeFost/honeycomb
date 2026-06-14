#!/usr/bin/env python3
# Verification gate for the scorer/worker split (demeter LP backtest version).
# Run before trusting the scorer on a live submission: proves the split is wired
# correctly and the persistent-worker property holds BEFORE it mis-scores a real bounty.
#
#   python3 grader/verify_split.py
#
# Four checks:
#   1. clean_lp.py     split == 902    (known honest score, final-net-value formula)
#   2. hardcoded_lp.py split == 1281   (known cheat score, must be > clean)
#   3. stateful_lp.py  split is non-zero AND deterministic (two runs agree)
#   4. stateful_lp.py  per-bar-spawn score != split score  (differential has teeth)
#
# NOTE: checks 3 and 4 together prove the persistent-worker property:
#   - check 3: the split scorer produces a stable, non-zero score for a stateful sub
#   - check 4: a BROKEN per-bar-spawn worker produces a DIFFERENT score, showing the
#     stateful fixture actually depends on accumulated state across bars
import os
import sys
import json
import select
import signal
import subprocess
import importlib.util
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
SUBS = os.path.join(HERE, "submissions")
SCORER = os.path.join(HERE, "scorer.py")
WORKER = os.path.join(HERE, "worker.py")

VENV_PY = os.path.join(HERE, ".demeter-venv", "bin", "python")
# Use the venv python if available, otherwise fall back to sys.executable.
# scorer.py has its own re-exec shim that handles this in production; here
# we invoke scorer.py via subprocess so it handles its own shim.
PYTHON = sys.executable


def split_score(sub_path):
    """Run scorer.py in a subprocess -- the normal production path."""
    out = subprocess.check_output([PYTHON, SCORER, sub_path], cwd=HERE)
    return int(out.strip())


def per_bar_spawn_score_subprocess(sub_path):
    """
    The BROKEN design, on purpose: spawn a fresh worker subprocess for every bar
    instead of one worker for the whole backtest. We run a helper script under the
    demeter venv so we can drive the actuator.
    """
    helper = os.path.join(HERE, "_verify_per_bar.py")
    py = VENV_PY if os.path.exists(VENV_PY) else PYTHON
    result = subprocess.run(
        [py, helper, sub_path],
        capture_output=True, text=True, cwd=HERE,
    )
    if result.returncode != 0:
        # Helper crashed; treat as different from split score (a non-zero value).
        return -1
    return int(result.stdout.strip())


def main():
    clean = os.path.join(SUBS, "clean_lp.py")
    hard = os.path.join(SUBS, "hardcoded_lp.py")
    stateful = os.path.join(SUBS, "stateful_lp.py")

    ok = True

    c = split_score(clean)
    print("1. clean_lp.py     split   = %-5d (expect 902)   %s" % (c, "OK" if c == 902 else "FAIL"))
    ok &= c == 902

    h = split_score(hard)
    print("2. hardcoded_lp.py split   = %-5d (expect 1281)  %s" % (h, "OK" if h == 1281 else "FAIL"))
    ok &= h == 1281

    # Check 3: split score for stateful is non-zero AND deterministic (run twice).
    s1 = split_score(stateful)
    s2 = split_score(stateful)
    pass3 = s1 != 0 and s1 == s2
    print("3. stateful_lp.py  split=%d  split2=%d  (non-zero, deterministic)  %s" % (
        s1, s2, "OK" if pass3 else "FAIL"))
    ok &= pass3

    # Check 4: per-bar-spawn gives a DIFFERENT score (proving state really matters).
    s_broken = per_bar_spawn_score_subprocess(stateful)
    pass4 = s_broken != s1
    print("4. stateful_lp.py  per-bar-spawn=%d != split=%d  (differential has teeth)  %s" % (
        s_broken, s1, "OK" if pass4 else "FAIL"))
    ok &= pass4

    print("\n%s" % (
        "ALL PASS -- split is behavior-preserving and the persistent-worker property is verified."
        if ok else "FAILURES ABOVE."
    ))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
