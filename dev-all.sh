#!/usr/bin/env bash
# ============================================================================
# dev-all.sh — boot the whole Honeycomb stack locally (mainnet-pointed) and
# stream every service's output with a [label] prefix. Ctrl-C stops everything.
#
#   [facilitator]  x402 facilitator        :4021   (gates the grader VM summon)
#   [api]          honeycomb-api (MCP backend) :8787   (create/read/grade over HTTP)
#   [web]          dashboard               :3000/dashboard   (human view)
#
# Then, in separate terminals:
#   • full pipeline : cd apps/grading-cre && bash e2e-mainnet.sh
#   • MCP in Claude : install plugins/honeycomb, honeycomb_api_url=http://localhost:8787
# ============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVF=/home/thegnome/ethny2026/.env
CREDS=/home/thegnome/ethny2026/bigquerycreds.txt
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

ALCHEMY=$(grep -E "^ALCHEMY_API_KEY=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r\n " ')
MAINNET_RPC=${HONEYCOMB_RPC:-https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY}
MAKER_PK=0x$(grep -E "^REAL_MONEY_PKEY=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r\n " ' | tr -d 'z' | sed 's/^0x//')
INFER=$(grep -E "^INFERENCE_API_KEY_VAR=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r\n " ')
# Prefer a dedicated funded relayer (avoids maker nonce clashes); fall back to the maker.
RELAYER_PK=$([ -f /tmp/relayer.json ] && python3 -c "import json;print(json.load(open('/tmp/relayer.json'))[0]['private_key'])" 2>/dev/null || echo "$MAKER_PK")
API_TOKEN=${HONEYCOMB_API_TOKEN:-honeycomb-local-token}
ESCROW=0x90058162D3d55542f39507d0328538824A24C9C3   # mainnet e2e escrow

pids=()
cleanup(){ echo; echo "[dev-all] stopping all services..."; for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
  fuser -k 4021/tcp 8787/tcp 3000/tcp 2>/dev/null || true; exit 0; }
trap cleanup INT TERM

# free ports first (avoid stale listeners)
fuser -k 4021/tcp 8787/tcp 3000/tcp 2>/dev/null || true; sleep 1

echo "[dev-all] booting Honeycomb stack — mainnet escrow $ESCROW"
[ -n "$ALCHEMY" ] || echo "[dev-all] WARN: ALCHEMY_API_KEY empty (public RPC fallback will be slower/rate-limited)"
[ -f "$CREDS" ] || echo "[dev-all] WARN: $CREDS missing (BigQuery reads + KMS will fail)"

# (1) x402 facilitator :4021
( cd "$ROOT/apps/x402-facilitator" \
  && NETWORKS=eip155:1 RELAYER_PRIVATE_KEY="$RELAYER_PK" RPC_URL_EIP155_1="$MAINNET_RPC" PORT=4021 \
     bun run server.ts 2>&1 | sed -u "s/^/[facilitator] /" ) & pids+=($!)

# (2) honeycomb-api :8787 (the MCP backend; HONEYCOMB_CHAIN=mainnet -> e2e escrow)
( cd "$ROOT/apps/honeycomb-api" \
  && HONEYCOMB_CHAIN=mainnet HONEYCOMB_RPC="$MAINNET_RPC" HONEYCOMB_API_TOKEN="$API_TOKEN" \
     SEP_PRIVATE_KEY="$MAKER_PK" INFERENCE_API_KEY_VAR="$INFER" GOOGLE_APPLICATION_CREDENTIALS="$CREDS" PORT=8787 \
     bun server.ts 2>&1 | sed -u "s/^/[api] /" ) & pids+=($!)

# (3) dashboard :3000 (reads BigQuery; Layer-2 escrow = the e2e escrow)
( cd "$ROOT/apps/web" \
  && GOOGLE_APPLICATION_CREDENTIALS="$CREDS" BQ_DATASET=honeycomb_mainnet BQ_LOGS_TABLE=honeycomb_mainnet.logs \
     BQ_ESCROW_ADDRESS="$ESCROW" REFRESH_TOKEN="$API_TOKEN" BQ_CACHE_TTL_MS=2000 \
     ./node_modules/.bin/next dev -p 3000 2>&1 | sed -u "s/^/[web] /" ) & pids+=($!)

sleep 6
echo "[dev-all] ──────────────────────────────────────────────────────────────"
echo "[dev-all] facilitator : http://localhost:4021/health"
echo "[dev-all] api (MCP)   : http://localhost:8787   (writes need HONEYCOMB_API_TOKEN=$API_TOKEN)"
echo "[dev-all] dashboard   : http://localhost:3000/dashboard"
echo "[dev-all] MCP shim    : install plugins/honeycomb, set honeycomb_api_url=http://localhost:8787"
echo "[dev-all] pipeline    : cd apps/grading-cre && bash e2e-mainnet.sh"
echo "[dev-all] (Layer-2 dashboard needs escrow logs indexed into BQ — see tools/chain-verify)"
echo "[dev-all] Ctrl-C to stop all. Streaming labeled output below:"
echo "[dev-all] ──────────────────────────────────────────────────────────────"
wait
