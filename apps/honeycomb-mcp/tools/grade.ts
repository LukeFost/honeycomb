// ============================================================================
// grade_submission: run a candidate submission through the REAL grader
// (apps/grading-cre/grader/grade.ts) and return its score + validity callback.
//
// Two execution backends, selected by GRADER_ENCLAVE_URL:
//
//   • UNSET (Stage 1, local):  shell to grade.ts unchanged — it owns the scorer
//     selection (BOUNTY env), the trusted/untrusted process split, the AI validity
//     call, and a content-commitment digest (NOT a hardware attestation).
//
//   • SET (Stage 2, enclave):  POST the submission to the warm grading enclave on
//     Confidential Space (apps/grading-cre/grader/enclave/enclave_grade_server.py),
//     which runs the SAME scorer inside the TEE and returns a KMS-HSM-signed score
//     digest — the exact (r,s,v) BountyEscrow._recordScore ecrecovers on-chain. The
//     AI validity attestation (Chainlink) still comes from the local grade.ts, which
//     does not run in this enclave. The enclave's signed score is authoritative and
//     replaces the local content-commitment.
//
// Requires INFERENCE_API_KEY_VAR for the validity attestation. For lp bounties the
// grading-cre .venv (python 3.12/3.14 + zelos-demeter) must be on PATH. The enclave
// path additionally needs GRADER_ENCLAVE_URL (the warm CS VM's base URL, e.g.
// http://VM_INTERNAL_IP:8000), mirroring how apps/web reaches the summon runner.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { recordGrade } from "../db/snapshot.ts";

// Persist a grade to Neon (best-effort). recordGrade opens/closes its own
// connection and throws on a DB error; we swallow that here so a persistence
// hiccup never fails the actual grade. Disabled cleanly when DATABASE_URL unset.
function persistGrade(callback: Record<string, any>, bounty?: string) {
	if (!process.env.DATABASE_URL) return;
	recordGrade(callback, bounty).catch((e) =>
		console.error("[grade] recordGrade failed:", e?.message ?? e),
	);
}

const GRADER_DIR = join(import.meta.dir, "..", "..", "grading-cre", "grader");
const GRADE_TS = join(GRADER_DIR, "grade.ts");

// Repo root, derived CWD-INDEPENDENTLY from this file's location
// (apps/honeycomb-mcp/tools/grade.ts -> ../../.. = repo root). Callers pass a
// repo-relative submissionPath (the server rejects absolute ones), but readFileSync /
// the subprocess argv resolve against process.cwd(), which is NOT the repo root in the
// Cloud Run image (WORKDIR is apps/honeycomb-api). Anchor relative paths here so the
// "repo-relative" contract holds no matter where the server process was launched.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const repoPath = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

// When set, execution grading runs in the warm Confidential Space enclave over HTTP
// (POST /grade) instead of the local python3 subprocess. Validity still runs locally.
const GRADER_ENCLAVE_URL = process.env.GRADER_ENCLAVE_URL?.replace(/\/+$/, "");

// grade.ts shells to a bare `python3` (resolved via PATH). Both scorers import
// demeter, which lives in the grader's own venv (py3.12 + zelos-demeter), not the
// system python3. Prepend that venv's bin to PATH so `python3` resolves to it.
// Override with HONEYCOMB_GRADER_VENV; fall back to inherited PATH if absent.
const GRADER_VENV_BIN =
	process.env.HONEYCOMB_GRADER_VENV ?? join(GRADER_DIR, ".venv", "bin");

export const gradeSubmissionInput = {
	submissionPath: {
		type: "string",
		description: "Absolute path to the submission file (a .py for directional, a Strategy .py for lp).",
	},
	bounty: {
		type: "string",
		enum: ["directional", "lp"],
		description: "Which scorer to use. directional -> scorer.py; lp -> lp_scorer.py. Default directional.",
	},
	jobId: { type: "string", description: "ERC-8183 job id to stamp on the callback. Default 1." },
	agentId: { type: "string", description: "ERC-8004 agentId of the submitter. Default 22." },
} as const;

