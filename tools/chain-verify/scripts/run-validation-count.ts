// Phase 3 assertion: a contract WE deployed (the mock Validation Registry on Anvil) → indexer
// → BigQuery fixture table → the dashboard's live count path reflects exactly what we emitted.
//
// Env is set BEFORE importing sql.ts because LOGS_TABLE / VALIDATION_REGISTRY.address are
// evaluated at import time from process.env (mirrors how bq.ts behaves in production).
export {}; // mark as an ES module (this file uses only dynamic import())

async function main() {
  const ds = process.env.BQ_DATASET || "honeycomb_test";
  process.env.BQ_DATASET = ds;
  process.env.BQ_LOGS_TABLE = process.env.BQ_LOGS_TABLE || `${ds}.logs`;

  const mockAddr = (process.env.MOCK_ADDRESS || process.argv[2] || "").toLowerCase();
  if (!mockAddr) throw new Error("Pass the mock address: `pnpm run e2e:validation 0xADDR`.");
  process.env.BQ_VALIDATION_REGISTRY = mockAddr;

  const sql = await import("../src/sql");
  if (sql.LOGS_TABLE === sql.DATASET) {
    throw new Error("Refusing to run: BQ_LOGS_TABLE resolved to the mainnet public table.");
  }
  const { getClient, bqLocation } = await import("../src/bqClient");
  const { bq } = getClient();

  // Same builder the live /api/bigquery route uses — just pointed at the fixture table.
  const query = sql.countSql(
    sql.VALIDATION_REGISTRY.address,
    sql.VALIDATION_REGISTRY.events.response.topic0,
    "1970-01-01",
  );
  const [rows] = await bq.query({ query, location: bqLocation(), maximumBytesBilled: "1000000000" });
  const n = Number((rows[0] as { n?: number | string } | undefined)?.n ?? 0);
  console.log(`ValidationResponse count for ${mockAddr} in ${sql.LOGS_TABLE}: ${n}`);

  if (process.env.EXPECTED_COUNT !== undefined) {
    const expected = Number(process.env.EXPECTED_COUNT);
    if (n !== expected) {
      console.error(`FAIL: expected ${expected}, got ${n}`);
      process.exit(1);
    }
    console.log("OK ✓");
  } else {
    console.log("(set EXPECTED_COUNT to assert a specific number)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
