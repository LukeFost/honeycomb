// ============================================================================
// grade_submission: run a candidate submission through the REAL grader
// (apps/grading-cre/grader/grade.ts) and return its score + validity callback.
//
// We shell to grade.ts unchanged — it already owns the scorer selection (BOUNTY
// env), the trusted/untrusted process split, and the AI validity call. This tool
// just sets env + parses the stdout JSON callback.
//
// Requires INFERENCE_API_KEY_VAR for the validity attestation. For lp bounties
// the grading-cre .venv (python 3.12/3.14 + zelos-demeter) must be on PATH.
// ============================================================================

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const GRADER_DIR = join(import.meta.dir, "..", "..", "grading-cre", "grader");
const GRADE_TS = join(GRADER_DIR, "grade.ts");

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
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	if (args.bounty) env.BOUNTY = args.bounty;
	if (existsSync(GRADER_VENV_BIN)) {
		env.PATH = `${GRADER_VENV_BIN}${delimiter}${env.PATH ?? ""}`;
	}

	const argv = ["bun", GRADE_TS, args.submissionPath, args.jobId ?? "1", args.agentId ?? "22"];
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
