# Honest recentering LP strategy.
# Provides liquidity in a symmetric band around the current tick.
# Recenters whenever price drifts more than DRIFT_THRESHOLD ticks from the
# band center, keeping capital active and following price. No file, network,
# clock, or future-bar access. Only stdlib math used.
#
# Band parameters (tick_spacing=10, WETH/USDC 0.05% pool):
#   HALF_WIDTH = 300 ticks (+/- 30 spacings) — wide enough to stay in range
#                for hours of normal volatility; narrow enough to concentrate
#                liquidity meaningfully more than full-range.
#   DRIFT_THRESHOLD = 150 ticks — recenter when price moves halfway to the
#                     band edge, keeping the position roughly centered.
# These are intentionally wider than the private window's realized range, so
# clean_lp generalizes to any window but earns less concentrated fees than a
# narrow, window-specific band.

HALF_WIDTH = 300          # ticks either side of center
DRIFT_THRESHOLD = 150     # ticks of drift from band center before recentering
TICK_SPACING = 10

# Module-level memo: center tick of the currently deployed band.
# None = no position yet (first bar).
_band_center = None


def _snap(tick: int) -> int:
    """Round tick to the nearest multiple of TICK_SPACING."""
    return round(tick / TICK_SPACING) * TICK_SPACING


def on_bar(snapshot: dict) -> dict:
    """
    snapshot keys:
        "price": float  — USDC per WETH
        "tick":  int    — current pool closeTick
        "i":     int    — bar index (0-based)

    Returns one action dict:
        {"action": "add_by_tick", "lower_tick": int, "upper_tick": int}
        {"action": "hold"}
    The scorer handles remove_all before re-adding when a fresh add_by_tick
    arrives while a position is already open.
    """
    global _band_center

    current_tick = snapshot["tick"]

    # First bar: establish the initial band.
    if _band_center is None:
        center = _snap(current_tick)
        _band_center = center
        return {
            "action": "add_by_tick",
            "lower_tick": center - HALF_WIDTH,
            "upper_tick": center + HALF_WIDTH,
        }

    # Subsequent bars: recenter if price has drifted beyond threshold.
    drift = abs(current_tick - _band_center)
    if drift > DRIFT_THRESHOLD:
        center = _snap(current_tick)
        _band_center = center
        return {
            "action": "add_by_tick",
            "lower_tick": center - HALF_WIDTH,
            "upper_tick": center + HALF_WIDTH,
        }

    return {"action": "hold"}
