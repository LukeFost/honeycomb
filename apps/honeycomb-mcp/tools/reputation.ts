// ============================================================================
// query_reputation: ERC-8004 reputation reads from BigQuery, via the local
// reputation.py helper (which reuses analysis/bqenv.py for auth). One cross-
// runtime seam: we shell to python3 and parse its one-line JSON.
//
// Needs Google BigQuery auth — analysis/.secrets/gcp-key.json (auto-discovered
// by bqenv) plus the google-cloud-bigquery python package on the PATH python3.
// ============================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";

const HELPER = join(import.meta.dir, "..", "reputation.py");

// reputation.py needs google-cloud-bigquery, which lives in analysis/.venv (the
// pipeline's venv), not the system python3. Prefer that venv; allow an explicit
// override; fall back to python3 for setups that installed bigquery globally.
const ANALYSIS_VENV_PY = join(import.meta.dir, "..", "..", "..", "analysis", ".venv", "bin", "python");
const PYTHON =
	process.env.HONEYCOMB_PYTHON ?? (existsSync(ANALYSIS_VENV_PY) ? ANALYSIS_VENV_PY : "python3");

export const queryReputationInput = {
	mode: {
		type: "string",
		enum: ["counts", "feedback", "leaderboard"],
		description:
			"counts = total agents + feedback events; feedback = recent NewFeedback rows (optionally one agent); leaderboard = per-agent feedback count + avg score.",
	},
	agentId: {
		type: "number",
		description: "feedback mode only: filter to one ERC-8004 agentId. Omit for all agents.",
	},
	limit: { type: "number", description: "feedback/leaderboard row cap. Default 25." },
} as const;

export async function queryReputation(args: { mode?: string; agentId?: number; limit?: number }) {
	const mode = args.mode ?? "counts";
	const argv = [HELPER, mode];
	if (mode === "feedback" && args.agentId !== undefined) argv.push("--agent", String(args.agentId));
	if ((mode === "feedback" || mode === "leaderboard") && args.limit !== undefined)
		argv.push("--limit", String(args.limit));

	const proc = Bun.spawn([PYTHON, ...argv], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`reputation.py exited ${code}: ${stderr.trim() || stdout.trim()}`);
	}
	return JSON.parse(stdout.trim());
}
