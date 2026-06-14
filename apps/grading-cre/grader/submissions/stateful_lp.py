# BENIGN stateful fixture -- not a cheat, a correctness probe.
# Carries module-level state across bars (a call counter + a tick EMA). Its score
# is only reproducible if the worker is spawned ONCE per submission and the module
# persists across the whole walk. Under a (buggy) one-process-per-bar worker the
# counter resets to 1 every bar and the EMA-based band is always the same, so the
# score diverges from the in-process score.
#
# The A1 differential check asserts:
#     split-score(stateful_lp.py) == in-process-score(stateful_lp.py)
# i.e. the persistent-worker property holds. clean_lp.py and hardcoded_lp.py are
# also stateful (clean_lp tracks _band_center; hardcoded_lp tracks _added) BUT
# their state is simple enough that they would still produce the same score even
# with per-bar spawn -- this fixture is the one whose score changes.

_calls = 0
_tick_ema = None
_in_range = False

TICK_SPACING = 10
HALF_WIDTH = 200


def _snap(tick):
    return round(tick / TICK_SPACING) * TICK_SPACING


def on_bar(snapshot: dict) -> dict:
    """
    Uses a slow tick EMA for band placement. Warmup gate (_calls < 10): hold.
    After warmup: center LP band on EMA-smoothed tick.
    Under per-bar-spawn worker, _calls is always 1 and the EMA never warms up,
    producing a different band position and thus a different score.
    """
    global _calls, _tick_ema, _in_range

    _calls += 1
    tick = snapshot["tick"]

    if _tick_ema is None:
        _tick_ema = float(tick)
    else:
        _tick_ema = 0.05 * tick + 0.95 * _tick_ema

    # Warmup: hold until we have enough history for the EMA to settle.
    if _calls < 10:
        return {"action": "hold"}

    ema_center = _snap(int(_tick_ema))
    lower = ema_center - HALF_WIDTH
    upper = ema_center + HALF_WIDTH

    # Reposition: always re-add with the EMA-based band on every bar.
    # This is deliberately stateful: the exact band changes based on accumulated EMA.
    return {
        "action": "add_by_tick",
        "lower_tick": lower,
        "upper_tick": upper,
    }
