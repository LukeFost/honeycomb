import { NextResponse } from "next/server";
import { queryStoreMeta } from "@/lib/queries";

// GET /api/health — is the store reachable, how fresh is it, and when did the loop last
// run? Queries the small derived tables directly (uncached) so it genuinely probes BigQuery.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const meta = await queryStoreMeta();
    const lastRefreshAgeSec = meta.lastRefresh
      ? Math.round((Date.now() - Date.parse(meta.lastRefresh)) / 1000)
      : null;
    return NextResponse.json({
      ok: true,
      store: "reachable",
      asOf: meta.asOf,
      asOfBlock: meta.asOfBlock,
      lastRefresh: meta.lastRefresh,
      lastRefreshAgeSec,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, store: "unreachable", error: message }, { status: 503 });
  }
}
