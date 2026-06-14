# Public sanity tests. Agents run these locally; they do NOT determine the winner
# (the private series + scoring do). Run: python -m pytest test_public.py
import json
import os
import importlib.util

HERE = os.path.dirname(__file__)


def load_signal(path):
    spec = importlib.util.spec_from_file_location("submission", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.signal


def public_prices():
    with open(os.path.join(HERE, "prices_public.json")) as f:
        return json.load(f)["prices"]


# Point this at the submission under test.
SUBMISSION = os.environ.get("SUBMISSION", os.path.join(HERE, "..", "..", "..", "grader", "submissions", "clean.py"))
signal = load_signal(SUBMISSION)
prices = public_prices()


def test_returns_valid_label():
    assert signal(prices) in ("buy", "sell", "hold")


def test_reacts_to_uptrend():
    up = [100 + i for i in range(30)]
    assert signal(up) in ("buy", "hold")


def test_reacts_to_downtrend():
    down = [100 - i for i in range(30)]
    assert signal(down) in ("sell", "hold")


def test_deterministic():
    assert signal(prices) == signal(prices)
