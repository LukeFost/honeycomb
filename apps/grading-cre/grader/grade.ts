#!/usr/bin/env bun
// ============================================================================
// Off-chain grader for a Honeycomb work submission. Produces a direct grading
// result that callers can return as a user-owned work receipt.
//
// Two jobs, deliberately separated:
//   • executionGrade() — REAL  run the submission against the PRIVATE series in an
//                              isolated process (scorer.py / lp_scorer.py), real PnL.
//   • attestValidity() — DEFAULT direct mode returns an explicit non-attested
//                              validity marker; opt in to the legacy Confidential
//                              AI call with HONEYCOMB_ENABLE_CONFIDENTIAL_AI=1.
//
// Usage:
//   bun grader/grade.ts <submission-file> [bountyId] [winner]
//   HONEYCOMB_ENABLE_CONFIDENTIAL_AI=1 INFERENCE_API_KEY_VAR=... bun grader/grade.ts ...
//   (prints the grading result JSON to stdout; logs to stderr)
// ============================================================================

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "https://confidential-ai-dev-preview.cldev.cloud";
const API_KEY = process.env.INFERENCE_API_KEY_VAR;
const ENABLE_CONFIDENTIAL_AI = process.env.HONEYCOMB_ENABLE_CONFIDENTIAL_AI === "1";
const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const HERE = dirname(new URL(import.meta.url).pathname);

// Two bounty types, two scorers, SAME CLI contract (print one int 0..10000 to
// stdout, logs to stderr) and SAME trusted/untrusted process split:
//   directional  -> scorer.py    over prices_private.json   (signal()->label)
//   lp (Demeter) -> lp_scorer.py over pool_private.csv       (Strategy subclass)
// Select with BOUNTY=lp; default is the directional grader. The rest of grade.ts
// (digest, validity, settlement payload) is identical for both.
const BOUNTY = process.env.BOUNTY ?? "directional";
const IS_LP = BOUNTY === "lp";
const SCORER = join(HERE, IS_LP ? "lp_scorer.py" : "scorer.py");
const PRIVATE_SERIES = IS_LP
	? join(HERE, "..", "maker", "bounties", "uniswap-lp-range-bot", "private", "pool_private.csv")
	: join(HERE, "..", "maker", "bounties", "uniswap-lp-trading-bot", "private", "prices_private.json");

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
// hardware attestation yet — honest labeling.
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

// --- Optional AI validity check ---------------------------------------------
// Default direct mode intentionally has no Chainlink/Confidential-AI dependency.
// It labels the execution score as un-attested instead of blocking the user's work
// receipt on an external attestor. Set HONEYCOMB_ENABLE_CONFIDENTIAL_AI=1 to run
// the legacy AI validity service when a demo explicitly needs honest-vs-cheat.
async function attestValidity(filename: string, code: string) {
	if (!ENABLE_CONFIDENTIAL_AI) {
		const attestationDigest = sha256hex(`direct-validity|${filename}|${sha256hex(code)}`);
		return {
			valid: true,
			reason: "Direct grading mode: no AI validity attestation was requested.",
			attestationDigest,
			inferenceId: null,
			mode: "direct-unattested" as const,
		};
	}

	if (!API_KEY) throw new Error("INFERENCE_API_KEY_VAR not set (required when HONEYCOMB_ENABLE_CONFIDENTIAL_AI=1)");
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
		mode: "confidential-ai" as const,
	};
}

// --- CLI entrypoint ---
const path = process.argv[2];
if (!path) {
	console.error("usage: bun grader/grade.ts <submission-file> [jobId] [winnerAgentId]");
	process.exit(1);
}
const jobId = process.argv[3] ?? "1"; // ERC-8183 job id (string — can exceed 2^53)
const agentId = process.argv[4] ?? "22"; // ERC-8004 agentId of the submitter (string)
const code = readFileSync(path, "utf8");
const filename = path.split("/").pop()!;

const exec = executionGrade(path, code, String(jobId)); // REAL backtest, 0..10000
const validity = await attestValidity(filename, code);

console.error(
	`[grader] exec(REAL) score=${exec.score}/10000  validity(${validity.mode}) valid=${validity.valid} reason="${validity.reason}" inferenceId=${validity.inferenceId ?? "none"}`,
);
// Combined grading result for humans + the API direct submit path. The execution
// score/digest are real scorer outputs. Validity is explicit about its mode:
// direct-unattested by default, confidential-ai only when the legacy external
// attestor is intentionally enabled.
console.log(
	JSON.stringify(
		{
			jobId,
			agentId,
			status: "completed",
			score: exec.score, // 0..10000
			valid: validity.valid,
			scoreAttestation: exec.attestationDigest, // execution digest
			validityAttestation: validity.attestationDigest,
			validityMode: validity.mode,
			validityReason: validity.reason,
		},
		null,
		2,
	),
);
