// Recreate `<BQ_DATASET>.agent_trust` from the CURRENT bq.ts view definition
// (CREATE OR REPLACE VIEW — non-destructive: a view holds no data; registrations/feedback are
// untouched). Use this to bring an already-loaded dataset's view in line with code changes to
// `agentTrustViewSql` WITHOUT re-running setup-test-dataset (which also creates the test-only
// `logs` fixture — undesirable in the real `honeycomb` dataset). Defaults to the real dataset.
//
//   GOOGLE_APPLICATION_CREDENTIALS=.../.secrets/gcp-key.json BQ_DATASET=honeycomb \
//     pnpm exec tsx scripts/recreate-agent-trust-view.ts
import { agentTrustViewSql } from "../src/sql";
import { getClient, bqLocation } from "../src/bqClient";

async function main() {
  const ds = process.env.BQ_DATASET || "honeycomb";
  const { bq, projectId } = getClient();
  await bq.query({ query: agentTrustViewSql(ds), location: bqLocation() });
  console.log(`Recreated ${projectId ?? "(project)"}:${ds}.agent_trust (adds owner + on-chain card decode).`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
