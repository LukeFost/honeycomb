// Test-only SQL — NOT part of production bq.ts. The fixture logs table mirrors the subset of
// `bigquery-public-data.goog_blockchain_ethereum_mainnet_us.logs` that the decode SQL reads,
// so BQ_LOGS_TABLE can point the REAL decode SQL at controllable data (a mock contract's logs
// via the indexer, or captured real mainnet bytes). Bytes must match the public format:
// address/data/topics lowercase, 0x-prefixed; topics as an array — or the SUBSTR offsets break.

/** DDL for the fixture logs table (public-table subset). Idempotent. */
export function createTestLogsTableSql(ds: string): string {
  return `CREATE TABLE IF NOT EXISTS \`${ds}.logs\` (
  address          STRING,
  topics           ARRAY<STRING>,
  data             STRING,
  block_timestamp  TIMESTAMP,
  block_number     INT64,
  transaction_hash STRING,
  log_index        INT64
)`;
}

/** Truncate the fixture between scenarios without dropping the dataset. */
export function truncateTestLogsSql(ds: string): string {
  return `TRUNCATE TABLE \`${ds}.logs\``;
}
