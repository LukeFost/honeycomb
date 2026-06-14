// Server-only: discovers the gitignored service-account key and builds a memoized
// BigQuery client for the serving reads + the refresh loop. Never import this from a
// client component — it touches fs and the key. The package is loaded with a dynamic
// import (like the live /api/bigquery route) so it stays out of the client bundle and
// degrades gracefully if it isn't installed.
import fs from "node:fs";
import path from "node:path";
import type { BigQuery } from "@google-cloud/bigquery";

/** The honeycomb dataset's region — must match the public source (…_us). */
export const BQ_LOCATION = process.env.BQ_LOCATION || "US";

/** Raised when BigQuery can't be reached (missing key/package); callers turn it into a
 *  503 so the dashboard/endpoints degrade instead of crashing. */
export class BigQueryUnavailableError extends Error {}

/** Walk up from cwd to find the gitignored service-account key (or honor the env var). */
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
  return null;
}

async function build(): Promise<BigQuery> {
  // Two credential paths. Locally we find the gitignored key file. On Cloud Run there is
  // NO key file (a key in the image would be a leak): we fall back to Application Default
  // Credentials, which the BigQuery client reads from the bound runtime service account via
  // the metadata server. Either way the project comes from BQ_BILLING_PROJECT (set explicitly
  // on Cloud Run), the key file's project_id, or ADC's own project resolution.
  const keyFile = findKey();
  let projectId: string | undefined = process.env.BQ_BILLING_PROJECT;
  if (keyFile) {
    try {
      projectId = projectId ?? JSON.parse(fs.readFileSync(keyFile, "utf8")).project_id;
    } catch {
      /* fall through; the client may still resolve a project */
    }
  }
  let Ctor: typeof import("@google-cloud/bigquery").BigQuery;
  try {
    ({ BigQuery: Ctor } = await import("@google-cloud/bigquery"));
  } catch {
    throw new BigQueryUnavailableError(
      "@google-cloud/bigquery is not installed. Run: pnpm --filter web add @google-cloud/bigquery",
    );
  }
  // keyFilename when we have a key (local); omit it to let the SDK use ADC (Cloud Run).
  // A bad/absent SA still fails loudly at query time — not silently swallowed here.
  return keyFile ? new Ctor({ keyFilename: keyFile, projectId }) : new Ctor({ projectId });
}

let client: Promise<BigQuery> | null = null;

/** Memoized BigQuery client. A failed init is not cached, so the next call retries. */
export function getBigQuery(): Promise<BigQuery> {
  if (!client) {
    client = build().catch((e) => {
      client = null;
      throw e;
    });
  }
  return client;
}

/** Run a read query in the dataset's region and return its rows. */
export async function queryRows<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const bq = await getBigQuery();
  const [rows] = await bq.query({ query, location: BQ_LOCATION });
  return rows as T[];
}
