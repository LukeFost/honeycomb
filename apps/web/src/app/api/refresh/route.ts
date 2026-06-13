import { NextResponse } from "next/server";
import { BQ_LOCATION, getBigQuery } from "@/lib/bqClient";
import { refreshWindowSql, refreshRegistrationsSql, refreshFeedbackSql, refreshLogInsertSql } from "@/lib/bq";
import { queryStoreMeta } from "@/lib/queries";
import { clearCache } from "@/lib/cache";

// POST /api/refresh — "the loop": incrementally append new ERC-8004 events from the public
// mainnet logs into honeycomb.* since the watermark, then bust the read cache. Run it on a
// schedule (Cloud Scheduler → this route) or, with zero app infra, as a BigQuery scheduled
// query calling honeycomb.refresh(). Auth: REFRESH_TOKEN via Bearer / x-refresh-token.
// ?mode=dryrun reports the scan without writing.
//
// Each table is MERGEd as its OWN direct job with an explicit high maximumBytesBilled,
// because a project's default bytes-billed ceiling (a safety cap) is inherited by jobs that
// don't set their own — a direct job overrides it, so even a cold backfill goes through.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 2 TB cap: a cold backfill scans ~85 GB/table; steady-state incremental is sub-GB.
const MAX_BYTES = process.env.BQ_MAX_BYTES ?? "2000000000000";

type MergeStat = { scannedGb: number; billedGb: number; inserted: number };

export async function POST(req: Request) {
  const token = process.env.REFRESH_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "REFRESH_TOKEN is not set — refusing to run the loop." }, { status: 501 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : (req.headers.get("x-refresh-token") ?? "");
  if (provided !== token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const dryRun = new URL(req.url).searchParams.get("mode") === "dryrun";

  try {
    const bq = await getBigQuery();

    async function merge(sql: string): Promise<MergeStat> {
      if (dryRun) {
        const [job] = await bq.createQueryJob({ query: sql, useLegacySql: false, location: BQ_LOCATION, dryRun: true });
        return { scannedGb: Number(job.metadata?.statistics?.totalBytesProcessed ?? 0) / 1e9, billedGb: 0, inserted: 0 };
      }
      const [job] = await bq.createQueryJob({ query: sql, useLegacySql: false, location: BQ_LOCATION, maximumBytesBilled: MAX_BYTES });
      await job.getQueryResults();
      const [meta] = await job.getMetadata();
      const s = meta.statistics ?? {};
      return {
        scannedGb: Number(s.totalBytesProcessed ?? 0) / 1e9,
        billedGb: Number(s.query?.totalBytesBilled ?? 0) / 1e9,
        inserted: Number(s.query?.dmlStats?.insertedRowCount ?? 0),
      };
    }

    // 1. next window (clean second-precision strings — sub-second literals break partition pruning)
    const [rows] = await bq.query({ query: refreshWindowSql(), location: BQ_LOCATION });
    const { scan_from: from, scan_through: through } = rows[0] as { scan_from: string; scan_through: string };

    // 2. incremental MERGE per table (each its own job → its own byte cap)
    const registrations = await merge(refreshRegistrationsSql(from));
    const feedback = await merge(refreshFeedbackSql(from));

    // 3. advance the watermark + surface new data immediately
    if (!dryRun) {
      await bq.query({
        query: refreshLogInsertSql(from, through, registrations.inserted, feedback.inserted),
        location: BQ_LOCATION,
      });
      clearCache();
    }

    const meta = await queryStoreMeta();
    return NextResponse.json({
      ok: true,
      mode: dryRun ? "dryrun" : "run",
      window: { from, through },
      registrations,
      feedback,
      scannedGb: registrations.scannedGb + feedback.scannedGb,
      asOf: meta.asOf,
      asOfBlock: meta.asOfBlock,
      lastRefresh: meta.lastRefresh,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
