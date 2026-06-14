"""ERC-8004 reputation reader for the Honeycomb MCP server.

Self-contained BigQuery auth + config (service-account key, billing project, window
start) is inlined below — analysis/bqenv.py was removed when that dir was stripped to
a dashboard, so this tool no longer depends on it. Emits one JSON object on stdout so
the TS MCP tool can shell out and parse it.

Subcommands:
  counts                       -> {agents_registered, feedback_events, window_start}
  feedback --agent <id>        -> recent NewFeedback rows for one agentId
  feedback                     -> recent NewFeedback rows across all agents
  leaderboard                  -> per-agent feedback count + latest score, top N

All decode logic mirrors the (former) analysis/extract_raw.py / query_example.py.
"""
import argparse
import json
import os
import pathlib

# --- BigQuery auth + config (inlined from the former analysis/bqenv.py) ------
# On import: load a .env searching this dir up to the repo root, then point
# GOOGLE_APPLICATION_CREDENTIALS at <repo>/.secrets/gcp-key.json if unset. The
# only secret is the gitignored JSON key. Billing project / window from env.
_HERE = pathlib.Path(__file__).resolve().parent


def _roots():
    """Yield this dir then ancestors, stopping at the git repo root."""
    yield _HERE
    for p in _HERE.parents:
        yield p
        if (p / ".git").is_dir():
            break


for _root in _roots():
    _envf = _root / ".env"
    if _envf.is_file():
        for _line in _envf.read_text().splitlines():
            _line = _line.strip()
            if not _line or _line.startswith("#") or "=" not in _line:
                continue
            _k, _v = _line.split("=", 1)
            _v = _v.strip()
            # Strip a MATCHED surrounding quote pair only -- not stray quotes
            # inside the value (e.g. a key containing a literal ").
            if len(_v) >= 2 and _v[0] == _v[-1] and _v[0] in "\"'":
                _v = _v[1:-1]
            os.environ.setdefault(_k.strip(), _v)
        break

if not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
    for _root in _roots():
        _key = _root / ".secrets" / "gcp-key.json"
        if _key.is_file():
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(_key)
            break

BILLING_PROJECT = os.environ.get("BQ_BILLING_PROJECT")  # unset -> client uses the key's project
START = os.environ.get("BQ_START", "2026-05-14")

from google.cloud import bigquery  # noqa: E402

DATASET = "bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs"
IDENTITY_REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"
REPUTATION_REGISTRY = "0x8004baa17c55a88189ae136b182e5fda19de9b63"
REGISTERED_EVENT = "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a"
FEEDBACK_EVENT = "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc"

_client = bigquery.Client(project=BILLING_PROJECT)


def _run(sql, params):
    cfg = bigquery.QueryJobConfig(query_parameters=params)
    return list(_client.query(sql, job_config=cfg).result())


def counts():
    sql = f"""
        SELECT
          COUNTIF(address = @identity AND topics[SAFE_OFFSET(0)] = @reg)  AS agents,
          COUNTIF(address = @rep      AND topics[SAFE_OFFSET(0)] = @fb)   AS feedback
        FROM `{DATASET}`
        WHERE block_timestamp >= TIMESTAMP(@start)
          AND address IN (@identity, @rep)
    """
    row = _run(sql, [
        bigquery.ScalarQueryParameter("identity", "STRING", IDENTITY_REGISTRY),
        bigquery.ScalarQueryParameter("rep", "STRING", REPUTATION_REGISTRY),
        bigquery.ScalarQueryParameter("reg", "STRING", REGISTERED_EVENT),
        bigquery.ScalarQueryParameter("fb", "STRING", FEEDBACK_EVENT),
        bigquery.ScalarQueryParameter("start", "STRING", START),
    ])[0]
    return {
        "agents_registered": row["agents"],
        "feedback_events": row["feedback"],
        "window_start": START,
    }


# raw_value / decimals decode positions mirror extract_raw.py.
_FEEDBACK_COLS = """
  SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64) AS agent_id,
  CONCAT("0x", SUBSTR(topics[SAFE_OFFSET(2)], 27)) AS client,
  SAFE_CAST(CONCAT("0x", SUBSTR(data, 67, 64)) AS INT64) AS raw_value,
  SAFE_CAST(CONCAT("0x", SUBSTR(data, 131, 64)) AS INT64) AS value_decimals,
  block_timestamp,
  transaction_hash
"""


