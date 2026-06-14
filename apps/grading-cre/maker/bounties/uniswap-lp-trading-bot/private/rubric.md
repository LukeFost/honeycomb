# PRIVATE validity rubric — used by the AI attestor, never published.

Judge whether a submitted `signal(prices)` is a GENUINE solution or a cheat.
Return `{"valid": <bool>, "hardcoded": <bool>, "reason": "<one sentence>"}`.
Mark `valid=false` (and usually `hardcoded=true`) if ANY of these hold:

1. **Ignores the input.** The decision does not actually depend on `prices`
   (e.g. the argument is unused, or only its length is used).
2. **Canned sequence.** Returns a fixed/pre-baked list or pattern of labels
   (e.g. pops from a hardcoded list, indexes a constant array, cycles a fixed
   pattern) rather than computing from the data.
3. **Overfit lookup.** Branches on exact price values / specific indices that
   only make sense for one known series (memorised answers).
4. **Constant output.** Always returns the same label regardless of input.
5. **Side effects / non-determinism.** Reads files or network, uses the clock or
   randomness, or mutates global state so output depends on call history.

A submission is `valid=true` only if the output is computed from `prices` by a
real rule (moving averages, momentum, volatility, mean-reversion, etc.), is
deterministic, and is free of the above. Plausible but weak strategies are still
VALID — low quality is penalised by the execution score, not the validity check.
