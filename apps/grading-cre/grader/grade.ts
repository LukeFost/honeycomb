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
import { readFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL ?? "https://confidential-ai-dev-preview.cldev.cloud";
const API_KEY = process.env.INFERENCE_API_KEY_VAR;
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// *** STUB *** execution grading.
// A real deployment runs the submission INSIDE A COMPUTE ENCLAVE (e.g. Google
// Confidential Space) against the public + private datasets and returns the
// measured score (backtest PnL, scaled 0..10000) plus the enclave's attestation
// digest. The Confidential AI Attester CANNOT do this — it is an LLM, not a code
// sandbox. Stubbed here as a deterministic placeholder derived from the code.
// ---------------------------------------------------------------------------
function executionGrade(code: string): { score: number; attestationDigest: string } {
	const score = 1 + (parseInt(sha256hex(code).slice(0, 4), 16) % 10000); // STUB score
	return { score, attestationDigest: sha256hex("STUB-EXECUTION:" + code) };
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
	console.error("usage: bun grader/grade.ts <submission-file> [bountyId] [winner]");
	process.exit(1);
}
const bountyId = process.argv[3] ?? "uniswap-lp-trading-bot-round-1";
const winner = process.argv[4] ?? "0x0000000000000000000000000000000000000001";
const code = readFileSync(path, "utf8");
const filename = path.split("/").pop()!;

const exec = executionGrade(code);
const validity = await attestValidity(filename, code);

console.error(
	`[grader] exec(STUB) score=${exec.score}  validity(REAL) valid=${validity.valid} reason="${validity.reason}" inferenceId=${validity.inferenceId}`,
);
console.log(
	JSON.stringify(
		{
			bountyId,
			status: "completed",
			winner,
			execution: { score: exec.score, attestation: { digest: exec.attestationDigest } },
			validity: { valid: validity.valid, attestation: { digest: validity.attestationDigest } },
		},
		null,
		2,
	),
);
