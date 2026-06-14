// ============================================================================
// StrategyVault — CRE swap-execution workflow (TypeScript)
// ============================================================================
// On each CRON tick the workflow pulls a LIVE quote from the real Uniswap Trading
// API (key from a CRE secret / Vault DON) in NODE mode, reaches DON consensus on the
// numeric min-out, rebuilds the Universal Router calldata deterministically, DON-signs
// the flat Action, and writes it (writeReport -> KeystoneForwarder -> vault.onReport).
//
// Consensus design (the load-bearing bit): each DON node calls /quote independently and
// gets a different quoteId/route/calldata. We NEVER reach consensus on the raw calldata.
// We aggregate ONLY the numeric min-out (median, via the por-style number->parseUnits
// trick) and rebuild the calldata ourselves from a pinned single-hop path. NO FALLBACK —
// if the live quote fails or disagrees, the tick fails (no deterministic price path).
//
// Route note: Uniswap's best route is often mixed v4+v3 through an intermediary; we take
// its live min-out as the on-chain floor but execute our proven single-hop V3 path (whose
// output sits at/above that floor in practice). Following the API's exact multi-hop route
// is a later enhancement.
//
// QuickJS/WASM runtime: viem does all ABI encoding/hashing; Buffer is shimmed; Solidity
// integers are bigint. Mirrors the proven bring-your-own-data (HTTP+consensus) +
// grading-cre (report/writeReport) patterns in this repo.
// ============================================================================

import {
	ConsensusAggregationByFields,
	cre,
	EVMClient,
	type HTTPSendRequester,
	median,
	prepareReportRequest,
	Runner,
	type Runtime,
} from "@chainlink/cre-sdk";
import {
	concatHex,
	encodeAbiParameters,
	encodeFunctionData,
	formatUnits,
	keccak256,
	numberToHex,
	parseAbiParameters,
	parseUnits,
	toHex,
	type Hex,
} from "viem";

