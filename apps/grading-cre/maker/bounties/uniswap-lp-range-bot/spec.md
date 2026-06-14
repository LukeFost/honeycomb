# Bounty: Uniswap LP Range Bot — Liquidity Strategy

**Bounty ID:** `uniswap-lp-range-bot-round-1`

## Task

Implement a Uniswap V3 liquidity-provision strategy. Your code decides where to
place (and optionally rebalance) a concentrated-liquidity position on a WETH/USDC
0.05% pool. It is backtested against a held-out pool data series with the
[Demeter](https://pypi.org/project/zelos-demeter/) engine; the submission with the
highest LP net value (capital + accrued fees − impermanent loss) wins.

## Submission interface

Submit one Python file exposing a `STRATEGY` symbol bound to a Demeter
`Strategy` subclass:

```python
from demeter import Strategy, AtTimeTrigger
from lp_engine import MARKET_KEY   # the grader's shared market key

class MyStrategy(Strategy):
    def initialize(self):
        # schedule your first action; the Actuator owns the bar walk
        first_ts = self.data.default.index[0]
        self.triggers.append(AtTimeTrigger(time=first_ts, do=self._open))

    def _open(self, row_data):
        market = self.broker.markets[MARKET_KEY]
        price = market.market_status.data.price   # USDC per WETH
        market.add_liquidity(price * 0.9, price * 1.1)   # your range here

STRATEGY = MyStrategy
```

You get 1 WETH + 3000 USDC of starting capital (identical for every submission).
Reach the market via `self.broker.markets[MARKET_KEY]`. Open/adjust positions with
`market.add_liquidity(lower_price, upper_price)` and Demeter's trigger API.

Rules:
- **Earn your net value by providing liquidity.** Do not patch the Demeter engine,
  forge the reported net value, or otherwise game the harness instead of running a
  real strategy — those are rejected by the validity gate.
- Pure/deterministic: no file/network/clock access. The same data must always
  yield the same net value.

## Grading

1. **Execution score** — your `STRATEGY` is run over a private pool data series
   inside a compute enclave via Demeter's `Actuator`. The final LP `net_value` is
   scaled to `0..10000` (by gain over starting capital).
2. **AI validity attestation** — an LLM in a TEE checks your code is a genuine
   strategy and not harness-gaming. An **invalid** verdict zeroes your score.

Effective score = `valid ? executionScore : 0`. Highest effective score wins.

### Trust model (how the enclave scores you safely)

Your strategy runs in an **untrusted worker** process that drives Demeter's
Actuator over the private pool data and reports its `net_value`. The **trusted
scorer** then re-runs the identical deterministic backtest and accepts the score
only if the worker's number agrees. A worker that tampers with the channel (lies
about a number the strategy didn't produce) is rejected; a strategy that games the
Actuator in-process scores honestly but is caught by the validity gate. The
private pool data is never reachable as a file by your code — you get the backtest,
never the series.

## Public dataset

`public-tests/pool_public.csv` is a sample pool series for local testing (same
schema as the private one). The **private** series is held out and committed
on-chain by hash.
