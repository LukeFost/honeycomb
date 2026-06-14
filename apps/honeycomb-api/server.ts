#!/usr/bin/env bun
// ============================================================================
// Honeycomb HTTP API.
//
// A thin HTTP transport over the SAME six functions the honeycomb MCP server
// drives (apps/honeycomb-mcp/tools/*). One source of bounty logic, two front
// doors: stdio (MCP, for a local agent) and HTTP (this, for a remote/thin
// client — e.g. the installable plugin that can't ship the grader venv).
//
// This service stays IN the repo so it keeps the things the plugin can't:
// the grading-cre demeter venv, the analysis BigQuery creds, @honeycomb/chain,
// and the macOS keychain secrets. The plugin just calls these routes.
//
//   GET  /                health
//   GET  /skill           the usage guide (markdown)            [no secrets]
//   GET  /jobs            list recent bounties                  [no secrets]
//   GET  /jobs/:id        one job's full state                  [no secrets]
//   GET  /events          decoded GradeRecorded/JobResolved...  [no secrets]
//   GET  /reputation      ERC-8004 reputation (BigQuery)        [BigQuery auth]
//   POST /bounties        open + fund a bounty (BROADCASTS)     [SEP_PRIVATE_KEY]
//   POST /grade           run the real grader                   [demeter venv, INFERENCE key]
//
// Run:  bun apps/honeycomb-api/server.ts            (PORT defaults to 8787)
//       bash apps/honeycomb-mcp/run-with-secrets.sh ... (for write+grade routes)
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createBounty } from "../honeycomb-mcp/tools/createBounty.ts";
import { getJob, listJobs, jobEvents } from "../honeycomb-mcp/tools/monitor.ts";
import { queryReputation } from "../honeycomb-mcp/tools/reputation.ts";
import { gradeSubmission } from "../honeycomb-mcp/tools/grade.ts";

const PORT = Number(process.env.PORT ?? process.env.HONEYCOMB_API_PORT ?? 8787);

// The usage guide is the Claude Code skill at .claude/skills/honeycomb/SKILL.md
// (repo root, four levels up from this file: apps/honeycomb-api/ -> repo). Read
// at call time and strip YAML frontmatter — same loader the MCP server uses, so
// /skill, the MCP get_skill tool, and the /honeycomb skill never drift.
const SKILL_PATH = fileURLToPath(new URL("../../.claude/skills/honeycomb/SKILL.md", import.meta.url));
function loadSkill(): string {
	const raw = readFileSync(SKILL_PATH, "utf8");
	const fm = raw.match(/^---\n[\s\S]*?\n---\n/);
	return (fm ? raw.slice(fm[0].length) : raw).trim();
}

// --- response helpers -------------------------------------------------------
const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});

const fail = (err: unknown, status = 500) =>
	json({ error: err instanceof Error ? err.message : String(err) }, status);

// Parse the JSON body of a write request; {} when empty/absent.
async function body(req: Request): Promise<Record<string, unknown>> {
	const text = await req.text();
	if (!text.trim()) return {};
	return JSON.parse(text);
}

// --- routing ----------------------------------------------------------------
// Errors thrown by any handler surface as a JSON {error} with a 4xx/5xx status,
// faithfully (no silent fallback) — same as the MCP server letting them hit isError.
async function route(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const { pathname } = url;
	const m = req.method;

	if (m === "GET" && pathname === "/") {
		return json({ name: "honeycomb-api", status: "ok", port: PORT });
	}

	// --- read routes (no secrets) -------------------------------------------
	if (m === "GET" && pathname === "/skill") {
		return new Response(loadSkill(), {
			headers: { "content-type": "text/markdown; charset=utf-8" },
		});
	}

	if (m === "GET" && pathname === "/jobs") {
		const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
		return json(await listJobs({ limit }));
	}

	const jobMatch = pathname.match(/^\/jobs\/(.+)$/);
	if (m === "GET" && jobMatch) {
		return json(await getJob({ jobId: decodeURIComponent(jobMatch[1]) }));
	}

	if (m === "GET" && pathname === "/events") {
		const eventName = url.searchParams.get("eventName") as
			| "GradeRecorded"
			| "JobResolved"
			| "JobCreated"
			| null;
		return json(
			await jobEvents({
				jobId: url.searchParams.get("jobId") ?? undefined,
				eventName: eventName ?? undefined,
				fromBlock: url.searchParams.get("fromBlock") ?? undefined,
			}),
		);
	}

	if (m === "GET" && pathname === "/reputation") {
		const mode = url.searchParams.get("mode") as "counts" | "feedback" | "leaderboard" | null;
		return json(
			await queryReputation({
				mode: mode ?? undefined,
				agentId: url.searchParams.has("agentId") ? Number(url.searchParams.get("agentId")) : undefined,
				limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
			}),
		);
	}

	// --- write routes (need secrets) ----------------------------------------
	if (m === "POST" && pathname === "/bounties") {
		return json(await createBounty(await body(req)));
	}

	if (m === "POST" && pathname === "/grade") {
		const b = await body(req);
		if (typeof b.submissionPath !== "string") {
			return fail("submissionPath (string) is required", 400);
		}
		return json(await gradeSubmission(b as Parameters<typeof gradeSubmission>[0]));
	}

	return fail(`no route for ${m} ${pathname}`, 404);
}

// --- boot -------------------------------------------------------------------
Bun.serve({
	port: PORT,
	idleTimeout: 255, // grading + on-chain settle can run long; max bun allows
	async fetch(req) {
		try {
			return await route(req);
		} catch (err) {
			return fail(err);
		}
	},
});

console.error(`[honeycomb-api] listening on http://localhost:${PORT}`);
