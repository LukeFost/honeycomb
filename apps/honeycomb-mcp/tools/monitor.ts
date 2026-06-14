// ============================================================================
// Read-only job monitoring against BountyEscrow on Sepolia.
//   get_job    — full Job struct + isSettled + winner wallet for one jobId
//   list_jobs  — getJob over [1 .. nextJobId-1], compact rows
//   job_events — decode ScoreRecorded / ValidityRecorded / NewLeader / JobCreated
//                / JobResolved logs over a block range
// ============================================================================

import { type Hex } from "viem";
import {
	ESCROW,
	ESCROW_ABI,
	decodeJob,
	publicClient,
} from "../chain.ts";

async function readJob(jobId: bigint) {
	const raw = await publicClient.readContract({
		address: ESCROW,
		abi: ESCROW_ABI,
		functionName: "getJobFull", // rich struct; standard getJob() returns only the 9-field ERC-8183 Job
		args: [jobId],
	});
	return decodeJob(raw);
}

// --- get_job ----------------------------------------------------------------
export const getJobInput = {
	jobId: { type: "string", description: "Job id (string; can exceed 2^53)." },
} as const;

export async function getJob(args: { jobId: string }) {
	const id = BigInt(args.jobId);
	const [job, settled, winner] = await Promise.all([
		readJob(id),
		publicClient.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "isSettled", args: [id] }),
		publicClient
			.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "winnerWalletOf", args: [id] })
			.catch(() => null),
	]);
	return { ...job, settled, winnerWallet: winner };
}

// --- list_jobs --------------------------------------------------------------
export const listJobsInput = {
	limit: { type: "number", description: "Max jobs to return, newest first. Default 25." },
} as const;

export async function listJobs(args: { limit?: number }) {
	const next = (await publicClient.readContract({
		address: ESCROW,
		abi: ESCROW_ABI,
		functionName: "nextJobId",
	})) as bigint;
	const last = next - 1n; // ids run 1..nextJobId-1; stay in BigInt (ids can exceed 2^53)
	if (last < 1n) return { count: 0, nextJobId: next.toString(), jobs: [] };

	const limit = args.limit ?? 25;
	const ids: bigint[] = [];
	for (let i = last; i >= 1n && ids.length < limit; i--) ids.push(i);

	const jobs = await Promise.all(
		ids.map(async (id) => {
			const j = await readJob(id);
			return {
				id: j.id,
				status: j.statusName,
				rewardUSDC: j.budgetUSDC,
				deadlineISO: j.expiredAtISO,
				bestAgentId: j.bestAgentId,
				bestScore: j.bestScore,
				gradeCount: j.gradeCount,
				specCid: j.specCid,
			};
		}),
	);
	return { count: jobs.length, nextJobId: next.toString(), jobs };
}

// --- job_events -------------------------------------------------------------
export const jobEventsInput = {
	jobId: { type: "string", description: "Filter to one job id. Optional; omit for all jobs." },
	eventName: {
		type: "string",
		enum: ["ScoreRecorded", "ValidityRecorded", "NewLeader", "JobResolved", "JobCreated"],
		description:
			"Which event to fetch. A grade is split across ScoreRecorded (execution score) + ValidityRecorded (AI verdict) + NewLeader (best valid grade advanced). Default ScoreRecorded.",
	},
	fromBlock: {
		type: "string",
		description: "Start block (decimal or hex). Default: last ~5000 blocks (paged in chunks). A bounty's full create->resolve life is a few hours, well inside this.",
	},
} as const;

// The hosted RPC (Goldsky) caps eth_getLogs at <1000 blocks/request, so page the
// range in sub-cap chunks. Default lookback ~5000 blocks (~17h on Sepolia) covers
// a bounty's full lifecycle in ~10 requests. Both tunable via env for deeper scans.
const CHUNK = BigInt(process.env.LOGS_CHUNK ?? 500);
const DEFAULT_LOOKBACK = BigInt(process.env.LOGS_LOOKBACK ?? 5_000);

type MonitorEvent = "ScoreRecorded" | "ValidityRecorded" | "NewLeader" | "JobResolved" | "JobCreated";

export async function jobEvents(args: { jobId?: string; eventName?: string; fromBlock?: string }) {
	const eventName = (args.eventName ?? "ScoreRecorded") as MonitorEvent;
	const eventAbi = ESCROW_ABI.find((x) => x.type === "event" && x.name === eventName);
	if (!eventAbi) throw new Error(`unknown event ${eventName}`);

	const tip = await publicClient.getBlockNumber();
	const fromBlock = args.fromBlock
		? BigInt(args.fromBlock)
		: tip > DEFAULT_LOOKBACK
			? tip - DEFAULT_LOOKBACK
			: 0n;

	const jobIdArg =
		args.jobId !== undefined ? ({ jobId: BigInt(args.jobId) } as Record<string, bigint>) : undefined;

	const logs: any[] = [];
	for (let start = fromBlock; start <= tip; start += CHUNK + 1n) {
		const end = start + CHUNK > tip ? tip : start + CHUNK;
		const page = await publicClient.getLogs({
			address: ESCROW,
			event: eventAbi as any,
			args: jobIdArg as any,
			fromBlock: start,
			toBlock: end,
		});
		logs.push(...page);
	}

	const events = logs.map((l) => {
		const a = (l as unknown as { args: Record<string, unknown> }).args ?? {};
		// logIndex makes (tx, logIndex) a true unique key — two escrow events in ONE tx
		// (e.g. ScoreRecorded + NewLeader) would otherwise both persist as logIndex 0 and
		// collide on the events PK, silently dropping one. Surface it for the DB layer.
		const out: Record<string, unknown> = {
			block: Number(l.blockNumber),
			tx: l.transactionHash,
			logIndex: Number((l as { logIndex?: number }).logIndex ?? 0),
		};
		for (const [k, v] of Object.entries(a)) out[k] = typeof v === "bigint" ? v.toString() : v;
		return out;
	});
	return { eventName, fromBlock: fromBlock.toString(), toBlock: tip.toString(), count: events.length, events };
}
