#!/usr/bin/env python3
# UNTRUSTED worker. Runs one submission's on_bar() in this process and nowhere else.
#
# Lifecycle: spawned EXACTLY ONCE per submission by scorer.py. Imports the submission
# once, then streams per-bar snapshots for the whole walk through this one live process,
# so module-level state in the submission persists across bars -- identical to what the
# old in-process scoring did. (One-process-per-bar would reset state every bar and
# misscore any stateful submission. Do not "optimize" this into per-bar spawns.)
#
# Protocol (NDJSON, one object per line):
#   parent -> worker, on stdin:     {"snapshot": {"price":..,"tick":..,"i":..}}\n  (one per bar)
#   worker -> parent, on result fd: {"action": "hold"|"remove_all"|"rebalance"|...}\n (one reply per bar)
#                     or            {"action": "add_by_tick", "lower_tick": int, "upper_tick": int}\n
#                     or            {"error": "<reason>"}\n  (on_bar raised / bad output)
# The result fd number is passed as argv[2] (the parent picks it; conventionally 3 but the
# parent decides). The submission owns stdout/stderr; the parent ignores them, so a
# submission cannot forge an action by printing.
import sys
import os
import json
import importlib.util

VALID_ACTIONS = ("add_by_tick", "remove_all", "rebalance", "hold")


def _load_on_bar(path):
    spec = importlib.util.spec_from_file_location("submission", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # runs untrusted module top-level once, in THIS jailed process
    return mod.on_bar


def _validate_action(reply):
    """Return (action_dict, error_str). Exactly one of them is None."""
    if not isinstance(reply, dict):
        return None, "on_bar must return a dict, got %r" % type(reply).__name__
    action = reply.get("action")
    if action not in VALID_ACTIONS:
        return None, "bad action: %r (must be one of %s)" % (action, VALID_ACTIONS)
    if action == "add_by_tick":
        lt = reply.get("lower_tick")
        ut = reply.get("upper_tick")
        if not isinstance(lt, int) or not isinstance(ut, int):
            return None, "add_by_tick requires int lower_tick and upper_tick"
        if lt >= ut:
            return None, "add_by_tick requires lower_tick < upper_tick, got %d >= %d" % (lt, ut)
        if lt % 10 != 0 or ut % 10 != 0:
            return None, "add_by_tick ticks must be multiples of 10 (tick_spacing=10)"
        return {"action": "add_by_tick", "lower_tick": lt, "upper_tick": ut}, None
    return {"action": action}, None


def main():
    submission_path = sys.argv[1]
    result_fd = int(sys.argv[2])  # parent-assigned inherited fd for the action channel
    result = os.fdopen(result_fd, "w", buffering=1)  # line-buffered

    # Import failure is fatal for the whole submission -> tell the parent once and exit.
    try:
        on_bar = _load_on_bar(submission_path)
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
            snapshot = msg["snapshot"]
        except (ValueError, KeyError, TypeError) as e:
            # Malformed framing from the parent should not happen; fail loud, end the walk.
            result.write(json.dumps({"error": "protocol: " + repr(e)}) + "\n")
            result.flush()
            return 1

        # Per-bar isolation: an on_bar() that raises ends THIS bar with an error marker.
        # The parent decides what an error does to the run. We do not crash the walk
        # on a submission exception -- but a single error reply lets the parent reject.
        try:
            reply = on_bar(snapshot)
        except BaseException as e:  # noqa: BLE001 -- untrusted call
            result.write(json.dumps({"error": "on_bar: " + repr(e)}) + "\n")
            result.flush()
            return 1

        action_dict, err = _validate_action(reply)
        if err is not None:
            result.write(json.dumps({"error": "bad-action: " + err}) + "\n")
            result.flush()
            return 1

        result.write(json.dumps(action_dict) + "\n")
        result.flush()

    return 0


if __name__ == "__main__":
    sys.exit(main())
