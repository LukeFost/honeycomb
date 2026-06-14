// Live job board data — reads the BountyEscrow over RPC (eth_getLogs) and folds the
// event stream into per-job state (submissions, scores, validity, leader, winner).
// Server-side only (used by /api/live). No BigQuery — this is the real-time view.
import { createPublicClient, http, decodeEventLog, parseAbi, formatUnits, type Hex } from "viem";
import { mainnet, sepolia } from "viem/chains";

const MAINNET = (process.env.HONEYCOMB_CHAIN ?? "mainnet") === "mainnet";
const RPC = process.env.HONEYCOMB_RPC || (MAINNET ? "https://ethereum-rpc.publicnode.com" : "https://ethereum-sepolia-rpc.publicnode.com");
const ESCROW = (process.env.HONEYCOMB_ESCROW || process.env.BQ_ESCROW_ADDRESS || "0x90058162D3d55542f39507d0328538824A24C9C3") as Hex;
const LOOKBACK = BigInt(process.env.LIVE_LOOKBACK || 8000);
const EXPLORER = MAINNET ? "https://etherscan.io/tx/" : "https://sepolia.etherscan.io/tx/";

const client = createPublicClient({ chain: MAINNET ? mainnet : sepolia, transport: http(RPC) });
const EVENTS = parseAbi([
	"event JobCreated(uint256 indexed jobId, address indexed client, address provider, address evaluator, uint256 expiredAt)",
	"event JobFunded(uint256 indexed jobId, address client, uint256 amount)",
	"event Submitted(uint256 indexed jobId, uint256 indexed agentId, string encCid)",
	"event ScoreRecorded(uint256 indexed jobId, uint256 indexed agentId, uint16 score, bytes32 scoreDigest)",
	"event ValidityRecorded(uint256 indexed jobId, uint256 indexed agentId, bool valid, bytes32 validityAtt)",
	"event NewLeader(uint256 indexed jobId, uint256 indexed agentId, uint16 score)",
	"event WinnerDelivered(uint256 indexed jobId, uint256 indexed winnerAgentId, string deliveryCid)",
	"event JobResolved(uint256 indexed jobId, uint256 indexed winnerAgentId, address provider, uint16 score, uint256 paidOut)",
]);

export type LiveSub = { agentId: string; score: number | null; valid: boolean | null; leader: boolean; sealed: boolean; tx?: string };
export type LiveJob = {
	id: number; client: string | null; rewardMusdc: number | null; deadline: number | null;
	status: "Funded" | "Grading" | "Settled" | "Delivered" | "Refunded" | "Open";
	subs: LiveSub[]; winner: string | null; paidMusdc: number | null; tx?: string;
};
export type LiveData = { jobs: LiveJob[]; block: number; escrow: string; chain: string; explorer: string; asOf: string };

export async function getLiveJobs(): Promise<LiveData> {
	const latest = await client.getBlockNumber();
	const from = latest > LOOKBACK ? latest - LOOKBACK : 0n;
	const logs = await client.getLogs({ address: ESCROW, fromBlock: from, toBlock: latest });

	const jobs = new Map<string, any>();
	const J = (id: bigint) => { const k = id.toString(); if (!jobs.has(k)) jobs.set(k, { id: Number(id), client: null, rewardMusdc: null, deadline: null, status: "Open", subs: new Map(), winner: null, paidMusdc: null }); return jobs.get(k); };
	const S = (job: any, aid: bigint) => { const k = aid.toString(); if (!job.subs.has(k)) job.subs.set(k, { agentId: k, score: null, valid: null, leader: false, sealed: false }); return job.subs.get(k); };

	for (const log of logs) {
		let ev: any;
		try { ev = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics }); } catch { continue; }
		const a = ev.args as any, tx = log.transactionHash as string;
		switch (ev.eventName) {
			case "JobCreated": { const j = J(a.jobId); j.client = a.client; j.deadline = Number(a.expiredAt); j.status = "Funded"; j.tx = tx; break; }
			case "JobFunded": { J(a.jobId).rewardMusdc = Number(formatUnits(a.amount, 6)); break; }
			case "Submitted": { const s = S(J(a.jobId), a.agentId); s.sealed = /seal|\.sealed/.test(String(a.encCid)); s.tx = tx; break; }
			case "ScoreRecorded": { const j = J(a.jobId); S(j, a.agentId).score = Number(a.score); if (j.status === "Funded") j.status = "Grading"; break; }
			case "ValidityRecorded": { S(J(a.jobId), a.agentId).valid = a.valid; break; }
			case "NewLeader": { const j = J(a.jobId); for (const s of j.subs.values()) s.leader = false; S(j, a.agentId).leader = true; break; }
			case "JobResolved": { const j = J(a.jobId); if (a.winnerAgentId === 0n) j.status = "Refunded"; else { j.status = "Settled"; j.winner = a.winnerAgentId.toString(); j.paidMusdc = Number(formatUnits(a.paidOut, 6)); j.tx = tx; } break; }
			case "WinnerDelivered": { J(a.jobId).status = "Delivered"; break; }
		}
	}
	const out: LiveJob[] = [...jobs.values()].map((j) => ({ ...j, subs: [...j.subs.values()] })).sort((x, y) => y.id - x.id);
	return { jobs: out, block: Number(latest), escrow: ESCROW, chain: MAINNET ? "mainnet" : "sepolia", explorer: EXPLORER, asOf: new Date().toISOString() };
}
