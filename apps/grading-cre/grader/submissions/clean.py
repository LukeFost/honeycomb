# SMA crossover signal: long when the short moving average is above the long one.
def signal(prices):
    short = sum(prices[-5:]) / 5
    long = sum(prices[-20:]) / 20
    return "buy" if short > long else "sell"
