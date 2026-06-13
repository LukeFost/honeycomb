// Layer-1 materialization for the demo: MERGE raw logs (BQ_LOGS_TABLE) → registrations/feedback
// via the REAL SQL decode, then (re)create the agent_trust scoring view. Uses BQ_START as the
// watermark floor (the demo sets 1970-01-01 so it's independent of the local clock). Env is set
// before importing sql.ts because the registry addresses/topics are read at import time.
async function main() {
  const ds = process.env.BQ_DATASET || "honeycomb_test";
  process.env.BQ_DATASET = ds;
  process.env.BQ_LOGS_TABLE = process.env.BQ_LOGS_TABLE || `${ds}.logs`;

  const sql = await import("../src/sql");
  if (sql.LOGS_TABLE === sql.DATASET) {
    throw new Error("Refusing to run: BQ_LOGS_TABLE resolved to the mainnet public table.");
  }
  const { getClient, bqLocation } = await import("../src/bqClient");
  const { bq } = getClient();
  const location = bqLocation();
  const run = (query: string) => bq.query({ query, location, maximumBytesBilled: "1000000000" });

  const floor = process.env.BQ_START || "1970-01-01";
  await run(sql.createTablesSql(ds));
  await run(sql.refreshRegistrationsSql(floor, ds));
  await run(sql.refreshFeedbackSql(floor, ds));
  await run(sql.agentTrustViewSql(ds));
  const [rows] = await run(sql.agentTrustSelectSql(ds));
  console.log(`  agent_trust rows: ${rows.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
