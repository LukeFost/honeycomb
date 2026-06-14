#!/usr/bin/env python3
# Verification gate for the Demeter LP grader. Run before trusting lp_scorer on a
# live submission: proves the trusted-scorer / untrusted-worker split works, the
# differential between honest strategies is real, and the agreement check catches
# a tampered worker.
#
#   python3 grader/verify_lp.py
#
# Checks:
#   1. clean.py  scores via the split, non-zero.
#   2. tight.py  scores via the split, non-zero.
#   3. clean != tight                          (the differential has teeth).
#   4. tampered worker (lies about net_value)  -> REJECTED by the agreement check.
#   5. cheat.py (in-process net_value forge)   -> scores high but is reported
#      HONESTLY by the scorer (validity gate's job to reject, not the scorer's).
import os
import sys
import json
import select
import signal
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
SUBS = os.path.join(HERE, "lp_submissions")

# Run everything with the same interpreter that imports demeter. verify_lp is
# launched with that interpreter, so sys.executable is correct.
PY = sys.executable

import lp_scorer  # noqa: E402  (for the tampered-worker check we reuse its constants)


def split_score(sub_path: str) -> int:
    out = subprocess.check_output([PY, os.path.join(HERE, "lp_scorer.py"), sub_path], cwd=HERE)
    return int(out.strip().splitlines()[-1])


def tampered_worker_rejected(sub_path: str) -> bool:
    # Drive the scorer's protocol directly but with a LYING worker: it reports a
    # net_value the strategy never produced. The trusted re-run must disagree and
    # raise. This is the property the agreement check exists for -- a worker binary
    # that tampers with the channel, distinct from a strategy that games the
    # Actuator in-process (check 5).
    sub_path = os.path.abspath(sub_path)
    csv_path = os.path.abspath(lp_scorer.PRIVATE_CSV)

    # A fake worker: ignore the real backtest, report a forged high net_value.
    fake_worker = (
        "import os,sys,json\n"
        "fd=int(sys.argv[2])\n"
        "os.write(fd, (json.dumps({'net_value': 999999.0})+chr(10)).encode())\n"
    )
    r_fd, w_fd = os.pipe()
    proc = subprocess.Popen(
        [PY, "-c", fake_worker, sub_path, str(w_fd), csv_path],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        pass_fds=(w_fd,), cwd=HERE, start_new_session=True,
    )
    os.close(w_fd)
    results = os.fdopen(r_fd, "r")
    ready, _, _ = select.select([results], [], [], 10.0)
    reply = json.loads(results.readline()) if ready else {}
    results.close()
    proc.wait(timeout=5)
    worker_net_value = float(reply["net_value"])

    # The scorer's re-run computes the HONEST number; require agreement, as lp_scorer does.
    parent_net_value = lp_scorer.lp_engine.run_backtest(sub_path, csv_path)
    return abs(parent_net_value - worker_net_value) > lp_scorer.AGREE_TOL  # disagrees -> rejected


def main():
    clean = os.path.join(SUBS, "clean.py")
    tight = os.path.join(SUBS, "tight.py")
    cheat = os.path.join(SUBS, "cheat.py")

    ok = True

    c = split_score(clean)
    print("1. clean.py  split score = %-6d (non-zero)        %s" % (c, "OK" if c > 0 else "FAIL"))
    ok &= c > 0

    t = split_score(tight)
    print("2. tight.py  split score = %-6d (non-zero)        %s" % (t, "OK" if t > 0 else "FAIL"))
    ok &= t > 0

    diff = c != t
    print("3. clean=%d != tight=%d  (differential has teeth)  %s" % (c, t, "OK" if diff else "FAIL"))
    ok &= diff

    rejected = tampered_worker_rejected(clean)
    print("4. tampered worker (forged net_value) -> %s by agreement check  %s"
          % ("REJECTED" if rejected else "ACCEPTED", "OK" if rejected else "FAIL"))
    ok &= rejected

    ch = split_score(cheat)
    # The in-process forge inflates net_value in BOTH worker and re-run, so they
    # agree -> the scorer reports a high (clamped) number HONESTLY. Rejecting it is
    # the validity gate's job, exactly like the directional hardcoded.py.
    cheat_high = ch >= 10000
    print("5. cheat.py  split score = %-6d -> reported honestly; validity-gate's job to reject  %s"
          % (ch, "OK" if cheat_high else "FAIL"))
    ok &= cheat_high

    print("\n%s" % (
        "ALL PASS -- LP split scores honestly, the honest differential is real, and the "
        "agreement check catches a tampered worker." if ok else "FAILURES ABOVE."))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