export async function gradeSubmission(args: {
	submissionPath: string;
	bounty?: string;
	jobId?: string;
	agentId?: string;
}) {
	if (!args.submissionPath) throw new Error("submissionPath is required");

	// Always run the local grader. Stage 1 (no enclave) -> this IS the result. Stage 2
	// (enclave set) -> we still need it for the AI validity attestation, which the enclave
	// does not produce; only its execution score+digest is replaced by the signed bundle.
	const callback = await gradeLocal(args);

	if (!GRADER_ENCLAVE_URL) {
		persistGrade(callback, args.bounty);
		return callback;
	}

	// Stage 2: re-grade execution in the warm TEE for a KMS-signed, on-chain-recomputable
	// score digest. The enclave wants the submission SOURCE (it writes its own temp file),
	// not a path, so read the file here.
	const code = readFileSync(repoPath(args.submissionPath), "utf8");
	const bundle = await gradeViaEnclave({
		code,
		jobId: args.jobId ?? "1",
		agentId: args.agentId ?? "22",
	});

	// Merge: the enclave's signed score+digest are authoritative and supersede the local
	// content-commitment scoreAttestation. Validity stays from the local grader. We surface
	// BOTH so a caller can see the local score for comparison, but the canonical on-chain
	// fields (score, scoreDigest, signature) come from the TEE.
	const merged = {
		...callback,
		score: bundle.score,
		scoreDigest: bundle.scoreDigest,
		signature: bundle.signature,
		signer: bundle.signer,
		attestationSource: "confidential-space" as const,
		localScore: callback.score,
		localScoreAttestation: callback.scoreAttestation,
	};
	persistGrade(merged, args.bounty);
	return merged;
}

// Stage 1: shell to grade.ts unchanged and parse its stdout callback JSON.
async function gradeLocal(args: {
	submissionPath: string;
	bounty?: string;
	jobId?: string;
	agentId?: string;
}) {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	if (args.bounty) env.BOUNTY = args.bounty;
	if (existsSync(GRADER_VENV_BIN)) {
		env.PATH = `${GRADER_VENV_BIN}${delimiter}${env.PATH ?? ""}`;
	}

	const argv = ["bun", GRADE_TS, repoPath(args.submissionPath), args.jobId ?? "1", args.agentId ?? "22"];
	const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`grade.ts exited ${code}: ${stderr.trim() || stdout.trim()}`);
	}
	// grade.ts prints the callback JSON to stdout, logs to stderr.
	const callback = JSON.parse(stdout.trim());
	return { ...callback, graderLog: stderr.trim() };
}

// Stage 2: POST the submission source to the warm grading enclave (Confidential Space) and
// return its KMS-signed grade bundle {jobId, agentId, score, scoreDigest, signature:{r,s,v},
// signer}. No silent fallback: a transport error or non-200 throws loudly so /grade reports
// the enclave failure rather than masking it with the local score.
async function gradeViaEnclave(req: { code: string; jobId: string; agentId: string }): Promise<{
	jobId: number;
	agentId: number;
	score: number;
	scoreDigest: string;
	signature: { r: string; s: string; v: number };
	signer: string;
}> {
	const url = `${GRADER_ENCLAVE_URL}/grade`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				code: req.code,
				jobId: Number(req.jobId),
				agentId: Number(req.agentId),
			}),
		});
	} catch (e) {
		throw new Error(`grading enclave unreachable at ${url}: ${(e as Error).message}`);
	}
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`grading enclave ${res.status} at ${url}: ${text.trim()}`);
	}
	let bundle: unknown;
	try {
		bundle = JSON.parse(text);
	} catch {
		throw new Error(`grading enclave returned non-JSON (${res.status}): ${text.slice(0, 400)}`);
	}
	const b = bundle as Record<string, unknown>;
	if (typeof b.score !== "number" || typeof b.scoreDigest !== "string" || !b.signature) {
		throw new Error(`grading enclave returned an unexpected bundle: ${JSON.stringify(b).slice(0, 400)}`);
	}
	return bundle as Awaited<ReturnType<typeof gradeViaEnclave>>;
}
