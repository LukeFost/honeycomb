#!/usr/bin/env bun
// ============================================================================
// broadcast-fork.ts — take the first REAL swing at an LP mint.
//
// Proves the full path end to end against a LOCAL ANVIL FORK of a real testnet:
//   LPDecision -> executeLPDecision (real Uniswap LP API) -> unsigned mint tx
//   -> ERC-20 approvals -> SIGN -> BROADCAST -> real tx hash + receipt.
//
// The fork is a real copy of testnet state (real pool, real tokens), so the
// mint really executes and emits a real position. The only difference from
// public testnet is the chain is local — no faucet, no private key handling.
// Signer is anvil's well-known account 0 (a PUBLIC test key, not a secret).
//
//   1) anvil --fork-url <sepolia-rpc> --chain-id 11155111 --port 8545
//   2) fund the signer's WETH:  cast send <WETH> 'deposit()' --value 1ether ...
//   3) bun broadcast-fork.ts
// ============================================================================

import {
	createWalletClient,
	createPublicClient,
	http,
	parseAbi,
	type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LPDecision } from "./decision.ts";
import { executeLPDecision } from "./executor.ts";
import { poolForChain } from "./pools.ts";
import { SEPOLIA_RPC } from "@honeycomb/chain/sepolia";

// FORK_RPC wins (point at a local `anvil --fork-url` for fork mode). Unset ->
// the shared canonical Sepolia RPC, so this can also swing at LIVE Sepolia.
// NOTE: live mode needs a FUNDED key; the anvil test key below only works on a
// fork. Override the signer before broadcasting against live Sepolia.
const RPC = process.env.FORK_RPC ?? SEPOLIA_RPC;
const CHAIN_ID = Number(process.env.FORK_CHAIN_ID ?? 11155111);
// anvil account 0 — a PUBLIC, well-known test key. Never a real secret.
const ANVIL_PK0 =
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const account = privateKeyToAccount(ANVIL_PK0);
const localChain = {
	id: CHAIN_ID,
	name: "anvil-fork",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } },
} as const;

const wallet = createWalletClient({ account, chain: localChain, transport: http(RPC) });
const pub = createPublicClient({ chain: localChain, transport: http(RPC) });

const pool = poolForChain(CHAIN_ID);

const erc20 = parseAbi([
	"function balanceOf(address) view returns (uint256)",
	"function allowance(address,address) view returns (uint256)",
	"function approve(address,uint256) returns (bool)",
]);

const MAX = (2n ** 256n - 1n) as bigint;

async function main() {
	console.log(`\n[fork] rpc=${RPC} chain=${CHAIN_ID} signer=${account.address}`);
	console.log(`[fork] pool ${pool.poolReference} ${pool.token0.symbol}/${pool.token1.symbol} ${pool.fee / 10000}%`);

	// 1) Get the REAL unsigned mint tx from the Uniswap LP API, for our signer.
	const decision: LPDecision = {
		action: "provide",
		pair: { token0: pool.token0, token1: pool.token1 },
		fee: pool.fee,
		range: "full",
		// commit a small amount of token0 (USDC, 6dp) -> 5 USDC
		amount: "5000000",
		independentSide: "token0",
	};
	const sim = await executeLPDecision(decision, {
		chainId: CHAIN_ID,
		walletAddress: account.address,
		mode: "simulate",
	});
	const tx = sim.unsignedTx;
	console.log(`[api] unsigned mint -> to=${tx.to} dataLen=${tx.data.length} ticks=${sim.ticks.tickLower}..${sim.ticks.tickUpper}`);

	const positionManager = tx.to;

	// 2) Approve BOTH tokens to the PositionManager (mint pulls both sides).
	for (const t of [pool.token0, pool.token1]) {
		const bal = await pub.readContract({ address: t.address, abi: erc20, functionName: "balanceOf", args: [account.address] });
		console.log(`[bal] ${t.symbol}: ${bal}`);
		const cur = await pub.readContract({ address: t.address, abi: erc20, functionName: "allowance", args: [account.address, positionManager] });
		if (cur < MAX / 2n) {
			const h = await wallet.writeContract({ address: t.address, abi: erc20, functionName: "approve", args: [positionManager, MAX] });
			await pub.waitForTransactionReceipt({ hash: h });
			console.log(`[approve] ${t.symbol} -> ${positionManager}  (${h})`);
		}
	}

	// 3) SIGN + BROADCAST the real mint tx the API gave us.
	console.log(`\n[broadcast] sending mint...`);
	const hash = await wallet.sendTransaction({
		to: tx.to,
		data: tx.data,
		value: BigInt(tx.value ?? "0x0"),
		// let the node estimate gas; the API gasLimit (if any) is a hint
	});
	console.log(`[broadcast] tx hash = ${hash}`);

	const receipt = await pub.waitForTransactionReceipt({ hash });
	console.log(`\n=== MINT RECEIPT ===`);
	console.log(`status:       ${receipt.status}`);
	console.log(`block:        ${receipt.blockNumber}`);
	console.log(`gasUsed:      ${receipt.gasUsed}`);
	console.log(`tx hash:      ${receipt.transactionHash}`);
	console.log(`logs:         ${receipt.logs.length} events emitted`);
	// The PositionManager emits an IncreaseLiquidity + ERC721 Transfer (the NFT).
	const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
	const nftMint = receipt.logs.find(
		(l) => l.address.toLowerCase() === positionManager.toLowerCase() && l.topics[0] === transferTopic,
	);
	if (nftMint) {
		const tokenId = BigInt(nftMint.topics[3] ?? "0x0");
		console.log(`position NFT: tokenId ${tokenId} minted to ${account.address}`);
	}
	if (receipt.status !== "success") {
		throw new Error("mint reverted onchain");
	}
	console.log(`\nREAL LP position minted on the fork. tx hash above is a real onchain transaction ID.\n`);
}

main().catch((e) => {
	console.error("\n[FAIL]", e instanceof Error ? e.message : e);
	process.exit(1);
});
