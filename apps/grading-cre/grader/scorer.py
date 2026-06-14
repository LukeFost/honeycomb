#!/usr/bin/env python3
# TRUSTED scorer (parent). Holds the private price series and all scoring math.
# The untrusted submission never runs in this process -- it runs in worker.py, a
# separate OS process that only ever sees one snapshot (price/tick/bar-index) at a
# time and hands back one action dict.
#
# Security split (preserved from the toy-PnL version):
#   parent (scorer.py) -> writes snapshot JSON on stdin -> worker.py loads on_bar()
#   -> worker writes action on fd-3 -> parent replays the action into demeter.
# The submission cannot forge a score (it produces no number; the parent drives demeter).
# The NO-PEEK property is satisfied BY CONSTRUCTION: the submission runs in the worker
# and receives only {"price", "tick", "i"} for the CURRENT bar. The demeter DataFrame
# and all future rows live exclusively in the trusted parent process. The worker
# boundary IS the no-peek boundary -- the untrusted on_bar never sees the DataFrame.
#
# Venv re-exec shim: grade.ts calls bare `python3 scorer.py`. demeter is NOT installed
# in the system Python; it lives in .demeter-venv. The shim at the top of __main__
# detects when demeter is absent and re-execs this same script under the venv's Python.
# This way grade.ts needs no changes and the shim adds a single re-exec at startup.

import sys
import os

# Re-exec shim: transparently switch to the demeter venv when demeter is not
# available in the current interpreter. Only fires once (DEMETER_REEXEC guard).
HERE = os.path.dirname(os.path.abspath(__file__))
VENV_PYTHON = os.path.join(HERE, ".demeter-venv", "bin", "python")

if os.environ.get("DEMETER_REEXEC") != "1":
    try:
        import demeter  # noqa: F401 -- just checking availability
    except ImportError:
        if os.path.exists(VENV_PYTHON):
            env = os.environ.copy()
            env["DEMETER_REEXEC"] = "1"
            os.execve(VENV_PYTHON, [VENV_PYTHON] + sys.argv, env)
        # If the venv Python doesn't exist either, fall through and let the
        # later `import demeter` raise a clear ImportError.

# Standard imports (after the re-exec so we're definitely in the right Python)
import json
import select
import signal
import subprocess
import logging
from datetime import date
from decimal import Decimal

from demeter import TokenInfo, Actuator, Strategy, Asset
from demeter.uniswap import UniV3Pool, UniLpMarket, load_uni_v3_data, get_price_from_data
from demeter.broker import MarketInfo

# Silence demeter's verbose progress output on stderr.
logging.disable(logging.CRITICAL)

# --- Config ---

# Per-bar wall-clock budget. An on_bar() that hangs (infinite loop, sleep,
# blocking I/O) must not hang the grader -- the parent arms a deadline on every
# action read and kills the worker's whole process group on expiry.
BAR_DEADLINE_S = 10.0

# Minimal environment for the worker. Submission has no legitimate need for
# the parent's env (no proxy vars, no creds, no PATH leakage).
WORKER_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"}
WORKER = os.path.join(HERE, "worker.py")

# Private data directory. The Confidential Space image bakes it next to the
# entrypoint and sets PRIVATE_DATA_DIR to that path. Override via env so the
# same scorer.py runs unmodified in both places.
PRIVATE_DATA_DIR = os.environ.get(
    "PRIVATE_DATA_DIR",
    os.path.join(HERE, "data", "private"),
)

# PRIVATE_SERIES is the FILE grade.ts and enclave_grade.py hash to build the
# content commitment: sha256(bountyId|submissionHash|privateSeriesHash|score).
# It must point at a real file inside the private window so the digest is a
# genuine commitment over the held-out data. We use the first day's CSV.
# grade.ts hardcodes a path under maker/bounties/.../private/prices_private.json;
# that file no longer exists. The env override lets the enclave (and CI) point
# PRIVATE_SERIES at the correct file without touching grade.ts.
# NOTE: grade.ts reads PRIVATE_SERIES at:
#   const PRIVATE_SERIES = join(HERE, "..", "maker", "bounties",
#       "uniswap-lp-trading-bot", "private", "prices_private.json");
# In Stage-1 local dev this resolves to a nonexistent path (pre-demeter era).
# The enclave (enclave_grade.py) reads its own PRIVATE_SERIES baked into the
# image. The digest commitment still covers the private data because we point
# PRIVATE_SERIES (via env) at the first-day CSV -- any change to the CSV
# changes the digest. This is documented for whoever provisions the enclave.
PRIVATE_SERIES = os.environ.get(
    "PRIVATE_SERIES",
    os.path.join(
        HERE, "data", "private",
        "ethereum-0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640-2025-06-03.minute.csv",
    ),
)

