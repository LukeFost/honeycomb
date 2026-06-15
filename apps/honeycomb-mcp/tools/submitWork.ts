// ============================================================================
// submit_work: the SOLVER's direct front door.
//
// A solver has a strategy/work file and a bounty id. This tool now runs the useful
// product path without Chainlink CRE or an on-chain grading relay:
//
//   1. read the bounty   — confirm it's a live, open task worth submitting to
//   2. hash the work     — produce a deterministic receipt for the user's output
//   3. grade the file    — through gradeSubmission (score + validity metadata)
//   4. report honestly   — return the score, validity, receipt hash, and whether
//                          it WOULD beat the current on-chain leader
//
// It deliberately does NOT pretend to settle the escrow. There is no CRE workflow,
// no enclave-signature requirement, no relayer key, and no `cre` CLI. The returned
// `recordedOnChain: false` is load-bearing: callers can show a direct, user-owned
// work result without claiming a false on-chain leader update.
// ============================================================================

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { gradeSubmission } from "./grade.ts";
import { getJob } from "./monitor.ts";

// Resolve paths CWD-independently. Prefer the API/plugin contract (repo-relative)
// but keep the old grader shorthand (relative to apps/grading-cre) working.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const GRADING_CRE_ROOT = join(REPO_ROOT, "apps", "grading-cre");

export const submitWorkInput = {
	jobId: {
		type: "string",
		description: "The bounty/task id you're submitting to. Get it from list_jobs / get_job.",
	},
	submissionPath: {
		type: "string",
		description: "Repo-relative path to your submission/work file. Grader shorthand relative to apps/grading-cre also works.",
	},
	agentId: {
		type: "string",
		description: "Your ERC-8004 agentId, used for attribution in the direct receipt. Default 22.",
	},
	bounty: {
		type: "string",
		enum: ["directional", "lp"],
		description: "Which scorer the task uses. directional -> scorer.py; lp -> lp_scorer.py. Default directional.",
	},
} as const;

export async function submitWork(args: {
	jobId: string;
	submissionPath: string;
	agentId?: string;
	bounty?: string;
}) {
	if (!args.jobId) throw new Error("jobId is required");
	if (!args.submissionPath) throw new Error("submissionPath is required");
	const agentId = args.agentId ?? "22";

	// 1. Read the bounty first — don't grade against a job that's already settled or
	//    past deadline. Even though this direct mode does not settle on-chain, a stale
	//    task would give the user misleading feedback.
	const job = await getJob({ jobId: args.jobId });
	if (job.settled) {
		throw new Error(`bounty #${args.jobId} is already settled — too late to submit`);
	}
	const now = Math.floor(Date.now() / 1000);
	if (job.expiredAt && job.expiredAt < now) {
		throw new Error(
			`bounty #${args.jobId} deadline passed (${job.expiredAtISO}) — too late to submit`,
		);
	}

	// 2. Produce a user-owned direct receipt over the exact file bytes. This replaces
	//    the old sealed encCid + CRE callback path for the submit front door.
	const submissionFile = readSubmission(args.submissionPath);
	const { resolvedPath, ...submission } = submissionFile;

	// 3. Grade through the grader. This may run the optional Confidential AI validity
	//    path when explicitly enabled, but submit_work no longer REQUIRES a hardware
	//    signature or relays anything through CRE. Use the exact same resolved path
	//    that we hashed for the receipt so grade+receipt cannot diverge.
	const grade = await gradeSubmission({
		submissionPath: resolvedPath,
		bounty: args.bounty,
		jobId: args.jobId,
		agentId,
	});

	const score: number = grade.score;
	const valid: boolean = grade.valid;
	const validityAttestation: string | undefined = grade.validityAttestation;
	const wouldBeLeader = Boolean(valid && score > job.bestScore);

	return {
		jobId: args.jobId,
		agentId,
		score,
		valid,
		// Honest status: this direct path does not mutate the escrow leaderboard.
		isLeader: false,
		wouldBeLeader,
		recordedOnChain: false,
		recordingMode: "direct" as const,
		// Compatibility fields kept explicit/null so older callers don't mistake an
		// omitted tx for a successful broadcast.
		encCid: null,
		submitTx: null,
		scoreTx: null,
		validityTx: null,
		// Direct receipt for the user's work output.
		submission,
		summary: plainSummary({ score, valid, wouldBeLeader, bestScore: job.bestScore }),
		bestAgentId: job.bestAgentId,
		bestScore: job.bestScore,
		gradeCount: job.gradeCount,
		validityAttestation,
		scoreAttestation: (grade as { scoreAttestation?: string }).scoreAttestation,
		scoreSignature: null,
		attestationSource: (grade as { attestationSource?: string }).attestationSource ?? "direct",
		validityMode: (grade as { validityMode?: string }).validityMode ?? "direct",
	};
}

// --- direct receipt ----------------------------------------------------------
function readSubmission(submissionPath: string): {
	path: string;
	resolvedPath: string;
	sha256: string;
	byteLen: number;
} {
	const subPath = resolveSubmissionPath(submissionPath);
	const bytes = readFileSync(subPath);
	return {
		path: submissionPath,
		resolvedPath: subPath,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		byteLen: bytes.length,
	};
}

function resolveSubmissionPath(submissionPath: string): string {
	if (isAbsolute(submissionPath)) {
		if (!existsSync(submissionPath)) throw new Error(`submission file not found: ${submissionPath}`);
		return submissionPath;
	}
	const repoRelative = resolve(REPO_ROOT, submissionPath);
	if (existsSync(repoRelative)) return repoRelative;
	const graderRelative = resolve(GRADING_CRE_ROOT, submissionPath);
	if (existsSync(graderRelative)) return graderRelative;
	throw new Error(
		`submission file not found: ${submissionPath} (tried ${repoRelative} and ${graderRelative})`,
	);
}

// --- plain-English summary --------------------------------------------------
function plainSummary(s: {
	score: number;
	valid: boolean;
	wouldBeLeader: boolean;
	bestScore: number;
}): string {
	const base = s.valid
		? `Scored ${s.score}/10000 and the validity check passed.`
		: `Graded ${s.score}/10000, but the validity check failed.`;
	const leader = s.wouldBeLeader
		? `This would beat the current on-chain leader (${s.bestScore}/10000).`
		: `The current on-chain leader is ${s.bestScore}/10000.`;
	return `${base} ${leader} Direct mode did not record anything on-chain; keep the returned submission.sha256 as the work receipt.`;
}