def feedback(agent_id, limit):
    where_agent = "AND SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64) = @agent" if agent_id is not None else ""
    sql = f"""
        SELECT {_FEEDBACK_COLS}
        FROM `{DATASET}`
        WHERE address = @rep
          AND topics[SAFE_OFFSET(0)] = @fb
          AND block_timestamp >= TIMESTAMP(@start)
          {where_agent}
        ORDER BY block_timestamp DESC
        LIMIT @limit
    """
    params = [
        bigquery.ScalarQueryParameter("rep", "STRING", REPUTATION_REGISTRY),
        bigquery.ScalarQueryParameter("fb", "STRING", FEEDBACK_EVENT),
        bigquery.ScalarQueryParameter("start", "STRING", START),
        bigquery.ScalarQueryParameter("limit", "INT64", limit),
    ]
    if agent_id is not None:
        params.append(bigquery.ScalarQueryParameter("agent", "INT64", agent_id))
    rows = _run(sql, params)
    return {"window_start": START, "count": len(rows), "feedback": [
        {
            "agent_id": r["agent_id"],
            "client": r["client"],
            "raw_value": r["raw_value"],
            "value_decimals": r["value_decimals"],
            # value_decimals == 0 is a valid scale (score == raw_value), so gate
            # on `is not None`, not truthiness -- a 0-decimal row must still divide.
            "score": (r["raw_value"] / (10 ** r["value_decimals"]))
            if r["raw_value"] is not None and r["value_decimals"] is not None
            else r["raw_value"],
            "at": r["block_timestamp"].isoformat(),
            "tx": r["transaction_hash"],
        }
        for r in rows
    ]}


def leaderboard(limit):
    sql = f"""
        WITH fb AS (
          SELECT
            SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64) AS agent_id,
            SAFE_CAST(CONCAT("0x", SUBSTR(data, 67, 64)) AS INT64) AS raw_value,
            SAFE_CAST(CONCAT("0x", SUBSTR(data, 131, 64)) AS INT64) AS value_decimals,
            block_timestamp
          FROM `{DATASET}`
          WHERE address = @rep
            AND topics[SAFE_OFFSET(0)] = @fb
            AND block_timestamp >= TIMESTAMP(@start)
        )
        SELECT
          agent_id,
          COUNT(*) AS feedback_count,
          AVG(SAFE_DIVIDE(raw_value, POW(10, value_decimals))) AS avg_score,
          MAX(block_timestamp) AS last_at
        FROM fb
        WHERE agent_id IS NOT NULL
        GROUP BY agent_id
        ORDER BY feedback_count DESC, avg_score DESC
        LIMIT @limit
    """
    rows = _run(sql, [
        bigquery.ScalarQueryParameter("rep", "STRING", REPUTATION_REGISTRY),
        bigquery.ScalarQueryParameter("fb", "STRING", FEEDBACK_EVENT),
        bigquery.ScalarQueryParameter("start", "STRING", START),
        bigquery.ScalarQueryParameter("limit", "INT64", limit),
    ])
    return {"window_start": START, "count": len(rows), "leaderboard": [
        {
            "agent_id": r["agent_id"],
            "feedback_count": r["feedback_count"],
            "avg_score": r["avg_score"],
            "last_at": r["last_at"].isoformat() if r["last_at"] else None,
        }
        for r in rows
    ]}


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("counts")
    fb = sub.add_parser("feedback")
    fb.add_argument("--agent", type=int, default=None)
    fb.add_argument("--limit", type=int, default=25)
    lb = sub.add_parser("leaderboard")
    lb.add_argument("--limit", type=int, default=25)
    a = p.parse_args()

    if a.cmd == "counts":
        out = counts()
    elif a.cmd == "feedback":
        out = feedback(a.agent, a.limit)
    elif a.cmd == "leaderboard":
        out = leaderboard(a.limit)
    else:
        raise SystemExit(f"unknown cmd {a.cmd}")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