# Worker filesystem jail.
#
# The "no-peek by construction" guarantee covers the DATA channel: the worker
# gets per-bar snapshots over stdin and never a reference to the private
# DataFrame. It does NOT cover the filesystem -- a malicious on_bar() can open
# PRIVATE_DATA_DIR by absolute path and exfiltrate the held-out series over its
# own stdout. (Verified: a deny-network-only sandbox still leaked the CSVs.)
#
# Close exactly that vector: deny the worker any read of PRIVATE_DATA_DIR.
# sandbox-exec resolves symlinks + "../" before matching, so absolute, cwd-
# relative, and traversal paths all collapse to the same denied subpath. We
# leave the rest of the filesystem readable on purpose -- a deny-default
# file-read profile would have to enumerate every dyld/framework path the
# interpreter needs just to launch (and the homebrew Cellar path carries the
# exact python patch version), so it breaks on the next `brew upgrade`. The
# only secret on this box is the private data; denying that subpath is the
# whole job. The Linux Confidential Space enclave has no sandbox-exec; it gets
# its own hardening (landlock / non-root USER) -- this wrapper no-ops there so
# the same scorer.py runs unmodified in both places.
def _jail_cmd(cmd):
    """Prefix cmd with a macOS sandbox-exec jail denying reads of the private
    data dir. On platforms without sandbox-exec (Linux enclave) return cmd
    unchanged -- those rely on container-level isolation instead."""
    sb = "/usr/bin/sandbox-exec"
    if not os.path.exists(sb):
        return cmd
    private = os.path.realpath(PRIVATE_DATA_DIR)
    profile = (
        "(version 1)\n"
        "(allow default)\n"
        f'(deny file-read* (subpath "{private}"))\n'
    )
    return [sb, "-p", profile, *cmd]


# Uniswap pool: USDC/WETH 0.05% on Ethereum
# fee=0.05 -> tick_spacing = int(0.05*200) = 10, fee_rate = 0.0005
USDC = TokenInfo(name="USDC", decimal=6)
WETH = TokenInfo(name="WETH", decimal=18)
POOL = UniV3Pool(token0=USDC, token1=WETH, fee=0.05, quote_token=USDC)
POOL_ADDRESS = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"
CHAIN = "ethereum"

# Backtest dates: held-out private window (2 days, 2880 one-minute bars).
# Jun 3-4 is a RANGING window (-0.50% then +0.58%, net ~flat) chosen so final
# LP net value -- the honest backtest metric -- separates strategies without a
# directional-price confound. (Jun 5 was a -7.4% dump that zeroed every LP
# strategy on final value; it is excluded from the scored window.)
START_DATE = date(2025, 6, 3)
END_DATE   = date(2025, 6, 4)  # inclusive

# Initial portfolio for the backtest.
# Set so that both clean_lp and hardcoded_lp land in a sane 0..10000 range.
# WETH ~2500 USDC at the private window open; 50/50 split = 5000 USDC + 2 WETH.
INIT_USDC = Decimal("5000")
INIT_WETH = Decimal("2")

# Scoring formula (the spec's "net value from final_status"):
#   ret = (final_net_value - initial_net_value) / initial_net_value
#   score = clamp(int(round(ret * 100000)), 0, 10000)
# final_net_value = the portfolio's net value at the LAST bar of the backtest.
# The ranging Jun 3-4 window is chosen so this honest final-value metric
# separates the strategies: the cheat's tight band (overfit to this window's
# realized tick range) concentrates liquidity and accrues more fees, ending
# above the honest wider-band strategy.


class WorkerError(Exception):
    """The worker reported an error reply, died, or desynced. Score is 0."""


# Demeter Strategy (TRUSTED -- lives in this process, never runs submission code)
class _LPStrategy(Strategy):
    """
    Trusted Strategy subclass. demeter calls on_bar() once per bar with a
    demeter Snapshot. We extract {price, tick, i} from the Snapshot, send it
    to the worker over stdin, read back the action over fd-3, then REPLAY the
    action into the demeter market.

    The worker -- and by extension the submission -- never receives the full
    DataFrame, never receives future bars, and never touches the actuator or
    market directly. Only the three-key snapshot dict crosses the wire.
    """

    def __init__(self, market_key: MarketInfo, worker_proc, worker_results, kill_fn):
        super().__init__()
        self._mkt = market_key
        self._proc = worker_proc
        self._results = worker_results
        self._kill = kill_fn
        self._bar_index = 0

    def on_bar(self, snapshot):
        # Extract the minimum info needed by the submission (NO-PEEK: only
        # current bar, no future rows, no DataFrame reference).
        row = snapshot.market_status[self._mkt]  # pd.Series of current bar
        price = float(row["price"])
        tick = int(row["closeTick"])
        bar_dict = {"price": price, "tick": tick, "i": self._bar_index}
        self._bar_index += 1

        # Send the snapshot to the untrusted worker.
        try:
            self._proc.stdin.write((json.dumps({"snapshot": bar_dict}) + "\n").encode())
            self._proc.stdin.flush()
        except BrokenPipeError:
            raise WorkerError("worker closed stdin (died) at bar %d" % (self._bar_index - 1))

        # Wall-clock deadline: a hanging on_bar never replies; select() times
        # out, we kill the worker group, and the run raises WorkerError.
        ready, _, _ = select.select([self._results], [], [], BAR_DEADLINE_S)
        if not ready:
            self._kill()
            raise WorkerError(
                "worker exceeded %.0fs wall-clock at bar %d (killed)" % (BAR_DEADLINE_S, self._bar_index - 1)
            )

        reply_line = self._results.readline()
        if reply_line == "":
            raise WorkerError("worker produced no action at bar %d (died/EOF)" % (self._bar_index - 1))
        reply = json.loads(reply_line)
        if "error" in reply:
            raise WorkerError("worker error at bar %d: %s" % (self._bar_index - 1, reply["error"]))

        # Replay the validated action into demeter.
        action = reply["action"]
        mkt = self.markets[self._mkt]

        if action == "add_by_tick":
            lt = reply["lower_tick"]
            ut = reply["upper_tick"]
            # Remove any existing position first (semantics: re-add = reposition).
            mkt.remove_all_liquidity()
            # add_liquidity_by_tick(lower_tick, upper_tick, base_max_amount=None,
            #   quote_max_amount=None, sqrt_price_x96=-1, tick=-1, trim_tick=True)
            # Passing None for amounts uses full wallet balance of each token.
            mkt.add_liquidity_by_tick(lt, ut)

        elif action == "remove_all":
            mkt.remove_all_liquidity()

        elif action == "rebalance":
            # even_rebalance(price=None) -- uses pool price if None; pass the
            # current bar's price explicitly so there is no ambiguity.
            mkt.even_rebalance(Decimal(str(price)))

        elif action == "hold":
            pass  # do nothing

        # Any other value would have been rejected by the worker already.


