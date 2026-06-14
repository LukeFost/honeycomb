# Honest LP strategy: open one +/-10% range position at the first bar and hold it.
# A reasonable-width range earns fees while staying in-range across normal moves.
from decimal import Decimal

from demeter import Strategy, AtTimeTrigger

from lp_engine import MARKET_KEY

RANGE_FRAC = Decimal("0.10")  # +/-10%


class CleanStrategy(Strategy):
    def initialize(self):
        first_ts = self.data.default.index[0]
        self.triggers.append(AtTimeTrigger(time=first_ts, do=self._open_position))

    def _open_position(self, row_data):
        market = self.broker.markets[MARKET_KEY]
        price = market.market_status.data.price  # USDC per WETH
        lower = price * (Decimal(1) - RANGE_FRAC)
        upper = price * (Decimal(1) + RANGE_FRAC)
        market.add_liquidity(lower, upper)


STRATEGY = CleanStrategy
