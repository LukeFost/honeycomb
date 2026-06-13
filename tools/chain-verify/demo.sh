#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────────────────────────────────────────────────
# Self-contained Honeycomb demo. Start an EMPTY dashboard, then seed it entirely from on-chain
# events emitted by mock contracts on a local Anvil chain — no stubbed/hardcoded data anywhere.
#
#   ./demo.sh up      # anvil + an empty honeycomb_demo dataset + the dashboard on :3000
#   ./demo.sh seed    # deploy mock contracts, emit a scenario, index → the dashboard populates
#   ./demo.sh down    # stop anvil + server, drop the demo dataset
#   ./demo.sh reset   # down, then up (fresh)
#
# Flow:  ./demo.sh up   → open http://localhost:3000  (empty: 0 agents, 0 bounties)
#        ./demo.sh seed → refresh the page            (populated from the smart contracts)
# ───────────────────────────────────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="$ROOT/tools/chain-verify"
CONTRACTS="$ROOT/contracts"
WEB="$ROOT/apps/web"
RUN="/tmp/honeycomb-demo"
RPC="http://127.0.0.1:8545"
PORT="${PORT:-3000}"
KEY_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # anvil dev acct #0

# Deterministic deploy addresses on a FRESH anvil (acct0 nonce 0 / 1):
REG="0x5fbdb2315678afecb367f032d93f642f64180aa3"   # MockErc8004 (Identity + Reputation)
ESC="0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"   # MockHoneycombEscrow

export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
export GOOGLE_APPLICATION_CREDENTIALS="$ROOT/.secrets/gcp-key.json"
# Demo wiring: the dashboard reads the honeycomb_demo dataset, and the decode/count SQL is
# pointed at OUR mock contracts (defaults are the real EF mainnet addresses).
export BQ_DATASET="honeycomb_demo"
export BQ_LOGS_TABLE="honeycomb_demo.logs"
export BQ_IDENTITY_REGISTRY="$REG"
export BQ_REPUTATION_REGISTRY="$REG"
export BQ_REPUTATION_TOPIC0="0x464064d02dd8555dc4a1d0316f1fecfc0f9f549816f9231af2f1d24dc78be894"
export BQ_VALIDATION_REGISTRY="$ESC"
export BQ_VALIDATION_TOPIC0="0x4c9b4b2b0502a4f8deaf051eea1568760ec7c9d24fc3a69ff8a0905f7a60fd43"
export BQ_START="1970-01-01"
export BQ_CACHE_TTL_MS="2000"   # short TTL so the page reflects the seed within ~2s

mkdir -p "$RUN"
tsx() { (cd "$HARNESS" && pnpm exec tsx "$@"); }

RPC_PROBE=(-X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}')
wait_http() { local url="$1"; shift; curl -s -o /dev/null --retry 90 --retry-connrefused --retry-delay 1 --max-time 180 "$@" "$url"; }
anvil_up()  { curl -s -o /dev/null --max-time 2 "${RPC_PROBE[@]}" "$RPC"; }

cmd_up() {
  if anvil_up; then echo "• anvil already running"; else
    nohup anvil --silent >"$RUN/anvil.log" 2>&1 & echo $! >"$RUN/anvil.pid"
    wait_http "$RPC" "${RPC_PROBE[@]}" || { echo "anvil didn't come up — see $RUN/anvil.log"; exit 1; }
    echo "• anvil up ($RPC)"
  fi

  echo "• (re)creating an EMPTY honeycomb_demo dataset…"
  tsx scripts/teardown-test-dataset.ts >/dev/null 2>&1 || true   # drop any prior seed → always start empty
  tsx scripts/setup-test-dataset.ts

  if curl -s -o /dev/null "http://localhost:$PORT"; then echo "• server already on :$PORT"; else
    (cd "$WEB" && nohup env \
      BQ_DATASET="$BQ_DATASET" BQ_LOGS_TABLE="$BQ_LOGS_TABLE" \
      BQ_IDENTITY_REGISTRY="$BQ_IDENTITY_REGISTRY" BQ_REPUTATION_REGISTRY="$BQ_REPUTATION_REGISTRY" \
      BQ_REPUTATION_TOPIC0="$BQ_REPUTATION_TOPIC0" \
      BQ_VALIDATION_REGISTRY="$BQ_VALIDATION_REGISTRY" BQ_VALIDATION_TOPIC0="$BQ_VALIDATION_TOPIC0" \
      BQ_START="$BQ_START" BQ_CACHE_TTL_MS="$BQ_CACHE_TTL_MS" \
      GOOGLE_APPLICATION_CREDENTIALS="$GOOGLE_APPLICATION_CREDENTIALS" \
      pnpm exec next dev -p "$PORT" >"$RUN/web.log" 2>&1 & echo $! >"$RUN/web.pid")
    echo "• dashboard starting on :$PORT…"
  fi
  wait_http "http://localhost:$PORT" || { echo "server didn't come up — see $RUN/web.log"; exit 1; }

  echo
  echo "✅ UP — open http://localhost:$PORT (it's EMPTY: 0 agents, 0 bounties)."
  echo "   Then:  $0 seed"
}

cmd_seed() {
  anvil_up || { echo "anvil isn't running — run '$0 up' first"; exit 1; }
  echo "1/4  deploy mock contracts + emit the on-chain scenario…"
  (cd "$CONTRACTS" && forge script script/DeployAndSeed.s.sol:DeployAndSeed \
      --rpc-url "$RPC" --private-key "$KEY_PK" --broadcast >"$RUN/seed.log" 2>&1) \
      || { echo "seed failed — see $RUN/seed.log"; exit 1; }
  echo "2/4  index raw ERC-8004 + escrow logs → $BQ_LOGS_TABLE…"
  tsx src/indexer.ts "$REG"
  tsx src/indexer.ts "$ESC"
  echo "3/4  decode escrow events → market tables…"
  tsx src/marketIndexer.ts "$ESC"
  echo "4/4  materialize Layer-1 (SQL decode → agent_trust view)…"
  tsx scripts/materialize.ts

  echo
  echo "✅ SEEDED — refresh http://localhost:$PORT (give it ~2s for the cache to roll)."
  echo "   Directory: a 10-wallet sybil ring flagged, organic agent #11 on top."
  echo "   Market: agent #11 leads on earned reputation; self-dealer #3 ≈ 0 despite a 97 enclave score."
}

cmd_down() {
  [ -f "$RUN/web.pid" ]   && kill "$(cat "$RUN/web.pid")"   2>/dev/null || true
  [ -f "$RUN/anvil.pid" ] && kill "$(cat "$RUN/anvil.pid")" 2>/dev/null || true
  pkill -f "next dev -p $PORT" 2>/dev/null || true
  tsx scripts/teardown-test-dataset.ts || true
  rm -f "$RUN"/*.pid
  echo "✅ DOWN — anvil + server stopped, honeycomb_demo dropped."
}

case "${1:-}" in
  up)    cmd_up ;;
  seed)  cmd_seed ;;
  down)  cmd_down ;;
  reset) cmd_down || true; cmd_up ;;
  *)     echo "usage: $0 {up|seed|down|reset}"; exit 1 ;;
esac
