// One-off: list datasets/tables + row counts in the billing project, so we know exactly
// what's in the DB before removing stubbed data.
import { getClient } from "../src/bqClient";

async function main() {
  const { bq, projectId } = getClient();
  console.log(`project: ${projectId}`);
  const [datasets] = await bq.getDatasets();
  for (const ds of datasets) {
    console.log(`\n[${ds.id}]`);
    const [tables] = await ds.getTables();
    for (const t of tables) {
      const [md] = await t.getMetadata();
      const rows = md.type === "VIEW" ? "(view)" : (md.numRows ?? "?");
      console.log(`  ${t.id}  ${md.type}  rows=${rows}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
