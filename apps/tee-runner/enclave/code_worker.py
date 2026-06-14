#!/usr/bin/env python3
# UNTRUSTED worker. Reads ONE job {code, input} from stdin, runs the user's Python program,
# and writes ONE result object on the parent-assigned result fd. Spawned exactly once per
# request by runner.py.
#
# This replaces the grading worker's signal()/per-bar loop with a generic exec-and-capture:
# there is no submission interface to honor, just "run this program, tell me what it printed
# and how it exited." The user code runs as a CHILD of this worker (a fresh python3 -c), not
# via exec() in-process, so:
#   - stdout / stderr / exit code are captured cleanly off the child's own fds;
#   - a sys.exit(), os._exit(), or hard crash in the user code cannot stop THIS worker from
#     writing its result line back to the parent;
#   - the user code never inherits the result fd (it is not in the child's pass_fds), so it
#     cannot forge a result.
#
# Protocol (one JSON object per line):
#   parent -> worker, on stdin:     {"code": "<python source>", "input": "<stdin for the program>"}\n
#   worker -> parent, on result fd: {"stdout","stderr","exitCode","durationMs"}\n
#                     or            {"error": "<reason>"}\n   (worker-level framing failure only)
# The result fd number is passed as argv[1] (the parent picks it). The user program owns its
# own stdout/stderr; the worker captures them and never lets the program touch the result fd.
import sys
import os
import json
import time
import subprocess

import sandbox  # A2 confinement: UID-drop + metadata-block applied to the user-code child

# Wall-clock cap for the user program. The parent (runner.py) arms its OWN select() deadline at
# RUN_DEADLINE_S and kills the process group on expiry. We set the worker's inner cap a hair
# SHORTER so the worker reliably wins the race: it catches the TimeoutExpired, SIGKILLs the
# child, and returns a clean {timedOut:true} result BEFORE the parent's deadline fires. If the
# two were equal they'd race, and a parent-side win leaves the worker still shutting down -- the
# parent then killpg's a just-exited (possibly recycled) pgid. Margin avoids that ambiguity.
_PARENT_DEADLINE_S = float(os.environ.get("RUN_DEADLINE_S", "30.0"))
CHILD_TIMEOUT_S = max(0.5, _PARENT_DEADLINE_S - 0.75)

# How much captured output we keep. A program that prints gigabytes must not OOM the worker
# or the result channel; truncate and flag it.
MAX_CAPTURE = int(os.environ.get("MAX_CAPTURE_BYTES", str(1 << 20)))  # 1 MiB each stream


def _truncate(b: bytes) -> str:
    if len(b) > MAX_CAPTURE:
        return b[:MAX_CAPTURE].decode("utf-8", "replace") + "\n...[truncated]"
    return b.decode("utf-8", "replace")


def main():
    result_fd = int(sys.argv[1])  # parent-assigned inherited fd for the result channel
    result = os.fdopen(result_fd, "w", buffering=1)  # line-buffered

    # Read the single job line. A malformed/absent job is a worker-level framing failure ->
    # tell the parent once and exit (distinct from a user program that ran and failed).
    try:
        line = sys.stdin.readline()
        job = json.loads(line)
        code = job["code"]
        stdin_input = job.get("input", "")
        if not isinstance(code, str):
            raise TypeError("code must be a string")
    except (ValueError, KeyError, TypeError) as e:
        result.write(json.dumps({"error": "protocol: " + repr(e)}) + "\n")
        result.flush()
        return 1

    # A2 confinement applied to the user-code child (NOT to this worker): UID-drop to an
    # unprivileged uid + an empty network namespace blocking the metadata server. Compute the
    # preexec hook first; if confinement is required but impossible, refuse loudly here rather
    # than running unconfined. (On a dev box with SANDBOX_ALLOW_UNSAFE=1 this returns None and
    # the run proceeds with a warning already printed to stderr.)
    try:
        preexec = sandbox.make_preexec()
    except RuntimeError as e:
        result.write(json.dumps({"error": "sandbox: " + repr(e)}) + "\n")
        result.flush()
        return 1

    # The child's env = the worker's already-scrubbed minimal env PLUS, in A3 "proxy" mode, the
    # HTTP(S)_PROXY vars so well-behaved clients route through the egress proxy automatically.
    # (Misbehaving clients that ignore the proxy env are still kernel-blocked by the iptables uid
    # rule the parent installed -- the proxy env is convenience, not the security boundary.)
    child_env = dict(os.environ)
    child_env.update(sandbox.child_proxy_env())

    # Run the user code as a child: `python3 -c <code>`. The child gets ONLY stdin/stdout/
    # stderr pipes -- not the result fd (close_fds defaults True, and we never pass it). The
    # preexec_fn runs after fork / before exec, so the child execs already UID-dropped and
    # netns/firewall-isolated. start_new_session in the preexec gives it its own group for killpg.
    started = time.monotonic()
    timed_out = False
    try:
        child = subprocess.run(
            [sys.executable, "-c", code],
            input=stdin_input.encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=CHILD_TIMEOUT_S,
            cwd=os.environ.get("USER_CODE_CWD", "/tmp"),
            preexec_fn=preexec,  # None on a dev box (unconfined, warned); the real cuts in the enclave
            env=child_env,
        )
        stdout, stderr, exit_code = child.stdout, child.stderr, child.returncode
    except subprocess.TimeoutExpired as e:
        timed_out = True
        stdout = e.stdout or b""
        stderr = e.stderr or b""
        exit_code = None

    duration_ms = int((time.monotonic() - started) * 1000)
    result.write(
        json.dumps(
            {
                "stdout": _truncate(stdout),
                "stderr": _truncate(stderr),
                "exitCode": exit_code,
                "durationMs": duration_ms,
                "timedOut": timed_out,
            }
        )
        + "\n"
    )
    result.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
