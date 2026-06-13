// Stand up the disposable demo/test dataset (BQ_DATASET, default honeycomb_test) using the REAL
// production SQL: Layer-1 tables (createTablesSql) + the agent_trust view, the Layer-2 market
// tables (createMarketTablesSql), and the test-only raw-logs fixture. Idempotent. The dataset
// starts EMPTY — the dashboard renders zeros until the demo seeds + indexes on-chain events.
// Reverse with `pnpm run bq:teardown`.
import { getClient, testDataset, bqLocation } from "../src/bqClient";
import { createTablesSql, createMarketTablesSql, agentTrustViewSql } from "../src/sql";
import { createTestLogsTableSql } from "../src/testSql";

async function main() {
  const ds = testDataset();
  const location = bqLocation();
  const { bq, projectId } = getClient();

  const [exists] = await bq.dataset(ds).exists();
  if (!exists) {
    await bq.createDataset(ds, { location });
    console.log(`Created dataset ${ds} (${location})`);
  } else {
    console.log(`Dataset ${ds} already exists`);
  }

  await bq.query({ query: createTablesSql(ds), location }); // registrations, feedback, refresh_log
  await bq.query({ query: createTestLogsTableSql(ds), location }); // raw-logs fixture
  await bq.query({ query: createMarketTablesSql(ds), location }); // bounties, submissions, validations, settlements
  await bq.query({ query: agentTrustViewSql(ds), location }); // the Layer-1 scoring view
  console.log(
    `Ready: ${projectId ?? "(project)"}:${ds} → { logs, registrations, feedback, refresh_log, ` +
      `bounties, submissions, validations, settlements, agent_trust(view) } — empty`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
