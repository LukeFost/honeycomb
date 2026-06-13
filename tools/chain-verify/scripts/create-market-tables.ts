// Provision the Layer-2 market tables (bounties/submissions/validations/settlements) in the
// target dataset (BQ_DATASET, default the production `honeycomb`). Idempotent. reputation.ts
// reads these; without them loadMarket() errors. Run once per dataset that serves the dashboard.
import { getClient, bqLocation } from "../src/bqClient";
import { createMarketTablesSql } from "../src/sql";

async function main() {
  const ds = process.env.BQ_DATASET || "honeycomb";
  const { bq } = getClient();
  await bq.query({ query: createMarketTablesSql(ds), location: bqLocation() });
  console.log(`Ensured Layer-2 market tables in ${ds}: bounties, submissions, validations, settlements`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
