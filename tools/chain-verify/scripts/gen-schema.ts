// Generate the canonical BigQuery schema (DDL + scoring view + refresh procedure) from the
// single source of truth — apps/web/src/lib/bq.ts, re-exported via src/sql.ts — so the committed
// SQL never drifts from the code the app actually runs (the old hand-synced docs/honeycomb-
// bigquery.sql drifted; this replaces it). Run with a clean env (no BQ_* overrides) and it emits
// the PRODUCTION shape: the `honeycomb` dataset; with no escrow configured the refresh() proc is
// Layer-1-only, matching production default. Run: pnpm gen:sql.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HONEYCOMB_DATASET,
  ESCROW_CONFIGURED,
  createTablesSql,
  createMarketTablesSql,
  agentTrustViewSql,
  refreshProcedureSql,
} from "../src/sql";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../../docs/honeycomb-bigquery.sql");

const banner = `-- GENERATED from apps/web/src/lib/bq.ts (the single source of truth) by
-- tools/chain-verify/scripts/gen-schema.ts. DO NOT EDIT BY HAND — run \`pnpm gen:sql\` after
-- changing bq.ts. Reflects the current env; with a clean env this is the production \`${HONEYCOMB_DATASET}\`
-- dataset (default EF mainnet addresses, refresh() ${ESCROW_CONFIGURED ? "with Layer 2" : "Layer-1-only until BQ_ESCROW_ADDRESS is set"}).`;

const sections: [string, string][] = [
  ["Layer-1 tables — identity + reputation + refresh log", createTablesSql()],
  ["Layer-2 market tables — bounties / submissions / validations / settlements", createMarketTablesSql()],
  ["Layer-1 trust / sybil-resistance scoring view", agentTrustViewSql()],
  [
    `Refresh loop as a stored procedure — schedule with CALL \`${HONEYCOMB_DATASET}.refresh\`() — ${
      ESCROW_CONFIGURED ? "Layer 1 + Layer 2" : "Layer 1 only (no escrow configured)"
    }`,
    refreshProcedureSql(),
  ],
];

const body = sections
  .map(
    ([title, sql]) =>
      `-- ===========================================================================\n` +
      `-- ${title}\n` +
      `-- ===========================================================================\n${sql}\n`,
  )
  .join("\n");

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${banner}\n\n${body}`);
console.log(`Wrote ${out}`);
