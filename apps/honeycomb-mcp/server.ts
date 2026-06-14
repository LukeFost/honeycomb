#!/usr/bin/env bun
// ============================================================================
// Honeycomb MCP server (stdio).
//
// Lets Claude Code drive the Honeycomb bounty lifecycle:
//   • create_bounty     — hash private bundle -> approve USDC -> createBounty (Sepolia, broadcasts)
//   • get_job           — full Job struct + settled + winner wallet
//   • list_jobs         — recent bounties, newest first
//   • job_events        — GradeRecorded / JobResolved / JobCreated logs
//   • query_reputation  — ERC-8004 reputation from BigQuery (counts/feedback/leaderboard)
//   • grade_submission  — run a submission through the REAL grader, get score + validity
//
// On-chain writes need SEP_PRIVATE_KEY. grade_submission needs INFERENCE_API_KEY_VAR
// (and, for lp, the grading-cre demeter venv on PATH). Reputation needs BigQuery auth
// (analysis/.secrets/gcp-key.json + google-cloud-bigquery on python3).
//
// Run:  bun apps/honeycomb-mcp/server.ts
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createBounty } from "./tools/createBounty.ts";
import { getJob, listJobs, jobEvents } from "./tools/monitor.ts";
import { queryReputation } from "./tools/reputation.ts";
import { gradeSubmission } from "./tools/grade.ts";

const server = new McpServer({ name: "honeycomb", version: "0.1.0" });

// Wrap a handler's result in MCP's content shape. Errors propagate to isError.
const ok = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

// The how-to-use guide IS the Claude Code skill at .claude/skills/honeycomb/SKILL.md
// (repo root, three levels up from this file). Read it at call time so the MCP and the
// skill never drift — one source of truth. Strip the YAML frontmatter; the body is the
// usage guide. Exposed two ways: an MCP *resource* (honeycomb://skill, the canonical way
// a client surfaces reference text) and a get_skill *tool* (fallback for clients that
// call tools but don't list resources). Both share this loader.
const SKILL_PATH = fileURLToPath(new URL("../../.claude/skills/honeycomb/SKILL.md", import.meta.url));

function loadSkill(): string {
	const raw = readFileSync(SKILL_PATH, "utf8");
	// Drop a leading `---\n...\n---\n` frontmatter block if present.
	const fm = raw.match(/^---\n[\s\S]*?\n---\n/);
	return (fm ? raw.slice(fm[0].length) : raw).trim();
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
	async (args) => ok(await createBounty(args)),
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
	async (args) => ok(await getJob(args)),
);

// --- list_jobs --------------------------------------------------------------
server.registerTool(
	"list_jobs",
	{
		title: "List recent bounties",
		description: "List bounties newest-first (id, status, reward, deadline, best agent/score, grade count, specCid).",
		inputSchema: { limit: z.number().int().positive().optional().describe("Max jobs, newest first. Default 25.") },
	},
	async (args) => ok(await listJobs(args)),
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
	async (args) => ok(await jobEvents(args)),
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
	async (args) => ok(await queryReputation(args)),
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
			agentId: z.string().optional().describe("ERC-8004 agentId of the submitter. Default 22."),
		},
	},
	async (args) => ok(await gradeSubmission(args)),
);

// --- honeycomb://skill (resource) -------------------------------------------
// The full usage guide as a readable resource. A client can list + read this to
// learn the lifecycle and exact tool params without the .claude/skills file.
server.registerResource(
	"honeycomb-skill",
	"honeycomb://skill",
	{
		title: "Honeycomb skill — how to use these tools",
		description:
			"The Honeycomb bounty-lifecycle guide: the 6 tools, their params, common flows (open/grade/watch a bounty), the honest-vs-cheat thesis, verified gotchas, and Sepolia addresses. Same content as the Claude Code /honeycomb skill.",
		mimeType: "text/markdown",
	},
	async (uri) => ({
		contents: [{ uri: uri.href, mimeType: "text/markdown", text: loadSkill() }],
	}),
);

// --- get_skill (tool) -------------------------------------------------------
// Same guide as a tool call, for clients that invoke tools but don't surface
// MCP resources. Returns the markdown verbatim.
server.registerTool(
	"get_skill",
	{
		title: "Get the Honeycomb usage guide",
		description:
			"Return the Honeycomb skill: how to use the other tools (params, common flows, the honest-vs-cheat thesis, gotchas, Sepolia addresses). Call this first if you're unsure how to drive a bounty. Same content as the honeycomb://skill resource.",
		inputSchema: {},
	},
	async () => ({ content: [{ type: "text" as const, text: loadSkill() }] }),
);

// --- boot -------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[honeycomb-mcp] ready on stdio");
