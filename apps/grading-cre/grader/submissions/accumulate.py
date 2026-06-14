# ETH accumulation signal: accumulate (buy) while price is near/below its recent average,
# step aside (sell) only when it's stretched >3% above the 20-bar average. Fully computed
# from the price series — nothing hardcoded.
def signal(prices):
    avg = sum(prices[-20:]) / 20
    return "sell" if prices[-1] > avg * 1.03 else "buy"
