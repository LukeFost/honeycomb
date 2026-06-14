// ============================================================================
// resolve_early: the maker closes a contest BEFORE its deadline (the "close
// quick" path on the mainnet escrow redeploy). Calls resolveEarly(jobId), which
// settles to the current best VALID leader (or refunds the maker if none) via
// the same _settle the CRON resolver uses — so the on-chain outcome + events are
// identical to a normal deadline resolution. BROADCASTS; requires SEP_PRIVATE_KEY.
//
// The maker only TRIGGERS settlement; the escrow picks the winner (best valid
// grade), so this cannot be used to pick a favourite — the anti-cheat property
// holds. The contract reverts if msg.sender != job client, the job isn't a
// funded contest, or it's already settled; those reverts surface to the caller.
// ============================================================================

import { decodeEventLog } from "viem";
import { ESCROW, ESCROW_ABI, publicClient, walletFromEnv } from "../chain.ts";

export const resolveEarlyInput = {
	jobId: {
		type: "string",
		description: "The bounty (job) id to close early. Must be a funded contest you created (the escrow requires msg.sender == the job client).",
	},
} as const;

export async function resolveEarly(args: { jobId: string }) {
	if (args.jobId === undefined || args.jobId === null || `${args.jobId}`.trim() === "") {
		throw new Error("jobId is required");
	}
	const jobId = BigInt(args.jobId);

	const { account, wallet } = walletFromEnv();

	// resolveEarly(jobId) — settles now to the best valid leader or refunds the maker.
	const txHash = await wallet.writeContract({
		address: ESCROW,
		abi: ESCROW_ABI,
		functionName: "resolveEarly",
		args: [jobId],
	});
	const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

	// _settle emits JobResolved(jobId, winnerAgentId, provider, score, paidOut) on
	// both the winner-paid and the no-winner-refund path (winnerAgentId/provider/
	// paidOut all zero on refund). Decode it for the outcome.
	let outcome:
		| { winnerAgentId: string; winnerWallet: string; score: number; paidOut: string; settled: boolean }
		| undefined;
	for (const log of receipt.logs) {
		if (log.address.toLowerCase() !== ESCROW.toLowerCase()) continue;
		try {
			const ev = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
			if (ev.eventName === "JobResolved") {
				const a = ev.args as { winnerAgentId: bigint; provider: string; score: number; paidOut: bigint };
				outcome = {
					winnerAgentId: a.winnerAgentId.toString(),
					winnerWallet: a.provider,
					score: Number(a.score),
					paidOut: a.paidOut.toString(),
					settled: true,
				};
				break;
			}
		} catch {
			// not a JobResolved log; skip
		}
	}
	if (!outcome) throw new Error("JobResolved event not found in receipt (resolveEarly did not settle)");

	const refunded = outcome.winnerAgentId === "0";
	return {
		jobId: jobId.toString(),
		caller: account.address,
		resolveTx: txHash,
		escrow: ESCROW,
		refunded, // true = no valid winner, budget refunded to the maker
		...outcome,
	};
}
