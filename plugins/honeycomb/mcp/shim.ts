#!/usr/bin/env bun
// ============================================================================
// Honeycomb plugin shim — the THIN client.
//
// The single Honeycomb front door. Instead of importing viem / the demeter venv
// / BigQuery / @honeycomb/chain, each tool FORWARDS its call over HTTP to the
// hosted honeycomb-api (apps/honeycomb-api), which owns the bounty logic
// (apps/honeycomb-mcp/tools/*) and the secrets. This plugin ships only
// @modelcontextprotocol/sdk and zod, so it installs anywhere Claude Code runs.
//
//   create_bounty        POST /bounties           [write token]
//   create_bounty_draft  POST /bounties/draft      [write token]  (x402 step 1)
//   finalize_bounty      POST /bounties/finalize   [write token]  (x402 step 2)
//   resolve_early     POST /bounties/:id/resolve-early  [write token]
//   get_job           GET  /jobs/:id
//   list_jobs         GET  /jobs?limit=
//   job_events        GET  /events?eventName=&jobId=&fromBlock=
//   query_reputation  GET  /reputation?mode=&agentId=&limit=
//   list_gcs_objects  GET  /gcs?jobId=&kind=&limit=
//   grade_submission  POST /grade         [write token]
//   submit_work       POST /submit             [write token]
//   register_agent    POST /agents/register    [write token]
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
			"Open + fund a bounty (ERC-8183 Job) on BountyEscrow (Sepolia). Hashes every file under the bounty's private/ dir (sorted, raw bytes) into testsHash, approves the USDC reward, calls createBounty, and returns the on-chain jobId. BROADCASTS a real transaction; requires SEP_PRIVATE_KEY.",
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
				.describe(
					"ADVANCED override of the private bundle file list (relative to bountyDir). Leave unset: the default sorted walk of private/ matches create-bounty.ts's testsHash exactly. An explicit list will NOT reproduce the maker's digest.",
				),
			attesterKey: z
				.string()
				.optional()
				.describe(
					"Execution enclave's score-signer address, sent on-chain by the 7-arg createBounty (the escrow ecrecovers each grade against it). Default: the live KMS score-signer.",
				),
			makerPubKey: z
				.string()
				.optional()
				.describe(
					"Maker's X25519 delivery pubkey as bytes32; the grader seals the winning submission to it. Sent on-chain (createBounty reverts on zero). Default: MAKER_PUBKEY from env/chain.ts.",
				),
			enclaveEncPub: z
				.string()
				.optional()
				.describe(
					"Per-bounty execution enclave's X25519 submission-sealing pubkey as bytes32 (the 7th createBounty arg, distinct from makerPubKey). Sent on-chain (the ERC-8183 contract reverts on zero). Default: ENCLAVE_ENCPUB from env/chain.ts.",
				),
		},
	},
	async (args) => ok(await post("/bounties", args)),
);

// --- create_bounty_draft ----------------------------------------------------
// Gasless funding step 1: the funder funds their OWN bounty without holding ETH.
// Computes the bounty commitment WITHOUT broadcasting and returns an x402
// 402-challenge (PaymentRequirements + the EIP-712 typed-data to sign).
server.registerTool(
	"create_bounty_draft",
	{
		title: "Draft a bounty for gasless funding (x402)",
		description:
			"Step 1 of gasless ('x402') bounty funding: the FUNDER pays for their own bounty without holding ETH for gas. Computes the bounty commitment (testsHash / budget / deadline / specCid) WITHOUT broadcasting and WITHOUT spending the server's USDC, then returns an x402 402-challenge: a draftId, the PaymentRequirements, and the EIP-712 typed-data to sign (an EIP-3009 TransferWithAuthorization). The funder signs `typedData` off-chain (setting message.from to their own wallet), then calls finalize_bounty with {draftId, signature, authorization}. Takes the same bounty-shaping args as create_bounty. Drafts expire in ~15 min.",
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
				.describe(
					"ADVANCED override of the private bundle file list (relative to bountyDir). Leave unset: the default sorted walk of private/ matches create-bounty.ts's testsHash exactly.",
				),
			attesterKey: z
				.string()
				.optional()
				.describe("Execution enclave's score-signer address (7-arg createBounty). Default: the live KMS score-signer."),
			makerPubKey: z
				.string()
				.optional()
				.describe("Maker's X25519 delivery pubkey as bytes32. Default: MAKER_PUBKEY from env/chain.ts."),
			enclaveEncPub: z
				.string()
				.optional()
				.describe("Per-bounty enclave's X25519 submission-sealing pubkey as bytes32. Default: ENCLAVE_ENCPUB from env/chain.ts."),
		},
	},
	async (args) => ok(await post("/bounties/draft", args)),
);

