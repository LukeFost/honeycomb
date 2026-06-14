#!/usr/bin/env bash
# ============================================================================
# cron_resolve.sh — point the CRE CRON resolver at a LIVE jobId, then print the
# exact (un-executed) CRE command that fires the time-based resolve.
#
# WHY: the CRON trigger (onResolveTick, trigger-index 1) carries no HTTP payload.
# It reads the bounty it settles from grading-workflow/config.mainnet.json's
# "jobId" field. So before the orchestrator fires the CRON resolve, that file
# must be rewritten to the bounty created this run.
#
# This script ONLY rewrites the jobId (preserving every other field) and PRINTS
# the command. It does NOT broadcast — the orchestrator runs the printed `cre`
# command itself (so it can capture/assert the resulting onReport tx).
#
# Usage:  cron_resolve.sh <jobId> [config-path]
#   <jobId>        the live bounty id (decimal) to settle via CRON
#   [config-path]  optional; defaults to the canonical config.mainnet.json
# ============================================================================
set -euo pipefail

GR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # apps/grading-cre
CFG="${2:-$GR/grading-workflow/config.mainnet.json}"

JOBID="${1:-}"
if [ -z "$JOBID" ]; then
  echo "usage: cron_resolve.sh <jobId> [config-path]" >&2
  exit 2
fi
# jobId must be a plain non-negative integer (it is encoded as uint256 on-chain).
case "$JOBID" in
  ''|*[!0-9]*) echo "✗ jobId must be a non-negative integer, got: '$JOBID'" >&2; exit 2 ;;
esac
[ -f "$CFG" ] || { echo "✗ config not found: $CFG" >&2; exit 2; }

# --- (a) rewrite ONLY config.jobId, preserving consumerAddress / chainSelectorName
#         ("ethereum-mainnet") / schedule / authorizedKeys, and keeping jobId a
#         JSON number (not a string). Uses python3 for a safe, key-order-stable edit.
python3 - "$CFG" "$JOBID" <<'PY'
import json, sys
cfg_path, job = sys.argv[1], int(sys.argv[2])
with open(cfg_path) as f:
    cfg = json.load(f)
cfg["jobId"] = job
with open(cfg_path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"✓ {cfg_path}: jobId -> {job} "
      f"(consumerAddress={cfg.get('consumerAddress')}, "
      f"chainSelectorName={cfg.get('chainSelectorName')}, "
      f"schedule={cfg.get('schedule')})", file=sys.stderr)
PY

# --- (b) print the exact CRE command for the time-based CRON resolve.
#         trigger-index 1 = onResolveTick (the CRON handler); action 2 = resolve.
#         Requires CRE_ETH_PRIVATE_KEY (maker key) in the environment.
#         Do NOT execute it here — the orchestrator runs it to capture the tx.
cat <<EOF
# --- CRON resolve (time-based; fire only AFTER the bounty deadline has passed) ---
# Run from: $GR   (with CRE_ETH_PRIVATE_KEY=<maker pk, no 0x> exported)
cre workflow simulate grading-workflow --non-interactive --target mainnet-settings --trigger-index 1 --broadcast
EOF
