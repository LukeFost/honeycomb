// ============================================================================
// Shared on-chain surface for the Honeycomb MCP server.
//
// Addresses + RPC mirror apps/grading-cre/maker/create-bounty.ts (Sepolia). The
// ABI here is the SUBSET the MCP needs: createBounty (write), getJob/isSettled/
// winnerWalletOf (read), plus the three events the monitor decodes.
// ============================================================================

import {
	createPublicClient,
	createWalletClient,
	http,
	type Address,
	type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { SEPOLIA_RPC } from "@honeycomb/chain/sepolia";

// Canonical Sepolia RPC (env-driven, secret stays in .env). See packages/chain.
export const RPC = SEPOLIA_RPC;
export const ESCROW = (process.env.ESCROW ??
	"0xC0543ac495B24948Ad84cD15d8488d7Af2F9ca90") as Address;
export const USDC = (process.env.USDC ??
	"0x3211C5E4B4d57B673d67a976699121667f419e17") as Address;
// Execution enclave's score-signer. createBounty registers this as the job's
// attesterKey; the escrow ecrecovers each recorded grade against it (BountyEscrow
// .sol:214), so it MUST be the live KMS signer (grader/HANDOFF.md:88). The escrow
// rejects attesterKey == 0. Override per-bounty with ATTESTER_KEY.
export const ATTESTER_KEY = (process.env.ATTESTER_KEY ??
	"0x5B57aF5eBAd44bEEfdfCcd71F33359d74Ec0e86F") as Address;

// ERC-8004 Identity Registry on Sepolia (winner wallet lookups happen inside the
// escrow's resolve; surfaced here only for reference / future tools).
export const IDENTITY_REGISTRY = (process.env.IDENTITY_REGISTRY ??
	"0x8004A818BFB912233c491871b3d84c89A494BD9e") as Address;

export const JOB_STATUS = [
	"Open",
	"Funded",
	"Submitted",
	"Completed",
	"Rejected",
	"Expired",
] as const;
export type JobStatusName = (typeof JOB_STATUS)[number];

// --- ABI (subset) -----------------------------------------------------------
// getJob returns the full Job struct; the tuple order MUST match the DEPLOYED
// BountyEscrow at ESCROW (Sepolia 0xC054…), which is the 15-field struct (id,
// client, provider, evaluator, budget, expiredAt, status, token, testsHash,
// specCid, bestAgentId, bestScore, bestScoreAtt, bestValidityAtt, gradeCount).
// NOTE: BountyEscrow.sol source has since added `attesterKey` after specCid (the
// G11 score-binding), but that contract is NOT redeployed yet — adding the field
// here would mis-decode the live 15-field struct. Re-add attesterKey + the
// createBounty(…,address) arg in lockstep with the redeploy. Verified 2026-06-13:
// 15-field decode reads job #1 score 2282 / agent 6552 clean.
const JOB_TUPLE = {
	type: "tuple",
	components: [
		{ name: "id", type: "uint256" },
		{ name: "client", type: "address" },
		{ name: "provider", type: "address" },
		{ name: "evaluator", type: "address" },
		{ name: "budget", type: "uint256" },
		{ name: "expiredAt", type: "uint64" },
		{ name: "status", type: "uint8" },
		{ name: "token", type: "address" },
		{ name: "testsHash", type: "bytes32" },
		{ name: "specCid", type: "string" },
		{ name: "bestAgentId", type: "uint256" },
		{ name: "bestScore", type: "uint16" },
		{ name: "bestScoreAtt", type: "bytes32" },
		{ name: "bestValidityAtt", type: "bytes32" },
		{ name: "gradeCount", type: "uint64" },
	],
} as const;

export const ESCROW_ABI = [
	{
		type: "function",
		name: "createBounty",
		stateMutability: "nonpayable",
		// 4-arg: matches the DEPLOYED escrow. Source adds a 5th `attesterKey`
		// (address) arg, gated on the redeploy — see JOB_TUPLE note.
		inputs: [
			{ name: "budget", type: "uint256" },
			{ name: "expiredAt", type: "uint64" },
			{ name: "testsHash", type: "bytes32" },
			{ name: "specCid", type: "string" },
		],
		outputs: [{ name: "jobId", type: "uint256" }],
	},
	{
		type: "function",
		name: "getJob",
		stateMutability: "view",
		inputs: [{ name: "jobId", type: "uint256" }],
		outputs: [JOB_TUPLE],
	},
	{
		type: "function",
		name: "isSettled",
		stateMutability: "view",
		inputs: [{ name: "jobId", type: "uint256" }],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "winnerWalletOf",
		stateMutability: "view",
		inputs: [{ name: "jobId", type: "uint256" }],
		outputs: [{ name: "", type: "address" }],
	},
	{
		type: "function",
		name: "nextJobId",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "event",
		name: "JobCreated",
		inputs: [
			{ name: "jobId", type: "uint256", indexed: true },
			{ name: "client", type: "address", indexed: true },
			{ name: "token", type: "address", indexed: false },
			{ name: "budget", type: "uint256", indexed: false },
			{ name: "expiredAt", type: "uint64", indexed: false },
			{ name: "testsHash", type: "bytes32", indexed: false },
			{ name: "specCid", type: "string", indexed: false },
		],
	},
	{
		type: "event",
		name: "GradeRecorded",
		inputs: [
			{ name: "jobId", type: "uint256", indexed: true },
			{ name: "agentId", type: "uint256", indexed: true },
			{ name: "score", type: "uint16", indexed: false },
			{ name: "valid", type: "bool", indexed: false },
			{ name: "scoreAttestationHash", type: "bytes32", indexed: false },
			{ name: "validityAttestationHash", type: "bytes32", indexed: false },
			{ name: "newLeader", type: "bool", indexed: false },
		],
	},
	{
		type: "event",
		name: "JobResolved",
		inputs: [
			{ name: "jobId", type: "uint256", indexed: true },
			{ name: "winnerAgentId", type: "uint256", indexed: true },
			{ name: "provider", type: "address", indexed: false },
			{ name: "score", type: "uint16", indexed: false },
			{ name: "paidOut", type: "uint256", indexed: false },
		],
	},
] as const;

export const ERC20_ABI = [
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "allowance",
		stateMutability: "view",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
		],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "function",
		name: "balanceOf",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "function",
		name: "decimals",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "uint8" }],
	},
] as const;

