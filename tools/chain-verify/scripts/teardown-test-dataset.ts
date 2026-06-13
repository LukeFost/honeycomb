// Drop the disposable test dataset and everything in it. Reversibility for the cloud side.
import { getClient, testDataset } from "../src/bqClient";

async function main() {
  const ds = testDataset();
  const { bq } = getClient();
  await bq.dataset(ds).delete({ force: true });
  console.log(`Deleted dataset ${ds}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
