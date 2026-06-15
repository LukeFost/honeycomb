// ============================================================================
// grade_submission: run a candidate submission through the Honeycomb grader
// (apps/grading-cre/grader/grade.ts) and return its score + receipt metadata.
//
// Default execution is direct/local:
//   • shell to grade.ts, which owns scorer selection (BOUNTY env), the trusted /
//     untrusted process split, and direct validity metadata. It does not require
//     Chainlink Confidential AI, a TEE, or an enclave signature by default.
//
// Optional backends, both explicit opt-ins:
//   • HONEYCOMB_ENABLE_CONFIDENTIAL_AI=1 makes grade.ts call the legacy AI
//     validity service and requires INFERENCE_API_KEY_VAR.
//   • HONEYCOMB_ENABLE_ENCLAVE_GRADING=1 + GRADER_ENCLAVE_URL re-grades execution
//     in the warm Confidential Space enclave and returns its signed score bundle.
// ============================================================================

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

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
const REPO_ROOT = realpathSync(join(import.meta.dir, "..", "..", ".."));
const repoPath = (p: string) => {
	const candidate = isAbsolute(p) ? p : resolve(REPO_ROOT, p);
	if (!existsSync(candidate)) throw new Error(`submission file not found: ${p}`);
	const realCandidate = realpathSync(candidate);
	if (!isPathInside(REPO_ROOT, realCandidate)) {
		throw new Error(`submissionPath escapes the Honeycomb repo: ${p}`);
	}
	return realCandidate;
};

function isPathInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

// When explicitly enabled, execution grading can run in the warm Confidential
// Space enclave over HTTP (POST /grade) after the local scorer. Direct mode keeps
// this off by default even if an old GRADER_ENCLAVE_URL is present in the runtime.
const ENABLE_ENCLAVE_GRADING = process.env.HONEYCOMB_ENABLE_ENCLAVE_GRADING === "1";
const GRADER_ENCLAVE_URL = ENABLE_ENCLAVE_GRADING
	? process.env.GRADER_ENCLAVE_URL?.replace(/\/+$/, "")
	: undefined;

// grade.ts shells to a bare `python3` (resolved via PATH). Both scorers import
// demeter, which lives in the grader's own venv (py3.12 + zelos-demeter), not the
// system python3. Prepend that venv's bin to PATH so `python3` resolves to it.
// Override with HONEYCOMB_GRADER_VENV; fall back to inherited PATH if absent.
const GRADER_VENV_BIN =
	process.env.HONEYCOMB_GRADER_VENV ?? join(GRADER_DIR, ".venv", "bin");

export const gradeSubmissionInput = {
	submissionPath: {
		type: "string",
		description: "Path to the submission file (a .py for directional, a Strategy .py for lp). Relative paths resolve from the repo root and must remain inside this repo.",
	},
	bounty: {
		type: "string",
		enum: ["directional", "lp"],
		description: "Which scorer to use. directional -> scorer.py; lp -> lp_scorer.py. Default directional.",
	},
	jobId: { type: "string", description: "ERC-8183 job id to stamp on the callback. Default 1." },
	agentId: { type: "string", description: "ERC-8004 agentId of the submitter. Default 22." },
	encCid: {
		type: "string",
		description:
			"Optional sealed-submission CID for the explicit enclave grading path. Ignored in default direct mode.",
	},
} as const;

export async function gradeSubmission(args: {
	submissionPath: string;
	bounty?: string;
	jobId?: string;
	agentId?: string;
	encCid?: string;
}) {
	if (!args.submissionPath) throw new Error("submissionPath is required");

	// Always run the local grader. Direct mode -> this IS the result. Optional
	// enclave mode -> re-grade execution in the enclave afterwards and merge the
	// signed score bundle, leaving the direct validity metadata from grade.ts.
	const callback = await gradeLocal(args);

	if (!GRADER_ENCLAVE_URL) {
		persistGrade(callback, args.bounty);
		return callback;
	}

	// Stage 2: re-grade execution in the warm TEE for a KMS-signed, on-chain-recomputable
	// score digest. This is a legacy/explicit opt-in path; direct submit does not require
	// it. Two ways to hand the submission to the enclave:
	//   • encCid set  -> SEALED path. Send only the on-chain encCid; the enclave fetches the
	//     sealed ciphertext from GCS and opens it with its own secret INSIDE the TEE, so the
	//     plaintext is never read here and never crosses the wire.
	//   • encCid unset -> INLINE path. Read the source and POST it as `code` (the standalone
	//     /grade route, which grades a path with no prior seal).
	// The enclave requires exactly one of code/encCid, so we send exactly one.
	const bundle = args.encCid
		? await gradeViaEnclave({
				encCid: args.encCid,
				jobId: args.jobId ?? "1",
				agentId: args.agentId ?? "22",
			})
		: await gradeViaEnclave({
				code: readFileSync(repoPath(args.submissionPath), "utf8"),
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

// Stage 2: POST the submission to the warm grading enclave (Confidential Space) and return its
// KMS-signed grade bundle {jobId, agentId, score, scoreDigest, signature:{r,s,v}, signer}.
// The submission is handed over as EXACTLY ONE of `code` (inline plaintext) or `encCid` (the
// sealed CID the enclave fetches+opens itself); the server rejects zero-or-both. No silent
// fallback: a transport error or non-200 throws loudly so /grade reports the enclave failure
// rather than masking it with the local score.
async function gradeViaEnclave(
	req: { jobId: string; agentId: string } & ({ code: string; encCid?: never } | { encCid: string; code?: never }),
): Promise<{
	jobId: number;
	agentId: number;
	score: number;
	scoreDigest: string;
	signature: { r: string; s: string; v: number };
	signer: string;
}> {
	const url = `${GRADER_ENCLAVE_URL}/grade`;
	// Send exactly the one source we were handed (the enclave enforces this too).
	const source = "encCid" in req ? { encCid: req.encCid } : { code: req.code };
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...source,
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