export const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });

/** Wallet client built from SEP_PRIVATE_KEY. Throws if unset — only writes need it. */
export function walletFromEnv() {
	const pk = process.env.SEP_PRIVATE_KEY;
	if (!pk) throw new Error("SEP_PRIVATE_KEY not set (required for on-chain writes)");
	const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
	const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
	return { account, wallet };
}

/** Decode a raw getJob tuple into a plain JSON-safe object (bigints -> strings). */
export function decodeJob(raw: any) {
	const statusIdx = Number(raw.status);
	return {
		id: raw.id.toString(),
		client: raw.client as Address,
		provider: raw.provider as Address,
		evaluator: raw.evaluator as Address,
		budget: raw.budget.toString(),
		budgetUSDC: Number(raw.budget) / 1e6,
		expiredAt: Number(raw.expiredAt),
		expiredAtISO: new Date(Number(raw.expiredAt) * 1000).toISOString(),
		status: statusIdx,
		statusName: (JOB_STATUS[statusIdx] ?? `Unknown(${statusIdx})`) as string,
		token: raw.token as Address,
		testsHash: raw.testsHash as Hex,
		specCid: raw.specCid as string,
		bestAgentId: raw.bestAgentId.toString(),
		bestScore: Number(raw.bestScore),
		bestScoreAtt: raw.bestScoreAtt as Hex,
		bestValidityAtt: raw.bestValidityAtt as Hex,
		gradeCount: Number(raw.gradeCount),
	};
}
