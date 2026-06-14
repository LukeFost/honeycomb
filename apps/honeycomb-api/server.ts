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
//   POST /submit          solver: grade + record on-chain       [grade deps + CRE relay/CLI]
//
// Run:  bun apps/honeycomb-api/server.ts            (PORT defaults to 8787; read routes only)
//       bash apps/honeycomb-api/run-with-secrets.sh (write+grade routes; keychain secrets)
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createBounty } from "../honeycomb-mcp/tools/createBounty.ts";
import { createBountyDraft } from "../honeycomb-mcp/tools/createBountyDraft.ts";
import { finalizeBounty } from "../honeycomb-mcp/tools/finalizeBounty.ts";
import { resolveEarly } from "../honeycomb-mcp/tools/resolveEarly.ts";
import { getJob, listJobs, jobEvents } from "../honeycomb-mcp/tools/monitor.ts";
import { queryReputation } from "../honeycomb-mcp/tools/reputation.ts";
import { gradeSubmission } from "../honeycomb-mcp/tools/grade.ts";
import { submitWork } from "../honeycomb-mcp/tools/submitWork.ts";
import { resolveSpec } from "../honeycomb-mcp/tools/resolveSpec.ts";
import { runSnapshot } from "../honeycomb-mcp/db/snapshot.ts";
import { record as recordToolCall } from "../honeycomb-mcp/db/telemetry.ts";
import { startSubscriberIfConfigured } from "../honeycomb-mcp/db/subscriber.ts";

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

	// Resolve a bounty's specCid to its public spec markdown. Read-only and
	// unauthenticated: the spec is the public side of a bounty (agents need it to
	// decide whether to compete). ?cid=<specCid> from get_job / list_jobs.
	if (m === "GET" && pathname === "/spec") {
		const cid = url.searchParams.get("cid");
		if (!cid) throw new HttpError("cid query param is required", 400);
		return json(await resolveSpec({ specCid: cid }));
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

	// Gasless funding, step 1: compute the bounty commitment WITHOUT broadcasting
	// and return an x402 402-challenge for the funder to sign. No USDC spent yet;
	// still behind the write token because it derives the custodial payTo from
	// SEP_PRIVATE_KEY and stashes a server-side draft.
	if (m === "POST" && pathname === "/bounties/draft") {
		requireWriteAuth(req);
		const b = await body(req);
		// Same untrusted-caller guard as /bounties: no absolute-path escape.
		if (typeof b.bountyDir === "string" && b.bountyDir.startsWith("/")) {
			throw new HttpError("bountyDir must be a repo-relative path", 400);
		}
		for (const k of ["rewardUSDC", "hoursToDeadline"]) {
			if (k in b && !Number.isFinite(Number(b[k]))) {
				throw new HttpError(`${k} must be a finite number`, 400);
			}
		}
		return json(await createBountyDraft(b));
	}

	// Gasless funding, step 2: take the funder's signed EIP-3009 authorization,
	// settle it through the facilitator (relayer pays gas, USDC -> custodial wallet),
	// then broadcast createBounty with the draft's exact params.
	if (m === "POST" && pathname === "/bounties/finalize") {
		requireWriteAuth(req);
		const b = await body(req);
		if (typeof b.draftId !== "string") {
			throw new HttpError("draftId (string) is required", 400);
		}
		if (typeof b.signature !== "string") {
			throw new HttpError("signature (string) is required", 400);
		}
		if (typeof b.authorization !== "object" || b.authorization === null) {
			throw new HttpError("authorization (object) is required", 400);
		}
		return json(await finalizeBounty(b as Parameters<typeof finalizeBounty>[0]));
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

	// Solver one-call front door: read the bounty -> grade -> record both gates
	// on-chain (CRE) -> plain-English verdict. Needs the same secrets as /grade
	// plus the CRE relay key + the `cre` CLI; submitWork throws loudly if absent.
	if (m === "POST" && pathname === "/submit") {
		requireWriteAuth(req);
		const b = await body(req);
		if (typeof b.jobId !== "string") {
			throw new HttpError("jobId (string) is required", 400);
		}
		if (typeof b.submissionPath !== "string") {
			throw new HttpError("submissionPath (string) is required", 400);
		}
		// Untrusted caller: keep the grader pointed at repo-relative submissions.
		if (b.submissionPath.startsWith("/")) {
			throw new HttpError("submissionPath must be a repo-relative path", 400);
		}
		return json(await submitWork(b as Parameters<typeof submitWork>[0]));
	}

	// Snapshot the live chain into Neon (jobs upsert + events append). Triggered
	// on a schedule by Cloud Scheduler against this always-on instance, so the
	// chain data records continuously without any laptop or Claude session. Reads
	// only public chain state, but writes to the DB, so it's behind the write
	// token to keep it from being spammed. Needs DATABASE_URL (snapshot throws if
	// unset). ?jobs=N&lookback=N override the defaults.
	if (m === "POST" && pathname === "/snapshot") {
		requireWriteAuth(req);
		const jobsLimit = numParam(url, "jobs");
		const lookback = url.searchParams.get("lookback") ?? undefined;
		return json(await runSnapshot({ jobsLimit, lookback }));
	}

	return fail(`no route for ${m} ${pathname}`, 404);
}

// Derive a stable logical tool name for telemetry from method+pathname, so the
// tool_calls.tool column reads like the MCP tool surface (get_job, list_jobs,
// grade_submission, ...) rather than raw HTTP paths.
function toolName(method: string, pathname: string): string {
	if (pathname === "/") return "health";
	if (pathname === "/skill") return "get_skill";
	if (pathname === "/jobs") return "list_jobs";
	if (/^\/jobs\/[^/]+$/.test(pathname)) return "get_job";
	if (pathname === "/events") return "job_events";
	if (pathname === "/spec") return "resolve_spec";
	if (pathname === "/reputation") return "query_reputation";
	if (pathname === "/bounties") return "create_bounty";
	if (pathname === "/bounties/draft") return "create_bounty_draft";
	if (pathname === "/bounties/finalize") return "finalize_bounty";
	if (/^\/bounties\/[^/]+\/resolve-early$/.test(pathname)) return "resolve_early";
	if (pathname === "/grade") return "grade_submission";
	if (pathname === "/submit") return "submit_work";
	if (pathname === "/snapshot") return "snapshot";
	return `${method} ${pathname}`;
}

// --- boot -------------------------------------------------------------------
// Parse a JSON string into an object for telemetry, tolerating non-JSON bodies.
function parseBodyForLog(text: string): unknown {
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text.slice(0, 2000) };
	}
}

