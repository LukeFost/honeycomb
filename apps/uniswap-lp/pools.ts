// ============================================================================
// Pool registry — REAL, confirmed-existing Uniswap V3 pools per chain.
//
// The LP API's `existingPool` requires a real `poolReference` (the pool
// contract address); {token0,token1,fee} alone is rejected with HTTP 400
// "pool does not match any of the allowed types". So a decision references a
// pool by a short key, and we look up the verified addresses here.
//
// Every entry below was probed against https://liquidity.api.uniswap.org and
// returned HTTP 200 (a real signable tx) unless noted. See the memory note
// "uniswap-lp-api-working-shape" for the raw probe results.
// ============================================================================

import type { FeeTier, Token } from "./decision.ts";

export type PoolEntry = {
	chainId: number;
	chainName: string;
	/** Pool contract address (the `poolReference` sent to the API). */
	poolReference: `0x${string}`;
	token0: Token;
	token1: Token;
	fee: FeeTier;
	/** The chain's V3 NonfungiblePositionManager (the API-returned `create.to`). */
	positionManager: `0x${string}`;
	/** true = probed and returned HTTP 200 with a real tx. */
	verified200: boolean;
};

// --- Unichain Sepolia (1301) — PICKED: Uniswap's native testnet. -------------
// unione/WETH 0.3%, confirmed by GeckoTerminal, probed -> HTTP 200.
const UNICHAIN_SEPOLIA_UNIONE_WETH: PoolEntry = {
	chainId: 1301,
	chainName: "Unichain Sepolia",
	poolReference: "0xef77b99870e7e08c6efae55e68fd0c48c1597876",
	token0: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
	token1: { address: "0x31d0220469e10c4E71834a79b1f276d740d3768F", symbol: "USDC", decimals: 6 },
	fee: 3000,
	positionManager: "0xB7F724d6dDDFd008eFf5cc2834edDE5F9eF0d075",
	verified200: true,
};

// --- Ethereum Sepolia (11155111) — SAFE FALLBACK: most liquidity/faucets. -----
// USDC/WETH 0.05%, indexed by GeckoTerminal, probed -> HTTP 200.
const ETH_SEPOLIA_USDC_WETH: PoolEntry = {
	chainId: 11155111,
	chainName: "Ethereum Sepolia",
	poolReference: "0x3289680dd4d6c10bb19b899729cda5eef58aeff1",
	token0: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", symbol: "USDC", decimals: 6 },
	token1: { address: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", symbol: "WETH", decimals: 18 },
	fee: 500,
	positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
	verified200: true,
};

/** Registry keyed by a short, stable name a decision can reference. */
export const POOLS: Record<string, PoolEntry> = {
	"unichain-sepolia/weth-usdc-0.3": UNICHAIN_SEPOLIA_UNIONE_WETH,
	"eth-sepolia/usdc-weth-0.05": ETH_SEPOLIA_USDC_WETH,
};

/** Default pool per chainId (what the demo / a bare decision uses). */
export const DEFAULT_POOL_BY_CHAIN: Record<number, string> = {
	1301: "unichain-sepolia/weth-usdc-0.3",
	11155111: "eth-sepolia/usdc-weth-0.05",
};

export function poolForChain(chainId: number): PoolEntry {
	const key = DEFAULT_POOL_BY_CHAIN[chainId];
	if (!key) {
		throw new Error(
			`no registered pool for chainId ${chainId}. ` +
				`Known chains: ${Object.keys(DEFAULT_POOL_BY_CHAIN).join(", ")}`,
		);
	}
	return POOLS[key];
}
