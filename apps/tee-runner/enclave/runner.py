#!/usr/bin/env python3
# TRUSTED runner (parent). Spawns the untrusted user program in code_worker.py, a separate
# OS process, hands it the code + input ONCE, and reads back one result object. The user's
# code never runs in this process.
#
# This is a generalization of the grading enclave's scorer.py: same load-bearing spawn
# mechanics (own process group, pass_fds result channel, killpg reaping, select() wall-clock
# deadline) but the grading-specific bar-walk + signal() protocol is gone. The parent no
# longer streams price prefixes or computes PnL -- it just runs the program once and captures
# what it printed.
#
# A1 scope: the generic run + transport. The OS confinement (UID-drop, metadata block) is A2
# and the egress proxy is A3; here code_worker.py is a plain subprocess with network OFF by
# spec (nothing in its env points at a network endpoint). The fd-result channel + the
# spawn-ONCE lifecycle are wired now because they are the transport the later tracks build on.
import sys
import os
import json
import select
import signal
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))

# Wall-clock budget for one program. A program that hangs (infinite loop, sleep, blocking
# I/O) must not hang the daemon -- the parent arms a deadline on the result read and kills
# the worker's whole process group on expiry. Wall-clock, not CPU-seconds, so a sleeping
# program is caught too. Override via env for slower workloads.
RUN_DEADLINE_S = float(os.environ.get("RUN_DEADLINE_S", "30.0"))

# Minimal environment for the worker. The user's code has no legitimate need for the parent's
# env (no creds, no proxy vars, no PATH leakage). At A1 the no-network posture is the spec
# contract; A2/A3 enforce it with UID-drop + a netns/egress proxy.
#
# We forward a small allowlist of CONFIG vars (not secrets) the worker/sandbox need: the run
# deadline, the confinement controls, the working dir, and capture cap. These configure the
# worker's behavior; they are resource names / flags, not credentials. They do leak into the
# user-code child (it inherits the worker's env), which is harmless -- user code cannot change
# its own already-applied confinement, and KMS_* are just resource identifiers, never key
# material. Credentials reach the signer SIDECAR only, never this worker's env.
_FORWARD_ENV = (
    "RUN_DEADLINE_S",
    "MAX_CAPTURE_BYTES",
    "USER_CODE_CWD",
    "SANDBOX_USER",
    "SANDBOX_ALLOW_UNSAFE",
    "EGRESS_MODE",        # "block" (empty netns) | "proxy" (network on, firewalled to the proxy)
    "EGRESS_PROXY_HOST",  # where the egress proxy listens (proxy mode)
    "EGRESS_PROXY_PORT",
)
WORKER_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"}
for _k in _FORWARD_ENV:
    if _k in os.environ:
        WORKER_ENV[_k] = os.environ[_k]
WORKER = os.path.join(HERE, "code_worker.py")


class WorkerError(Exception):
    """The worker died, desynced, or blew the deadline. The run is rejected."""


def run(code: str, stdin_input: str = "") -> dict:
    """Run user `code` once in a child process; return {stdout, stderr, exitCode, durationMs,
    timedOut}. Raises WorkerError only if the transport itself fails (the child never replied)
    -- a program that crashes is a normal result with a nonzero exitCode, not a WorkerError."""
    # Pipes: parent writes the {code,input} job to the worker's stdin; worker writes its one
    # result object on the result channel. pass_fds keeps the write-end open in the child at
    # WHATEVER number it already has, and we pass that number on argv -- no dup2, no hardcoded
    # 3, no thread-unsafe preexec_fn. (Same trick scorer.py uses for the label channel.)
    r_fd, w_fd = os.pipe()
    proc = subprocess.Popen(
        [sys.executable, WORKER, str(w_fd)],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,  # the program owns stdout/stderr; we capture them in-worker
        stderr=subprocess.DEVNULL,
        pass_fds=(w_fd,),
        cwd=HERE,
        env=WORKER_ENV,
        start_new_session=True,  # own process group -> killpg reaps anything the program forks
    )
    os.close(w_fd)  # parent keeps only the read end
    results = os.fdopen(r_fd, "r")

    def kill_worker():
        # Kill the whole process group, not just the worker: a forking program leaves
        # children that a bare proc.kill() would orphan. Both errors below mean "nothing of
        # mine to kill here", so they are safe to swallow:
        #   ProcessLookupError -- the group is already gone (clean exit / earlier kill).
        #   PermissionError    -- the worker exited and its pgid was RECYCLED to an unrelated
        #                         process owned by another uid; killpg on it is EPERM. We must
        #                         not signal a stranger's group, and there is nothing of ours
        #                         left to reap, so treat it as done. (Seen on macOS when the
        #                         worker wins the timeout race and exits before the parent's
        #                         deadline fires.) The real reaping in the enclave is the
        #                         in-worker SIGKILL of the child plus this best-effort group kill.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    try:
        # Hand the whole job over once, then close stdin so the worker sees EOF and runs.
        job = json.dumps({"code": code, "input": stdin_input}) + "\n"
        try:
            proc.stdin.write(job.encode())
            proc.stdin.flush()
            proc.stdin.close()
        except BrokenPipeError:
            raise WorkerError("worker closed stdin before the job was sent (died on startup)")

        # Wall-clock deadline on the single result read. A program that never finishes never
        # replies; select() times out, we kill the group, and we return a timedOut result.
        ready, _, _ = select.select([results], [], [], RUN_DEADLINE_S)
        if not ready:
            kill_worker()
            return {
                "stdout": "",
                "stderr": "",
                "exitCode": None,
                "durationMs": int(RUN_DEADLINE_S * 1000),
                "timedOut": True,
            }

        reply_line = results.readline()
        if reply_line == "":
            raise WorkerError("worker produced no result (died/EOF before replying)")
        reply = json.loads(reply_line)
        if "error" in reply:
            # Transport-level worker error (couldn't read the job, framing broke). Distinct
            # from a user program that ran and exited nonzero.
            raise WorkerError("worker error: %s" % reply["error"])
        return {
            "stdout": reply["stdout"],
            "stderr": reply["stderr"],
            "exitCode": reply["exitCode"],
            "durationMs": reply["durationMs"],
            # Honor the worker's own timeout flag: when the INNER cap (code_worker's slightly
            # shorter CHILD_TIMEOUT_S) fires first, the worker SIGKILLs the child and replies
            # {timedOut:true, exitCode:null}. The parent only synthesizes its own timedOut
            # result on the select-deadline path above (worker never replied at all).
            "timedOut": bool(reply.get("timedOut", False)),
        }
    finally:
        results.close()
        # ALWAYS kill the whole process group, even after a clean worker exit. The worker runs
        # the user code as a grandchild; a program that fork()s backgrounded children leaves
        # them in this group, and the worker can reply + exit 0 while those grandchildren live
        # on. A bare proc.wait() would then see the worker gone and never reap them, orphaning
        # sleepers to init. start_new_session=True exists precisely so this killpg reaps the
        # whole tree -- so we do it unconditionally, not only on the wait-timeout path. It is
        # idempotent (ProcessLookupError swallowed) and harmless if everything already exited.
        kill_worker()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            kill_worker()
            proc.wait(timeout=5)


if __name__ == "__main__":
    # CLI smoke test: runner.py runs a program from a file (or stdin) and prints the result.
    src = open(sys.argv[1]).read() if len(sys.argv) > 1 else sys.stdin.read()
    print(json.dumps(run(src), indent=2))
