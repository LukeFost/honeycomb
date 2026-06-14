#!/usr/bin/env bun
// ============================================================================
// Honeycomb plugin shim — the THIN client.
//
// Ships the SAME seven tools as apps/honeycomb-mcp/server.ts, but instead of
// importing viem / the demeter venv / BigQuery / @honeycomb/chain, each tool
// FORWARDS its call over HTTP to a hosted honeycomb-api (apps/honeycomb-api).
// That service keeps the heavy deps and the secrets; this plugin ships only
// @modelcontextprotocol/sdk and zod, so it installs anywhere Claude Code runs.
//
//   create_bounty     POST /bounties     [write token]
//   get_job           GET  /jobs/:id
//   list_jobs         GET  /jobs?limit=
//   job_events        GET  /events?eventName=&jobId=&fromBlock=
//   query_reputation  GET  /reputation?mode=&agentId=&limit=
//   grade_submission  POST /grade         [write token]
//   get_skill         GET  /skill         (text/markdown)
//
// Config (env):
//   HONEYCOMB_API_URL    (required) base URL of the hosted honeycomb-api
//   HONEYCOMB_API_TOKEN  (optional) bearer token for the two write routes
//
// Run:  bun {plugin}/mcp/shim.ts
// ============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- config -----------------------------------------------------------------
// Read the API base once at boot. Fail loud if it's unset — a thin client with
// nowhere to forward to is useless, and a quiet default would mask the misconfig.
const RAW_BASE = process.env.HONEYCOMB_API_URL;
if (!RAW_BASE) {
	throw new Error(
		"HONEYCOMB_API_URL is unset: the Honeycomb plugin shim needs the base URL of a hosted honeycomb-api (e.g. http://localhost:8787) to forward tool calls to.",
	);
}
// Trim a trailing slash so `${BASE}/jobs` never doubles up.
const BASE = RAW_BASE.replace(/\/+$/, "");

// Bearer token for the two write routes. May be undefined — if so we still send
// the request and let the server answer 503/401, which we surface faithfully.
const TOKEN = process.env.HONEYCOMB_API_TOKEN;

const server = new McpServer({ name: "honeycomb", version: "0.1.0" });

// Wrap a parsed-JSON result in MCP's content shape. Same wrapper shape as the
// local server's ok(); errors thrown by the fetch helpers propagate to isError.
const ok = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

// --- HTTP helpers -----------------------------------------------------------
// On a non-2xx response, throw an Error whose message carries the HTTP status
// AND the server's {error} body text — so the failure surfaces as MCP isError
// instead of being swallowed into a fake-success default (repo rule: raise).
async function readError(res: Response): Promise<string> {
	const text = await res.text();
	if (!text) return `HTTP ${res.status} ${res.statusText}`;
	try {
		const parsed = JSON.parse(text) as { error?: unknown };
		const detail = typeof parsed.error === "string" ? parsed.error : text;
		return `HTTP ${res.status}: ${detail}`;
	} catch {
		return `HTTP ${res.status}: ${text}`;
	}
}

// GET a JSON route. Returns the parsed body; throws on non-2xx.
async function getJson(path: string): Promise<unknown> {
	const res = await fetch(`${BASE}${path}`);
	if (!res.ok) throw new Error(await readError(res));
	return res.json();
}

// GET a text route (/skill returns text/markdown, not JSON). Throws on non-2xx.
async function getText(path: string): Promise<string> {
	const res = await fetch(`${BASE}${path}`);
	if (!res.ok) throw new Error(await readError(res));
	return res.text();
}

// POST a JSON body to a write route. Attaches Authorization: Bearer <TOKEN>
// only when TOKEN is set; when unset we still POST and surface the 503/401.
async function post(path: string, bodyObj: unknown): Promise<unknown> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(bodyObj),
	});
	if (!res.ok) throw new Error(await readError(res));
	return res.json();
}

// Build a query string from only the defined params (skip undefined), so an
// omitted optional never becomes the literal "undefined" in the URL.
function qs(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined) search.set(k, String(v));
	}
	const s = search.toString();
	return s ? `?${s}` : "";
}

// --- create_bounty ----------------------------------------------------------
server.registerTool(
	"create_bounty",
	{
		title: "Create a Honeycomb bounty",
		description:
			"Open + fund a bounty (ERC-8183 Job) on BountyEscrow (Sepolia). Hashes the private bundle (rubric + scoring + private series) into testsHash, approves the USDC reward, calls createBounty, and returns the on-chain jobId. BROADCASTS a real transaction; requires SEP_PRIVATE_KEY.",
		inputSchema: {
			rewardUSDC: z.number().positive().optional().describe("Reward in human USDC (6dp token). Default 50."),
			hoursToDeadline: z.number().positive().optional().describe("Hours from now to the contest deadline. Default 1."),
			bountyDir: z
				.string()
				.optional()
				.describe(
					"Bounty dir holding private/ files. Relative paths resolve under apps/grading-cre. Default maker/bounties/uniswap-lp-trading-bot.",
				),
			specCid: z.string().optional().describe("Public spec reference (IPFS CID or honeycomb:// URI). Auto-derived if omitted."),
			privateFiles: z
				.array(z.string())
				.optional()
				.describe("Override the private bundle file list (relative to bountyDir). Default: rubric.md, scoring.py, prices_private.json."),
		},
	},
	async (args) => ok(await post("/bounties", args)),
);

