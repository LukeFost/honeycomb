"""Smoke test: count ERC-8004 events on Ethereum mainnet via BigQuery.

Standalone — `import bqenv` auto-resolves auth (repo-local .secrets/gcp-key.json) and
config (.env), so this runs with no manual env setup. Defaults to the 30-day window
(BQ_START); set BQ_START=2026-01-28 for full history (~191 GB scanned per count).
"""
import bqenv
from google.cloud import bigquery

DATASET = "bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs"
IDENTITY_REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"
REPUTATION_REGISTRY = "0x8004baa17c55a88189ae136b182e5fda19de9b63"
REGISTERED_EVENT = "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a"
FEEDBACK_EVENT = "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc"

client = bigquery.Client(project=bqenv.BILLING_PROJECT)


def count_events(address, event_topic):
    sql = f"""
        SELECT COUNT(*) AS n
        FROM `{DATASET}`
        WHERE address = @address
          AND topics[SAFE_OFFSET(0)] = @event
          AND block_timestamp >= TIMESTAMP(@start)
    """
    config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("address", "STRING", address),
        bigquery.ScalarQueryParameter("event", "STRING", event_topic),
        bigquery.ScalarQueryParameter("start", "STRING", bqenv.START),
    ])
    return next(iter(client.query(sql, job_config=config).result()))["n"]


if __name__ == "__main__":
    print("billing project:", client.project, "| window start:", bqenv.START)
    print("Agents registered:", count_events(IDENTITY_REGISTRY, REGISTERED_EVENT))
    print("Feedback events:  ", count_events(REPUTATION_REGISTRY, FEEDBACK_EVENT))
