// ============================================================================
// Bounty Grading — Winner Settlement Workflow (CRE, TypeScript)
// ============================================================================
// Simplest version of the Honeycomb grading flow.
//
// Flow:
//   1. A grader (TEE enclave / MCP) finishes scoring a bounty's submissions and
//      POSTs the result to this workflow's HTTP-trigger endpoint. The body
//      carries the winning submission + the TEE attestation digest that proves
//      the grade was produced inside the enclave.
//   2. This workflow parses that result, ABI-encodes a settlement, and writes it
//      on-chain via the EVM client (report -> KeystoneForwarder -> onReport).
//   3. The on-chain BountyEscrow consumer records the winner and exposes
//      winnerOf(bountyId) / isSettled(bountyId) so payout can be gated on it.
//
// Mirrors the proven pattern from the confidential-ai-attester demo. No secrets,
// no Confidential HTTP, no x402 yet — just the attester-style push/callback +
// on-chain write.
//
// QuickJS/WASM runtime: no process.env / Buffer / crypto; viem does all ABI
// encoding and hashing; Solidity integers are bigint.
// ============================================================================

import {
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

// --- Config (config.staging.json / config.production.json) ------------------

// HTTP trigger authorized signer key. Leave authorizedKeys empty ([]) in
// simulation to accept any sender.
type AuthorizedKey = {
	type?: "KEY_TYPE_UNSPECIFIED" | "KEY_TYPE_ECDSA_EVM";
	publicKey?: string;
};

export type Config = {
	authorizedKeys: AuthorizedKey[];
	consumerAddress: `0x${string}`;
	chainSelectorName: string;
};

// --- Grading callback (only the fields this workflow uses) ------------------
// See simulation/grading-callback.json. The off-chain grader picks the winner
// (an ERC-8004 agentId) from the two attested TEE jobs — execution grading
// (score) and AI validity attestation — and posts the settlement here.
type GradingCallback = {
	jobId?: number | string; // ERC-8183 job id (uint256)
	status?: string; // "completed" | "failed"
	winnerAgentId?: number | string; // ERC-8004 agentId of the winner
	valid?: boolean; // AI attestor verdict: valid and not hardcoded
	score?: number; // winning execution score, 0..100
	reason?: string; // attestation / validation responseHash (bytes32 hex)
};

// ABI shape written on-chain and decoded by BountyEscrow.onReport():
//   (uint256 jobId, uint256 winnerAgentId, bool valid, uint8 score, bytes32 reason)
const SETTLEMENT_ABI =
	"uint256 jobId, uint256 winnerAgentId, bool valid, uint8 score, bytes32 reason";

const ZERO_BYTES32 = "0x".padEnd(66, "0") as Hex;

// --- Helpers ----------------------------------------------------------------

/** Normalize a 32-byte hex digest (with or without 0x) to a bytes32 value. */
const toBytes32 = (hex: string): Hex => {
	const h = hex.replace(/^0[xX]/, "");
	if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) {
		throw new Error(`expected a 32-byte hex digest, got "${hex}"`);
	}
	return `0x${h.toLowerCase()}` as Hex;
};

// --- HTTP trigger handler — receives the grading callback -------------------

export const onGradingResult = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	// 1. Decode the HTTP body bytes into the callback object.
	const callback = JSON.parse(bytesToString(payload.input)) as GradingCallback;
	runtime.log(
		`Grading callback received: jobId=${callback.jobId ?? "unknown"} status=${
			callback.status ?? "unknown"
		}`,
	);

	// 2. Only act on completed gradings.
	if (callback.status !== "completed") {
		runtime.log(`Status is not "completed"; skipping on-chain write.`);
		return JSON.stringify({
			jobId: callback.jobId ?? null,
			status: callback.status ?? null,
			action: "skipped",
		});
	}

	// 3. Resolve the settlement fields.
	const jobId = BigInt(callback.jobId ?? 0);
	const winnerAgentId = BigInt(callback.winnerAgentId ?? 0);
	const valid = callback.valid === true;
	const rawScore = Number(callback.score ?? 0);
	const score = Math.max(0, Math.min(100, Math.round(rawScore))); // clamp to uint8 0..100
	const reason = callback.reason ? toBytes32(callback.reason) : ZERO_BYTES32;
	runtime.log(
		`jobId=${jobId} winnerAgentId=${winnerAgentId} valid=${valid} score=${score} reason=${reason}`,
	);

	// 4. ABI-encode the settlement: (uint256, uint256, bool, uint8, bytes32).
	const encodedPayload = encodeAbiParameters(parseAbiParameters(SETTLEMENT_ABI), [
		jobId,
		winnerAgentId,
		valid,
		score,
		reason,
	]);

	// 5. Generate a signed report and write it on-chain. Guarded so the workflow
	//    always returns a summary even when the write can't be broadcast.
	let write: Record<string, unknown> = { attempted: false };
	try {
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

		const txHash = reply.txHash ? toHex(reply.txHash) : null;
		const errorMessage = reply.errorMessage ?? null;
		write = { attempted: true, txHash, error: errorMessage };
		runtime.log(`On-chain write: txHash=${txHash ?? "n/a"} error=${errorMessage ?? "n/a"}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		write = { attempted: true, error: message };
		runtime.log(
			`On-chain write failed (expected in simulation without --broadcast / a real consumer): ${message}`,
		);
	}

	// 6. Return a JSON summary.
	return JSON.stringify({
		jobId: jobId.toString(),
		winnerAgentId: winnerAgentId.toString(),
		status: callback.status,
		valid,
		score: score.toString(),
		reason,
		consumerAddress: runtime.config.consumerAddress,
		chainSelectorName: runtime.config.chainSelectorName,
		write,
	});
};

// --- Workflow wiring --------------------------------------------------------

export const initWorkflow = (config: Config) => {
	const http = new HTTPCapability();
	return [handler(http.trigger({ authorizedKeys: config.authorizedKeys }), onGradingResult)];
};

export async function main() {
	const runner = await Runner.newRunner<Config>();
	await runner.run(initWorkflow);
}
