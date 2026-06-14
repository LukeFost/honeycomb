// ============================================================================
// StrategyVault — MULTI-USER CRE swap-execution workflow (TypeScript)
// ============================================================================
// One workflow serves MANY users. On each CRON tick it:
//   1. EVM-reads StrategyRegistry.listActive(maxVaults) — the set of registered
//      (vault, strategy) rows, each user self-registered their own vault.
//   2. For EACH active vault: pulls a live Uniswap quote in NODE mode, reaches DON
//      consensus on the min-out, rebuilds the Universal Router calldata, DON-signs a
//      report, and writes it to THAT vault (writeReport -> forwarder -> onReport -> swap).
//
// Isolation: every user's funds live in their own policy-bounded StrategyVault, with
// its own nonce mapping. A bad strategy can only ever hurt its own vault. One failing
// vault is caught and skipped — it never blocks the others.
//
// Scale note: each vault costs ~1 HTTP quote + 1 writeReport per tick, so a single run
// is bounded by CRE per-run quotas (HTTP <=5). `maxVaults` caps the fan-out; beyond that
// you shard across runs/workflows. Min-out consensus medians the raw wei as a JS number
// (exact for amounts < 2^53 wei — fine for the demo sizes; scale via decimals for larger).
// ============================================================================

import {
	bytesToHex,
	ConsensusAggregationByFields,
	cre,
	encodeCallMsg,
	EVMClient,
	type HTTPSendRequester,
	LATEST_BLOCK_NUMBER,
	median,
	prepareReportRequest,
	Runner,
	type Runtime,
} from "@chainlink/cre-sdk";
import {
	concatHex,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	keccak256,
	numberToHex,
	parseAbiParameters,
	toHex,
	zeroAddress,
	type Hex,
} from "viem";

// --- Config -----------------------------------------------------------------
export type Config = {
	schedule: string;
	chainSelectorName: string; // CRE write chain, e.g. "ethereum-mainnet-base-1"
	quoteChainId: number; // Uniswap API chainId (8453 = Base)
	tradeApiBase: string;
	registry: `0x${string}`; // StrategyRegistry
	router: `0x${string}`; // Universal Router (chain-global)
	maxVaults: number; // fan-out cap per tick (CRE HTTP quota)
	deadlineSeconds: number;
	gasLimit: string;
	// Gap 7 — declarative "accumulate" strategy. The workflow only swaps when the strategy
	// DECIDES to (it no longer blindly swaps every active vault). Optional; sensible defaults.
	priceApiBase?: string; // Coinbase Exchange candles base (default api.exchange.coinbase.com)
	priceGranularity?: number; // candle granularity in seconds (default 3600 = hourly)
	accumulateBandBps?: number; // buy when last <= avg * (1 + band); default 50 (0.50%)
};

// Each user's row, as decoded from StrategyRegistry.listActive(...).
type Entry = {
	vault: `0x${string}`;
	tokenIn: `0x${string}`;
	tokenOut: `0x${string}`;
	fee: number;
	amountIn: bigint;
	slippageBps: number;
	strategyId: `0x${string}`;
};

const REGISTRY_ABI = [
	{
		type: "function",
		name: "listActive",
		stateMutability: "view",
		inputs: [{ name: "maxCount", type: "uint256" }],
		outputs: [
			{
				name: "out",
				type: "tuple[]",
				components: [
					{ name: "vault", type: "address" },
					{ name: "tokenIn", type: "address" },
					{ name: "tokenOut", type: "address" },
					{ name: "fee", type: "uint24" },
					{ name: "amountIn", type: "uint256" },
					{ name: "slippageBps", type: "uint16" },
					{ name: "strategyId", type: "bytes32" },
				],
			},
		],
	},
] as const;

const ACTION_ABI =
	"address to, bytes data, uint256 value, uint256 minOut, uint64 deadline, " +
	"address tokenIn, address tokenOut, uint256 amountIn, bytes32 nonce, bytes32 artifactHash";

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

const V3_SWAP_EXACT_IN: Hex = "0x00";

type QuoteNumerics = { minOut: number; expectedOut: number };

function buildUniversalRouterCalldata(
	tokenIn: `0x${string}`,
	fee: number,
	tokenOut: `0x${string}`,
	recipient: `0x${string}`,
	amountIn: bigint,
	minOut: bigint,
	deadline: bigint,
): Hex {
	const path = concatHex([tokenIn, numberToHex(fee, { size: 3 }), tokenOut]);
	const swapInput = encodeAbiParameters(
		parseAbiParameters(
			"address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser",
		),
		[recipient, amountIn, minOut, path, true],
	);
	return encodeFunctionData({
		abi: UR_EXECUTE_ABI,
		functionName: "execute",
		args: [V3_SWAP_EXACT_IN, [swapInput], deadline],
	});
}

