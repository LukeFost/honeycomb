#!/usr/bin/env python3
# Shared Demeter LP backtest engine. ONE implementation, called by both the
# untrusted worker (lp_worker.py) and the trusted scorer (lp_scorer.py), so the
# two cannot drift -- the trust model is "worker computes, scorer re-runs the
# IDENTICAL backtest and rejects on disagreement", which only holds if both run
# the same code over the same data.
#
# The backtest is a pure deterministic function of (strategy class, private pool
# CSV): no clock, no randomness, no network. The submission's only freedom is its
# own LP range/rebalance decisions -- the exact thing being scored. It cannot gain
# an edge by "seeing the future" because the whole series is fixed and the score
# is path-independent given the decisions. So the worker reporting net_value is
# safe: a worker that lies is caught by the scorer's re-run; a worker that picks a
# clever strategy is just... a good submission.
#
# net_value (final LP position value in USDC, incl. accrued fees minus IL) is the
# score, scaled to 0..10000 like the directional grader.
#
# Demeter API notes baked in here (each one cost a real debugging hour):
#   - UniV3Pool fee is in PERCENT (0.05), not fraction. -> tick_spacing 10.
#   - token0=USDC(6), token1=WETH(18), quote=USDC. price = USDC per WETH.
#   - tick columns MUST be python int, not numpy.int64: Decimal(numpy.int64)
#     raises TypeError inside V3CoreLib.update_fee when price crosses a boundary.
#   - atomic-unit + price columns load as Decimal via converters.
#   - market.data = df attaches data directly (skips load_uni_v3_data's
#     _add_statistic_column), so the CSV must already carry the price column.
#   - set_price(market.get_price_from_data()) -> net_value denominated in USDC.
import importlib.util
import os
from decimal import Decimal

import pandas as pd

from demeter import Actuator, TokenInfo, Asset, MarketInfo, MarketTypeEnum
from demeter.uniswap import UniV3Pool, UniLpMarket

# Market key shared by the engine and every submitted strategy. A submission's
# Strategy reaches its market via self.broker.markets[MARKET_KEY].
MARKET_KEY = MarketInfo("lp", MarketTypeEnum.uniswap_v3)

# Pool definition -- MUST match make_pool_data.py that produced the private CSV.
USDC = TokenInfo("USDC", 6)   # token0
WETH = TokenInfo("WETH", 18)  # token1
POOL = UniV3Pool(USDC, WETH, 0.05, USDC)  # fee PERCENT -> tick_spacing 10

# Initial capital handed to every submission, identical across all of them so the
# score reflects the strategy, not the starting wallet.
INIT_WETH = Decimal("1")
INIT_USDC = Decimal("3000")

_DEC_INT_COLS = ["netAmount0", "netAmount1", "inAmount0", "inAmount1", "currentLiquidity"]
_DEC_PRICE_COLS = ["open", "price", "low", "high", "volume0", "volume1"]
_TICK_COLS = ["closeTick", "openTick", "lowestTick", "highestTick"]


def load_pool_df(csv_path: str) -> pd.DataFrame:
    converters = {c: Decimal for c in (_DEC_INT_COLS + _DEC_PRICE_COLS)}
    df = pd.read_csv(csv_path, converters=converters)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df.set_index("timestamp", inplace=True)
    # Force python ints (object dtype) on tick columns. See header note.
    for c in _TICK_COLS:
        df[c] = df[c].map(lambda x: int(x)).astype(object)
    return df


def load_strategy_class(submission_path: str):
    # Runs the untrusted module top-level once. In the worker this is the jailed
    # process; in the scorer's re-run it is the (separately spawned) re-run process.
    spec = importlib.util.spec_from_file_location("lp_submission", submission_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.STRATEGY


def run_backtest(submission_path: str, csv_path: str) -> float:
    """Run the submission's Demeter Strategy over the private pool data.

    Returns the final LP net_value in USDC (capital + fees - impermanent loss).
    Pure deterministic function of (submission, csv).
    """
    df = load_pool_df(csv_path)

    market = UniLpMarket(MARKET_KEY, POOL)
    market.data = df

    actuator = Actuator()
    actuator.broker.add_market(market)
    actuator.set_assets([Asset(WETH, INIT_WETH), Asset(USDC, INIT_USDC)])
    actuator.set_price(market.get_price_from_data())
    actuator.strategy = load_strategy_class(submission_path)()

    actuator.run(print_result=False)

    net_value = actuator.final_status.market_status[MARKET_KEY].net_value
    return float(net_value)


# Score = gain of the LP position over its starting capital, scaled into 0..10000.
# Initial capital is 1 WETH + 3000 USDC, ~6000 USDC at the opening price, so a
# strategy that just holds scores ~0 and one that earns net fees scores positive.
# GAIN_SCALE maps the realistic LP gain band onto the score band without pinning
# honest strategies at the ceiling (clean ~2400 gain, tight ~4400 gain on the
# fixture). A forged/runaway net_value still clamps to 10000 -- that is a validity
# problem (the AI gate rejects harness-gaming code), not a scorer problem.
INIT_CAPITAL_USDC = 6000.0
GAIN_SCALE = 2.0


def net_value_to_score(net_value: float) -> int:
    """LP net_value (USDC) -> 0..10000 integer score, by gain over starting capital."""
    gain = net_value - INIT_CAPITAL_USDC
    return max(0, min(10000, int(round(gain * GAIN_SCALE))))


def score(submission_path: str, csv_path: str) -> int:
    return net_value_to_score(run_backtest(os.path.abspath(submission_path), csv_path))
