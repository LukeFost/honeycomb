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
import { sepolia, mainnet } from "viem/chains";
import { SEPOLIA_RPC } from "@honeycomb/chain/sepolia";

// Network selector. HONEYCOMB_CHAIN=mainnet points the MCP at the LIVE mainnet e2e
// (escrow 0x90058162, MockUSDC 0x8f938d9d, ERC-8004 0x8004a169); default stays Sepolia
// so nothing breaks. Writes sign with the selected chainId, so this MUST switch the viem
// `chain`, not just the RPC — set HONEYCOMB_RPC to a real node (Alchemy) for production use.
export const MAINNET = process.env.HONEYCOMB_CHAIN === "mainnet";
export const CHAIN = MAINNET ? mainnet : sepolia;
export const RPC =
	process.env.HONEYCOMB_RPC?.trim() ||
	(MAINNET ? "https://ethereum-rpc.publicnode.com" : SEPOLIA_RPC);
// ERC-8183-conformant escrow (apps/grading-cre/INTEGRATION.md "Deployed"). 7-arg
// createBounty(...,attesterKey,makerPubKey,enclaveEncPub); the contract `is IERC8183`
// so the standard getJob() returns the 9-field Job and getJobFull() the rich struct
// the MCP reads (verified on-chain 2026-06-14: 0xce27EEDE, job #1 isContest=true).
// Both the ABI + JOB_TUPLE below match getJobFull.
export const ESCROW = (process.env.ESCROW ??
	(MAINNET
		? "0x90058162D3d55542f39507d0328538824A24C9C3"   // e2e escrow (canonical forwarder + resolveEarly)
		: "0xce27EEDE3b033582e1Adec94F8679d3feEF142c2")) as Address;
// Funding/reward token. Mainnet = REAL Circle USDC (FiatTokenV2, EIP-3009-capable;
// EIP-712 domain "USD Coin"/"2" verified on-chain 2026-06-14 against its live
// DOMAIN_SEPARATOR). Sepolia = MockUSDCv2. Override with USDC for a custom token
// (e.g. the staging MockUSDC 0x8f938d9d to test the mainnet rail without real
// money). The x402 token name/version (apps/honeycomb-mcp/x402.ts) MUST match the
// chosen token's domain or every funder signature fails verification.
export const USDC = (process.env.USDC ??
	(MAINNET
		? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"   // mainnet real USDC (Circle)
		: "0x3211C5E4B4d57B673d67a976699121667f419e17")) as Address;
// Execution enclave's score-signer. createBounty registers this as the job's
// attesterKey; the escrow ecrecovers each recorded grade against it (BountyEscrow
// .sol:248), so it MUST be the live KMS score-signer. The escrow
// reverts on attesterKey == 0. Sent on-chain by the 7-arg createBounty; override
// per-bounty with ATTESTER_KEY.
export const ATTESTER_KEY = (process.env.ATTESTER_KEY ??
	"0x5B57aF5eBAd44bEEfdfCcd71F33359d74Ec0e86F") as Address;

// Maker's X25519 delivery pubkey (32 bytes -> bytes32). The grader seals the
// winning code to this so only the maker can open it; the escrow reverts on a
// zero key. Default is a placeholder — override with the real maker key.
export const MAKER_PUBKEY = (process.env.MAKER_PUBKEY ??
	`0x${"11".repeat(32)}`) as Hex;

// Per-bounty enclave's X25519 SUBMISSION key (agents seal submissions to it). The
// escrow reverts on a zero key. This default is the pubkey of the warm grading
// enclave's baked X25519 secret (apps/grading-cre/grader/enclave/enclave_enc_secret),
// so bounties opened with it are sealable to the enclave we actually run — no more
// 0x2222… placeholder that submit_work refuses to seal to. Override with ENCLAVE_ENCPUB
// per-bounty. CAVEAT: the *currently deployed* warm image predates the sealed-encCid
// /grade branch (it only opens inline `code`), so end-to-end sealed grading needs the
// enclave redeployed from the current Dockerfile.server before this key is fully live.
export const ENCLAVE_ENCPUB = (process.env.ENCLAVE_ENCPUB ??
	"0x9a9154479731d21c2e27b04c0f284a5480090e4d2eb93787bda9dffd0d5a1257") as Hex;

