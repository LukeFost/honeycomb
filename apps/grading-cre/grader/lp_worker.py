#!/usr/bin/env python3
# UNTRUSTED LP worker. Runs one submission's Demeter Strategy in this process and
# nowhere else, then reports the backtest net_value back to the trusted scorer.
#
# Unlike the directional worker (per-bar signal()->label streaming), the Demeter
# Actuator owns the bar walk, so the whole backtest runs in one call here. That is
# fine for the trust model: the backtest is a deterministic pure function of
# (strategy, private CSV), the submission cannot see the future or forge a number
# the scorer won't re-derive, and the scorer re-runs the identical backtest to
# catch a lying worker. See lp_engine.py's header for the full argument.
#
# Protocol (one JSON object on the result fd):
#   worker -> scorer, on result fd:  {"net_value": <float>}\n     (success)
#                     or             {"error": "<reason>"}\n        (import/run raised)
# argv: [submission_path, result_fd, csv_path]
# The submission owns stdout/stderr; the scorer ignores them, so a submission
# cannot forge a result by printing.
import os
import sys
import json

import lp_engine


def main():
    submission_path = sys.argv[1]
    result_fd = int(sys.argv[2])
    csv_path = sys.argv[3]
    result = os.fdopen(result_fd, "w", buffering=1)

    # The whole run (untrusted import + untrusted strategy callbacks driven by the
    # Actuator) is wrapped: any failure is reported once and the worker exits.
    try:
        net_value = lp_engine.run_backtest(submission_path, csv_path)
    except BaseException as e:  # noqa: BLE001 -- untrusted code, catch everything
        result.write(json.dumps({"error": repr(e)}) + "\n")
        result.flush()
        return 1

    result.write(json.dumps({"net_value": net_value}) + "\n")
    result.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
