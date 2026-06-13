// Phase 1: run the REAL Layer-1 pipeline (decode → MERGE → agent_trust view → serving read)
// over whatever is in the fixture logs table, isolated in the test dataset. Populate the
// fixture first: `pnpm run index <mockAddr>` (local chain) or capture real mainnet bytes
// (point the indexer at a mainnet RPC with a bounded block range — see README).
//
// The whole point: this exercises the exact SQL bq.ts ships, just sourced from BQ_LOGS_TABLE.
export {}; // mark as an ES module (this file uses only dynamic import())

async function main() {
  const ds = process.env.BQ_DATASET || "honeycomb_test";
  process.env.BQ_DATASET = ds;
  process.env.BQ_LOGS_TABLE = process.env.BQ_LOGS_TABLE || `${ds}.logs`;

  const sql = await import("../src/sql");
  if (sql.LOGS_TABLE === sql.DATASET) {
    throw new Error(
      "Refusing to run: BQ_LOGS_TABLE resolved to the mainnet public table (would scan ~44 GB).",
    );
  }
  const { getClient, bqLocation } = await import("../src/bqClient");
  const { bq } = getClient();
  const location = bqLocation();
  const run = (query: string) => bq.query({ query, location, maximumBytesBilled: "1000000000" });

  await run(sql.createTablesSql(ds));
  await run(sql.refreshRegistrationsSql(sql.WINDOW.start, ds));
  await run(sql.refreshFeedbackSql(sql.WINDOW.start, ds));
  await run(sql.agentTrustViewSql(ds));
  const [agents] = await run(sql.agentTrustSelectSql(ds));

  console.log(`agent_trust rows: ${agents.length} (sourced from ${sql.LOGS_TABLE})`);
  console.table(
    (agents as Array<Record<string, unknown>>).slice(0, 10).map((a) => ({
      agent_id: a.agent_id,
      trust_score: a.trust_score,
      avg_score: a.avg_score,
      feedback_count: a.feedback_count,
      independent_clients: a.independent_clients,
      flags: a.flags,
    })),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
