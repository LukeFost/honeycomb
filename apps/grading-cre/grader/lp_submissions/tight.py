# A different honest LP strategy: a tight +/-2% range. Earns more fees per dollar
# while price stays in the band, but goes fully one-sided (stops earning) and
# suffers more impermanent loss when price exits. Scores differently from clean.
from decimal import Decimal

from demeter import Strategy, AtTimeTrigger

from lp_engine import MARKET_KEY

RANGE_FRAC = Decimal("0.02")  # +/-2%


class TightStrategy(Strategy):
    def initialize(self):
        first_ts = self.data.default.index[0]
        self.triggers.append(AtTimeTrigger(time=first_ts, do=self._open_position))

    def _open_position(self, row_data):
        market = self.broker.markets[MARKET_KEY]
        price = market.market_status.data.price
        lower = price * (Decimal(1) - RANGE_FRAC)
        upper = price * (Decimal(1) + RANGE_FRAC)
        market.add_liquidity(lower, upper)


STRATEGY = TightStrategy