def score(submission_path: str) -> int:
    """
    Run a demeter UniV3 LP backtest against the private window (2025-06-03..04).
    The untrusted submission's on_bar() runs in a separate worker process and
    receives only {price, tick, i} per bar -- the demeter DataFrame never crosses
    the trust boundary.

    Returns an integer 0..10000 where:
        0     = final return <= 0% (or worker error / invalid submission)
        10000 = final return >= 10%
    Scaling: ret = (final_net_value - init_net_value) / init_net_value
             score = clamp(round(ret * 100000), 0, 10000)
    "Final" = net_value at the LAST bar of the backtest (the spec's final_status).
    """
    submission_path = os.path.abspath(submission_path)

    # Build the demeter market with private data. The DataFrame is ONLY in
    # the trusted parent; the worker receives no reference to it.
    mkt_key = MarketInfo("lp")
    market = UniLpMarket(mkt_key, POOL)
    df = load_uni_v3_data(
        POOL, CHAIN, POOL_ADDRESS, START_DATE, END_DATE, PRIVATE_DATA_DIR
    )
    market.data = df

    # Spawn the untrusted worker ONCE. It will stream per-bar snapshots.
    r3_fd, w3_fd = os.pipe()
    proc = subprocess.Popen(
        _jail_cmd([sys.executable, WORKER, submission_path, str(w3_fd)]),
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,   # submission owns stdout; parent ignores it
        stderr=subprocess.DEVNULL,
        pass_fds=(w3_fd,),
        cwd=HERE,
        env=WORKER_ENV,
        start_new_session=True,      # own process group -> killpg reaps fork-bombs
    )
    os.close(w3_fd)  # parent keeps only the read end
    results = os.fdopen(r3_fd, "r")

    def kill_worker():
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    # Wire the actuator with the trusted Strategy.
    strategy = _LPStrategy(mkt_key, proc, results, kill_worker)

    actuator = Actuator()
    actuator.broker.add_market(market)
    # set_assets takes a List[Asset]
    actuator.set_assets([
        Asset(USDC, INIT_USDC),
        Asset(WETH, INIT_WETH),
    ])
    # set_price feeds the price series demeter uses to value the portfolio.
    # get_price_from_data returns (DataFrame, quote_token).
    actuator.set_price(get_price_from_data(df, POOL))
    actuator.strategy = strategy

    initial_net_value = float(INIT_USDC) + float(INIT_WETH) * float(df["price"].iloc[0])

    try:
        # run() calls strategy.on_bar() once per bar over the full df.
        actuator.run(print_result=False)
    except WorkerError:
        # Worker died or produced an invalid response. Score 0 -- honest.
        return 0
    finally:
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        results.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            kill_worker()
            proc.wait(timeout=5)

    # Final net value -- the spec's "net value from final_status".
    # account_status is a list of AccountStatus (one per bar); the LAST element
    # is the portfolio's net value at the end of the backtest. On the ranging
    # Jun 3-4 window this honest final-value metric separates the strategies:
    # the cheat's tight overfit band accrues more fees and ends higher than the
    # honest wider-band strategy.
    final_net_value = float(actuator.account_status[-1].net_value)

    # Fractional return from initial to final -> 0..10000 scale (same scaling
    # formula as the toy-PnL version: ret * 100000, clamp 0..10000).
    if initial_net_value <= 0:
        return 0
    ret = (final_net_value - initial_net_value) / initial_net_value
    scaled = int(round(ret * 100000))
    return max(0, min(10000, scaled))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: scorer.py <submission.py>", file=sys.stderr)
        sys.exit(1)
    print(score(sys.argv[1]))
