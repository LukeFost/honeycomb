#!/usr/bin/env python3
# TRUSTED LP scorer (parent). Holds the private pool CSV and decides the score.
#
# Trust model -- "worker computes, scorer re-runs":
#   1. Spawn lp_worker.py (UNTRUSTED) under a wall-clock deadline + own process
#      group. It runs the submission's Demeter Strategy over the private CSV and
#      reports net_value back on a label-only fd. A hang/fork/crash -> rejected.
#   2. RE-RUN the identical deterministic backtest HERE, in the trusted parent.
#      The backtest is a pure function of (strategy, CSV), so an honest worker's
#      net_value must match the parent's to a tiny tolerance. A worker that lies
#      (reports a fake high number) is caught here and the run is REJECTED.
#
# Why re-running is sound and not circular: the worker's value is never trusted;
# it only has to AGREE with the parent's independent computation. The parent's
# number is the score. The worker exists so the submission's code executes in a
# separate, jailed OS process first (matching the directional grader's posture);
# the agreement check turns that jailed run into a tamper-evident one.
#
# Confidentiality of the private CSV rests on the deployed enclave (no network
# egress, baked-in data), exactly as scorer.py documents for the directional case.
import sys
import os
import json
import select
import signal
import subprocess

import lp_engine

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "lp_worker.py")

# Wall-clock budget for the whole Demeter backtest (the Actuator walks all bars in
# one worker call, so this is per-run, not per-bar). A non-finishing strategy is
# killed and the run rejected.
RUN_DEADLINE_S = 30.0

# No-network posture: nothing in the worker's env points at a network endpoint.
# True egress blocking is the Confidential Space VPC's job in the enclave.
WORKER_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"}

# Agreement tolerance between worker-reported and parent-recomputed net_value.
# The backtest is deterministic, so honest runs match to float round-off; a real
# cheat is off by orders of magnitude. 1e-6 absolute is comfortably tight.
AGREE_TOL = 1e-6

# Private pool CSV. Override via env so the same scorer runs unmodified in the
# enclave image (data baked next to the entrypoint) and on the laptop.
PRIVATE_CSV = os.environ.get(
    "PRIVATE_POOL_CSV",
    os.path.join(
        HERE, "..", "maker", "bounties", "uniswap-lp-range-bot", "private", "pool_private.csv"
    ),
)


class WorkerError(Exception):
    """The worker reported an error, died, timed out, or disagreed with the re-run."""


def score(submission_path: str) -> int:
    submission_path = os.path.abspath(submission_path)
    csv_path = os.path.abspath(PRIVATE_CSV)

    r_fd, w_fd = os.pipe()
    proc = subprocess.Popen(
        [sys.executable, WORKER, submission_path, str(w_fd), csv_path],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,  # submission owns stdout; ignored (no forged result)
        stderr=subprocess.DEVNULL,
        pass_fds=(w_fd,),
        cwd=HERE,  # so `import lp_engine` resolves in the worker
        env=WORKER_ENV,
        start_new_session=True,  # own process group -> killpg reaps forked children
    )
    os.close(w_fd)
    results = os.fdopen(r_fd, "r")

    def kill_worker():
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    try:
        ready, _, _ = select.select([results], [], [], RUN_DEADLINE_S)
        if not ready:
            kill_worker()
            raise WorkerError("worker exceeded %.0fs wall-clock (killed)" % RUN_DEADLINE_S)

        reply_line = results.readline()
        if reply_line == "":
            raise WorkerError("worker produced no result (died/EOF)")
        reply = json.loads(reply_line)
        if "error" in reply:
            raise WorkerError("worker error: %s" % reply["error"])
        worker_net_value = float(reply["net_value"])
    finally:
        results.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            kill_worker()
            proc.wait(timeout=5)

    # Re-run the IDENTICAL backtest in the trusted parent and require agreement.
    parent_net_value = lp_engine.run_backtest(submission_path, csv_path)
    if abs(parent_net_value - worker_net_value) > AGREE_TOL:
        raise WorkerError(
            "worker net_value %.10f disagrees with trusted re-run %.10f (tampered/non-deterministic)"
            % (worker_net_value, parent_net_value)
        )

    return lp_engine.net_value_to_score(parent_net_value)


if __name__ == "__main__":
    print(score(sys.argv[1]))
