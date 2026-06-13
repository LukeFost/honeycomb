# Handoff → Riley (BigQuery)

1. Working pipeline in `analysis/`: queries ERC-8004 events from `bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs` (Identity reg `0x8004a169...`, Reputation `0x8004baa1...`). Billing goes to `foster-housing-connect` only; spent ~$2.41 / 386 GB total (under the 1 TB/mo free tier, net ~$0). Env: `analysis/.venv`.
2. The table is partitioned by MONTH not address, so every query scans ~70 GB (~$0.43). Use `BQ_START` to window and keep `BQ_MAX_BYTES` cap on (`q()` in `build_notebook.py`). Set billing to your coupon project before re-running.
3. Next: point the dashboard/MCP at live BQ for bounty + reputation reads (Google track). Trust scoring already done — `trust_score.py` flags the `0x668add...` single-wallet sybil ring (101 of 105 agents fed by it; only Surf AI is organic).
