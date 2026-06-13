#!/usr/bin/env python3
# TRUSTED scorer (parent). Holds the private price series and does all the scoring math.
# The untrusted submission never runs in this process -- it runs in worker.py, a separate
# OS process that only ever sees one price prefix at a time and hands back one label.
#
# This is the security split: the submission cannot forge a score (it never produces a
# number; the parent computes PnL) and never sees a FUTURE bar at decision time (it gets
# prices[:i+1] one bar at a time). Full-series confidentiality rests on the A2 sandbox +
# the label-only fd 3, not on the slice -- the last call legitimately hands prices[:40].
#
# A1 scope: the split + behavior preservation. The worker here is a plain subprocess;
# the sandbox-exec jail and the parent-armed wall-clock deadline are A2. The fd-3 + NDJSON
# protocol and the spawn-ONCE lifecycle are wired now because they are the load-bearing
# correctness pieces (persistent module state across the walk).
import sys
import os
import json
import select
import signal
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))

# Per-bar wall-clock budget. A signal() that hangs (infinite loop, sleep, blocking
# I/O) must not hang the grader -- the parent arms a deadline on every label read
# and kills the worker's whole process group on expiry. This is the REAL timeout;
# it is wall-clock, not CPU-seconds, so a sleeping submission is caught too.
BAR_DEADLINE_S = 10.0

# Minimal environment for the worker. The submission has no legitimate need for the
# parent's env (no proxy vars, no creds, no PATH leakage). This is the no-network
# posture at Stage 1: nothing in the env points the worker at a network endpoint.
# True egress blocking is the Confidential Space VPC's job in the deployed enclave;
# on the laptop we minimize what the worker inherits and rely on the no-net spec
# contract (the submission interface is pure: signal(prices) -> label).
WORKER_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"}
WORKER = os.path.join(HERE, "worker.py")
# Private series location. Local dev resolves it under maker/; the Confidential Space
# image bakes it next to the entrypoint and points PRIVATE_SERIES at that copy. Override
# via env so the same scorer.py runs unmodified in both places (no forked file).
PRIVATE = os.environ.get(
    "PRIVATE_SERIES",
    os.path.join(
        HERE, "..", "maker", "bounties", "uniswap-lp-trading-bot", "private", "prices_private.json"
    ),
)


def private_prices():
    with open(PRIVATE) as f:
        return json.load(f)["prices"]


class WorkerError(Exception):
    """The worker reported an error reply, died, or desynced. The run is rejected (A3)."""


def score(submission_path: str, warmup: int = 20) -> int:
    # Resolve to absolute: the worker runs with a different cwd (HERE now, a sandbox temp
    # dir under A2), so a relative submission path would not resolve in the child.
    submission_path = os.path.abspath(submission_path)
    prices = private_prices()

    # Pipes: parent writes prefixes to the worker's stdin; worker writes labels on the result
    # channel. subprocess's pass_fds keeps the write-end open in the child but at WHATEVER
    # number it already has (not necessarily 3), and dup2-in-preexec_fn races the close_fds
    # sweep. So instead we pass the inherited fd NUMBER to the worker on argv -- no dup2, no
    # hardcoded 3, no preexec_fn (which is thread-unsafe). The worker writes labels there only;
    # the submission still owns stdout/stderr and cannot forge a label.
    r3_fd, w3_fd = os.pipe()
    proc = subprocess.Popen(
        [sys.executable, WORKER, submission_path, str(w3_fd)],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,  # submission owns stdout; we ignore it (no forged labels)
        stderr=subprocess.DEVNULL,
        pass_fds=(w3_fd,),
        cwd=HERE,
        env=WORKER_ENV,  # no-network posture: nothing in env points at a network endpoint
        start_new_session=True,  # own process group -> killpg reaps fork-bomb children too
    )
    os.close(w3_fd)  # parent keeps only the read end
    results = os.fdopen(r3_fd, "r")

    def kill_worker():
        # Kill the whole process group, not just the worker: a forking submission
        # leaves children that a bare proc.kill() would orphan.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    position = 0  # 1 = long, 0 = flat
    pnl = 0.0
    try:
        for i in range(warmup, len(prices)):
            prefix = prices[: i + 1]
            # Send one bar's prefix as NDJSON. A dead worker -> BrokenPipe -> rejected.
            try:
                proc.stdin.write((json.dumps({"prices": prefix}) + "\n").encode())
                proc.stdin.flush()
            except BrokenPipeError:
                raise WorkerError("worker closed stdin (died) at bar %d" % i)

            # Wall-clock deadline on the label read. A hanging signal() never replies;
            # select() times out, we kill the worker's group, and the run is rejected
            # (the parent decides reject -> score 0 in A3; here we raise WorkerError).
            ready, _, _ = select.select([results], [], [], BAR_DEADLINE_S)
            if not ready:
                kill_worker()
                raise WorkerError("worker exceeded %.0fs wall-clock at bar %d (killed)" % (BAR_DEADLINE_S, i))

            reply_line = results.readline()
            if reply_line == "":
                raise WorkerError("worker produced no label at bar %d (died/EOF)" % i)
            reply = json.loads(reply_line)
            if "error" in reply:
                raise WorkerError("worker error at bar %d: %s" % (i, reply["error"]))
            s = reply["label"]  # worker already validated it is one of buy/sell/hold

            if s == "buy":
                position = 1
            elif s == "sell":
                position = 0
            # "hold" keeps the current position
            ret = (prices[i] - prices[i - 1]) / prices[i - 1]
            pnl += position * ret
    finally:
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        results.close()
        # Graceful exit first (EOF on stdin -> worker returns 0). If it doesn't
        # die promptly, kill the whole group so nothing the submission forked
        # outlives the grade.
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            kill_worker()
            proc.wait(timeout=5)

    scaled = int(round(pnl * 100000))  # ~1% total return -> 1000
    return max(0, min(10000, scaled))


if __name__ == "__main__":
    print(score(sys.argv[1]))
