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

import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readContract } from "viem/actions";
import {
	ESCROW,
	ESCROW_ABI,
	IDENTITY_REGISTRY,
	IDENTITY_ABI,
	publicClient,
	walletFromKey,
} from "../chain.ts";
import { putContent, SUBMISSIONS_BUCKET } from "../storage/gcs.ts";
import { sealToPub } from "../storage/seal.ts";
import { gradeSubmission } from "./grade.ts";
import { getJob } from "./monitor.ts";

// grading-cre root, for resolving a relative submissionPath (mirrors grade.ts).
const GRADING_CRE_ROOT = join(import.meta.dir, "..", "..", "grading-cre");

// The agent's OWN key, which the escrow's submit() requires as msg.sender. Distinct
// from the maker/relayer SEP_PRIVATE_KEY that drives createBounty and the CRE relay.
// Falls back to SEP_PRIVATE_KEY for the common single-key dev setup.
const SUBMIT_KEY = process.env.SUBMIT_PRIVATE_KEY ?? process.env.SEP_PRIVATE_KEY;

// The placeholder enclaveEncPub (chain.ts default until a real key is summoned).
// Sealing to it produces a blob nobody can open, so we refuse rather than upload
// an unopenable submission.
const PLACEHOLDER_ENCPUB = `0x${"22".repeat(32)}`;

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

	// 1.5 Seal + register the submission CID on-chain (Leg 1 of encrypted delivery).
	//     The plaintext .py is sealed to the job's enclaveEncPub, uploaded to the
	//     submissions bucket, and its gcs:// URI is written to submissionOf[jobId]
	//     [agentId] via submit(jobId, agentId, encCid). The grading enclave re-fetches
	//     this CID at delivery to re-seal the winner to the maker. This is what makes
	//     encCid (previously never populated) point at real, openable content.
	const { encCid, submitTx } = await sealAndRegister({
		jobId: args.jobId,
		agentId,
		submissionPath: args.submissionPath,
		enclaveEncPub: job.enclaveEncPub,
	});

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
		// Leg 1 of encrypted delivery: the sealed submission's content-addressed URI,
		// now registered on-chain (submissionOf[jobId][agentId].encCid). Resolvable
		// only by the grading enclave that holds the matching secret.
		encCid,
		submitTx,
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

// --- seal + register submission CID (Leg 1) ---------------------------------
// Read the plaintext submission, seal it to the job's enclaveEncPub, upload the
// ciphertext to the submissions bucket, then register the resulting gcs:// URI
// on-chain via submit(jobId, agentId, encCid). The escrow requires msg.sender ==
// the agent's registered wallet, so we sign with SUBMIT_KEY and pre-check the
// registry to fail loud on a mismatch rather than burn gas on a sure revert.
async function sealAndRegister(p: {
	jobId: string;
	agentId: string;
	submissionPath: string;
	enclaveEncPub: string;
}): Promise<{ encCid: string; submitTx: string }> {
	// Resolve + read the submission (relative paths resolve under apps/grading-cre).
	const subPath = isAbsolute(p.submissionPath)
		? p.submissionPath
		: resolve(GRADING_CRE_ROOT, p.submissionPath);
	if (!existsSync(subPath)) throw new Error(`submission file not found: ${subPath}`);
	const plaintext = readFileSync(subPath, "utf8");

	// Refuse to seal to the placeholder enclave key — the blob would be unopenable.
	if (p.enclaveEncPub.toLowerCase() === PLACEHOLDER_ENCPUB) {
		throw new Error(
			`bounty #${p.jobId} has the placeholder enclaveEncPub (0x2222…) — no enclave holds the matching secret, so a sealed submission could never be opened. The maker must open the bounty with a real enclaveEncPub (summon a grading enclave key) before submissions can be sealed.`,
		);
	}

	// The submit() tx must come from the agent's OWN registered wallet.
	if (!SUBMIT_KEY) {
		throw new Error(
			"cannot register the submission on-chain: set SUBMIT_PRIVATE_KEY (or SEP_PRIVATE_KEY) to the agent's registered wallet key — the escrow's submit() requires msg.sender == getAgentWallet(agentId).",
		);
	}
	const { account, wallet } = walletFromKey(SUBMIT_KEY, "SUBMIT_PRIVATE_KEY");

	// Pre-check the registry: if the signer isn't the agent's wallet, submit() will
	// revert "not agent wallet". Surface that BEFORE broadcasting.
	const registered = (await readContract(publicClient, {
		address: IDENTITY_REGISTRY,
		abi: IDENTITY_ABI,
		functionName: "getAgentWallet",
		args: [BigInt(p.agentId)],
	})) as `0x${string}`;
	if (registered.toLowerCase() !== account.address.toLowerCase()) {
		throw new Error(
			`SUBMIT_PRIVATE_KEY wallet ${account.address} is not the registered wallet for agentId ${p.agentId} (registry has ${registered}). The escrow's submit() would revert "not agent wallet". Use the agent's own key.`,
		);
	}

	// Leg 1: seal to enclaveEncPub, upload, register.
	const sealed = await sealToPub(plaintext, p.enclaveEncPub);
	const encCid = await putContent(SUBMISSIONS_BUCKET, sealed, "application/octet-stream");

	const submitTx = await wallet.writeContract({
		address: ESCROW,
		abi: ESCROW_ABI,
		functionName: "submit",
		args: [BigInt(p.jobId), BigInt(p.agentId), encCid],
	});
	await publicClient.waitForTransactionReceipt({ hash: submitTx });

	return { encCid, submitTx };
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