// --- get_job ----------------------------------------------------------------
server.registerTool(
	"get_job",
	{
		title: "Get one bounty's full state",
		description:
			"Read the full Job struct for one jobId from BountyEscrow (Sepolia): status, reward, deadline, current best valid grade (agentId/score/attestations), grade count, plus isSettled and the winner wallet.",
		inputSchema: { jobId: z.string().describe("Job id (string; can exceed 2^53).") },
	},
	async (args) => ok(await getJson(`/jobs/${encodeURIComponent(args.jobId)}`)),
);

// --- list_jobs --------------------------------------------------------------
server.registerTool(
	"list_jobs",
	{
		title: "List recent bounties",
		description: "List bounties newest-first (id, status, reward, deadline, best agent/score, grade count, specCid).",
		inputSchema: { limit: z.number().int().positive().optional().describe("Max jobs, newest first. Default 25.") },
	},
	async (args) => ok(await getJson(`/jobs${qs({ limit: args.limit })}`)),
);

// --- job_events -------------------------------------------------------------
server.registerTool(
	"job_events",
	{
		title: "Read bounty events",
		description:
			"Fetch decoded GradeRecorded / JobResolved / JobCreated logs from BountyEscrow over a block range. Optionally filter to one jobId. Use this to monitor a bounty's grading + settlement in a loop.",
		inputSchema: {
			jobId: z.string().optional().describe("Filter to one job id. Omit for all jobs."),
			eventName: z.enum(["GradeRecorded", "JobResolved", "JobCreated"]).optional().describe("Which event. Default GradeRecorded."),
			fromBlock: z.string().optional().describe("Start block (decimal or hex). Default: last 50000 blocks."),
		},
	},
	async (args) =>
		ok(await getJson(`/events${qs({ eventName: args.eventName, jobId: args.jobId, fromBlock: args.fromBlock })}`)),
);

// --- query_reputation -------------------------------------------------------
server.registerTool(
	"query_reputation",
	{
		title: "Query ERC-8004 reputation",
		description:
			"Read live ERC-8004 reputation from BigQuery (Ethereum mainnet public logs). counts = total agents registered + feedback events; feedback = recent NewFeedback rows (optionally one agentId); leaderboard = per-agent feedback count + avg score. Needs BigQuery auth (analysis/.secrets/gcp-key.json).",
		inputSchema: {
			mode: z.enum(["counts", "feedback", "leaderboard"]).optional().describe("counts | feedback | leaderboard. Default counts."),
			agentId: z.number().int().optional().describe("feedback mode only: filter to one ERC-8004 agentId."),
			limit: z.number().int().positive().optional().describe("feedback/leaderboard row cap. Default 25."),
		},
	},
	async (args) => ok(await getJson(`/reputation${qs({ mode: args.mode, agentId: args.agentId, limit: args.limit })}`)),
);

// --- grade_submission -------------------------------------------------------
server.registerTool(
	"grade_submission",
	{
		title: "Grade a submission (real scorer)",
		description:
			"Run a candidate submission through the REAL Honeycomb grader and return its grading callback: execution score (0..10000), validity verdict, and both attestation digests. directional -> scorer.py over a price series; lp -> lp_scorer.py (Demeter) over a pool CSV. Needs INFERENCE_API_KEY_VAR; lp needs the grading-cre demeter venv on PATH.",
		inputSchema: {
			submissionPath: z.string().describe("Absolute path to the submission file."),
			bounty: z.enum(["directional", "lp"]).optional().describe("Scorer to use. Default directional."),
			jobId: z.string().optional().describe("Job id to stamp on the callback. Default 1."),
			agentId: z.number().int().optional().describe("ERC-8004 agentId of the submitter. Default 22."),
		},
	},
	async (args) => ok(await post("/grade", args)),
);

// --- get_skill --------------------------------------------------------------
// The usage guide as markdown. /skill returns text/markdown, so we return the
// raw text verbatim (not JSON.stringify'd) inside the MCP content wrapper.
server.registerTool(
	"get_skill",
	{
		title: "Get the Honeycomb usage guide",
		description:
			"Return the Honeycomb skill: how to use the other tools (params, common flows, the honest-vs-cheat thesis, gotchas, Sepolia addresses). Call this first if you're unsure how to drive a bounty.",
		inputSchema: {},
	},
	async () => ({ content: [{ type: "text" as const, text: await getText("/skill") }] }),
);

// --- boot -------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[honeycomb-shim] ready on stdio -> ${BASE}`);