// --- Gap 7: declarative "accumulate" strategy decision -----------------------
// The winning strategy is expressed declaratively: ACCUMULATE — buy the asset only when its
// live price is at/below its recent average plus a small band (i.e. "not pumping"). This mirrors
// grader/run_signal.py's spirit (decide from a Coinbase ETH/USD close series), but the decision
// is computed in-workflow under DON consensus instead of off-chain in bash. If the decision is
// "buy" we proceed with the existing USDC->WETH swap; otherwise we hold/skip (no report written).
type PriceStats = { last: number; avg: number };

// Coinbase Exchange candles: [time, low, high, open, close, volume], newest first. We fetch a
// short series, median each statistic across DON nodes, and decide from the consensus values.
function fetchPriceStats(
	runtime: Runtime<Config>,
	cfg: Config,
	http: InstanceType<typeof cre.capabilities.HTTPClient>,
): PriceStats {
	const base = cfg.priceApiBase ?? "https://api.exchange.coinbase.com";
	const gran = cfg.priceGranularity ?? 3600;
	const fetch = (sendRequester: HTTPSendRequester): PriceStats => {
		const resp = sendRequester
			.sendRequest({
				method: "GET",
				url: `${base}/products/ETH-USD/candles?granularity=${gran}`,
				headers: { "User-Agent": "honeycomb-e2e" },
			})
			.result();
		if (resp.statusCode !== 200) throw new Error(`/candles HTTP ${resp.statusCode}`);
		const rows = JSON.parse(Buffer.from(resp.body).toString("utf-8")) as number[][];
		if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty candle series");
		rows.sort((a, b) => a[0] - b[0]); // chronological
		const closes = rows.map((c) => c[4]); // close price
		const window = closes.slice(-20); // recent average over up to 20 closes
		const avg = window.reduce((s, p) => s + p, 0) / window.length;
		return { last: closes[closes.length - 1], avg };
	};
	return http
		.sendRequest(
			runtime,
			fetch,
			ConsensusAggregationByFields<PriceStats>({ last: median, avg: median }),
		)()
		.result();
}

// ACCUMULATE rule: buy when last <= avg * (1 + band). Returns true to swap, false to hold.
function shouldAccumulate(stats: PriceStats, bandBps: number): boolean {
	const ceiling = stats.avg * (1 + bandBps / 10_000);
	return stats.last <= ceiling;
}

// Serve ONE registered vault: strategy decision -> (if buy) live quote -> consensus min-out ->
// Action -> writeReport. Throws on any failure for this vault; the caller catches so other
// vaults are unaffected.
function serveVault(
	runtime: Runtime<Config>,
	cfg: Config,
	evm: EVMClient,
	http: InstanceType<typeof cre.capabilities.HTTPClient>,
	apiKey: string,
	e: Entry,
	stats: PriceStats,
): Record<string, unknown> {
	const amountIn = e.amountIn;

	// Gap 7: act on the strategy's decision instead of always swapping.
	const bandBps = cfg.accumulateBandBps ?? 50;
	if (!shouldAccumulate(stats, bandBps)) {
		runtime.log(
			`vault ${e.vault}: strategy hold/skip — last=${stats.last} > avg*(1+${bandBps}bps)=${(
				stats.avg *
				(1 + bandBps / 10_000)
			).toFixed(2)}`,
		);
		return {
			vault: e.vault,
			decision: "hold",
			last: stats.last,
			avg: stats.avg,
			txHash: null,
			error: null,
		};
	}
	runtime.log(`vault ${e.vault}: strategy BUY — last=${stats.last} <= avg*(1+${bandBps}bps)`);

	const fetchQuote = (sendRequester: HTTPSendRequester): QuoteNumerics => {
		const reqBody = {
			type: "EXACT_INPUT",
			amount: amountIn.toString(),
			tokenInChainId: cfg.quoteChainId,
			tokenOutChainId: cfg.quoteChainId,
			tokenIn: e.tokenIn,
			tokenOut: e.tokenOut,
			swapper: e.vault,
			slippageTolerance: Number(e.slippageBps) / 100,
			protocols: ["V3"],
		};
		const resp = sendRequester
			.sendRequest({
				method: "POST",
				url: `${cfg.tradeApiBase}/quote`,
				headers: { "x-api-key": apiKey, "content-type": "application/json" },
				body: Buffer.from(JSON.stringify(reqBody)).toString("base64"),
			})
			.result();
		if (resp.statusCode !== 200) throw new Error(`/quote HTTP ${resp.statusCode}`);
		const j = JSON.parse(Buffer.from(resp.body).toString("utf-8"));
		if (j.routing !== "CLASSIC") throw new Error(`routing ${j.routing} != CLASSIC`);
		const out = j.quote && j.quote.output;
		if (!out || !out.minimumAmount || !out.amount) throw new Error("missing quote.output amounts");
		// raw wei as numbers (exact < 2^53 — fine for demo sizes); median, then back to wei.
		return { minOut: Number(out.minimumAmount), expectedOut: Number(out.amount) };
	};

	const q = http
		.sendRequest(
			runtime,
			fetchQuote,
			ConsensusAggregationByFields<QuoteNumerics>({ minOut: median, expectedOut: median }),
		)()
		.result();

	const minOutWei = BigInt(Math.round(q.minOut));
	const deadline = BigInt(Math.floor(Date.now() / 1000) + cfg.deadlineSeconds);
	const nonce = keccak256(
		concatHex([e.vault, numberToHex(amountIn, { size: 32 }), numberToHex(deadline, { size: 32 })]),
	);
	const urData = buildUniversalRouterCalldata(
		e.tokenIn,
		e.fee,
		e.tokenOut,
		e.vault,
		amountIn,
		minOutWei,
		deadline,
	);
	const payload = encodeAbiParameters(parseAbiParameters(ACTION_ABI), [
		cfg.router,
		urData,
		0n,
		minOutWei,
		deadline,
		e.tokenIn,
		e.tokenOut,
		amountIn,
		nonce,
		e.strategyId,
	]);

	const signed = runtime.report(prepareReportRequest(payload)).result();
	const reply = evm
		.writeReport(runtime, {
			receiver: e.vault,
			report: signed,
			gasConfig: { gasLimit: cfg.gasLimit },
		})
		.result();
	const txHash = reply.txHash ? toHex(reply.txHash) : null;
	runtime.log(`vault ${e.vault}: minOut=${minOutWei} tx=${txHash ?? "n/a"} err=${reply.errorMessage ?? "n/a"}`);
	return {
		vault: e.vault,
		decision: "buy",
		minOutWei: minOutWei.toString(),
		txHash,
		error: reply.errorMessage ?? null,
	};
}