// --- Config (config.staging.json / config.production.json) ------------------
export type Config = {
	schedule: string; // CRON (6-field, with seconds)
	chainSelectorName: string; // CRE write chain, e.g. "ethereum-mainnet"
	quoteChainId: number; // Uniswap API chainId (1 = mainnet)
	tradeApiBase: string; // "https://trade-api.gateway.uniswap.org/v1"
	vault: `0x${string}`; // StrategyVault (the CRE receiver / consumer)
	router: `0x${string}`; // Universal Router for the chain
	tokenIn: `0x${string}`;
	tokenOut: `0x${string}`;
	tokenOutDecimals: number; // for the wei<->float min-out consensus round-trip
	fee: number; // pinned execution-path V3 fee (500 / 3000 / 10000)
	amountIn: string; // raw tokenIn units
	slippageTolerance: number; // % sent to the API (e.g. 0.5)
	protocols: string[]; // which Uniswap protocols to quote over (e.g. ["V3"] to match our V3 exec)
	deadlineSeconds: number; // swap deadline horizon from now
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

// The numeric quote fields the DON reaches consensus on. Wei amounts are reduced to a
// token-unit float first (the por pattern) so `median` works; parseUnits restores wei.
type QuoteNumerics = { minOut: number; expectedOut: number };

/** Build UR calldata for an exact-in single-hop V3 swap, output to the vault. */
function buildUniversalRouterCalldata(
	cfg: Config,
	amountIn: bigint,
	minOut: bigint,
	deadline: bigint,
): Hex {
	const path = concatHex([cfg.tokenIn, numberToHex(cfg.fee, { size: 3 }), cfg.tokenOut]);
	const swapInput = encodeAbiParameters(
		parseAbiParameters(
			"address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser",
		),
		[cfg.vault, amountIn, minOut, path, true],
	);
	return encodeFunctionData({
		abi: UR_EXECUTE_ABI,
		functionName: "execute",
		args: [V3_SWAP_EXACT_IN, [swapInput], deadline],
	});
}

// --- CRON handler — live quote -> consensus min-out -> Action -> write -------
export const onTick = (runtime: Runtime<Config>): string => {
	const cfg = runtime.config;
	const amountIn = BigInt(cfg.amountIn);

	// 1. Secret: the Uniswap API key. Vault DON secret once deployed; local .env in simulate.
	const apiKey = runtime.getSecret({ id: "UNISWAP_API_KEY" }).result().value;

	// 2. LIVE quote in NODE mode; consensus over numeric fields ONLY (median). No fallback —
	//    a non-200 / non-CLASSIC / missing-field response throws and the tick fails.
	const fetchQuote = (sendRequester: HTTPSendRequester): QuoteNumerics => {
		const reqBody = {
			type: "EXACT_INPUT",
			amount: cfg.amountIn,
			tokenInChainId: cfg.quoteChainId,
			tokenOutChainId: cfg.quoteChainId,
			tokenIn: cfg.tokenIn,
			tokenOut: cfg.tokenOut,
			swapper: cfg.vault,
			slippageTolerance: cfg.slippageTolerance,
			protocols: cfg.protocols,
		};
		const resp = sendRequester
			.sendRequest({
				method: "POST",
				url: `${cfg.tradeApiBase}/quote`,
				headers: { "x-api-key": apiKey, "content-type": "application/json" },
				// RequestJson body is base64-decoded to bytes by the runtime.
				body: Buffer.from(JSON.stringify(reqBody)).toString("base64"),
			})
			.result();
		if (resp.statusCode !== 200) {
			throw new Error(`Uniswap /quote HTTP ${resp.statusCode}`);
		}
		const j = JSON.parse(Buffer.from(resp.body).toString("utf-8"));
		if (j.routing !== "CLASSIC") {
			throw new Error(`Uniswap routing is ${j.routing}, expected CLASSIC`);
		}
		const out = j.quote && j.quote.output;
		if (!out || !out.minimumAmount || !out.amount) {
			throw new Error("missing quote.output.{minimumAmount,amount}");
		}
		return {
			minOut: Number(formatUnits(BigInt(out.minimumAmount), cfg.tokenOutDecimals)),
			expectedOut: Number(formatUnits(BigInt(out.amount), cfg.tokenOutDecimals)),
		};
	};

	const httpCapability = new cre.capabilities.HTTPClient();
	const quote = httpCapability
		.sendRequest(
			runtime,
			fetchQuote,
			ConsensusAggregationByFields<QuoteNumerics>({ minOut: median, expectedOut: median }),
		)()
		.result();

	const minOutWei = parseUnits(quote.minOut.toFixed(cfg.tokenOutDecimals), cfg.tokenOutDecimals);
	runtime.log(
		`live quote: expectedOut=${quote.expectedOut} minOut=${quote.minOut} (${minOutWei} wei)`,
	);

	// 3. Deterministic deadline + nonce (Date.now() is host-provided + consensus-reconciled in CRE).
	const deadline = BigInt(Math.floor(Date.now() / 1000) + cfg.deadlineSeconds);
	const artifactHash = keccak256(toHex(cfg.strategyId));
	const nonce = keccak256(
		concatHex([
			cfg.vault,
			numberToHex(amountIn, { size: 32 }),
			numberToHex(deadline, { size: 32 }),
		]),
	);

	// 4. Rebuild Router calldata deterministically from the agreed min-out (consensus-safe).
	const urData = buildUniversalRouterCalldata(cfg, amountIn, minOutWei, deadline);

	// 5. ABI-encode the FLAT Action the vault decodes.
	const encodedPayload = encodeAbiParameters(parseAbiParameters(ACTION_ABI), [
		cfg.router,
		urData,
		0n,
		minOutWei,
		deadline,
		cfg.tokenIn,
		cfg.tokenOut,
		amountIn,
		nonce,
		artifactHash,
	]);

	// 6. DON-sign the report and write it on-chain. The try/catch only handles the no-broadcast
	//    case in simulate so a summary is still returned — it is NOT a price fallback (min-out
	//    always comes from the live quote above).
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
		tokenIn: cfg.tokenIn,
		tokenOut: cfg.tokenOut,
		amountIn: amountIn.toString(),
		expectedOut: quote.expectedOut,
		minOut: quote.minOut,
		minOutWei: minOutWei.toString(),
		deadline: deadline.toString(),
		artifactHash,
		nonce,
		calldataLen: urData.length,
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
