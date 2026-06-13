# BENIGN stateful fixture -- not a cheat, a correctness probe.
# Carries module-level state across bars (a call counter + an incremental EMA). Its score
# is only reproducible if the worker is spawned ONCE per submission and the module persists
# across the whole walk. Under a (buggy) one-process-per-bar worker the counter resets to 1
# every bar and the score diverges. The A1 differential check asserts:
#     split-score(stateful.py) == in-process-score(stateful.py)
# i.e. the persistent-worker property holds. (clean.py/hardcoded.py are stateless and pass
# even with the per-bar bug, so they cannot catch this -- this fixture is the one that does.)
_calls = 0
_ema = None


def signal(prices):
    global _calls, _ema
    _calls += 1
    price = prices[-1]
    if _ema is None:
        _ema = price
    else:
        _ema = 0.3 * price + 0.7 * _ema
    # Behavior depends on accumulated state: long while price leads the slow EMA, but only
    # after a warmup measured in CALLS (state), not in series length (which the worker also
    # sees). On a per-bar-spawned worker _calls is always 1 -> the warmup gate never lifts ->
    # always flat -> score 0, diverging from the in-process score.
    if _calls < 5:
        return "hold"
    return "buy" if price > _ema else "sell"
