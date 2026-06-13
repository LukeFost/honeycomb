import { NextResponse } from "next/server";
import { loadSnapshot } from "@/lib/snapshot";
import { jsonData, jsonError } from "@/lib/api";

// GET /api/agents/:id — one agent's trust record (or 404).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const snap = await loadSnapshot();
    const agent = snap.agents.find((a) => a.agentId === Number(id));
    if (!agent) return NextResponse.json({ error: `agent ${id} not found` }, { status: 404 });
    return jsonData(agent, snap);
  } catch (e) {
    return jsonError(e);
  }
}
