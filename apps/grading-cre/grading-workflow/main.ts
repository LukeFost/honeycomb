// ============================================================================
// Bounty Grading + Resolution Workflow (CRE, TypeScript)
// ============================================================================
// Two handlers, one workflow:
//
//   • HTTP trigger  onGrade        — the grader (TEE) posts each graded submission;
//     this records it on-chain via BountyEscrow.recordGrade, carrying BOTH TEE
//     outputs: the execution score (+ scoreAttestationHash) and the AI validity
//     verdict (+ validityAttestationHash). Only valid grades can take the lead.
//
//   • CRON trigger  onResolveTick  — the TIME-BASED resolver. After the bounty's
//     deadline it calls BountyEscrow.resolve(jobId), paying the best valid agent
//     (ERC-8004 Identity) or refunding the maker. The contract enforces the
//     deadline; before it, resolve reverts and we just log + move on.
//
// Both reach the consumer through the KeystoneForwarder's single onReport, with
// an action discriminator (0 = recordGrade, 1 = resolve).
//
// QuickJS/WASM runtime: no process.env / Buffer / crypto; viem does ABI encoding;
// Solidity integers are bigint.
// ============================================================================

import {
	CronCapability,
	EVMClient,
	HTTPCapability,
	handler,
	prepareReportRequest,
	Runner,
	type HTTPPayload,
	type Runtime,
} from "@chainlink/cre-sdk";
import {
	bytesToString,
	encodeAbiParameters,
	parseAbiParameters,
	toHex,
	type Hex,
} from "viem";

// --- Config -----------------------------------------------------------------

type AuthorizedKey = {
	type?: "KEY_TYPE_UNSPECIFIED" | "KEY_TYPE_ECDSA_EVM";
	publicKey?: string;
};

export type Config = {
	authorizedKeys: AuthorizedKey[]; // gates the HTTP (recordGrade) trigger when deployed
	consumerAddress: `0x${string}`;
	chainSelectorName: string;
	schedule: string; // CRON schedule for the resolver
	jobId: number; // the bounty the CRON resolver settles
};

// --- Callback (Architecture A: two TEEs write independently) ----------------
// One HTTP trigger, dispatched by `kind`:
//   kind="score"    — the Grader enclave's callback (carries the KMS signature)
//   kind="validity" — the AI Attestor's callback (carries the verdict)
// See simulation/score-callback.json and simulation/validity-callback.json.
type Callback = {
	kind?: "score" | "validity" | "delivery";
	jobId?: number | string;
	agentId?: number | string; // ERC-8004 agentId of the submitter
	status?: string; // "completed" | "failed"
	// score callback:
	score?: number; // execution score 0..10000
	signature?: { v?: number; r?: string; s?: string }; // enclave KMS sig over keccak256(jobId,agentId,score)
	// validity callback:
	valid?: boolean; // AI validity verdict (valid && not hardcoded)
	validityAttestation?: string; // Confidential AI Attestor digest (bytes32 hex)
	// delivery callback (post-resolve, from the grader enclave):
	deliveryCid?: string; // winning code re-sealed to the maker's key
};

const ZERO_BYTES32 = "0x".padEnd(66, "0") as Hex;
const SCORE_ABI = "uint256 jobId, uint256 agentId, uint16 score, uint8 v, bytes32 r, bytes32 s";
const VALIDITY_ABI = "uint256 jobId, uint256 agentId, bool valid, bytes32 validityAtt";
const DELIVER_ABI = "uint256 jobId, string deliveryCid";
const ACTION_ABI = "uint8 action, bytes data";

/** Normalize a 32-byte hex digest (with or without 0x) to bytes32. */
const toBytes32 = (hex: string): Hex => {
	const h = hex.replace(/^0[xX]/, "");
	if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) {
		throw new Error(`expected a 32-byte hex digest, got "${hex}"`);
	}
	return `0x${h.toLowerCase()}` as Hex;
};

/** Wrap an inner payload with the onReport action discriminator. */
const actionReport = (action: number, innerEncoded: Hex): Hex =>
	encodeAbiParameters(parseAbiParameters(ACTION_ABI), [action, innerEncoded]);

/** Sign + write a report to the consumer via the forwarder. */
const writeReport = (runtime: Runtime<Config>, encodedPayload: Hex) => {
	const signedReport = runtime.report(prepareReportRequest(encodedPayload)).result();
	const selectors = EVMClient.SUPPORTED_CHAIN_SELECTORS;
	const chainSelector = selectors[runtime.config.chainSelectorName as keyof typeof selectors];
	if (chainSelector === undefined) {
		throw new Error(`unsupported chainSelectorName: ${runtime.config.chainSelectorName}`);
	}
	const reply = new EVMClient(chainSelector)
		.writeReport(runtime, {
			receiver: runtime.config.consumerAddress,
			report: signedReport,
			gasConfig: { gasLimit: "500000" },
		})
		.result();
	return { txHash: reply.txHash ? toHex(reply.txHash) : null, error: reply.errorMessage ?? null };
};

