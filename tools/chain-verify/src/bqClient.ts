// BigQuery client + service-account key discovery. Ported from honeycomb's
// apps/web/src/app/api/bigquery/route.ts so the harness authenticates identically. All env
// is read at call time (not import time) so scripts can set env before using these helpers.
import fs from "node:fs";
import path from "node:path";
import { BigQuery } from "@google-cloud/bigquery";

/** Locate the gitignored SA key: explicit env → walk up for .secrets/gcp-key.json → the
 *  sibling honeycomb checkout (this harness lives next to honeycomb/ until folded in). */
export function findKey(): string | null {
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (env && fs.existsSync(env)) return env;

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const k = path.join(dir, ".secrets", "gcp-key.json");
    if (fs.existsSync(k)) return k;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const sibling = path.resolve(process.cwd(), "..", "honeycomb", ".secrets", "gcp-key.json");
  if (fs.existsSync(sibling)) return sibling;

  return null;
}

export function getClient(): { bq: BigQuery; projectId: string | undefined; keyFile: string } {
  const keyFile = findKey();
  if (!keyFile) {
    throw new Error(
      "Service-account key not found. Set GOOGLE_APPLICATION_CREDENTIALS, or place it at " +
        "honeycomb/.secrets/gcp-key.json.",
    );
  }
  let projectId: string | undefined = process.env.BQ_BILLING_PROJECT;
  try {
    const keyJson = JSON.parse(fs.readFileSync(keyFile, "utf8")) as { project_id?: string };
    projectId = projectId ?? keyJson.project_id;
  } catch {
    /* client may still resolve a project from the env */
  }
  return { bq: new BigQuery({ keyFilename: keyFile, projectId }), projectId, keyFile };
}

/** Disposable test dataset + its fixture logs table + region. Read at call time. */
export const testDataset = (): string => process.env.BQ_DATASET || "honeycomb_test";
export const testLogsTable = (): string => process.env.BQ_LOGS_TABLE || `${testDataset()}.logs`;
export const bqLocation = (): string => process.env.BQ_LOCATION || "US";
