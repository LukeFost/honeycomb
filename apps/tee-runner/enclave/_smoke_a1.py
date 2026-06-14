#!/usr/bin/env python3
# A1 functional smoke: drive runner.run() the way the daemon will. Not a unit-test suite,
# just a "does the real path behave" check (hackathon ethos: verify by running).
import json
import time
import runner

RUN_DEADLINE_OVERRIDE = None  # rely on runner's env-driven default


def check(name, code, stdin_input="", expect=None):
    t0 = time.monotonic()
    out = runner.run(code, stdin_input)
    dt = time.monotonic() - t0
    ok = expect(out) if expect else True
    print(f"[{'PASS' if ok else 'FAIL'}] {name}  ({dt:.1f}s wall)")
    print("       " + json.dumps(out)[:200])
    if not ok:
        raise SystemExit(f"FAILED: {name}")


# 1. clean program prints and exits 0
check(
    "hello",
    'print("hello from TEE")',
    expect=lambda o: o["exitCode"] == 0 and "hello from TEE" in o["stdout"] and not o["timedOut"],
)

# 2. stdin is passed through to the program
check(
    "stdin passthrough",
    'import sys; print("echo:" + sys.stdin.read().strip())',
    stdin_input="ping",
    expect=lambda o: "echo:ping" in o["stdout"],
)

# 3. a crash is a normal result with nonzero exit + traceback on stderr (NOT a WorkerError)
check(
    "uncaught exception",
    'raise ValueError("boom")',
    expect=lambda o: o["exitCode"] not in (0, None) and "ValueError: boom" in o["stderr"],
)

# 4. explicit nonzero exit code is reported
check(
    "sys.exit(7)",
    'import sys; sys.exit(7)',
    expect=lambda o: o["exitCode"] == 7,
)

# 5. infinite loop hits the wall-clock deadline -> timedOut, group killed, parent returns
check(
    "infinite loop -> deadline",
    'while True:\n    pass',
    expect=lambda o: o["timedOut"] is True and o["exitCode"] is None,
)

# 6. fork storm: backgrounded children hold stdout open, so the run blocks to the deadline
# and times out -- but the parent is NOT wedged (it returns a result) and killpg reaps the
# whole tree (verified separately: zero orphaned sleepers survive). A program that backgrounds
# children holding stdout legitimately hangs; the deadline + group-kill is the safety net.
check(
    "fork storm reaped (returns, not wedged)",
    'import os, time\nfor _ in range(10):\n    if os.fork() == 0:\n        time.sleep(60)\n        os._exit(0)\nprint("forked", flush=True)',
    expect=lambda o: o["timedOut"] is True,
)

print("\nA1 smoke: all checks passed.")
