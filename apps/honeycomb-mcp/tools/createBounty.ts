// ============================================================================
// create_bounty: hash the PRIVATE bundle -> approve USDC -> createBounty, then
// read the real jobId from the JobCreated event. Broadcasts to Sepolia directly
// (per the chosen write-safety mode); requires SEP_PRIVATE_KEY.
//
// Mirrors apps/grading-cre/maker/create-bounty.ts step-for-step, in viem.
// ============================================================================

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { decodeEventLog, type Address, type Hex } from "viem";
import {
	ATTESTER_KEY,
	MAKER_PUBKEY,
	ESCROW,
	ESCROW_ABI,
	ERC20_ABI,
	USDC,
	publicClient,
	walletFromEnv,
} from "../chain.ts";

// grading-cre root, resolved relative to this file (apps/honeycomb-mcp/tools -> apps/grading-cre).
const GRADING_CRE = join(import.meta.dir, "..", "..", "grading-cre");

// testsHash digests EVERY file under <bountyDir>/private/, sorted. This MUST
// byte-match create-bounty.ts (apps/grading-cre/maker/create-bounty.ts): dotfiles
// dropped, sorted readdir, each file read as a RAW Buffer (no encoding), framed
// with "\n--FILE--\n", sha256. Read as Buffers — not utf8 — so the digest is
// byte-exact across both writers even for non-UTF8 / binary private files; a utf8
// round-trip here would silently diverge the on-chain testsHash from the maker's.
// A fixed file list (the old shape) diverged from the maker's sorted walk and
// produced a DIFFERENT testsHash for the identical bundle.
function bundleFiles(dir: string, files: string[]): Buffer {
	return Buffer.concat(
		files.flatMap((f, i) => {
			const data = readFileSync(join(dir, f)); // Buffer, no encoding
			return i === 0 ? [data] : [Buffer.from("\n--FILE--\n"), data];
		}),
	);
}
function bundlePrivateDir(bountyDir: string): Buffer {
	const dir = join(bountyDir, "private");
	// Drop dotfiles (.DS_Store etc.) so OS cruft can't perturb the commitment, and
	// fail loud on an empty dir rather than committing sha256("") silently.
	const files = readdirSync(dir)
		.filter((f) => !f.startsWith("."))
		.sort();
	if (files.length === 0) throw new Error(`no private files under ${dir}`);
	return bundleFiles(dir, files);
}

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
			"ADVANCED override of the private bundle file list (paths relative to bountyDir). Leave unset: the default sorted dir-walk of private/ matches create-bounty.ts's testsHash exactly. An explicit list will NOT reproduce the maker's digest.",
	},
	attesterKey: {
		type: "string",
		description:
			"Execution enclave's score-signer address. Sent on-chain by the 6-arg createBounty: the escrow ecrecovers each recorded grade against it. Default: the live KMS score-signer.",
	},
	makerPubKey: {
		type: "string",
		description:
			"Maker's X25519 delivery pubkey as bytes32. The grader seals the winning submission to it. Sent on-chain (createBounty reverts on zero). Default: MAKER_PUBKEY from env/chain.ts.",
	},
} as const;

export async function createBounty(args: {
	rewardUSDC?: number;
	hoursToDeadline?: number;
	bountyDir?: string;
	specCid?: string;
	privateFiles?: string[];
	attesterKey?: string;
	makerPubKey?: string;
}) {
	const reward = args.rewardUSDC ?? 50;
	const hours = args.hoursToDeadline ?? 1;
	const relDir = args.bountyDir ?? "maker/bounties/uniswap-lp-trading-bot";
	// A relative bountyDir MUST stay under apps/grading-cre — the docstring promises
	// it, and the bundle gets read + hashed + committed on-chain, so an unbounded
	// "../../" would read (and disclose the digest of) arbitrary files. Normalize
	// with resolve() so "../" segments collapse before the prefix check. An absolute
	// path is honored as a deliberate operator opt-out.
	const bountyDir = isAbsolute(relDir) ? relDir : resolve(GRADING_CRE, relDir);
	if (!isAbsolute(relDir)) {
		const root = resolve(GRADING_CRE);
		if (bountyDir !== root && !bountyDir.startsWith(root + sep)) {
			throw new Error(`bountyDir escapes apps/grading-cre: ${relDir}`);
		}
	}
	const attesterKey = (args.attesterKey ?? ATTESTER_KEY) as Address;
	const makerPubKey = (args.makerPubKey ?? MAKER_PUBKEY) as Hex;

	// 1. Commit to the PRIVATE bundle (never published). Default: the same sorted
	//    dir-walk the maker uses, so the testsHash is byte-identical regardless of
	//    which path opened the bounty. An explicit privateFiles override is honored
	//    but will NOT match the maker's digest — only use it if you know why.
	const bundle = args.privateFiles
		? bundleFiles(bountyDir, args.privateFiles)
		: bundlePrivateDir(bountyDir);
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
	// 6-arg: matches the REDEPLOYED escrow at 0x1210d43E (chain.ts ESCROW_ABI).
	// attesterKey binds the grade signature (the escrow ecrecovers each grade
	// against it) and makerPubKey is the maker's X25519 delivery key; the contract
	// reverts on a zero for either, so both must be real non-zero values.
	const createHash_ = await wallet.writeContract({
		address: ESCROW,
		abi: ESCROW_ABI,
		functionName: "createBounty",
		args: [budget, deadline, testsHash, specCid, attesterKey, makerPubKey],
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
		// Bound on-chain by the 6-arg createBounty above: the escrow stores
		// attesterKey as the job's ecrecover target and makerPubKey as the maker's
		// delivery key.
		attesterKey,
		makerPubKey,
		attesterKeyOnChain: true,
		approveTx: approveHash,
		createTx: createHash_,
		escrow: ESCROW,
	};
}
