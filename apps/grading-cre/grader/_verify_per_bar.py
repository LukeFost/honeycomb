#!/usr/bin/env python3
# Helper for verify_split.py check 4.
# Runs the BROKEN per-bar-spawn design: a fresh worker subprocess is spawned for
# EVERY bar instead of once for the whole backtest. Because stateful_lp.py relies
# on accumulated state across bars, its score diverges from the correctly-wired
# split scorer, proving the persistent-worker property has teeth.
#
# Must be run under .demeter-venv/bin/python (called by verify_split.py).
# Prints a single integer to stdout (the broken score).

import sys
import os
import json
import select
import signal
import subprocess
from decimal import Decimal
from datetime import date
import logging

logging.disable(logging.CRITICAL)

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "worker.py")

# Re-use scorer's config (pool, dates, initial assets, data dir) by importing it.
# We are already in the venv, so no re-exec shim fires.
os.environ["DEMETER_REEXEC"] = "1"
import importlib.util
spec = importlib.util.spec_from_file_location("scorer", os.path.join(HERE, "scorer.py"))
scorer_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorer_mod)
os.environ.pop("DEMETER_REEXEC", None)

sub_path = sys.argv[1]
sub_path_abs = os.path.abspath(sub_path)

mkt_key = scorer_mod.MarketInfo("lp")
df = scorer_mod.load_uni_v3_data(
    scorer_mod.POOL, scorer_mod.CHAIN, scorer_mod.POOL_ADDRESS,
    scorer_mod.START_DATE, scorer_mod.END_DATE, scorer_mod.PRIVATE_DATA_DIR,
)


class PerBarSpawnStrategy(scorer_mod.Strategy):
    """Spawn a fresh worker for EVERY bar (the broken design)."""

    def __init__(self):
        super().__init__()
        self._bar = 0

    def on_bar(self, snapshot):
        row = snapshot.market_status[mkt_key]
        price = float(row["price"])
        tick = int(row["closeTick"])
        bar_dict = {"price": price, "tick": tick, "i": self._bar}
        self._bar += 1

        r_fd, w_fd = os.pipe()
        proc = subprocess.Popen(
            [sys.executable, WORKER, sub_path_abs, str(w_fd)],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            pass_fds=(w_fd,),
            cwd=HERE,
            env=scorer_mod.WORKER_ENV,
            start_new_session=True,
        )
        os.close(w_fd)
        result_file = os.fdopen(r_fd, "r")

        proc.stdin.write((json.dumps({"snapshot": bar_dict}) + "\n").encode())
        proc.stdin.flush()

        ready, _, _ = select.select([result_file], [], [], scorer_mod.BAR_DEADLINE_S)
        if not ready:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            result_file.close()
            raise scorer_mod.WorkerError("per-bar worker hung at bar %d" % (self._bar - 1))

        reply_line = result_file.readline()
        result_file.close()
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        proc.wait(timeout=5)

        reply = json.loads(reply_line)
        if "error" in reply:
            raise scorer_mod.WorkerError("per-bar worker error: %s" % reply["error"])

        action = reply["action"]
        mkt = self.markets[mkt_key]
        if action == "add_by_tick":
            mkt.remove_all_liquidity()
            mkt.add_liquidity_by_tick(reply["lower_tick"], reply["upper_tick"])
        elif action == "remove_all":
            mkt.remove_all_liquidity()
        elif action == "rebalance":
            mkt.even_rebalance(Decimal(str(price)))
        # hold: pass


market = scorer_mod.UniLpMarket(mkt_key, scorer_mod.POOL)
market.data = df.copy()
actuator = scorer_mod.Actuator()
actuator.broker.add_market(market)
actuator.set_assets([
    scorer_mod.Asset(scorer_mod.USDC, scorer_mod.INIT_USDC),
    scorer_mod.Asset(scorer_mod.WETH, scorer_mod.INIT_WETH),
])
actuator.set_price(scorer_mod.get_price_from_data(df, scorer_mod.POOL))
actuator.strategy = PerBarSpawnStrategy()

initial_nv = float(scorer_mod.INIT_USDC) + float(scorer_mod.INIT_WETH) * float(df["price"].iloc[0])

try:
    actuator.run(print_result=False)
except scorer_mod.WorkerError:
    print(0)
    sys.exit(0)

peak_nv = max(float(s.net_value) for s in actuator.account_status)
if initial_nv <= 0:
    print(0)
    sys.exit(0)

ret = (peak_nv - initial_nv) / initial_nv
score = max(0, min(10000, int(round(ret * 100000))))
print(score)
