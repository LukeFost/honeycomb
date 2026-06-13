#!/usr/bin/env bun
// ============================================================================
// Off-chain grader for a bounty submission. Produces the grading-callback the
// grader POSTs to the CRE workflow's HTTP trigger.
//
// Two jobs, deliberately separated:
//   • executionGrade() — *** STUB ***  run the code against the test datasets.
//   • attestValidity() — REAL  call the Chainlink Confidential AI Attester (TEE
//                              LLM) to attest the code is valid / not hardcoded.
//
// Usage:
//   INFERENCE_API_KEY_VAR=... bun grader/grade.ts <submission-file> [bountyId] [winner]
//   (prints the grading-callback JSON to stdout; logs to stderr)
// ============================================================================

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "https://confidential-ai-dev-preview.cldev.cloud";
const API_KEY = process.env.INFERENCE_API_KEY_VAR;
const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const HERE = dirname(new URL(import.meta.url).pathname);
const SCORER = join(HERE, "scorer.py");
const PRIVATE_SERIES = join(
	HERE,
	"..",
	"maker",
	"bounties",
	"uniswap-lp-trading-bot",
	"private",
	"prices_private.json",
);

// ---------------------------------------------------------------------------
// REAL execution grading. Runs the submission against the PRIVATE price series
// in a separate, isolated process (scorer.py spawns the untrusted worker; the
// submission sees only price DATA, never the file, never the network) and
// returns the real backtested PnL, scaled 0..10000 — NOT a hash of the code.
//
// In the Confidential Space deployment this exact scorer runs inside the enclave
// and the digest below is signed by Cloud KMS. Here (Stage 1) the digest is a
// content commitment over the graded inputs+output: it proves "this exact code,
// graded against this exact private series, produced this exact score", and is
// verifiable later against the on-chain scoreAttestationHash. It is NOT a
// hardware attestation yet — honest labeling per HARNESS_SPEC.md.
// ---------------------------------------------------------------------------
function executionGrade(submissionPath: string, code: string, bountyId: string): {
	score: number;
	attestationDigest: string;
} {
	const out = execFileSync("python3", [SCORER, submissionPath], {
		encoding: "utf8",
		timeout: 30_000, // hard ceiling on the whole grade; scorer has its own per-walk deadline
	});
	const score = parseInt(out.trim(), 10);
	if (!Number.isInteger(score) || score < 0 || score > 10000) {
		throw new Error(`scorer returned a non-score: ${JSON.stringify(out)}`);
	}

	// Content commitment: sha256(bountyId || submissionHash || privateSeriesHash || score).
	const submissionHash = sha256hex(code);
	const privateSeriesHash = sha256hex(readFileSync(PRIVATE_SERIES));
	const attestationDigest = sha256hex(
		`${bountyId}|${submissionHash}|${privateSeriesHash}|${score}`,
	);
	return { score, attestationDigest };
}

// ---------------------------------------------------------------------------
// REAL AI validity attestation via the Chainlink Confidential AI Attester.
// ---------------------------------------------------------------------------
async function attestValidity(filename: string, code: string) {
	if (!API_KEY) throw new Error("INFERENCE_API_KEY_VAR not set");
	const auth = { Authorization: `Bearer ${API_KEY}` };

	const submit = await fetch(`${BASE_URL}/v1/inference`, {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "qwen3.6",
			system_prompt:
				"You are a code auditor. Respond with ONLY a valid JSON object and nothing else.",
			prompt:
				'Does this code genuinely solve the task, or does it cheat by hardcoding/returning canned answers instead of computing them? Respond with ONLY: {"valid": true, "hardcoded": false, "reason": "one sentence"}',
			resources: [
				{ filename, content_type: "text/plain", content_base64: Buffer.from(code).toString("base64") },
			],
		}),
	});
	const { id } = (await submit.json()) as { id: string };

	let res: any;
	for (let i = 0; i < 60; i++) {
		await new Promise((r) => setTimeout(r, 3000));
		res = await (await fetch(`${BASE_URL}/v1/inference/${id}`, { headers: auth })).json();
		if (res.status === "completed" || res.status === "failed") break;
	}
	if (res?.status !== "completed") throw new Error(`inference ${res?.status}: ${res?.error ?? ""}`);

	const fenced = String(res.output).trim().match(/^```(?:[a-z0-9]+)?\s*([\s\S]*?)\s*```$/i);
	const verdict = JSON.parse(fenced ? fenced[1] : res.output);
	const attestationDigest = res.resources?.[0]?.response_digest ?? sha256hex(res.output);
	return {
		valid: verdict.valid === true && verdict.hardcoded === false,
		reason: verdict.reason ?? "",
		attestationDigest,
		inferenceId: id,
	};
}

// ---------------------------------------------------------------------------
const path = process.argv[2];
if (!path) {
	console.error("usage: bun grader/grade.ts <submission-file> [jobId] [winnerAgentId]");
	process.exit(1);
}
const jobId = Number(process.argv[3] ?? 1); // ERC-8183 job id
const winnerAgentId = Number(process.argv[4] ?? 22); // ERC-8004 agentId
const code = readFileSync(path, "utf8");
const filename = path.split("/").pop()!;

const exec = executionGrade(path, code, bountyId);
const validity = await attestValidity(filename, code);
const score = Math.round(exec.score / 100); // STUB 0..10000 -> 0..100

console.error(
	`[grader] exec(REAL) score0_100=${score}  validity(REAL) valid=${validity.valid} reason="${validity.reason}" inferenceId=${validity.inferenceId}`,
);
// Settlement-shaped payload posted to the CRE workflow's HTTP trigger.
// reason = the REAL AI-attestor response_digest (the validity attestation).
// (The execution attestation will become a separate ERC-8004 Validation entry.)
console.log(
	JSON.stringify(
		{
			jobId,
			status: "completed",
			winnerAgentId,
			valid: validity.valid,
			score,
			reason: validity.attestationDigest,
		},
		null,
		2,
	),
);
