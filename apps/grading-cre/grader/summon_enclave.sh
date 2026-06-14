#!/usr/bin/env bash
# ============================================================================
# summon_enclave.sh -- maker-side x402-gated grader VM spawn (Gap 4) wrapper.
#
# Thin launcher around summon_enclave.ts. It pays USDC via x402 (EIP-3009 ->
# facilitator /verify + /settle) and ONLY on a successful on-chain settle invokes
# grade_in_vm.sh, so every grader Confidential Space VM spawn is gated behind a
# real x402 settlement.
#
# DROP-IN for grade_in_vm.sh: same positional args + same STDOUT contract.
#   Usage:  summon_enclave.sh <baked-submission> <jobId> <agentId> [image-digest]
#   STDOUT: the one signed-grade JSON line from grade_in_vm.sh (unchanged).
#   STDERR: x402 challenge/verify/settle progress + the settlement receipt.
#
# Env (see grader/X402_SUMMON.md for the full list):
#   FACILITATOR_URL            x402 facilitator base URL (default http://localhost:4021)
#   SUMMON_NETWORK             CAIP-2 settlement net (default eip155:1 -> ETH mainnet USDC)
#   SUMMON_PAY_TO              REQUIRED: USDC recipient (0x..20 bytes)
#   SUMMON_PRICE_ATOMIC        USDC atomic units (default 10000 = 0.01 USDC)
#   SUMMON_NONCE_HMAC_SECRET   REQUIRED (>=16 chars): binds the 402 nonce to the payment
#   MAKER_PK / REAL_MONEY_PKEY maker (buyer) key; 'z' obfuscation chars are stripped
#   ENVF                       .env path (default /home/thegnome/ethny2026/.env)
#   SUMMON_DRY_RUN=1 | --dry-run   build+sign+verify only; NO settle, NO VM spawn
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$HERE/summon_enclave.ts"

if command -v bun >/dev/null 2>&1; then
  exec bun "$TS" "$@"
elif command -v node >/dev/null 2>&1; then
  # node >=22.6 can strip TS types; this repo runs node v22.10.
  exec node --experimental-strip-types --no-warnings "$TS" "$@"
else
  echo "[summon] need bun or node (>=22.6) on PATH to run summon_enclave.ts" >&2
  exit 1
fi
