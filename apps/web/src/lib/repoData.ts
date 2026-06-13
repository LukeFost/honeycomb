// Shared server-side helpers for reading the repo's analysis/ snapshot CSVs. Used by both
// snapshot.ts (ERC-8004 global data) and reputation.ts (Honeycomb Layer-2 seed). Walks up
// from cwd to find analysis/, mirroring analysis/bqenv.py's repo-root discovery.
import fs from "node:fs";
import path from "node:path";
import { parseCsv, type Row } from "./csv";

export function analysisDir(): string {
  const override = process.env.HONEYCOMB_ANALYSIS_DIR;
  if (override && fs.existsSync(path.join(override, "erc8004_trust.csv"))) return override;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "analysis");
    if (fs.existsSync(path.join(candidate, "erc8004_trust.csv"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate analysis/erc8004_trust.csv. Run the analysis pipeline, or set HONEYCOMB_ANALYSIS_DIR.",
  );
}

export function readCsv(dir: string, file: string): Row[] {
  return parseCsv(fs.readFileSync(path.join(dir, file), "utf8"));
}
