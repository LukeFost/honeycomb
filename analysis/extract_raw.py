"""Extract row-level ERC-8004 events for the trust pipeline.

build_notebook.py only emits the *aggregated* directory/adoption/leaderboard CSVs.
trust_score.py needs the raw per-event rows, which were never committed. This script
fills that gap: it pulls one row per Registered / NewFeedback event in the window and
writes the two CSVs trust_score.py reads.

Outputs (same schema trust_score.py expects):
  erc8004_registrations_raw.csv  agent_id, owner, registered_at, reg_tx
  erc8004_feedback_raw.csv       agent_id, client, raw_value, value_decimals,
                                 block_timestamp, transaction_hash

Env:
  GOOGLE_APPLICATION_CREDENTIALS  service-account key
  BQ_BILLING_PROJECT              billing project (default: the service-account key's project)
  BQ_START                        window start (default 2026-05-14, the 30d window)
  BQ_MAX_BYTES                    per-query byte cap (default 100 GB; feedback_raw
                                  scans ~81 GB because of the transaction_hash column,
                                  so the notebook's 70 GB cap is too low here)
"""
import os
import bqenv  # noqa: F401 — loads .env + resolves GOOGLE_APPLICATION_CREDENTIALS to .secrets/gcp-key.json
from google.cloud import bigquery

BILLING_PROJECT = os.environ.get("BQ_BILLING_PROJECT")  # if unset, client uses the key's project
MAX_BYTES_BILLED = int(os.environ.get("BQ_MAX_BYTES", 100_000_000_000))  # 100 GB ceiling
START = os.environ.get("BQ_START", "2026-05-14")

LOGS = "bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs"
IDENTITY   = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"
REPUTATION = "0x8004baa17c55a88189ae136b182e5fda19de9b63"
TOPIC_REGISTERED  = "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a"
TOPIC_NEWFEEDBACK = "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc"

client = bigquery.Client(project=BILLING_PROJECT)


def q(sql):
    cfg = bigquery.QueryJobConfig(maximum_bytes_billed=MAX_BYTES_BILLED)
    job = client.query(sql, job_config=cfg)
    df = job.to_dataframe()
    gb = (job.total_bytes_billed or 0) / 1e9
    print(f"  billed {gb:.3f} GB  (~${gb/1000*6.25:.4f})  |  {len(df)} rows")
    return df


def main():
    print(f"billing project: {client.project}   window: {START} -> now")

    print("registrations_raw ...")
    reg = q(f"""
        SELECT
          SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)       AS agent_id,
          CONCAT("0x", SUBSTR(topics[SAFE_OFFSET(2)], 27)) AS owner,
          block_timestamp                                  AS registered_at,
          transaction_hash                                 AS reg_tx
        FROM `{LOGS}`
        WHERE address = "{IDENTITY}"
          AND topics[SAFE_OFFSET(0)] = "{TOPIC_REGISTERED}"
          AND block_timestamp >= TIMESTAMP "{START}"
        ORDER BY registered_at DESC
    """)
    reg.to_csv("erc8004_registrations_raw.csv", index=False)

    print("feedback_raw ...")
    fb = q(f"""
        SELECT
          SAFE_CAST(topics[SAFE_OFFSET(1)] AS INT64)              AS agent_id,
          CONCAT("0x", SUBSTR(topics[SAFE_OFFSET(2)], 27))        AS client,
          SAFE_CAST(CONCAT("0x", SUBSTR(data,  67, 64)) AS INT64) AS raw_value,
          SAFE_CAST(CONCAT("0x", SUBSTR(data, 131, 64)) AS INT64) AS value_decimals,
          block_timestamp,
          transaction_hash
        FROM `{LOGS}`
        WHERE address = "{REPUTATION}"
          AND topics[SAFE_OFFSET(0)] = "{TOPIC_NEWFEEDBACK}"
          AND block_timestamp >= TIMESTAMP "{START}"
          AND SUBSTR(data, 67, 1) != "f"
        ORDER BY block_timestamp
    """)
    fb.to_csv("erc8004_feedback_raw.csv", index=False)

    print(f"\nwrote erc8004_registrations_raw.csv ({len(reg)} rows, "
          f"{reg['agent_id'].nunique()} agents)")
    print(f"wrote erc8004_feedback_raw.csv ({len(fb)} rows, "
          f"{fb['agent_id'].nunique()} agents, {fb['client'].nunique()} clients)")


if __name__ == "__main__":
    main()
