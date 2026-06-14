// Minimal REAL AI-validity attestation: calls the Chainlink Confidential AI Attester
// (same request as grade.ts attestValidity) and prints ONE JSON line:
//   {"valid":bool,"reason":string,"validityAttestation":"0x<32-byte response_digest>","inferenceId":string}
// Usage: INFERENCE_API_KEY_VAR=... bun grader/attest.ts <submission-file>
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const BASE_URL = process.env.BASE_URL ?? "https://confidential-ai-dev-preview.cldev.cloud";
const API_KEY = process.env.INFERENCE_API_KEY_VAR;
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

const path = process.argv[2];
if (!path) { console.error("usage: bun grader/attest.ts <submission-file>"); process.exit(1); }
if (!API_KEY) { console.error("INFERENCE_API_KEY_VAR not set"); process.exit(1); }
const code = readFileSync(path, "utf8");
const filename = path.split("/").pop()!;
const auth = { Authorization: `Bearer ${API_KEY}` };

const submit = await fetch(`${BASE_URL}/v1/inference`, {
	method: "POST",
	headers: { ...auth, "Content-Type": "application/json" },
	body: JSON.stringify({
		model: "qwen3.6",
		system_prompt: "You are a code auditor. Respond with ONLY a valid JSON object and nothing else.",
		prompt:
			'Does this code genuinely solve the task, or does it cheat by hardcoding/returning canned answers instead of computing them? Respond with ONLY: {"valid": true, "hardcoded": false, "reason": "one sentence"}',
		resources: [{ filename, content_type: "text/plain", content_base64: Buffer.from(code).toString("base64") }],
	}),
});
const { id } = (await submit.json()) as { id: string };
if (!id) { console.error("no inference id"); process.exit(1); }

let res: any;
for (let i = 0; i < 60; i++) {
	await new Promise((r) => setTimeout(r, 3000));
	res = await (await fetch(`${BASE_URL}/v1/inference/${id}`, { headers: auth })).json();
	if (res.status === "completed" || res.status === "failed") break;
}
if (res?.status !== "completed") { console.error(`inference ${res?.status}: ${res?.error ?? ""}`); process.exit(1); }

const fenced = String(res.output).trim().match(/^```(?:[a-z0-9]+)?\s*([\s\S]*?)\s*```$/i);
const verdict = JSON.parse(fenced ? fenced[1] : res.output);
const digest = res.resources?.[0]?.response_digest ?? sha256hex(res.output);
console.log(JSON.stringify({
	valid: verdict.valid === true && verdict.hardcoded === false,
	reason: verdict.reason ?? "",
	validityAttestation: "0x" + String(digest).replace(/^0x/, ""),
	inferenceId: id,
}));
