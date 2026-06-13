import { loadMarket } from "@/lib/reputation";
import { jsonData, jsonError } from "@/lib/api";

// GET /api/bounties?status=open|all — the bounty board. Layer 2 stays on the seed CSVs
// until the escrow contract ships; the response contract won't change when it goes live.
// Defaults to open (what an agent poller wants: jobs to work on).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const status = new URL(req.url).searchParams.get("status") === "all" ? "all" : "open";
    const market = await loadMarket();
    const data = status === "all" ? market.bounties : market.openBounties;
    return jsonData(data, market, { status, count: data.length });
  } catch (e) {
    return jsonError(e);
  }
}
