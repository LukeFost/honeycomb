# ERC-8004 Agent Economy — BigQuery analysis

Search / ranking / trust layer for **ERC-8004 trustless agents** on Ethereum mainnet, backed by Google BigQuery's public blockchain dataset.

## Data source

- Table: `bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs` (partitioned by **month**, clustered on `block_timestamp` only — filtering by contract address does **not** reduce bytes scanned).
- Identity Registry `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432` → `Registered` topic0 `0xca52e62c…449bc4a`
- Reputation Registry `0x8004baa17c55a88189ae136b182e5fda19de9b63` → `NewFeedback` topic0 `0x6a4a6174…5e58febc`
- History starts `2026-01-28`; addresses are lowercase; event signature = `topics[SAFE_OFFSET(0)]`.

## Account / auth / config

Everything is self-contained in this repo — no cross-repo paths:

- **Secret:** the service-account JSON key lives at `honeycomb/.secrets/gcp-key.json` (gitignored). That is the only secret — and it carries its own project id, so queries bill to the right project with nothing hardcoded.
- `bqenv.py` auto-discovers that key and loads `.env`, so every script and the notebook run with **no manual `export`**.
- **Config:** set `BQ_BILLING_PROJECT` (only if you want to bill a project other than the key's), `BQ_START`, `BQ_MAX_BYTES` in `.env` (copy `.env.example` → `.env`).

```bash
# only manual step: place the SA key at  honeycomb/.secrets/gcp-key.json
cp .env.example .env        # optional — override window / billing project
```

Cost: ~1 TiB of query processing per month is free, then ~$6.25/TiB. A 30-day windowed query scans ~44–80 GB; a full-history `COUNT` (`query_example.py` with `BQ_START=2026-01-28`) scans ~191 GB each. Dry-run before large scans.

## Setup

```bash
python -m venv .venv && .venv/bin/pip install \
  google-cloud-bigquery db-dtypes pyarrow pandas numpy matplotlib seaborn nbformat nbconvert ipykernel
```

## Pipeline (run from this directory)

```bash
# 0. (optional) smoke-test auth + access
.venv/bin/python query_example.py
# 1. notebook -> erc8004_{directory,adoption,leaderboard}.csv
.venv/bin/jupyter nbconvert --to notebook --execute --inplace erc8004_analysis.ipynb
# 2. raw event rows -> erc8004_{registrations,feedback}_raw.csv  (feeds trust scoring)
.venv/bin/python extract_raw.py
# 3. off-chain metadata -> erc8004_directory_resolved.csv  (network fetch, cached in .x402_cache.json)
.venv/bin/python resolve_x402.py
# 4. sybil / trust scoring -> erc8004_trust.csv
.venv/bin/python trust_score.py
# 5. charts + snapshot -> chart_*.png, erc8004_snapshot.md
.venv/bin/python make_charts.py && .venv/bin/python make_charts_resolved.py
```

`bqenv.py` handles auth/config for all of the above. `build_notebook.py` regenerates `erc8004_analysis.ipynb`; `extract_raw.py` produces the raw rows `trust_score.py` consumes.

## Headline findings (30-day window, May–Jun 2026)

- ~2,100 agents registered in the window; **51** have reputation feedback.
- Only **1** is confirmed x402-payable from on-chain metadata; most metadata lives off-chain (HTTPS/IPFS).
- Trust scoring flags a **single-wallet sybil ring** (`0x668add92…`) feeding **101 of 105** agents with reputation — only **Surf AI** (`#34135`) has an organic (≥5 independent reviewer) client base.

## Next

Point the dashboard / MCP (`apps/web`) at live BigQuery for bounty + reputation reads (Google Cloud track).
