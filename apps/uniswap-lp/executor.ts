// ============================================================================
// executeLPDecision — the generalized LP execution capability.
//
// Given an abstract LPDecision, turn it into a real Uniswap liquidity position
// via the Uniswap Developer Platform LP API. Knows nothing about Honeycomb,
// CRE, or any specific caller — a grader (or anything) imports this.
//
//   mode "simulate" -> POST /lp/create, return the UNSIGNED tx + decoded view. STOP.
//   mode "execute"  -> additionally sign + broadcast. Returns the tx hash.
//                      (guarded: requires an explicit signing key; off by default)
//
// The unsigned tx the API returns is the prize's qualifying artifact: sign it,
// broadcast it, and the resulting hash is a real onchain transaction ID.
// ============================================================================

import { decodeFunctionData, type Hex } from "viem";
import {
	type LPDecision,
	resolveTicks,
} from "./decision.ts";
import { poolForChain, type PoolEntry } from "./pools.ts";

const LP_API_BASE = "https://liquidity.api.uniswap.org";

/** Unsigned transaction the LP API returns. You sign + broadcast this. */
export type TransactionRequest = {
	to: `0x${string}`;
	data: Hex;
	value?: string;
	chainId?: number;
	gasLimit?: string;
	maxFeePerGas?: string;
	maxPriorityFeePerGas?: string;
	from?: `0x${string}`;
};

export type ExecuteMode = "simulate" | "execute";

export type ExecuteOptions = {
	chainId: number;
	walletAddress: `0x${string}`;
	mode: ExecuteMode;
	/** Override the registry pool; otherwise the chain's default pool is used. */
	pool?: PoolEntry;
};

export type SimulateResult = {
	mode: "simulate";
	chainId: number;
	pool: PoolEntry;
	ticks: { tickLower: number; tickUpper: number };
	unsignedTx: TransactionRequest;
	/** Human-readable decode of the calldata (best-effort). */
	decoded: { selector: string; note: string };
	/** Echo of the API's range echo, if present. */
	priceRange?: { minPrice?: string; maxPrice?: string };
};

export type ExecuteResult = SimulateResult & {
	mode: "execute";
	txHash: `0x${string}`;
};

/** Pull the API key from macOS Keychain. Never logged, never returned. */
function getApiKey(): string {
	// Bun: spawn `security` synchronously. The value is used in-process only.
	const proc = Bun.spawnSync([
		"security",
		"find-generic-password",
		"-a",
		process.env.USER ?? "",
		"-s",
		"uniswap_api_key",
		"-w",
	]);
	const key = new TextDecoder().decode(proc.stdout).trim();
	if (!key) {
		throw new Error(
			"uniswap_api_key not found in Keychain. Store it with the keychain-secret skill.",
		);
	}
	return key;
}

/** Map a generalized LPDecision -> the verified /lp/create request body. */
function buildCreateBody(decision: LPDecision, opts: ExecuteOptions, pool: PoolEntry) {
	if (decision.action !== "provide") {
		// increase/decrease/claim use different endpoints; provide is the create path.
		throw new Error(
			`executor currently renders action "provide" via /lp/create; ` +
				`got "${decision.action}" (increase/decrease/claim are separate endpoints).`,
		);
	}
	const ticks = resolveTicks(decision);
	const independentSide = decision.independentSide ?? "token0";
	const independentToken =
		independentSide === "token0" ? pool.token0.address : pool.token1.address;

	return {
		body: {
			walletAddress: opts.walletAddress,
			chainId: opts.chainId,
			protocol: "V3" as const,
			existingPool: {
				token0Address: pool.token0.address,
				token1Address: pool.token1.address,
				poolReference: pool.poolReference,
			},
			independentToken: {
				tokenAddress: independentToken,
				amount: decision.amount,
			},
			// VERIFIED shape: tickBounds, NOT priceBounds. See memory note.
			tickBounds: { tickLower: ticks.tickLower, tickUpper: ticks.tickUpper },
			simulateTransaction: false,
		},
		ticks,
	};
}

// Minimal ABI fragment for the V3 PositionManager mint, for a friendly decode.
const MINT_ABI = [
	{
		type: "function",
		name: "mint",
		stateMutability: "payable",
		inputs: [
			{
				name: "params",
				type: "tuple",
				components: [
					{ name: "token0", type: "address" },
					{ name: "token1", type: "address" },
					{ name: "fee", type: "uint24" },
					{ name: "tickLower", type: "int24" },
					{ name: "tickUpper", type: "int24" },
					{ name: "amount0Desired", type: "uint256" },
					{ name: "amount1Desired", type: "uint256" },
					{ name: "amount0Min", type: "uint256" },
					{ name: "amount1Min", type: "uint256" },
					{ name: "recipient", type: "address" },
					{ name: "deadline", type: "uint256" },
				],
			},
		],
		outputs: [],
	},
] as const;

function decodeCalldata(data: Hex): { selector: string; note: string } {
	const selector = data.slice(0, 10);
	try {
		const d = decodeFunctionData({ abi: MINT_ABI, data });
		return { selector, note: `decoded as ${d.functionName}(...)` };
	} catch {
		// Many LP txs are multicall-wrapped; a clean mint decode isn't guaranteed.
		return { selector, note: "calldata not a bare mint() (likely multicall-wrapped)" };
	}
}

/**
 * Render a generalized LPDecision into a real Uniswap LP transaction.
 * In "simulate" mode (default-safe) returns the unsigned tx and stops.
 */
export async function executeLPDecision(
	decision: LPDecision,
	opts: ExecuteOptions,
): Promise<SimulateResult | ExecuteResult> {
	const pool = opts.pool ?? poolForChain(opts.chainId);
	const { body, ticks } = buildCreateBody(decision, opts, pool);

	const apiKey = getApiKey();
	// The upstream gateway intermittently 504s. Retry ONLY transient 5xx, with
	// backoff. Any non-5xx error (and a persistent 5xx) still throws loudly.
	let resp: Response | undefined;
	let lastErr = "";
	for (let attempt = 1; attempt <= 4; attempt++) {
		resp = await fetch(`${LP_API_BASE}/lp/create`, {
			method: "POST",
			headers: { "x-api-key": apiKey, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (resp.ok) break;
		if (resp.status < 500) break; // client error: don't retry, fall through to throw
		lastErr = `HTTP ${resp.status}`;
		if (attempt < 4) {
			console.error(`[lp/create] ${lastErr} (transient), retry ${attempt}/3...`);
			await new Promise((r) => setTimeout(r, 1500 * attempt));
		}
	}

	if (!resp || !resp.ok) {
		const text = resp ? await resp.text() : lastErr;
		// Surface the real error loudly. No silent fallback.
		throw new Error(`/lp/create HTTP ${resp?.status ?? "?"}: ${text.slice(0, 500)}`);
	}

	const json = (await resp.json()) as {
		create: TransactionRequest;
		minPrice?: string;
		maxPrice?: string;
	};
	const unsignedTx = json.create;

	const sim: SimulateResult = {
		mode: "simulate",
		chainId: opts.chainId,
		pool,
		ticks,
		unsignedTx,
		decoded: decodeCalldata(unsignedTx.data),
		priceRange: { minPrice: json.minPrice, maxPrice: json.maxPrice },
	};

	if (opts.mode === "simulate") return sim;

	// --- execute mode: sign + broadcast. Guarded; off until a key is supplied. ---
	throw new Error(
		"execute mode requires a testnet signing key (uniswap_testnet_pk) which is " +
			"not configured. Staying simulate-only by design. Supply a key and wire " +
			"the sign+broadcast block to enable broadcast.",
	);
}
