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

// --- Grade callback (from the grader) ---------------------------------------
// See simulation/grade-callback.json.
type GradeCallback = {
	jobId?: number | string;
	agentId?: number | string; // ERC-8004 agentId of the submitter
	status?: string; // "completed" | "failed"
	score?: number; // execution score 0..10000 (real backtest PnL, scaled)
	valid?: boolean; // AI validity verdict (valid && not hardcoded)
	scoreAttestation?: string; // execution-enclave attestation digest (bytes32 hex)
	validityAttestation?: string; // Confidential AI Attester digest (bytes32 hex)
};

const ZERO_BYTES32 = "0x".padEnd(66, "0") as Hex;
const RECORD_GRADE_ABI =
	"uint256 jobId, uint256 agentId, uint16 score, bool valid, bytes32 scoreAtt, bytes32 validityAtt";
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

// --- HTTP trigger: record a graded submission -------------------------------

export const onGrade = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	const cb = JSON.parse(bytesToString(payload.input)) as GradeCallback;
	runtime.log(`Grade received: job=${cb.jobId ?? "?"} agent=${cb.agentId ?? "?"} status=${cb.status ?? "?"}`);

	if (cb.status !== "completed") {
		runtime.log(`Status not "completed"; skipping.`);
		return JSON.stringify({ action: "skipped", jobId: cb.jobId ?? null });
	}

	const jobId = BigInt(cb.jobId ?? 0);
	const agentId = BigInt(cb.agentId ?? 0);
	const score = Math.max(0, Math.min(10000, Math.round(Number(cb.score ?? 0)))); // uint16
	const valid = cb.valid === true;
	const scoreAtt = cb.scoreAttestation ? toBytes32(cb.scoreAttestation) : ZERO_BYTES32;
	const validityAtt = cb.validityAttestation ? toBytes32(cb.validityAttestation) : ZERO_BYTES32;
	runtime.log(
		`recordGrade job=${jobId} agent=${agentId} score=${score} valid=${valid} scoreAtt=${scoreAtt} validityAtt=${validityAtt}`,
	);

	const inner = encodeAbiParameters(parseAbiParameters(RECORD_GRADE_ABI), [
		jobId,
		agentId,
		score,
		valid,
		scoreAtt,
		validityAtt,
	]);
	const report = actionReport(0, inner);

	let write: Record<string, unknown> = { attempted: false };
	try {
		write = { attempted: true, ...writeReport(runtime, report) };
		runtime.log(`recordGrade write: ${JSON.stringify(write)}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		write = { attempted: true, error: message };
		runtime.log(`recordGrade write failed (expected without --broadcast): ${message}`);
	}

	return JSON.stringify({
		action: "recordGrade",
		jobId: jobId.toString(),
		agentId: agentId.toString(),
		score,
		valid,
		scoreAttestationHash: scoreAtt,
		validityAttestationHash: validityAtt,
		write,
	});
};

// --- CRON trigger: time-based resolution ------------------------------------

export const onResolveTick = (runtime: Runtime<Config>): string => {
	const jobId = BigInt(runtime.config.jobId ?? 0);
	runtime.log(`Resolve tick at ${runtime.now().toISOString()} for job ${jobId}`);

	const inner = encodeAbiParameters(parseAbiParameters("uint256 jobId"), [jobId]);
	const report = actionReport(1, inner);

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

// --- Wiring (trigger-index 0 = grade/HTTP, 1 = resolve/CRON) -----------------

export const initWorkflow = (config: Config) => {
	const http = new HTTPCapability();
	const cron = new CronCapability();
	return [
		handler(http.trigger({ authorizedKeys: config.authorizedKeys }), onGrade),
		handler(cron.trigger({ schedule: config.schedule }), onResolveTick),
	];
};

export async function main() {
	const runner = await Runner.newRunner<Config>();
	await runner.run(initWorkflow);
}