// --- HTTP trigger: dispatch a TEE callback (score OR validity) ---------------

export const onCallback = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	const cb = JSON.parse(bytesToString(payload.input)) as Callback;
	runtime.log(`Callback kind=${cb.kind ?? "?"} job=${cb.jobId ?? "?"} agent=${cb.agentId ?? "?"} status=${cb.status ?? "?"}`);

	if (cb.status !== "completed") {
		runtime.log(`Status not "completed"; skipping.`);
		return JSON.stringify({ action: "skipped", jobId: cb.jobId ?? null });
	}

	const jobId = BigInt(cb.jobId ?? 0);
	const agentId = BigInt(cb.agentId ?? 0);
	let report: Hex;
	let summary: Record<string, unknown>;

	if (cb.kind === "score") {
		// Grader enclave callback: enclave-signed score, verified on-chain via ecrecover.
		const score = Math.max(0, Math.min(10000, Math.round(Number(cb.score ?? 0))));
		const v = Number(cb.signature?.v ?? 0);
		const r = cb.signature?.r ? toBytes32(cb.signature.r) : ZERO_BYTES32;
		const s = cb.signature?.s ? toBytes32(cb.signature.s) : ZERO_BYTES32;
		runtime.log(`recordScore job=${jobId} agent=${agentId} score=${score} v=${v}`);
		report = actionReport(0, encodeAbiParameters(parseAbiParameters(SCORE_ABI), [jobId, agentId, score, v, r, s]));
		summary = { action: "recordScore", jobId: jobId.toString(), agentId: agentId.toString(), score };
	} else if (cb.kind === "validity") {
		// AI Attestor callback: verdict + attestation digest.
		const valid = cb.valid === true;
		const validityAtt = cb.validityAttestation ? toBytes32(cb.validityAttestation) : ZERO_BYTES32;
		runtime.log(`recordValidity job=${jobId} agent=${agentId} valid=${valid} att=${validityAtt}`);
		report = actionReport(1, encodeAbiParameters(parseAbiParameters(VALIDITY_ABI), [jobId, agentId, valid, validityAtt]));
		summary = { action: "recordValidity", jobId: jobId.toString(), agentId: agentId.toString(), valid };
	} else if (cb.kind === "delivery") {
		// Grader enclave callback (post-resolve): winning code re-sealed to the maker's key.
		const deliveryCid = cb.deliveryCid ?? "";
		runtime.log(`deliverWinner job=${jobId} deliveryCid=${deliveryCid}`);
		report = actionReport(3, encodeAbiParameters(parseAbiParameters(DELIVER_ABI), [jobId, deliveryCid]));
		summary = { action: "deliverWinner", jobId: jobId.toString(), deliveryCid };
	} else {
		runtime.log(`unknown kind "${cb.kind}"; expected "score" or "validity".`);
		return JSON.stringify({ action: "skipped", reason: "unknown kind" });
	}

	let write: Record<string, unknown> = { attempted: false };
	try {
		write = { attempted: true, ...writeReport(runtime, report) };
		runtime.log(`write: ${JSON.stringify(write)}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		write = { attempted: true, error: message };
		runtime.log(`write failed (expected without --broadcast): ${message}`);
	}

	return JSON.stringify({ ...summary, write });
};

// --- CRON trigger: time-based resolution ------------------------------------

export const onResolveTick = (runtime: Runtime<Config>): string => {
	const jobId = BigInt(runtime.config.jobId ?? 0);
	runtime.log(`Resolve tick at ${runtime.now().toISOString()} for job ${jobId}`);

	const inner = encodeAbiParameters(parseAbiParameters("uint256 jobId"), [jobId]);
	const report = actionReport(2, inner); // ACTION_RESOLVE

	let write: Record<string, unknown> = { attempted: false };
	try {
		write = { attempted: true, ...writeReport(runtime, report) };
		runtime.log(`resolve write: ${JSON.stringify(write)}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		write = { attempted: true, error: message };
		runtime.log(`resolve skipped/failed (before deadline or already resolved): ${message}`);
	}

	return JSON.stringify({ action: "resolve", jobId: jobId.toString(), write });
};

// --- Wiring (trigger-index 0 = callback/HTTP, 1 = resolve/CRON) --------------

export const initWorkflow = (config: Config) => {
	const http = new HTTPCapability();
	const cron = new CronCapability();
	return [
		handler(http.trigger({ authorizedKeys: config.authorizedKeys }), onCallback),
		handler(cron.trigger({ schedule: config.schedule }), onResolveTick),
	];
};

export async function main() {
	const runner = await Runner.newRunner<Config>();
	await runner.run(initWorkflow);
}
