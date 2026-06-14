#!/usr/bin/env bun
// ============================================================================
// Demo: feed one generalized LPDecision through executeLPDecision against a
// testnet and print the real unsigned tx the Uniswap LP API returns.
//
//   bun apps/uniswap-lp/demo.ts                  # Unichain Sepolia (default)
//   bun apps/uniswap-lp/demo.ts 11155111         # Ethereum Sepolia
//
// Simulate-only: nothing is signed or broadcast. The printed `to`/`data` IS
// the qualifying artifact — sign + broadcast it to get a real tx hash.
// ============================================================================

import type { LPDecision } from "./decision.ts";
import { executeLPDecision } from "./executor.ts";
import { poolForChain } from "./pools.ts";

const chainId = Number(process.argv[2] ?? 1301);
// A throwaway address is fine for simulate; the API builds calldata for it but
// nothing is signed. Replace with your funded address before broadcasting.
const walletAddress = (process.argv[3] ??
	"0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421") as `0x${string}`;

const pool = poolForChain(chainId);

// The generalized strategy output. A grader would produce/score this shape.
const decision: LPDecision = {
	action: "provide",
	pair: { token0: pool.token0, token1: pool.token1 },
	fee: pool.fee,
	range: "full", // simple, general; concentrated ranges also supported
	// 0.001 of the independent token (token0). Raw units per token0 decimals.
	amount: pool.token0.decimals === 18 ? "1000000000000000" : "1000",
	independentSide: "token0",
};

console.error(`\n[demo] chain ${chainId} (${pool.chainName})`);
console.error(`[demo] pool ${pool.poolReference}  ${pool.token0.symbol}/${pool.token1.symbol} ${pool.fee / 10000}%`);
console.error(`[demo] decision:`, JSON.stringify(decision, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

const result = await executeLPDecision(decision, {
	chainId,
	walletAddress,
	mode: "simulate",
});

console.log("\n=== REAL unsigned LP transaction from the Uniswap LP API ===");
console.log("chain:        ", result.chainId, `(${result.pool.chainName})`);
console.log("to:           ", result.unsignedTx.to, "(V3 PositionManager)");
console.log("value:        ", result.unsignedTx.value ?? "0x00");
console.log("gasLimit:     ", result.unsignedTx.gasLimit ?? "(estimate at broadcast)");
console.log("ticks:        ", result.ticks.tickLower, "->", result.ticks.tickUpper, "(full range)");
console.log("calldata len: ", result.unsignedTx.data.length, "hex chars");
console.log("selector:     ", result.decoded.selector, "-", result.decoded.note);
console.log("\nNext: sign this tx with a funded", result.pool.chainName, "wallet and broadcast.");
console.log("The broadcast hash is the prize's qualifying onchain transaction ID.\n");