// --- CRON handler — fan out over every registered vault ---------------------
export const onTick = (runtime: Runtime<Config>): string => {
	const cfg = runtime.config;
	const apiKey = runtime.getSecret({ id: "UNISWAP_API_KEY" }).result().value;

	const selectors = EVMClient.SUPPORTED_CHAIN_SELECTORS;
	const sel = selectors[cfg.chainSelectorName as keyof typeof selectors];
	if (sel === undefined) throw new Error(`unsupported chainSelectorName: ${cfg.chainSelectorName}`);
	const evm = new EVMClient(sel);
	const http = new cre.capabilities.HTTPClient();

	// 1. Read the registry: who is active this tick. Read at LATEST (not finalized) so a
	//    just-registered vault is visible immediately — Base finality lags ~minutes, which would
	//    otherwise hide fresh registrations. Trade-off: nodes could momentarily disagree at the
	//    chain head; acceptable for an infrequently-changing registry (tighten to finalized for
	//    stricter consensus, accepting the lag).
	const listCall = encodeFunctionData({
		abi: REGISTRY_ABI,
		functionName: "listActive",
		args: [BigInt(cfg.maxVaults)],
	});
	const raw = evm
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: cfg.registry, data: listCall }),
			blockNumber: LATEST_BLOCK_NUMBER,
		})
		.result();
	const entries = decodeFunctionResult({
		abi: REGISTRY_ABI,
		functionName: "listActive",
		data: bytesToHex(raw.data),
	}) as readonly Entry[];

	runtime.log(`registry ${cfg.registry}: ${entries.length} active vault(s)`);

	// 2. Compute the strategy decision ONCE per tick from a consensus price series (shared by
	//    all vaults — saves HTTP quota vs per-vault). If the series can't be fetched we skip the
	//    whole tick rather than swap blindly (fail-closed: hold beats an uninformed trade).
	let stats: PriceStats;
	try {
		stats = fetchPriceStats(runtime, cfg, http);
		runtime.log(`strategy price: last=${stats.last} avg=${stats.avg}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		runtime.log(`strategy: hold/skip all — price series unavailable: ${message}`);
		return JSON.stringify({
			registry: cfg.registry,
			servedVaults: entries.length,
			decision: "hold",
			error: message,
			results: [],
		});
	}

	// 3. Serve each vault independently; one failure never blocks the others.
	const results: Record<string, unknown>[] = [];
	for (const e of entries) {
		try {
			results.push(serveVault(runtime, cfg, evm, http, apiKey, e, stats));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			runtime.log(`vault ${e.vault}: skipped — ${message}`);
			results.push({ vault: e.vault, error: message });
		}
	}

	return JSON.stringify({ registry: cfg.registry, servedVaults: entries.length, results });
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
