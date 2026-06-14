# Cheat: tries to forge a high net_value instead of earning it.
#
# It opens no real position (or a trivial one) but monkeypatches the LP market's
# net_value property IN ITS OWN PROCESS so the Actuator's final_status reports a
# huge number. In the worker process this inflates the reported net_value.
#
# This is exactly what the scorer's "re-run and require agreement" check exists to
# catch: the trusted parent re-runs the SAME strategy in a SEPARATE process, where
# the same monkeypatch also fires -- but the parent does not trust the worker's
# number, it compares. Because BOTH processes run the cheat, both inflate, and...
# they AGREE. So this particular cheat is NOT caught by the agreement check alone.
#
# That is the honest finding the verify harness must surface: agreement catches a
# worker that tampers with the CHANNEL (lies about a number the strategy didn't
# produce), NOT a strategy that legitimately drives the Actuator to a high
# net_value via in-process patching. The latter is a VALIDITY problem -- the same
# split as the directional grader: the AI validity gate rejects code that games
# the harness instead of solving the task. The scorer reports the honest number it
# computes; "is this strategy cheating" is the validity gate's job, not the
# scorer's. (HARNESS_SPEC.md section 1: two independent gates.)
from decimal import Decimal

from demeter import Strategy, AtTimeTrigger
from demeter.uniswap.market import UniLpMarket

from lp_engine import MARKET_KEY

# Monkeypatch the method that builds the LP balance (which carries net_value) so
# every snapshot reports a huge number, regardless of the real position. Runs in
# whatever process imports the submission -- the worker AND the scorer's re-run.
_FORGED = Decimal("999999999")
_real_get_market_balance = UniLpMarket.get_market_balance


def _forged_get_market_balance(self):
    bal = _real_get_market_balance(self)
    bal.net_value = _FORGED
    return bal


UniLpMarket.get_market_balance = _forged_get_market_balance


class CheatStrategy(Strategy):
    def initialize(self):
        first_ts = self.data.default.index[0]
        self.triggers.append(AtTimeTrigger(time=first_ts, do=self._noop))

    def _noop(self, row_data):
        # Open a trivial position so the market is "used"; the forged net_value
        # dominates regardless.
        market = self.broker.markets[MARKET_KEY]
        price = market.market_status.data.price
        market.add_liquidity(price * Decimal("0.99"), price * Decimal("1.01"))


STRATEGY = CheatStrategy
