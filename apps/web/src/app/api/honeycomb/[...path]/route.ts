// ============================================================================
// /api/honeycomb/[...path] -- server-side proxy to the deployed honeycomb-api.
//
// WHY THIS EXISTS: the browser must never hold the write token. This route holds
// it server-side and injects it on writes, exactly like /api/summon holds the
// x402/enclave secrets. Same secret-handling model.
//
//   GET  /api/honeycomb/jobs?limit=20   -> proxies GET honeycomb-api/jobs (no auth)
//   POST /api/honeycomb/grade  {body}   -> proxies POST honeycomb-api/grade WITH
//                                          the injected Bearer token
//
// WRITE GATING (this is the whole "no perms to worry about" trick):
//   POST is allowed ONLY when HONEYCOMB_DEV=1 AND HONEYCOMB_API_TOKEN is set --
//   i.e. only on the local dev box. Deployed (no dev flag) every POST gets 403
//   here before it ever reaches the upstream, so the public /ops page is
//   structurally read-only. No upstream perms, no token in the deployed env.
//
// No secret ever appears in a response or a log line. Upstream errors are
// surfaced faithfully (status + body) per the repo's loud-failure convention.
// ============================================================================

import { NextResponse } from "next/server";
import { HONEYCOMB_API_URL, isDevMode, writeToken } from "@/lib/honeycomb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only these upstream paths are reachable through the proxy. Keeps the catch-all
// from being a generic open relay and documents the surface in one place.
// "logs" is a public read upstream (the api redacts secrets at the source), so it
// proxies through the GET path with no auth just like jobs/events.
const READ_PATHS = new Set(["jobs", "events", "reputation", "skill", "logs"]);
const WRITE_PATHS = new Set(["grade", "bounties", "submit", "snapshot"]);

/** Join the catch-all segments back into an upstream path, preserving the query. */
function upstreamPath(segments: string[], search: string): string {
  const p = segments.map(encodeURIComponent).join("/");
  return `/${p}${search}`;
}

/** First path segment -- the logical route name we gate on (jobs, grade, ...). */
function head(segments: string[]): string {
  return segments[0] ?? "";
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const route = head(path);
  if (!READ_PATHS.has(route)) {
    return NextResponse.json(
      { error: `read route "${route}" is not proxied (allowed: ${[...READ_PATHS].join(", ")})` },
      { status: 404 },
    );
  }
  const search = new URL(req.url).search;
  const url = `${HONEYCOMB_API_URL}${upstreamPath(path, search)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "application/json";
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": contentType },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `honeycomb-api unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const route = head(path);

  // Gate 1: write surface only exists in local dev. This is the perms firewall.
  if (!isDevMode()) {
    return NextResponse.json(
      { error: "write routes are disabled (set HONEYCOMB_DEV=1 to enable, local dev only)" },
      { status: 403 },
    );
  }
  // Gate 2: only known write paths.
  if (!WRITE_PATHS.has(route)) {
    return NextResponse.json(
      { error: `write route "${route}" is not proxied (allowed: ${[...WRITE_PATHS].join(", ")})` },
      { status: 404 },
    );
  }
  // Gate 3: the token must be present to inject. Fail loud, do not call upstream.
  const token = writeToken();
  if (!token) {
    return NextResponse.json(
      { error: "HONEYCOMB_API_TOKEN is not set in this environment; cannot authorize a write" },
      { status: 503 },
    );
  }

  const bodyText = await req.text();
  const search = new URL(req.url).search;
  const url = `${HONEYCOMB_API_URL}${upstreamPath(path, search)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Injected server-side; never leaves this process toward the browser.
        authorization: `Bearer ${token}`,
      },
      body: bodyText,
      cache: "no-store",
    });
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "application/json";
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": contentType },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `honeycomb-api unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
