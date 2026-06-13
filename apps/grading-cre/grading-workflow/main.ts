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
	getAddress,
	keccak256,
	parseAbiParameters,
	stringToHex,
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
// See simulation/grading-callback.json. The winner is decided off-chain from two
// attested TEE jobs: `execution` (run the tests → score) and `validity`
// (AI attestor → valid / not hardcoded). Each carries its own attestation digest.
type GradingCallback = {
	bountyId?: string; // human/string id; hashed to bytes32 on-chain
	status?: string; // "completed" | "failed"
	winner?: string; // winning agent / submission payout address
	execution?: { score?: number; attestation?: { digest?: string } }; // STUB grader
	validity?: { valid?: boolean; attestation?: { digest?: string } }; // AI attestor
};

// ABI shape written on-chain and decoded by BountyEscrow.onReport():
//   (bytes32 bountyId, address winner, uint256 score, bool valid,
//    bytes32 scoreAttestationHash, bytes32 validityAttestationHash)
const SETTLEMENT_ABI =
	"bytes32 bountyId, address winner, uint256 score, bool valid, bytes32 scoreAttestationHash, bytes32 validityAttestationHash";

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
		`Grading callback received: bountyId=${callback.bountyId ?? "unknown"} status=${
			callback.status ?? "unknown"
		}`,
	);

	// 2. Only act on completed gradings.
	if (callback.status !== "completed") {
		runtime.log(`Status is not "completed"; skipping on-chain write.`);
		return JSON.stringify({
			bountyId: callback.bountyId ?? null,
			status: callback.status ?? null,
			action: "skipped",
		});
	}

	// 3. Resolve the settlement fields from the two attested jobs.
	const bountyId = keccak256(stringToHex(callback.bountyId ?? ""));
	const winner = getAddress(callback.winner ?? "0x0000000000000000000000000000000000000000");
	const score = BigInt(callback.execution?.score ?? 0);
	const valid = callback.validity?.valid === true;
	const scoreAttestationHash = callback.execution?.attestation?.digest
		? toBytes32(callback.execution.attestation.digest)
		: ZERO_BYTES32;
	const validityAttestationHash = callback.validity?.attestation?.digest
		? toBytes32(callback.validity.attestation.digest)
		: ZERO_BYTES32;
	runtime.log(
		`Winner=${winner} score=${score} valid=${valid} scoreAtt=${scoreAttestationHash} validityAtt=${validityAttestationHash}`,
	);

	// 4. ABI-encode the settlement: (bytes32, address, uint256, bool, bytes32, bytes32).
	const encodedPayload = encodeAbiParameters(parseAbiParameters(SETTLEMENT_ABI), [
		bountyId,
		winner,
		score,
		valid,
		scoreAttestationHash,
		validityAttestationHash,
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
		bountyId: callback.bountyId ?? null,
		bountyIdHash: bountyId,
		status: callback.status,
		winner,
		score: score.toString(),
		valid,
		scoreAttestationHash,
		validityAttestationHash,
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