// ERC-8004 Identity Registry on Sepolia (winner wallet lookups happen inside the
// escrow's resolve; surfaced here only for reference / future tools).
export const IDENTITY_REGISTRY = (process.env.IDENTITY_REGISTRY ??
	(MAINNET
		? "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"   // ERC-8004 Identity (Ethereum mainnet)
		: "0x8004A818BFB912233c491871b3d84c89A494BD9e")) as Address;

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
// getJobFull returns the full internal JobData struct; the tuple order MUST match
// the DEPLOYED BountyEscrow at ESCROW (Sepolia 0xce27EEDE), the ERC-8183-conformant
// redeploy. NOTE: the standard `getJob` now returns the SMALL ERC-8183 Job (9
// fields) — we read the rich struct via `getJobFull`. The G14 redeploy inserted
// `hook` + `isContest` after enclaveEncPub. The field ORDER is load-bearing — a
// mis-aligned decode reads garbage (verified on-chain 2026-06-14: full decode reads
// job #1 attesterKey 0x5B57aF / isContest true).
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
		{ name: "specCid", type: "string" }, // == ERC-8183 description
		{ name: "attesterKey", type: "address" }, // ecrecover target for scores
		{ name: "makerPubKey", type: "bytes32" }, // maker's X25519 delivery key
		{ name: "enclaveEncPub", type: "bytes32" }, // per-bounty enclave's X25519 submission key
		{ name: "hook", type: "address" }, // ERC-8183 hook (0 = non-hooked kernel)
		{ name: "isContest", type: "bool" }, // true = evaluator-settled bounty
		{ name: "bestAgentId", type: "uint256" },
		{ name: "bestScore", type: "uint16" },
		{ name: "bestScoreAtt", type: "bytes32" },
		{ name: "bestValidityAtt", type: "bytes32" },
		{ name: "gradeCount", type: "uint64" },
		{ name: "winnerDeliveryCid", type: "string" }, // winning code re-sealed to makerPubKey
	],
} as const;

