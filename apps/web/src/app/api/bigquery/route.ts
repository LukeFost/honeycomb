import { NextResponse } from "next/server";
import fs from "node:fs";
import { liveQueries, WINDOW } from "@/lib/bq";
import { findKey } from "@/lib/bqClient";

// Live BigQuery proxy: runs the same ERC-8004 count queries the analysis pipeline uses,
// server-side, with the repo-local service-account key (gitignored). Defaults to dry-run
// (free, estimates bytes). Degrades gracefully so the dashboard still works if the key or
// the @google-cloud/bigquery package isn't present.
//
// In "run" mode each query is executed twice: a free dry-run to report the query's real
// scan size, plus the actual run for the count + bytes billed. BigQuery caches results, so
// a repeated live run bills 0 bytes (cacheHit) even though the query genuinely scans ~44 GB
// — we surface both numbers so a free cached run reads as success, not "0 GB / nothing".

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const START = process.env.BQ_START ?? WINDOW.start;
const MAX_BYTES = process.env.BQ_MAX_BYTES ?? "150000000000"; // 150 GB safety cap

function maskProject(id: string | undefined): string | null {
  if (!id) return null;
  if (process.env.BQ_SHOW_PROJECT === "1") return id;
  // Hide the project id by default (it's intentionally kept out of committed artifacts);
  // show only a short suffix so the demo can prove a real project answered. Reveal the
  // full id locally with BQ_SHOW_PROJECT=1.
  return id.length <= 3 ? "••••" : `••••${id.slice(-3)}`;
}

// identity + reputation always; the validation registry is added once BQ_VALIDATION_REGISTRY is set.
const QUERIES = liveQueries(START);

function fail(error: string, mode: string) {
  return NextResponse.json({
    available: false,
    mode,
    project: null,
    start: START,
    results: [],
    totalScanGb: 0,
    totalBilledGb: 0,
    estCostUsd: 0,
    cacheHit: false,
    error,
  });
}

export async function POST(req: Request) {
  const mode = new URL(req.url).searchParams.get("mode") === "run" ? "run" : "dryrun";

  const keyFile = findKey();
  if (!keyFile) {
    return fail("Service-account key not found. Place it at honeycomb/.secrets/gcp-key.json.", mode);
  }

  let projectId: string | undefined = process.env.BQ_BILLING_PROJECT;
  try {
    const keyJson = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    projectId = projectId ?? keyJson.project_id;
  } catch {
    /* fall through; client may still resolve a project */
  }

  let BigQuery: typeof import("@google-cloud/bigquery").BigQuery;
  try {
    ({ BigQuery } = await import("@google-cloud/bigquery"));
  } catch {
    return fail("@google-cloud/bigquery is not installed. Run: pnpm --filter web add @google-cloud/bigquery", mode);
  }

  try {
    const bq = new BigQuery({ keyFilename: keyFile, projectId });

    // free dry-run: the query's logical scan size (ignores cache)
    async function scanBytes(sql: string): Promise<number> {
      const [job] = await bq.createQueryJob({ query: sql, useLegacySql: false, dryRun: true });
      return Number(job.metadata?.statistics?.totalBytesProcessed ?? 0);
    }

    const results = [];
    let totalScan = 0;
    let totalBilled = 0;
    let anyCache = false;

    for (const q of QUERIES) {
      const scan = await scanBytes(q.sql);
      totalScan += scan;

      let billed = 0;
      let count: number | null = null;
      let cacheHit = false;

      if (mode === "run") {
        const [job] = await bq.createQueryJob({
          query: q.sql,
          useLegacySql: false,
          maximumBytesBilled: MAX_BYTES,
        });
        const [rows] = await job.getQueryResults();
        const stats = job.metadata?.statistics ?? {};
        cacheHit = Boolean(stats.query?.cacheHit);
        billed = Number(stats.query?.totalBytesBilled ?? stats.totalBytesProcessed ?? 0);
        count = rows.length ? Number((rows[0] as { n: number | string }).n) : null;
        totalBilled += billed;
        anyCache = anyCache || cacheHit;
      }

      results.push({
        key: q.key,
        title: q.title,
        scanGb: scan / 1e9,
        billedGb: billed / 1e9,
        count,
        cacheHit,
      });
    }

    return NextResponse.json({
      available: true,
      mode,
      project: maskProject(projectId),
      start: START,
      results,
      totalScanGb: totalScan / 1e9,
      totalBilledGb: totalBilled / 1e9,
      estCostUsd: (totalBilled / 1e9 / 1000) * 6.25,
      cacheHit: anyCache,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`BigQuery query failed: ${msg}`, mode);
  }
}
