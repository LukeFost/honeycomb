# PRIVATE backtest scorer — run by the execution enclave, never published.
# Walks the private series bar by bar, feeding each prefix to signal(); holds a
# long position while the latest signal is "buy", flat otherwise; sums returns.
# Final score is the backtested return scaled to 0..10000 (clamped).
import json
import os
import importlib.util

HERE = os.path.dirname(__file__)


def load_signal(path):
    spec = importlib.util.spec_from_file_location("submission", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.signal


def private_prices():
    with open(os.path.join(HERE, "prices_private.json")) as f:
        return json.load(f)["prices"]


def score(submission_path: str, warmup: int = 20) -> int:
    signal = load_signal(submission_path)
    prices = private_prices()
    position = 0  # 1 = long, 0 = flat
    pnl = 0.0
    for i in range(warmup, len(prices)):
        s = signal(prices[: i + 1])
        if s == "buy":
            position = 1
        elif s == "sell":
            position = 0
        # "hold" keeps the current position
        ret = (prices[i] - prices[i - 1]) / prices[i - 1]
        pnl += position * ret
    scaled = int(round(pnl * 100000))  # ~1% total return -> 1000
    return max(0, min(10000, scaled))


if __name__ == "__main__":
    import sys

    print(score(sys.argv[1]))
