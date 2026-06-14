"""
Generate the held-out Demeter-format pool DataFrame for a WETH/USDC 0.05%
pool over ~3 days of hourly bars, and save it as pool_private.csv next to
this file. This is the PRIVATE data the LP backtest is scored against;
deterministic (seed 42) so the committed CSV is reproducible.

Token layout (matches the real mainnet USDC/WETH 0.05% pool):
    token0 = USDC (6 decimals)
    token1 = WETH (18 decimals)
    quote  = USDC   -> is_token0_quote = True
    price unit = USDC per WETH  (~3000)
    fee passed to UniV3Pool = 0.05  (PERCENT units -> fee_rate 0.05%, tick_spacing 10)

The price follows a random walk around $3000 so that a full-range LP and a
tight-range LP score differently. inAmount0/inAmount1/volume0/volume1 are
nonzero on every bar so swap fees actually accrue.

The CSV is self-contained: every column UniLpMarket reads at backtest time is
precomputed here (price/open/low/high/volume0/volume1), because demeter only
runs its _add_statistic_column inside load_uni_v3_data, which we bypass by
assigning market.data directly.
"""

import os
from decimal import Decimal, getcontext

import numpy as np
import pandas as pd

from demeter import TokenInfo
from demeter.uniswap import (
    UniV3Pool,
    base_unit_price_to_tick,
    tick_to_base_unit_price,
    nearest_usable_tick,
)

getcontext().prec = 50

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pool_private.csv")

# Pool definition -----------------------------------------------------------
USDC = TokenInfo("USDC", 6)   # token0
WETH = TokenInfo("WETH", 18)  # token1
POOL = UniV3Pool(USDC, WETH, 0.05, USDC)  # fee in PERCENT -> tick_spacing 10, fee_rate 0.0005

DEC0 = POOL.token0.decimal           # 6
DEC1 = POOL.token1.decimal           # 18
IS_T0_QUOTE = POOL.is_token0_quote   # True
TICK_SPACING = POOL.tick_spacing     # 10


def price_to_close_tick(price: float) -> int:
    """USDC-per-WETH price -> usable closeTick."""
    raw = base_unit_price_to_tick(Decimal(str(price)), DEC0, DEC1, IS_T0_QUOTE)
    return nearest_usable_tick(int(raw), TICK_SPACING)


def tick_to_price(tick: int) -> Decimal:
    return tick_to_base_unit_price(int(tick), DEC0, DEC1, IS_T0_QUOTE)


def main():
    rng = np.random.default_rng(42)

    n_bars = 3 * 24  # 3 days hourly = 72 bars
    start = pd.Timestamp("2024-01-01 00:00:00")
    index = pd.date_range(start=start, periods=n_bars, freq="1h")

    # --- random-walk price path around 3000 -------------------------------
    p0 = 3000.0
    # hourly log-returns, ~1.2% hourly vol; mild so price mostly stays within
    # a +/-10% band but occasionally pokes outside a +/-2% band.
    rets = rng.normal(loc=0.0, scale=0.012, size=n_bars)
    log_path = np.cumsum(rets)
    close_prices = p0 * np.exp(log_path)

    rows = []
    prev_close_tick = price_to_close_tick(p0)
    for i, ts in enumerate(index):
        close_price = float(close_prices[i])
        close_tick = price_to_close_tick(close_price)

        # open tick = previous bar's close tick (price column is close.shift(1))
        open_tick = prev_close_tick

        # intrabar low/high ticks: widen around open/close by a few spacings
        wig = rng.integers(1, 4) * TICK_SPACING
        lo_t = min(open_tick, close_tick) - int(wig)
        hi_t = max(open_tick, close_tick) + int(wig)
        lowest_tick = nearest_usable_tick(lo_t, TICK_SPACING)
        highest_tick = nearest_usable_tick(hi_t, TICK_SPACING)

        # --- swap volumes (atomic units) so fees accrue -----------------
        # token0 = USDC (6 dec), token1 = WETH (18 dec).
        # Per-bar swap volume scales with random activity.
        usdc_vol = float(rng.uniform(2.0e5, 1.2e6))      # 200k - 1.2M USDC
        weth_vol = usdc_vol / close_price                # equivalent WETH

        in_amount0 = int(usdc_vol * 10**DEC0)            # USDC atomic in
        in_amount1 = int(weth_vol * 10**DEC1)            # WETH atomic in

        # net amounts: signed flow, smaller than gross in-amounts
        net_amount0 = int(in_amount0 * float(rng.uniform(-0.3, 0.3)))
        net_amount1 = int(in_amount1 * float(rng.uniform(-0.3, 0.3)))

        # pool-wide active liquidity (atomic L). Real USDC/WETH 0.05% pool is
        # order 1e16-1e17. Use a steady large value so position fee share is
        # small but nonzero.
        current_liquidity = int(2.0e16 + rng.uniform(-2e15, 2e15))

        # --- precomputed price columns (USDC per WETH) -------------------
        close_p = tick_to_price(close_tick)
        # demeter convention: price at start of bar = previous bar's close.
        price_p = tick_to_price(open_tick)
        low_p = tick_to_price(highest_tick)   # higher tick -> lower USDC/WETH price
        high_p = tick_to_price(lowest_tick)   # lower tick  -> higher USDC/WETH price
        open_p = tick_to_price(open_tick)

        volume0 = Decimal(in_amount0) / Decimal(10**DEC0)
        volume1 = Decimal(in_amount1) / Decimal(10**DEC1)

        rows.append(
            {
                "timestamp": ts,
                "netAmount0": net_amount0,
                "netAmount1": net_amount1,
                "closeTick": close_tick,
                "openTick": open_tick,
                "lowestTick": lowest_tick,
                "highestTick": highest_tick,
                "inAmount0": in_amount0,
                "inAmount1": in_amount1,
                "currentLiquidity": current_liquidity,
                "open": open_p,
                "price": price_p,
                "low": low_p,
                "high": high_p,
                "volume0": volume0,
                "volume1": volume1,
            }
        )
        prev_close_tick = close_tick

    df = pd.DataFrame(rows)
    df.to_csv(OUT_PATH, index=False)

    price_series = df["price"].astype(float)
    print(f"wrote {OUT_PATH}  ({len(df)} hourly bars)")
    print(f"price range USDC/WETH: {price_series.min():.2f} .. {price_series.max():.2f}")
    print(f"first price {price_series.iloc[0]:.2f}  last price {price_series.iloc[-1]:.2f}")
    print("columns:", list(df.columns))


if __name__ == "__main__":
    main()