// --- finalize_bounty --------------------------------------------------------
// Gasless funding step 2: settle the funder's signed authorization (relayer pays
// gas, USDC -> custodial wallet) then broadcast createBounty with the draft's
// exact params.
server.registerTool(
	"finalize_bounty",
	{
		title: "Finalize a gasless-funded bounty (x402)",
		description:
			"Step 2 of gasless ('x402') bounty funding. Hand back the draftId from create_bounty_draft plus the funder's signature and the authorization they signed. Settles the EIP-3009 payment through the facilitator (the relayer broadcasts the transfer and pays gas, moving the funder's USDC into the server's custodial wallet), THEN broadcasts createBounty on-chain with the draft's exact params. Returns the real jobId plus the settlement tx. BROADCASTS real transactions; fails loudly (no silent success) if the payment is invalid or the on-chain open fails.",
		inputSchema: {
			draftId: z.string().describe("The draftId returned by create_bounty_draft."),
			signature: z.string().describe("The funder's EIP-712 signature over the draft's TransferWithAuthorization typed-data (0x-hex)."),
			authorization: z
				.object({
					from: z.string().describe("The funder's wallet address (the signer)."),
					to: z.string().describe("payTo — the custodial wallet from the draft. Echo verbatim."),
					value: z.string().describe("Amount in 6-decimal base units. Echo verbatim from the draft."),
					validAfter: z.string().describe("Unix seconds the auth becomes valid. Echo verbatim."),
					validBefore: z.string().describe("Unix seconds the auth expires. Echo verbatim."),
					nonce: z.string().describe("The bytes32 replay nonce from the draft. Echo verbatim."),
				})
				.describe("The signed EIP-3009 authorization. `from` is the funder; every other field is the draft's authorizationTemplate verbatim."),
		},
	},
	async (args) => ok(await post("/bounties/finalize", args)),
);

