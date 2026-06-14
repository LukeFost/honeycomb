// ============================================================================
// /api/fund -- the web front door for GASLESS bounty funding (x402).
//
// This is the browser-facing leg of create_bounty_draft -> finalize_bounty
// (apps/honeycomb-mcp/tools/*). A funder funds their OWN bounty with no ETH:
//
//   POST /api/fund { stage: "draft",    ...bountyShape }  -> 402-challenge:
//        forwards create_bounty_draft, returns {draftId, typedData,
//        authorizationTemplate, accepts, bounty}. The browser signs typedData.
//
//   POST /api/fund { stage: "finalize", draftId, signature, authorization }
//        -> forwards finalize_bounty: the facilitator settles the signed
//        EIP-3009 (relayer pays gas, funder USDC -> custodial wallet) and the
//        server opens the bounty on-chain. Returns the created bounty + receipt.
//
// WHY A SEPARATE ROUTE (not /api/honeycomb): /api/honeycomb gates ALL writes
// behind HONEYCOMB_DEV=1 (an ADMIN console, local-only). Funding is a PUBLIC
// front door -- any funder with a wallet should be able to open a bounty in the
// deployed dashboard. So this route does NOT require dev mode. It STILL injects
// HONEYCOMB_API_TOKEN server-side (never to the browser); if the token is unset
// in this environment the route fails loud with 503 rather than running
// half-wired. No secret ever appears in a response.
//
// Upstream errors are surfaced faithfully (status + body) per the repo's
// loud-failure convention -- a settle/create failure must never look like a
// funded bounty.
// ============================================================================

import { NextResponse } from "next/server";
import { HONEYCOMB_API_URL, writeToken } from "@/lib/honeycomb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The two upstream tools this route fans out to, keyed by `stage`.
const STAGE_PATH: Record<string, string> = {
  draft: "/bounties/draft",
  finalize: "/bounties/finalize",
};

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const stage = typeof body.stage === "string" ? body.stage : "";
  const upstream = STAGE_PATH[stage];
  if (!upstream) {
    return NextResponse.json(
      { error: `stage must be one of: ${Object.keys(STAGE_PATH).join(", ")} (got "${stage}")` },
      { status: 400 },
    );
  }

  // The token is injected server-side. Absent => the funding rail is not
  // provisioned in this environment; fail loud, do not call upstream.
  const token = writeToken();
  if (!token) {
    return NextResponse.json(
      {
        error:
          "funding is not configured here: HONEYCOMB_API_TOKEN is unset, so /api/fund cannot authorize the draft/finalize write",
      },
      { status: 503 },
    );
  }

  // Forward everything except our own routing key. The upstream tools validate
  // their own inputs (and finalize re-verifies the signed authorization), so we
  // stay a thin, faithful proxy here.
  const { stage: _stage, ...forward } = body;

  const url = `${HONEYCOMB_API_URL}${upstream}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Injected server-side; never leaves this process toward the browser.
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(forward),
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
