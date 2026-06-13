// ============================================================================
// StrategyVault — CRE swap-execution workflow (TypeScript)
// ============================================================================
// The off-chain half of the trust-minimized "strategy box". On each CRON tick it
// turns a strategy DECISION into a Uniswap Universal Router swap, ABI-encodes the
// vault's Action (FLAT — byte-identical to StrategyVault.onReport's abi.decode),
// DON-signs it (runtime.report), and writes it on-chain (writeReport ->
// KeystoneForwarder -> StrategyVault.onReport). The vault then enforces the
// on-chain policy + balance-delta post-conditions.
//
// v1 builds the Router calldata DETERMINISTICALLY from config (no live quote yet) so
// every DON node produces byte-identical output and consensus is trivial — exactly
// the calldata the Foundry fork test proved executes a real swap. The strategy
// decision is a stub (always emit the configured swap); the A1 declarative
// interpreter / A4 INT8 ML policy slot in here later, behind the same Action.
//
// QuickJS/WASM runtime: no process/Buffer/crypto on the hot path; viem does all ABI
// encoding + hashing; Solidity integers are bigint. Mirrors the proven grading-cre
// (report/writeReport) + keeper-bot (CRON trigger) patterns in this repo.
// ============================================================================

import {
	cre,
	EVMClient,
	prepareReportRequest,
	Runner,
	type Runtime,
} from "@chainlink/cre-sdk";
import {
	concatHex,
	encodeAbiParameters,
	encodeFunctionData,
	keccak256,
	numberToHex,
	parseAbiParameters,
	toHex,
	type Hex,
} from "viem";

// --- Config (config.staging.json / config.production.json) ------------------
export type Config = {
	schedule: string; // CRON (6-field, with seconds)
	chainSelectorName: string; // e.g. "ethereum-testnet-sepolia"
	vault: `0x${string}`; // StrategyVault (the CRE receiver / consumer)
	router: `0x${string}`; // Universal Router for the TARGET chain + version
	tokenIn: `0x${string}`;
	tokenOut: `0x${string}`;
	fee: number; // V3 pool fee (500 / 3000 / 10000)
	amountIn: string; // raw units (string -> bigint)
	minOut: string; // raw-units floor the vault enforces
	deadline: number; // unix seconds (the workflow has no clock; operator sets a horizon)
	gasLimit: string;
	strategyId: string; // -> artifactHash = keccak256(strategyId)
};

// Action tuple — FLAT, byte-identical to StrategyVault.onReport's abi.decode(...).
const ACTION_ABI =
	"address to, bytes data, uint256 value, uint256 minOut, uint64 deadline, " +
	"address tokenIn, address tokenOut, uint256 amountIn, bytes32 nonce, bytes32 artifactHash";

// Universal Router execute(bytes commands, bytes[] inputs, uint256 deadline).
const UR_EXECUTE_ABI = [
	{
		type: "function",
		name: "execute",
		stateMutability: "payable",
		inputs: [
			{ name: "commands", type: "bytes" },
			{ name: "inputs", type: "bytes[]" },
			{ name: "deadline", type: "uint256" },
		],
		outputs: [],
	},
] as const;

const V3_SWAP_EXACT_IN: Hex = "0x00"; // Universal Router command byte

/** Build UR calldata for an exact-in single-hop V3 swap, output to the vault. */
function buildUniversalRouterCalldata(cfg: Config, amountIn: bigint, minOut: bigint): Hex {
	// V3 path = tokenIn (20) | fee (uint24, 3) | tokenOut (20)
	const path = concatHex([cfg.tokenIn, numberToHex(cfg.fee, { size: 3 }), cfg.tokenOut]);
	// V3_SWAP_EXACT_IN input = (recipient, amountIn, amountOutMin, path, payerIsUser)
	const swapInput = encodeAbiParameters(
		parseAbiParameters(
			"address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser",
		),
		[cfg.vault, amountIn, minOut, path, true],
	);
	return encodeFunctionData({
		abi: UR_EXECUTE_ABI,
		functionName: "execute",
		args: [V3_SWAP_EXACT_IN, [swapInput], BigInt(cfg.deadline)],
	});
}

// --- CRON handler — produce one swap Action and write it on-chain ------------
export const onTick = (runtime: Runtime<Config>): string => {
	const cfg = runtime.config;
	const amountIn = BigInt(cfg.amountIn);
	const minOut = BigInt(cfg.minOut);

	// 1. STRATEGY DECISION (v1 stub: always emit the configured swap). The A1
	//    declarative interpreter / A4 ML policy slot in here, behind the same Action.
	runtime.log(
		`tick: swap ${amountIn} of ${cfg.tokenIn} -> ${cfg.tokenOut} (fee ${cfg.fee}) via ${cfg.router}`,
	);

	// 2. Build the Router calldata deterministically (consensus-trivial; no live quote yet).
	const urData = buildUniversalRouterCalldata(cfg, amountIn, minOut);

	// 3. Provenance + replay nonce (deterministic across nodes; unique per vault+amount+deadline).
	const artifactHash = keccak256(toHex(cfg.strategyId));
	const nonce = keccak256(
		concatHex([
			cfg.vault,
			numberToHex(amountIn, { size: 32 }),
			numberToHex(BigInt(cfg.deadline), { size: 32 }),
		]),
	);

	// 4. ABI-encode the FLAT Action the vault decodes.
	const encodedPayload = encodeAbiParameters(parseAbiParameters(ACTION_ABI), [
		cfg.router,
		urData,
		0n,
		minOut,
		BigInt(cfg.deadline),
		cfg.tokenIn,
		cfg.tokenOut,
		amountIn,
		nonce,
		artifactHash,
	]);

	// 5. DON-sign the report and write it on-chain. Guarded so simulate always returns a
	//    summary even when the write can't broadcast (no --broadcast / no deployed vault).
	let write: Record<string, unknown> = { attempted: false };
	try {
		const signed = runtime.report(prepareReportRequest(encodedPayload)).result();

		const selectors = EVMClient.SUPPORTED_CHAIN_SELECTORS;
		const sel = selectors[cfg.chainSelectorName as keyof typeof selectors];
		if (sel === undefined) {
			throw new Error(`unsupported chainSelectorName: ${cfg.chainSelectorName}`);
		}

		const reply = new EVMClient(sel)
			.writeReport(runtime, {
				receiver: cfg.vault,
				report: signed,
				gasConfig: { gasLimit: cfg.gasLimit },
			})
			.result();

		const txHash = reply.txHash ? toHex(reply.txHash) : null;
		write = { attempted: true, txHash, error: reply.errorMessage ?? null };
		runtime.log(`write: txHash=${txHash ?? "n/a"} error=${reply.errorMessage ?? "n/a"}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		write = { attempted: true, error: message };
		runtime.log(
			`write failed (expected in simulation without --broadcast / a deployed vault): ${message}`,
		);
	}

	return JSON.stringify({
		vault: cfg.vault,
		router: cfg.router,
		tokenIn: cfg.tokenIn,
		tokenOut: cfg.tokenOut,
		amountIn: amountIn.toString(),
		minOut: minOut.toString(),
		artifactHash,
		nonce,
		calldataLen: urData.length,
		encodedAction: encodedPayload, // the exact report bytes StrategyVault.onReport decodes
		write,
	});
};

// --- Workflow wiring --------------------------------------------------------
export const initWorkflow = (config: Config) => {
	const cron = new cre.capabilities.CronCapability();
	return [cre.handler(cron.trigger({ schedule: config.schedule }), onTick)];
};

export async function main() {
	const runner = await Runner.newRunner<Config>();
	await runner.run(initWorkflow);
}
