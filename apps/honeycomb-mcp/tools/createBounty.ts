// ============================================================================
// create_bounty: hash the PRIVATE bundle -> approve USDC -> createBounty, then
// read the real jobId from the JobCreated event. Broadcasts to Sepolia directly
// (per the chosen write-safety mode); requires SEP_PRIVATE_KEY.
//
// Mirrors apps/grading-cre/maker/create-bounty.ts step-for-step, in viem.
// ============================================================================

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { decodeEventLog, type Hex } from "viem";
import {
	ESCROW,
	ESCROW_ABI,
	ERC20_ABI,
	USDC,
	publicClient,
	walletFromEnv,
} from "../chain.ts";

// grading-cre root, resolved relative to this file (apps/honeycomb-mcp/tools -> apps/grading-cre).
const GRADING_CRE = join(import.meta.dir, "..", "..", "grading-cre");

// Fixed bundle order — MUST match create-bounty.ts so the testsHash commitment
// is reproducible by anyone holding the private files.
const PRIVATE_FILES = ["private/rubric.md", "private/scoring.py", "private/prices_private.json"];

export const createBountyInput = {
	rewardUSDC: { type: "number", description: "Reward in human USDC (6-decimal token). E.g. 50." },
	hoursToDeadline: { type: "number", description: "Hours from now until the contest deadline." },
	bountyDir: {
		type: "string",
		description:
			"Path to the bounty dir holding private/ files. Relative paths resolve under apps/grading-cre. Default: maker/bounties/uniswap-lp-trading-bot",
	},
	specCid: {
		type: "string",
		description: "Public spec reference (IPFS CID or honeycomb:// URI). Optional; auto-derived if omitted.",
	},
	privateFiles: {
		type: "array",
		items: { type: "string" },
		description:
			"Override the private bundle file list (relative to bountyDir). Default matches create-bounty.ts: rubric.md, scoring.py, prices_private.json.",
	},
} as const;

export async function createBounty(args: {
	rewardUSDC?: number;
	hoursToDeadline?: number;
	bountyDir?: string;
	specCid?: string;
	privateFiles?: string[];
}) {
	const reward = args.rewardUSDC ?? 50;
	const hours = args.hoursToDeadline ?? 1;
	const relDir = args.bountyDir ?? "maker/bounties/uniswap-lp-trading-bot";
	const bountyDir = isAbsolute(relDir) ? relDir : join(GRADING_CRE, relDir);
	const files = args.privateFiles ?? PRIVATE_FILES;

	// 1. Commit to the PRIVATE bundle (fixed order, never published).
	const bundle = files.map((f) => readFileSync(join(bountyDir, f), "utf8")).join("\n--FILE--\n");
	const testsHash = ("0x" + createHash("sha256").update(bundle).digest("hex")) as Hex;

	const budget = BigInt(Math.round(reward * 1e6));
	const deadline = BigInt(Math.floor(Date.now() / 1000) + hours * 3600);
	const specCid = args.specCid ?? `honeycomb://${relDir.split("/").pop()}/spec.md`;

	const { account, wallet } = walletFromEnv();

	// 2. approve the escrow to pull the reward.
	const approveHash = await wallet.writeContract({
		address: USDC,
		abi: ERC20_ABI,
		functionName: "approve",
		args: [ESCROW, budget],
	});
	await publicClient.waitForTransactionReceipt({ hash: approveHash });

	// 3. createBounty, then recover the real jobId from JobCreated (topics[1]).
	const createHash_ = await wallet.writeContract({
		address: ESCROW,
		abi: ESCROW_ABI,
		functionName: "createBounty",
		args: [budget, deadline, testsHash, specCid],
	});
	const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash_ });

	let jobId: string | undefined;
	for (const log of receipt.logs) {
		if (log.address.toLowerCase() !== ESCROW.toLowerCase()) continue;
		try {
			const ev = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
			if (ev.eventName === "JobCreated") {
				jobId = (ev.args as { jobId: bigint }).jobId.toString();
				break;
			}
		} catch {
			// not a JobCreated log; skip
		}
	}
	if (!jobId) throw new Error("JobCreated event not found in receipt");

	return {
		jobId,
		client: account.address,
		budget: budget.toString(),
		rewardUSDC: reward,
		deadline: Number(deadline),
		deadlineISO: new Date(Number(deadline) * 1000).toISOString(),
		testsHash,
		specCid,
		approveTx: approveHash,
		createTx: createHash_,
		escrow: ESCROW,
	};
}
