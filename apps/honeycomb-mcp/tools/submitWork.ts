// ============================================================================
// submit_work: the SOLVER's one-call front door.
//
// A solver has a strategy file and a bounty id. This tool runs the whole solver
// leg for them, in plain steps:
//
//   1. read the bounty  — confirm it's a live, open contest worth submitting to
//   2. grade the file   — through the REAL grader (gradeSubmission), which yields
//                         an execution score, an AI validity verdict, and — on the
//                         enclave path — a KMS-HSM signature the escrow ecrecovers
//   3. record on-chain  — relay BOTH gates (score + validity) through the CRE
//                         grading-workflow via `cre workflow simulate --broadcast`,
//                         the SAME path e2e-mainnet.sh uses, so the grade lands on
//                         BountyEscrow and the solver can become the leader
//   4. say what happened — a short plain-English summary: your score, valid or not,
//                         and whether you're now the bounty's leader
//
// On-chain recording needs a real enclave signature (the local content-commitment
// has none to ecrecover) and the `cre` CLI on PATH. Per the repo's loud-failure
// rule, a missing signature or a missing/ failing `cre` THROWS — it never silently
// downgrades to "graded but not recorded" and reports a false green.
// ============================================================================

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeSubmission } from "./grade.ts";
import { getJob } from "./monitor.ts";

// Where the CRE grading-workflow lives (apps/grading-cre). `cre workflow simulate`
// must run from this dir so it resolves grading-workflow + its target settings.
const GRADING_CRE = join(import.meta.dir, "..", "..", "grading-cre");

// The CRE settings target naming the deployed escrow + forwarder. e2e-mainnet.sh
// uses `mainnet-settings`; override per-env (e.g. a Sepolia settings file) with
// HONEYCOMB_CRE_TARGET. The grading-workflow's onCallback (trigger-index 0) reads
// the http-payload and writes the report through the forwarder.
const CRE_TARGET = process.env.HONEYCOMB_CRE_TARGET ?? "mainnet-settings";

// The maker/relayer key the CRE simulate broadcasts with. e2e exports
// CRE_ETH_PRIVATE_KEY; fall back to SEP_PRIVATE_KEY so a single key configured for
// the rest of the MCP also drives the relay. No key -> we can't broadcast, throw.
const CRE_KEY = process.env.CRE_ETH_PRIVATE_KEY ?? process.env.SEP_PRIVATE_KEY;

