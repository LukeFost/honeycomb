#!/usr/bin/env python3
# UNTRUSTED worker. Runs one submission's signal() in this process and nowhere else.
#
# Lifecycle: spawned EXACTLY ONCE per submission by scorer.py. Imports the submission
# once, then streams per-bar prefixes for the whole walk through this one live process,
# so module-level state in the submission persists across bars -- identical to what the
# old in-process scoring.py did. (One-process-per-bar would reset state every bar and
# misscore any stateful submission. Do not "optimize" this into per-bar spawns.)
#
# Protocol (NDJSON, one object per line):
#   parent -> worker, on stdin:     {"prices": [...]}\n          (one per bar)
#   worker -> parent, on result fd: {"label": "buy|sell|hold"}\n  (one reply per bar)
#                     or            {"error": "<reason>"}\n        (signal raised / bad output)
# The result fd number is passed as argv[2] (the parent picks it; conventionally 3 but the
# parent decides). The submission owns stdout/stderr; the parent ignores them, so a
# submission cannot forge a label by printing.
import sys
import os
import json
import importlib.util

LABELS = ("buy", "sell", "hold")


def _load_signal(path):
    spec = importlib.util.spec_from_file_location("submission", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # runs untrusted module top-level once, in THIS jailed process
    return mod.signal


def main():
    submission_path = sys.argv[1]
    result_fd = int(sys.argv[2])  # parent-assigned inherited fd for the label channel
    result = os.fdopen(result_fd, "w", buffering=1)  # line-buffered

    # Import failure is fatal for the whole submission -> tell the parent once and exit.
    try:
        signal = _load_signal(submission_path)
    except BaseException as e:  # noqa: BLE001 -- untrusted import, catch everything
        result.write(json.dumps({"error": "import: " + repr(e)}) + "\n")
        result.flush()
        return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            prices = msg["prices"]
        except (ValueError, KeyError, TypeError) as e:
            # Malformed framing from the parent should not happen; fail loud, end the walk.
            result.write(json.dumps({"error": "protocol: " + repr(e)}) + "\n")
            result.flush()
            return 1

        # Per-bar isolation: a signal() that raises ends THIS bar with an error marker.
        # The parent decides what an error does to the run (A3). We do not crash the walk
        # on a submission exception here -- but a single error reply lets the parent reject.
        try:
            label = signal(prices)
        except BaseException as e:  # noqa: BLE001 -- untrusted call
            result.write(json.dumps({"error": "signal: " + repr(e)}) + "\n")
            result.flush()
            return 1

        if label not in LABELS:
            result.write(json.dumps({"error": "bad-label: " + repr(label)}) + "\n")
            result.flush()
            return 1

        result.write(json.dumps({"label": label}) + "\n")
        result.flush()

    return 0


if __name__ == "__main__":
    sys.exit(main())