Bun.serve({
	port: PORT,
	hostname: HOST,
	idleTimeout: 255, // grading + on-chain settle can run long; max bun allows
	async fetch(req, server) {
		const url = new URL(req.url);
		const startedNs = Bun.nanoseconds();
		// Read the request body off a CLONE so route()'s own body() read still works
		// (a Request body is single-use). Best-effort: a failed clone/read just leaves
		// the logged body undefined — never blocks the real request.
		let reqBodyText = "";
		if (req.method !== "GET" && req.method !== "HEAD") {
			try {
				reqBodyText = await req.clone().text();
			} catch {
				/* body unavailable for logging; proceed */
			}
		}

		let res: Response;
		try {
			res = await route(req);
		} catch (err) {
			res = fail(err, err instanceof HttpError ? err.status : 500);
		}

		// Telemetry: capture the response body off a clone, then record fire-and-forget.
		// Nothing here is awaited into the response path — the client gets `res` either
		// way, and a telemetry failure is swallowed inside record().
		try {
			const latencyMs = (Bun.nanoseconds() - startedNs) / 1e6;
			const query = Object.fromEntries(url.searchParams.entries());
			res
				.clone()
				.text()
				.then((resText) => {
					recordToolCall({
						tool: toolName(req.method, url.pathname),
						method: req.method,
						path: url.pathname,
						query: Object.keys(query).length ? query : null,
						request: parseBodyForLog(reqBodyText),
						response: parseBodyForLog(resText),
						status: res.status,
						latencyMs,
						caller: req.headers.get("x-honeycomb-caller") ?? req.headers.get("user-agent"),
						remoteAddr: server?.requestIP(req)?.address ?? null,
					});
				})
				.catch(() => {
					/* telemetry capture failed; swallow */
				});
		} catch {
			/* telemetry setup failed; swallow */
		}

		return res;
	},
});

console.error(`[honeycomb-api] listening on http://${HOST}:${PORT}`);
console.error(
	WRITE_TOKEN
		? "[honeycomb-api] write routes require HONEYCOMB_API_TOKEN"
		: "[honeycomb-api] write routes DISABLED (set HONEYCOMB_API_TOKEN to enable)",
);

// Co-located chain stream: start the live eth_subscribe watcher in THIS process,
// so the always-on API instance (Cloud Run min-instances=1, CPU-always-on) is the
// single home for all three recording streams — telemetry + grades (inline) and the
// chain subscriber (background). No-op unless DATABASE_URL + SEPOLIA_WS are both set,
// and a subscriber failure never takes the API down (see startSubscriberIfConfigured).
startSubscriberIfConfigured();
