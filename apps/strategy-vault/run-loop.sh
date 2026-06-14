#!/usr/bin/env bash
# ============================================================================
# run-loop.sh — automatic "strategy box" via a centralized runner.
# ============================================================================
# Until Chainlink org DEPLOYMENT ACCESS is enabled (then `cre workflow deploy`
# hands execution to the DON), the workflow can still run AUTOMATICALLY by
# looping `cre workflow simulate --broadcast` on a schedule. Each iteration is a
# full, independent tick:
#     live Uniswap quote -> report (signed locally) -> KeystoneForwarder
#     -> StrategyVault.onReport -> REAL on-chain swap on Base.
#
# Trust model (honest):
#   • REAL + bounded:  the on-chain swap and the vault policy (caps/slippage/
#     allowlist/expiry/nonce). Worst case is bounded on-chain regardless.
#   • CENTRALIZED here: the trigger + report signing run on THIS box with your
#     key — NOT a decentralized DON. The DON-autonomous version is `cre workflow
#     deploy` once `cre account access` is granted (+ set expectedWorkflowId).
#
# ⚠ EACH TICK SPENDS REAL FUNDS (a real swap) while the strategy is the
#   always-swap stub. Build the A1 declarative strategy so ticks DECIDE (and
#   often do nothing) before running this unattended.
#
# Usage (from apps/strategy-vault):
#   INTERVAL=300 ./run-loop.sh          # one tick every 5 min
#   ENV_FILE=../../.env ./run-loop.sh   # where REAL_MONEY_PKEY / UNISWAP_API_KEY live
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-../../.env}"
INTERVAL="${INTERVAL:-300}"
export CRE_TARGET="${CRE_TARGET:-staging-settings}"

set -a; . "$ENV_FILE"; set +a
# Clean REAL_MONEY_PKEY (drop up to '0x', strip non-hex). Override by exporting
# CRE_ETH_PRIVATE_KEY (raw 64-hex, no 0x) before running.
if [ -z "${CRE_ETH_PRIVATE_KEY:-}" ]; then
  RAW="${REAL_MONEY_PKEY:?set REAL_MONEY_PKEY or CRE_ETH_PRIVATE_KEY}"
  HEX="${RAW#*0x}"; HEX="${HEX//[^0-9a-fA-F]/}"
  export CRE_ETH_PRIVATE_KEY="$HEX"
fi

echo "[loop] strategy box: one tick every ${INTERVAL}s — Ctrl-C to stop. EACH TICK IS A REAL SWAP."
while true; do
  echo "[loop] $(date -u '+%Y-%m-%dT%H:%M:%SZ') tick"
  cre workflow simulate strategy-workflow --non-interactive --trigger-index 0 --broadcast -e "$ENV_FILE" \
    2>&1 | grep -iE "live quote|write:|error|revert" || true
  sleep "$INTERVAL"
done