export const submitWorkInput = {
	jobId: {
		type: "string",
		description: "The bounty (job) id you're submitting to. Get it from list_jobs / get_job.",
	},
	submissionPath: {
		type: "string",
		description: "Path to your submission file (a .py strategy). Relative paths resolve under apps/grading-cre.",
	},
	agentId: {
		type: "string",
		description: "Your ERC-8004 agentId — the identity the grade is recorded under. Default 22.",
	},
	bounty: {
		type: "string",
		enum: ["directional", "lp"],
		description: "Which scorer the bounty uses. directional -> scorer.py; lp -> lp_scorer.py. Default directional.",
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
	//    past deadline; the solver would burn a grade that can never win. We surface
	//    the reason instead of letting the on-chain record silently no-op later.
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

	// 2. Grade through the real grader. On the enclave path this also returns the
	//    KMS-HSM signature the escrow ecrecovers; on the local path it does not.
	const grade = await gradeSubmission({
		submissionPath: args.submissionPath,
		bounty: args.bounty,
		jobId: args.jobId,
		agentId,
	});

	const score: number = grade.score;
	const valid: boolean = grade.valid;
	const validityAttestation: string = grade.validityAttestation;
	const signature = (grade as { signature?: { v?: number; r?: string; s?: string } }).signature;

	// 3. Record on-chain. recordScore is ecrecovered against the job's attesterKey,
	//    so it NEEDS a real enclave signature. The local content-commitment has none
	//    — broadcasting it would revert on-chain. Fail loud and tell the operator how
	//    to get a signature (point the grader at the enclave) rather than pretend.
	if (!signature || !signature.r || !signature.s) {
		throw new Error(
			"graded, but no enclave signature to record on-chain: recordScore is ecrecovered against the bounty's attesterKey, so it requires the KMS-HSM signature from the grading enclave. Set GRADER_ENCLAVE_URL so grade runs in the Confidential Space enclave, then resubmit.",
		);
	}
	if (!CRE_KEY) {
		throw new Error(
			"cannot broadcast the grade: set CRE_ETH_PRIVATE_KEY (or SEP_PRIVATE_KEY) to the relayer key the CRE forwarder broadcasts with.",
		);
	}

	const scoreTx = await broadcastCallback({
		kind: "score",
		jobId: Number(args.jobId),
		agentId: Number(agentId),
		status: "completed",
		score,
		signature,
	});
	const validityTx = await broadcastCallback({
		kind: "validity",
		jobId: Number(args.jobId),
		agentId: Number(agentId),
		status: "completed",
		valid,
		validityAttestation,
	});

	// 4. Did this grade take the lead? Re-read the bounty: the escrow only advances
	//    bestAgentId on a VALID grade that beats the standing best, so comparing the
	//    fresh leader to this agent is the honest "are you winning?" check.
	const after = await getJob({ jobId: args.jobId });
	const isLeader = after.bestAgentId === agentId && after.bestScore === score;

	return {
		jobId: args.jobId,
		agentId,
		score,
		valid,
		isLeader,
		// Plain-English one-liner the solver actually reads.
		summary: plainSummary({ score, valid, isLeader, bestScore: after.bestScore }),
		scoreTx,
		validityTx,
		bestAgentId: after.bestAgentId,
		bestScore: after.bestScore,
		gradeCount: after.gradeCount,
		validityAttestation,
		scoreSignature: signature,
		attestationSource: (grade as { attestationSource?: string }).attestationSource ?? "local",
	};
}

// --- plain-English summary --------------------------------------------------
function plainSummary(s: {
	score: number;
	valid: boolean;
	isLeader: boolean;
	bestScore: number;
}): string {
	if (!s.valid) {
		return `Graded ${s.score}/10000, but the validity check FAILED — this submission can't win. Fix the strategy so it genuinely computes its answer (no hardcoding) and resubmit.`;
	}
	if (s.isLeader) {
		return `Scored ${s.score}/10000 and it's valid — you're the new leader. Hold this until the bounty settles to win.`;
	}
	return `Scored ${s.score}/10000 and it's valid, but the leader is ahead at ${s.bestScore}/10000. Improve the strategy and resubmit to take the lead.`;
}

// --- CRE broadcast ----------------------------------------------------------
// Relay one callback (score OR validity) through the CRE grading-workflow exactly
// as e2e-mainnet.sh does: write the payload to a temp file and run
//   cre workflow simulate grading-workflow --non-interactive --target <t>
//       --trigger-index 0 --http-payload <file> --broadcast
// from apps/grading-cre, with CRE_ETH_PRIVATE_KEY in env. Parse the broadcast tx
// hash from stdout. A missing `cre` binary or a non-zero exit THROWS (no fake green).
async function broadcastCallback(payload: Record<string, unknown>): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "honeycomb-cb-"));
	const file = join(dir, `${payload.kind}.json`);
	writeFileSync(file, JSON.stringify(payload));
	try {
		const proc = Bun.spawn(
			[
				"cre",
				"workflow",
				"simulate",
				"grading-workflow",
				"--non-interactive",
				"--target",
				CRE_TARGET,
				"--trigger-index",
				"0",
				"--http-payload",
				file,
				"--broadcast",
			],
			{
				cwd: GRADING_CRE,
				env: { ...(process.env as Record<string, string>), CRE_ETH_PRIVATE_KEY: stripHex(CRE_KEY as string) },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const combined = `${stdout}\n${stderr}`;
		if (code !== 0) {
			// `cre: command not found` (127) is the common "CLI not installed" case —
			// name it explicitly so the operator knows what to install.
			if (code === 127 || /command not found|No such file/.test(combined)) {
				throw new Error(
					`the 'cre' CLI is not installed on this host, so the grade can't be broadcast. Install the Chainlink CRE CLI (it's what relays the score/validity gates on-chain) and retry.`,
				);
			}
			throw new Error(`cre broadcast (${payload.kind}) failed [exit ${code}]: ${combined.trim().slice(0, 600)}`);
		}
		const tx = combined.match(/0x[0-9a-fA-F]{64}/)?.[0];
		if (!tx) {
			throw new Error(`cre broadcast (${payload.kind}) returned no tx hash: ${combined.trim().slice(0, 600)}`);
		}
		return tx;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const stripHex = (k: string) => (k.startsWith("0x") ? k.slice(2) : k);
