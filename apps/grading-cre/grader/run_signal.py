#!/usr/bin/env python3
# Run a WINNING submission's signal() against REAL recent ETH/USD prices and print the
# decision. This is the bridge from "graded trading algo" -> "live on-chain action": the
# strategy-vault swaps USDC->WETH only when the winning algo says "buy".
#
# Prices: Coinbase public candles (keyless), hourly closes, chronological.
# Usage: python run_signal.py <submission.py> [granularity_seconds]
# Output (one JSON line): {"decision","n","last","short_sma","long_sma","source"}
import json
import sys
import urllib.request
import importlib.util


def fetch_eth_usd_closes(granularity: int = 3600):
    # Coinbase Exchange candles: [time, low, high, open, close, volume], newest first.
    url = f"https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity={granularity}"
    req = urllib.request.Request(url, headers={"User-Agent": "honeycomb-e2e"})
    with urllib.request.urlopen(req, timeout=20) as r:
        rows = json.load(r)
    rows.sort(key=lambda c: c[0])  # chronological
    return [float(c[4]) for c in rows]  # close prices


def load_signal(path: str):
    spec = importlib.util.spec_from_file_location("submission", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "signal"):
        raise SystemExit("submission has no signal(prices) function")
    return mod.signal


def main():
    path = sys.argv[1]
    gran = int(sys.argv[2]) if len(sys.argv) > 2 else 3600
    prices = fetch_eth_usd_closes(gran)
    sig = load_signal(path)
    decision = str(sig(prices)).strip().lower()
    out = {
        "decision": decision,
        "n": len(prices),
        "last": round(prices[-1], 2),
        "short_sma": round(sum(prices[-5:]) / 5, 2),
        "long_sma": round(sum(prices[-20:]) / 20, 2),
        "source": "coinbase:ETH-USD",
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