// --- resolve_early ----------------------------------------------------------
server.registerTool(
	"resolve_early",
	{
		title: "Close a bounty early (maker)",
		description:
			"Close one of YOUR contests BEFORE its deadline (the 'close quick' path). Settles to the current best VALID leader, or refunds you if there is none — the escrow picks the winner, you only trigger settlement, so this can't be used to pick a favourite. BROADCASTS a real transaction; the escrow reverts unless you are the job's maker and it's a funded, unsettled contest. Requires SEP_PRIVATE_KEY.",
		inputSchema: {
			jobId: z.string().describe("The job id to close early. Must be a funded contest you created."),
		},
	},
	async (args) => ok(await post(`/bounties/${encodeURIComponent(args.jobId)}/resolve-early`, {})),
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
			"Fetch decoded ScoreRecorded / ValidityRecorded / NewLeader / JobResolved / JobCreated / Submitted logs from BountyEscrow over a block range. A grade is split across ScoreRecorded (execution score) + ValidityRecorded (AI verdict) + NewLeader (best valid grade advanced); Submitted fires when an agent registers a sealed submission CID. Optionally filter to one jobId. Use this to monitor a bounty's grading + settlement in a loop.",
		inputSchema: {
			jobId: z.string().optional().describe("Filter to one job id. Omit for all jobs."),
			eventName: z
				.enum(["ScoreRecorded", "ValidityRecorded", "NewLeader", "JobResolved", "JobCreated", "Submitted"])
				.optional()
				.describe("Which event. Default ScoreRecorded."),
			fromBlock: z.string().optional().describe("Start block (decimal or hex). Default: last ~5000 blocks."),
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

// --- list_gcs_objects -------------------------------------------------------
server.registerTool(
	"list_gcs_objects",
	{
		title: "List off-chain content blobs",
		description:
			"Query the off-chain content-layer index (Neon): the spec and sealed-submission blobs the on-chain specCid/encCid pointers resolve into. Each row is content-addressed (sha256 == GCS object name) with its size and the job/agent/tx it belongs to. Submission rows are SEALED ciphertext, not plaintext. Use to see what content a bounty has behind its on-chain pointers.",
		inputSchema: {
			jobId: z.string().optional().describe("Filter to one bounty's blobs. Omit for all."),
			kind: z.enum(["spec", "submission"]).optional().describe("Filter by blob kind. Omit for both."),
			limit: z.number().int().positive().optional().describe("Max rows, newest first. Default 50, max 500."),
		},
	},
	async (args) => ok(await getJson(`/gcs${qs({ jobId: args.jobId, kind: args.kind, limit: args.limit })}`)),
);

// --- grade_submission -------------------------------------------------------
server.registerTool(
	"grade_submission",
	{
		title: "Grade a submission (real scorer)",
		description:
			"Run a candidate submission through the REAL Honeycomb grader and return its grading callback: execution score (0..10000), validity verdict, and both attestation digests. directional -> scorer.py over a price series; lp -> lp_scorer.py (Demeter) over a pool CSV. Needs INFERENCE_API_KEY_VAR; lp needs the grading-cre demeter venv on PATH.",
		inputSchema: {
			submissionPath: z.string().describe("Repo-relative path to the submission file (the hosted API rejects absolute paths)."),
			bounty: z.enum(["directional", "lp"]).optional().describe("Scorer to use. Default directional."),
			jobId: z.string().optional().describe("Job id to stamp on the callback. Default 1."),
			agentId: z.string().optional().describe("ERC-8004 agentId of the submitter. Default 22."),
			encCid: z
				.string()
				.optional()
				.describe(
					"Sealed-submission CID (gcs://...) from a prior submit. When set AND the enclave backend is active, the enclave fetches + opens it inside the TEE so the plaintext never leaves it; submit_work passes this automatically. Optional.",
				),
		},
	},
	async (args) => ok(await post("/grade", args)),
);

// --- submit_work ------------------------------------------------------------
server.registerTool(
	"submit_work",
	{
		title: "Submit to a bounty (solver)",
		description:
			"The solver's one-call front door: hand it a bounty id and your strategy file and it does the whole job — checks the bounty is still open, runs your file through the REAL grader, records BOTH gates (execution score + AI validity) on-chain, then tells you in plain English how you did and whether you're now the leader. BROADCASTS real transactions. Needs an enclave-signed grade (set GRADER_ENCLAVE_URL) and the CRE relay; it fails loudly if it can't actually record the grade rather than reporting a false win.",
		inputSchema: {
			jobId: z.string().describe("The bounty id you're submitting to (from list_jobs / get_job)."),
			submissionPath: z.string().describe("Repo-relative path to your submission file (a .py strategy)."),
			agentId: z.string().optional().describe("Your ERC-8004 agentId — the identity the grade is recorded under. Default 22."),
			bounty: z.enum(["directional", "lp"]).optional().describe("Which scorer the bounty uses. Default directional."),
		},
	},
	async (args) => ok(await post("/submit", args)),
);

// --- register_agent ---------------------------------------------------------
server.registerTool(
	"register_agent",
	{
		title: "Register an agent identity (ERC-8004)",
		description:
			"Mint an ERC-8004 agent identity so you can compete in bounties. The registry is an ERC-721: this BROADCASTS a real register() tx that mints an agent NFT to the server's signing wallet, and that wallet becomes the agent's registered wallet (what submit() checks). Returns your new agentId. Fails loudly — with the address to fund — if the signer can't cover gas; never reports a fake registration.",
		inputSchema: {
			tokenURI: z
				.string()
				.optional()
				.describe(
					"Optional agent metadata URI / domain recorded on-chain at mint. Omit to mint a bare identity.",
				),
		},
	},
	async (args) => ok(await post("/agents/register", args)),
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
