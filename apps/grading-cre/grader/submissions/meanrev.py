# Mean-reversion: buy the dip — go long when price is below its 20-bar average
# (expecting reversion upward), otherwise exit. Computes the decision from the actual
# price series; nothing is hardcoded.
def signal(prices):
    long = sum(prices[-20:]) / 20
    return "buy" if prices[-1] < long else "sell"
