#!/usr/bin/env bun
// ============================================================================
// Honeycomb HTTP API.
//
// The ONE backend behind every Honeycomb front door. It owns the bounty logic
// (apps/honeycomb-mcp/tools/*) and the heavy deps the clients can't ship: the
// grading-cre demeter venv, the analysis BigQuery creds, @honeycomb/chain, and
// the macOS keychain secrets.
//
// The installable Claude Code plugin (plugins/honeycomb) is a thin stdio MCP
// shim that FORWARDS every tool call to these routes — so it installs anywhere
// without the venv or the keys. The team runs this service locally and points
// the plugin at http://localhost:8787; for everyone else you host it.
//
//   GET  /                health
//   GET  /skill           the usage guide (markdown)            [no secrets]
//   GET  /jobs            list recent bounties                  [no secrets]
//   GET  /jobs/:id        one job's full state                  [no secrets]
//   GET  /events          decoded ScoreRecorded/ValidityRecorded/NewLeader/JobResolved/JobCreated  [no secrets]
//   GET  /reputation      ERC-8004 reputation (BigQuery)        [BigQuery auth]
//   POST /bounties        open + fund a bounty (BROADCASTS)     [SEP_PRIVATE_KEY]
//   POST /grade           run the real grader                   [demeter venv, INFERENCE key]
//
// Run:  bun apps/honeycomb-api/server.ts            (PORT defaults to 8787; read routes only)
//       bash apps/honeycomb-api/run-with-secrets.sh (write+grade routes; keychain secrets)
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createBounty } from "../honeycomb-mcp/tools/createBounty.ts";
import { resolveEarly } from "../honeycomb-mcp/tools/resolveEarly.ts";
import { getJob, listJobs, jobEvents } from "../honeycomb-mcp/tools/monitor.ts";
import { queryReputation } from "../honeycomb-mcp/tools/reputation.ts";
import { gradeSubmission } from "../honeycomb-mcp/tools/grade.ts";

const PORT = Number(process.env.PORT ?? process.env.HONEYCOMB_API_PORT ?? 8787);
// Bind loopback by default — the write routes broadcast funded txs and spawn the
// grader, so they must not be reachable from the LAN. Set HOST=0.0.0.0 to expose
// deliberately (and only behind HONEYCOMB_API_TOKEN).
const HOST = process.env.HOST ?? process.env.HONEYCOMB_API_HOST ?? "127.0.0.1";
// Shared secret guarding the mutating routes. When unset, write routes are
// refused outright rather than served unauthenticated.
const WRITE_TOKEN = process.env.HONEYCOMB_API_TOKEN;

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

// A handler error carrying an explicit HTTP status (e.g. 400/401), so the
// top-level catch can surface the right code instead of a blanket 500.
class HttpError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

// Parse the JSON body of a write request; {} when empty/absent. Malformed JSON
// is a client error (400), not a server fault (500).
async function body(req: Request): Promise<Record<string, unknown>> {
	const text = await req.text();
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError("invalid JSON body", 400);
	}
}

// Parse an optional numeric query param. Absent -> undefined. Present but not a
// finite number (e.g. ?limit=abc) -> 400, not a silent NaN handed downstream.
function numParam(url: URL, key: string): number | undefined {
	if (!url.searchParams.has(key)) return undefined;
	const n = Number(url.searchParams.get(key));
	if (!Number.isFinite(n)) throw new HttpError(`${key} must be a finite number`, 400);
	return n;
}

// Reject a mutating request that is missing or fails the shared-secret check.
// Throws (loud) rather than returning a soft default, per the repo convention.
function requireWriteAuth(req: Request): void {
	if (!WRITE_TOKEN) {
		throw new HttpError(
			"write routes are disabled: set HONEYCOMB_API_TOKEN to enable them",
			503,
		);
	}
	const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
		?? req.headers.get("x-honeycomb-token");
	if (presented !== WRITE_TOKEN) {
		throw new HttpError("unauthorized", 401);
	}
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
		return json(await listJobs({ limit: numParam(url, "limit") }));
	}

	const jobMatch = pathname.match(/^\/jobs\/(.+)$/);
	if (m === "GET" && jobMatch) {
		return json(await getJob({ jobId: decodeURIComponent(jobMatch[1]) }));
	}

	if (m === "GET" && pathname === "/events") {
		const eventName = url.searchParams.get("eventName") as
			| "ScoreRecorded"
			| "ValidityRecorded"
			| "NewLeader"
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
				agentId: numParam(url, "agentId"),
				limit: numParam(url, "limit"),
			}),
		);
	}

	// --- write routes (need secrets + auth) ---------------------------------
	if (m === "POST" && pathname === "/bounties") {
		requireWriteAuth(req);
		const b = await body(req);
		// Over HTTP the caller is untrusted: forbid the absolute-path escape that
		// the local operator is allowed (createBounty.ts treats absolute bountyDir
		// as a deliberate opt-out of the traversal guard).
		if (typeof b.bountyDir === "string" && b.bountyDir.startsWith("/")) {
			throw new HttpError("bountyDir must be a repo-relative path", 400);
		}
		for (const k of ["rewardUSDC", "hoursToDeadline"]) {
			if (k in b && !Number.isFinite(Number(b[k]))) {
				throw new HttpError(`${k} must be a finite number`, 400);
			}
		}
		return json(await createBounty(b));
	}

	// Maker closes a contest early (resolveEarly). The escrow itself enforces that
	// the caller is the job client; this route just needs the write token + key.
	const resolveMatch = pathname.match(/^\/bounties\/(.+)\/resolve-early$/);
	if (m === "POST" && resolveMatch) {
		requireWriteAuth(req);
		return json(await resolveEarly({ jobId: decodeURIComponent(resolveMatch[1]) }));
	}

	if (m === "POST" && pathname === "/grade") {
		requireWriteAuth(req);
		const b = await body(req);
		if (typeof b.submissionPath !== "string") {
			throw new HttpError("submissionPath (string) is required", 400);
		}
		// Untrusted caller: keep the grader pointed at repo-relative submissions.
		if (b.submissionPath.startsWith("/")) {
			throw new HttpError("submissionPath must be a repo-relative path", 400);
		}
		return json(await gradeSubmission(b as Parameters<typeof gradeSubmission>[0]));
	}

	return fail(`no route for ${m} ${pathname}`, 404);
}

// --- boot -------------------------------------------------------------------
Bun.serve({
	port: PORT,
	hostname: HOST,
	idleTimeout: 255, // grading + on-chain settle can run long; max bun allows
	async fetch(req) {
		try {
			return await route(req);
		} catch (err) {
			return fail(err, err instanceof HttpError ? err.status : 500);
		}
	},
});

console.error(`[honeycomb-api] listening on http://${HOST}:${PORT}`);
console.error(
	WRITE_TOKEN
		? "[honeycomb-api] write routes require HONEYCOMB_API_TOKEN"
		: "[honeycomb-api] write routes DISABLED (set HONEYCOMB_API_TOKEN to enable)",
);
