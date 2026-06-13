#!/usr/bin/env python3
# A1 verification gate (also the WF-3 pre-grade self-test from the plan's order-of-operations).
# Run before trusting the scorer on a live submission: proves the scorer/worker split is wired
# right and behavior-preserving BEFORE it mis-scores a real bounty.
#
#   python3 grader/verify_split.py
#
# Four checks:
#   1. clean.py     split == 2282   (known honest score)
#   2. hardcoded.py split == 3081   (known cheat score)
#   3. stateful.py  split == in-process score, non-zero  (persistent-worker property)
#   4. stateful.py  per-bar-spawn  != in-process score    (the differential has teeth)
import os
import sys
import json
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # apps/grading-cre
WORKER = os.path.join(HERE, "worker.py")
PRIVATE = os.path.join(ROOT, "maker", "bounties", "uniswap-lp-trading-bot", "private", "prices_private.json")
INPROC_SCORING = os.path.join(ROOT, "maker", "bounties", "uniswap-lp-trading-bot", "private", "scoring.py")
SUBS = os.path.join(HERE, "submissions")


def split_score(sub):
    out = subprocess.check_output([sys.executable, os.path.join(HERE, "scorer.py"), sub], cwd=HERE)
    return int(out.strip())


def inproc_score(sub):
    # scoring.py resolves prices_private.json relative to its own dir, so run it from there.
    out = subprocess.check_output([sys.executable, INPROC_SCORING, sub], cwd=os.path.dirname(INPROC_SCORING))
    return int(out.strip())


def per_bar_spawn_score(sub, warmup=20):
    # The BROKEN design, on purpose: one worker per bar -> module state resets each call.
    with open(PRIVATE) as f:
        prices = json.load(f)["prices"]
    position = 0
    pnl = 0.0
    for i in range(warmup, len(prices)):
        r3, w3 = os.pipe()
        p = subprocess.Popen(
            [sys.executable, WORKER, sub, str(w3)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            pass_fds=(w3,), cwd=HERE,
        )
        os.close(w3)
        p.stdin.write((json.dumps({"prices": prices[: i + 1]}) + "\n").encode())
        p.stdin.flush()
        line = os.fdopen(r3).readline()
        p.stdin.close()
        p.wait(timeout=5)
        s = json.loads(line)["label"]
        if s == "buy":
            position = 1
        elif s == "sell":
            position = 0
        ret = (prices[i] - prices[i - 1]) / prices[i - 1]
        pnl += position * ret
    return max(0, min(10000, int(round(pnl * 100000))))


def main():
    clean = os.path.join(SUBS, "clean.py")
    hard = os.path.join(SUBS, "hardcoded.py")
    stateful = os.path.join(SUBS, "stateful.py")

    ok = True

    c = split_score(clean)
    print("1. clean.py     split   = %-5d (expect 2282)  %s" % (c, "OK" if c == 2282 else "FAIL"))
    ok &= c == 2282

    h = split_score(hard)
    print("2. hardcoded.py split   = %-5d (expect 3081)  %s" % (h, "OK" if h == 3081 else "FAIL"))
    ok &= h == 3081

    s_split = split_score(stateful)
    s_inproc = inproc_score(stateful)
    pass3 = s_split == s_inproc and s_split != 0
    print("3. stateful.py  split=%d  in-proc=%d  (equal, non-zero)  %s" % (s_split, s_inproc, "OK" if pass3 else "FAIL"))
    ok &= pass3

    s_broken = per_bar_spawn_score(stateful)
    pass4 = s_broken != s_inproc
    print("4. stateful.py  per-bar-spawn=%d != in-proc=%d  (differential has teeth)  %s" % (s_broken, s_inproc, "OK" if pass4 else "FAIL"))
    ok &= pass4

    print("\n%s" % ("ALL PASS -- split is behavior-preserving and the persistent-worker property is verified." if ok else "FAILURES ABOVE."))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
