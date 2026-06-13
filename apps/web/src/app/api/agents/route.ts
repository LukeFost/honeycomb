import { loadSnapshot } from "@/lib/snapshot";
import { jsonData, jsonError } from "@/lib/api";

// GET /api/agents — the Layer-1 ERC-8004 trust directory (sybil-scored), from the live
// honeycomb.agent_trust view behind the short-TTL cache. Reads the small view (~MB), not
// the raw logs. MCP/agent pollers consume this.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snap = await loadSnapshot();
    return jsonData(snap.agents, snap, { count: snap.agents.length });
  } catch (e) {
    return jsonError(e);
  }
}