export const ESCROW_ABI = [
	{
		type: "function",
		name: "createBounty",
		stateMutability: "nonpayable",
		// 7-arg: matches the ERC-8183 escrow at 0xce27EEDE. attesterKey binds the
		// grade signature (ecrecover), makerPubKey is the maker's X25519 delivery key,
		// enclaveEncPub the submission-sealing key; the contract reverts on any zero.
		inputs: [
			{ name: "budget", type: "uint256" },
			{ name: "expiredAt", type: "uint64" },
			{ name: "testsHash", type: "bytes32" },
			{ name: "specCid", type: "string" },
			{ name: "attesterKey", type: "address" },
			{ name: "makerPubKey", type: "bytes32" },
			{ name: "enclaveEncPub", type: "bytes32" },
		],
		outputs: [{ name: "jobId", type: "uint256" }],
	},
	{
		// Rich internal state. The standard ERC-8183 getJob() returns only the 9-field
		// Job; the MCP needs the contest/leaderboard fields, so it reads getJobFull.
		type: "function",
		name: "getJobFull",
		stateMutability: "view",
		inputs: [{ name: "jobId", type: "uint256" }],
		outputs: [JOB_TUPLE],
	},
	{
		// Agent: register a submission CID (the sealed-box ciphertext, sealed to the
		// job's enclaveEncPub). The escrow stores it on submissionOf[jobId][agentId];
		// the grading enclave re-fetches this CID at delivery to re-seal the winner.
		// ACCESS: the contract requires msg.sender == identityRegistry.getAgentWallet(
		// agentId), so this MUST be broadcast by the agent's OWN registered wallet —
		// submitWork signs it with SUBMIT_PRIVATE_KEY (see submitWork.ts). Overloads
		// the ERC-8183 submit(uint256,bytes32,bytes); distinct 3-arg selector.
		type: "function",
		name: "submit",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "jobId", type: "uint256" },
			{ name: "agentId", type: "uint256" },
			{ name: "encCid", type: "string" },
		],
		outputs: [],
	},
	{
		// Maker-driven EARLY close (resolveEarly, the "close quick" path on the mainnet
		// redeploy 0x90058162). Settles the contest BEFORE its deadline to the current
		// best VALID leader (or refunds the maker if none). msg.sender must == the job
		// client; the maker only TRIGGERS settlement for whoever legitimately leads, it
		// cannot pick the winner — so the anti-cheat property holds. Shares _settle with
		// the CRON _resolve, so it emits the SAME JobResolved/BountySettled events.
		type: "function",
		name: "resolveEarly",
		stateMutability: "nonpayable",
		inputs: [{ name: "jobId", type: "uint256" }],
		outputs: [],
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
		// ERC-8183 canonical JobCreated. (The rich create-time fields — token/budget/
		// testsHash/specCid — now live on the BountyCreated alias + getJobFull.)
		// createBounty.ts only needs jobId (topics[1]).
		type: "event",
		name: "JobCreated",
		inputs: [
			{ name: "jobId", type: "uint256", indexed: true },
			{ name: "client", type: "address", indexed: true },
			{ name: "provider", type: "address", indexed: false },
			{ name: "evaluator", type: "address", indexed: false },
			{ name: "expiredAt", type: "uint256", indexed: false },
		],
	},
	// The REDEPLOYED escrow splits a grade across three events (the old single
	// GradeRecorded no longer exists): ScoreRecorded (execution enclave) +
	// ValidityRecorded (AI attestor) + NewLeader (best VALID grade advanced).
	// Emitted by submit(jobId, agentId, encCid) — an agent registered a sealed
	// submission CID on-chain. (The contract dual-emits SubmissionMade with the
	// same args as a dashboard alias; we decode the lifecycle Submitted here.)
	// encCid is the gcs:// URI of the sealed-box ciphertext in the submissions
	// bucket; snapshotting it lets the monitor/db tie a submission to its content.
	{
		type: "event",
		name: "Submitted",
		inputs: [
			{ name: "jobId", type: "uint256", indexed: true },
			{ name: "agentId", type: "uint256", indexed: true },
			{ name: "encCid", type: "string", indexed: false },
		],
	},
	{
		type: "event",
		name: "ScoreRecorded",
		inputs: [
			{ name: "jobId", type: "uint256", indexed: true },
			{ name: "agentId", type: "uint256", indexed: true },
			{ name: "score", type: "uint16", indexed: false },
			{ name: "scoreDigest", type: "bytes32", indexed: false },
		],
	},
	{
		type: "event",
		name: "ValidityRecorded",
		inputs: [
			{ name: "jobId", type: "uint256", indexed: true },
			{ name: "agentId", type: "uint256", indexed: true },
			{ name: "valid", type: "bool", indexed: false },
			{ name: "validityAtt", type: "bytes32", indexed: false },
		],
	},
	{
		type: "event",
		name: "NewLeader",
		inputs: [
			{ name: "jobId", type: "uint256", indexed: true },
			{ name: "agentId", type: "uint256", indexed: true },
			{ name: "score", type: "uint16", indexed: false },
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

// ERC-8004 Identity Registry. The registry is an ERC-721 — an agent is an NFT,
// minted to msg.sender by register(). submit() ecrecovers msg.sender against
// getAgentWallet(agentId), so submitWork reads getAgentWallet to fail loud on a
// registry mismatch BEFORE broadcasting a sure-to-revert submit.
//
// register surface (verified on-chain 2026-06-14 against the live mainnet registry
// 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432 via its UUPS impl 0x7274e874): three
// overloads — register() mints with no metadata; register(string) sets a tokenURI/
// domain at mint; the tuple overload sets metadata keys. We expose the two an agent
// actually self-registers with. register* MINTS to msg.sender, so the minting wallet
// becomes the agent's wallet — which is exactly what getAgentWallet returns and what
// the escrow's submit() requires. Called against IDENTITY_REGISTRY, not ESCROW.
export const IDENTITY_ABI = [
	{
		type: "function",
		name: "getAgentWallet",
		stateMutability: "view",
		inputs: [{ name: "agentId", type: "uint256" }],
		outputs: [{ name: "", type: "address" }],
	},
	{
		type: "function",
		name: "register",
		stateMutability: "nonpayable",
		inputs: [],
		outputs: [{ name: "agentId", type: "uint256" }],
	},
	{
		type: "function",
		name: "register",
		stateMutability: "nonpayable",
		inputs: [{ name: "tokenURI", type: "string" }],
		outputs: [{ name: "agentId", type: "uint256" }],
	},
	// Emitted by register*: Registered(agentId indexed, tokenURI, owner indexed). We
	// parse it from the tx receipt to learn the minted agentId without a follow-up read.
	{
		type: "event",
		name: "Registered",
		inputs: [
			{ name: "agentId", type: "uint256", indexed: true },
			{ name: "tokenURI", type: "string", indexed: false },
			{ name: "owner", type: "address", indexed: true },
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

export const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });

/** Wallet client built from SEP_PRIVATE_KEY. Throws if unset — only writes need it. */
export function walletFromEnv() {
	const pk = process.env.SEP_PRIVATE_KEY;
	if (!pk) throw new Error("SEP_PRIVATE_KEY not set (required for on-chain writes)");
	const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
	const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
	return { account, wallet };
}

/**
 * Wallet client built from a specific raw private key (0x-optional). Used by the
 * submit() leg, which the escrow requires to be signed by the AGENT's own
 * registered wallet — a different key than the maker/relayer SEP_PRIVATE_KEY.
 * Throws on a missing/blank key so the caller fails loud rather than reverting.
 */
export function walletFromKey(pk: string | undefined, label = "private key") {
	if (!pk || !pk.trim()) throw new Error(`${label} not set (required for this on-chain write)`);
	const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
	const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
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
		attesterKey: raw.attesterKey as Address,
		makerPubKey: raw.makerPubKey as Hex,
		enclaveEncPub: raw.enclaveEncPub as Hex,
		hook: raw.hook as Address, // ERC-8183 hook (0 = non-hooked kernel)
		isContest: Boolean(raw.isContest), // evaluator-settled bounty vs generic 8183 job
		bestAgentId: raw.bestAgentId.toString(),
		bestScore: Number(raw.bestScore),
		bestScoreAtt: raw.bestScoreAtt as Hex,
		bestValidityAtt: raw.bestValidityAtt as Hex,
		gradeCount: Number(raw.gradeCount),
		winnerDeliveryCid: raw.winnerDeliveryCid as string,
	};
}
