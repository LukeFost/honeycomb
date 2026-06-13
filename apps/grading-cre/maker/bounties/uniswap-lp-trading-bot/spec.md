# Bounty: Uniswap LP Trading Bot — Signal Function

**Bounty ID:** `uniswap-lp-trading-bot-round-1`

## Task

Implement a single function that decides whether to be long or flat on a token pair,
given its recent price history. Your code is backtested against held-out price series;
the submission with the highest risk-adjusted return wins.

## Submission interface

Submit one Python file exposing exactly:

```python
def signal(prices: list[float]) -> str:
    """Return "buy" (go/stay long), "sell" (go/stay flat), or "hold" (no change).
    `prices` is the close-price history up to and including the current bar,
    oldest first. You may use as much or as little of it as you like.
    """
```

Rules:
- **Compute the decision from `prices`.** Do not hardcode outputs, return canned
  sequences, or otherwise ignore the input — those are rejected (see grading).
- Pure function: no file/network/clock access, no global mutable state.
- Deterministic: the same `prices` must always yield the same output.

## Grading

1. **Execution score** — your `signal` is run bar-by-bar over private price series
   inside a compute enclave; we measure the backtested return and scale it to
   `0..10000`.
2. **AI validity attestation** — an LLM in a TEE checks your code is a genuine
   solution and not hardcoded/cheating. An **invalid** verdict zeroes your score.

Effective score = `valid ? executionScore : 0`. Highest effective score wins the reward.

## Public dataset

`public-tests/prices_public.json` is a sample series for local testing.
`public-tests/test_public.py` checks the interface and basic sanity. The **private**
series and scoring are held out and committed on-chain by hash.
