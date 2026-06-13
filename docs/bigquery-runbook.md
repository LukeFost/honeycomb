# Honeycomb — BigQuery store & refresh loop (runbook)

How the dashboard's Layer-1 ERC-8004 data is materialized in BigQuery and kept fresh.
Implements [`bigquery-dashboard-plan.md`](./bigquery-dashboard-plan.md).

## Architecture

```
Ethereum mainnet ERC-8004 logs (EF identity + reputation addresses)   ← raw data (44 GB+/scan)
        │  the loop: incremental MERGE since the watermark (cheap clustered tail)
        ▼
   honeycomb.* dataset (US)
     honeycomb.registrations, honeycomb.feedback     ← decoded events, append-only (idempotent on tx_hash+log_index)
     honeycomb.agent_trust (VIEW)                     ← sybil-discounted trust = analysis/erc8004_trust.csv
     honeycomb.refresh_log                            ← watermark + per-run telemetry
        │  serving read: SELECT * FROM honeycomb.agent_trust   (small: ~MB, ~free)
        ▼
   Next.js loaders (short-TTL cache) → dashboard + GET /api/agents /bounties /market /health
   POST /api/refresh = the loop trigger · POST /api/bigquery = on-demand live provenance
```

All SQL is generated from **`apps/web/src/lib/bq.ts`** (the single source of truth). The
ready-to-run DDL is committed at [`honeycomb-bigquery.sql`](./honeycomb-bigquery.sql).

## One-time setup

The dataset already exists for the baseline account. To (re)create it elsewhere:

1. **Auth.** Put a service-account key at `honeycomb/.secrets/gcp-key.json` (gitignored). It
   needs BigQuery Job User + Data Editor on the billing project. The dataset bills the key's
   project unless `BQ_BILLING_PROJECT` is set.
2. **Create the objects.** Run [`honeycomb-bigquery.sql`](./honeycomb-bigquery.sql) in the
   **US** region (BigQuery console, or `bq query --use_legacy_sql=false --location=US < docs/honeycomb-bigquery.sql`).
   It creates the schema, the three tables, the `refresh()` procedure, and the `agent_trust` view.
3. **Backfill** (one-time, scans ~85 GB/table over the window from `2026-05-14`):
   `curl -XPOST -H "x-refresh-token: $REFRESH_TOKEN" https://<host>/api/refresh`
   — on empty tables the watermark defaults to the window start, so the first run backfills,
   and every run after is the cheap tail. (A cold backfill via `CALL honeycomb.refresh()`
   needs the project's default bytes-billed ceiling raised; the app route sets its own high
   cap per job, so prefer it for the backfill.)

Verify: `SELECT * FROM honeycomb.agent_trust ORDER BY trust_score DESC` — agent `#34135`
(Surf AI) is the lone organic agent (trust 100); ~101 agents are the sybil ring at trust ≈5.

## The refresh loop

Pick one (both append only new events, idempotently; reads stay on the small view):

- **App route (recommended here):** Cloud Scheduler → `POST /api/refresh` every 15–30 min with
  the `REFRESH_TOKEN` as a Bearer / `x-refresh-token` header. Runs each table's MERGE as its own
  job with a high `maximumBytesBilled`, advances the watermark, and busts the read cache. Use
  `?mode=dryrun` to preview (note: the dry-run figure is a **conservative upper bound** —
  BigQuery can't price clustering pruning ahead of time, so it reports the whole month; the real
  run prunes to **< 1 GB**, logged per run in `honeycomb.refresh_log`).
- **BigQuery scheduled query (zero app infra):** a scheduled query whose body is
  `CALL `honeycomb`.refresh()`, every 15–30 min. Most BigQuery-native; steady-state incremental
  scans are well under the project's default cap.

**Watermark.** The loop scans `block_timestamp >= scan_from`, where `scan_from` is the last
`scanned_through` (or the backfill floor). Each run advances `scanned_through` to
`now − BQ_REFRESH_LAG_MINUTES` (default 120) — a buffer that re-scans recent time so late-landing
rows aren't missed (the MERGE de-dupes the overlap). This keeps scans cheap even though feedback
is sparse (a last-*event* watermark would re-scan a growing gap).

## Cost

- Backfill: ~85 GB/table, one-time. Incremental: **~0.8 GB/run** (clustered tail). At 30-min
  cadence ≈ 0.8 GB × 48/day ≈ a few hundred GB/month — within / near BigQuery's 1 TiB/mo free tier.
  Tune with cadence + `BQ_REFRESH_LAG_MINUTES`.
- The footgun the design avoids: never run the full extraction/scoring against the raw logs per
  request. Only the loop touches raw logs; the cache sits in front of the small `agent_trust` view.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `REFRESH_TOKEN` | — | **required** to enable `POST /api/refresh` (Bearer / `x-refresh-token`) |
| `BQ_BILLING_PROJECT` | key's project | bill a different project |
| `BQ_DATASET` | `honeycomb` | target dataset name |
| `BQ_LOCATION` | `US` | dataset region (match the public source) |
| `BQ_CACHE_TTL_MS` | `30000` | serving read cache TTL |
| `BQ_REFRESH_LAG_MINUTES` | `120` | watermark ingestion-lag buffer |
| `BQ_MAX_BYTES` | `2000000000000` | per-job bytes-billed cap for the refresh MERGEs |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | key path override (else auto-discovered) |
