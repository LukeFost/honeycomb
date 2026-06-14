// GET /api/live — real-time job board data, read straight from the escrow via RPC
// (eth_getLogs folded into per-job state). No cache; the /live page polls this.
import { getLiveJobs } from "@/lib/live";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
	try {
		return Response.json(await getLiveJobs(), { headers: { "cache-control": "no-store" } });
	} catch (e) {
		return Response.json({ error: (e as Error).message, jobs: [] }, { status: 500 });
	}
}
