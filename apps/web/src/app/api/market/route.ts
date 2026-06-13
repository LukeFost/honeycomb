import { loadMarket } from "@/lib/reputation";
import { jsonData, jsonError } from "@/lib/api";

// GET /api/market — the full Layer-2 view: earned-reputation leaderboard, bounties,
// categories, validator, and KPIs (the same object the dashboard renders).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const market = await loadMarket();
    return jsonData(market, market);
  } catch (e) {
    return jsonError(e);
  }
}
