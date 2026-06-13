// Re-export honeycomb's single source of truth for ERC-8004 addresses/topics + the BigQuery
// SQL (apps/web/src/lib/bq.ts). The harness runs the REAL production SQL — there is no
// vendored copy to drift. The §6 `LOGS_TABLE` override (point the decode/count SQL at a
// fixture table via BQ_LOGS_TABLE) lives in bq.ts itself. See docs/onchain-verification-plan.md.
export * from "../../../apps/web/src/lib/bq";
