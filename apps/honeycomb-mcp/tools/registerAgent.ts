// ============================================================================
// register_agent: mint an ERC-8004 agent identity on the live registry.
//
// An agent must exist in the ERC-8004 Identity Registry before it can submit to a
// bounty — the escrow's submit() requires msg.sender == getAgentWallet(agentId), so
// the agent needs an agentId whose wallet IS its own signing key. The registry is an
// ERC-721: register() mints a fresh agent NFT to msg.sender, and the minting wallet
// becomes that agent's wallet (getAgentWallet(agentId) == msg.sender). So registering
// is one real on-chain tx, signed by the key the agent will later submit with.
//
// This tool, in plain steps:
//   1. build the signer  — from SEP_PRIVATE_KEY (the MCP's configured key) by default
//   2. PRE-CHECK gas      — read the signer's balance on the SELECTED chain and abort
//                          BEFORE broadcasting if it can't cover a register() tx.
//                          On mainnet a register with no ETH would just revert and
//                          burn nothing, but failing loud here (with the funding
//                          address) beats a cryptic on-chain revert.
//   3. register on-chain  — register() (or register(tokenURI) if a domain is given);
//                          mints the agent NFT to the signer.
//   4. read back the id   — parse the Registered event from the receipt for the new
//                          agentId, then confirm getAgentWallet(agentId) == signer so
//                          the caller KNOWS the identity is submit-ready, not just minted.
//
// Per the repo's loud-failure rule, an unfunded signer / a missing key / a receipt
// with no Registered event all THROW with an actionable message — never a silent
// "registered" with a bogus id.
// ============================================================================

import { decodeEventLog, formatEther, type Hex } from "viem";
import { readContract } from "viem/actions";
import {
	CHAIN,
	MAINNET,
	IDENTITY_REGISTRY,
	IDENTITY_ABI,
	publicClient,
	walletFromKey,
} from "../chain.ts";

// The agent's signing key. Same resolution the submit() leg uses: the agent's OWN
// key (SUBMIT_PRIVATE_KEY) if set, else the MCP's configured SEP_PRIVATE_KEY — so a
// single-key dev setup registers and submits under one identity. No key -> throw.
const REGISTER_KEY = process.env.SUBMIT_PRIVATE_KEY ?? process.env.SEP_PRIVATE_KEY;

// A register() tx is a single SSTORE-heavy ERC-721 mint; ~200k gas is a safe ceiling.
// We require the signer's balance to cover (GAS_CEILING * the current base+priority
// fee) before broadcasting, so we abort on a definitely-can't-pay signer instead of
// sending a tx that reverts for out-of-gas.
const GAS_CEILING = 250_000n;

export const registerAgentInput = {
	tokenURI: {
		type: "string",
		description:
			"Optional agent metadata URI / domain recorded on-chain at mint (ERC-8004 register(string)). Omit to mint a bare identity with no URI (register()).",
	},
} as const;

export async function registerAgent(args: { tokenURI?: string } = {}) {
	// 1. Build the signer. Fail loud if there's no key — registering is a real tx.
	if (!REGISTER_KEY) {
		throw new Error(
			"cannot register an agent: set SUBMIT_PRIVATE_KEY (or SEP_PRIVATE_KEY) to the key the agent will sign with. register() mints the agent identity to msg.sender, so this key becomes the agent's wallet.",
		);
	}
	const { account, wallet } = walletFromKey(REGISTER_KEY, "SUBMIT_PRIVATE_KEY");

	// 2. Pre-check gas on the SELECTED chain (mainnet when HONEYCOMB_CHAIN=mainnet,
	//    else Sepolia). Surface the funding address so the operator can top it up.
	const balance = await publicClient.getBalance({ address: account.address });
	const fees = await publicClient.estimateFeesPerGas();
	const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
	const estCost = GAS_CEILING * maxFee;
	if (balance < estCost) {
		const net = MAINNET ? "mainnet" : "Sepolia";
		throw new Error(
			`signer ${account.address} has ${formatEther(balance)} ETH on ${net}, but registering needs ~${formatEther(estCost)} ETH for gas (${GAS_CEILING} gas @ ${formatEther(maxFee)} ETH/gas). Fund ${account.address} on ${net}${MAINNET ? " with real ETH" : " (Sepolia faucet)"} and retry — no tx was broadcast.`,
		);
	}

	// 3. Broadcast register(). With a tokenURI we use the register(string) overload so
	//    the metadata lands at mint; viem selects the overload by argument arity.
	const hash = args.tokenURI
		? await wallet.writeContract({
				address: IDENTITY_REGISTRY,
				abi: IDENTITY_ABI,
				functionName: "register",
				args: [args.tokenURI],
			})
		: await wallet.writeContract({
				address: IDENTITY_REGISTRY,
				abi: IDENTITY_ABI,
				functionName: "register",
				args: [],
			});
	// Wait for 2 confirmations, not just 1. The post-mint getAgentWallet read below
	// hits a load-balanced RPC endpoint, and a lagging read replica can still be one
	// block behind the block that mined the mint. An extra confirmation gives the
	// pool's replicas time to index the new state before we read it back.
	const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });

	// 4. Parse the Registered event for the minted agentId. The registry emits it from
	//    IDENTITY_REGISTRY; ignore any unrelated logs (a paymaster, a proxy admin).
	let agentId: string | undefined;
	for (const log of receipt.logs) {
		if (log.address.toLowerCase() !== IDENTITY_REGISTRY.toLowerCase()) continue;
		try {
			const ev = decodeEventLog({ abi: IDENTITY_ABI, data: log.data, topics: log.topics });
			if (ev.eventName === "Registered") {
				agentId = (ev.args as { agentId: bigint }).agentId.toString();
				break;
			}
		} catch {
			// not a Registered log (e.g. an ERC-721 Transfer); skip.
		}
	}
	if (!agentId) {
		throw new Error(
			`register() tx ${hash} confirmed but no Registered event was found in the receipt — cannot determine the minted agentId. Check the tx on the explorer.`,
		);
	}

	// Confirm the identity is submit-ready: getAgentWallet(agentId) must be the signer,
	// so a later submit(jobId, agentId, ...) from this key passes the escrow's
	// msg.sender == getAgentWallet check. If it isn't, say so loudly rather than imply
	// the agent can compete.
	//
	// But this read RACES the RPC pool's state indexing: even after several
	// confirmations a lagging read replica can return the zero address for a
	// just-minted agentId (observed on Sepolia 2026-06-14: agentId 6600 minted real
	// — getAgentWallet/ownerOf both returned the signer on a fresh read seconds later
	// — yet five back-to-back reads right after the mint all returned 0x0). So we
	// retry the read with backoff and only throw the "do not submit" error if it
	// STILL mismatches after the replicas have had a chance to catch up. This keeps
	// the loud-failure contract (a genuinely wrong wallet still throws) without
	// false-negativing a confirmed mint.
	//
	// Two things make the retry actually clear the lag:
	//   1. We re-fetch the chain head each attempt and pin the read to that explicit
	//      blockNumber. viem caches eth_call by request for ~cacheTime, so without an
	//      advancing block tag every retry could re-serve the same cached 0x0 instead
	//      of hitting the network — pinning to a fresh, advancing block busts that
	//      cache and forces a real read against newer state.
	//   2. A generous total budget (8 attempts x 3s) outlasts the observed lag, which
	//      exceeded a 5x1.5s window on this pool.
	const READ_ATTEMPTS = 8;
	const READ_BACKOFF_MS = 3_000;
	let registeredWallet: `0x${string}` = "0x0000000000000000000000000000000000000000";
	let walletMatches = false;
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		const blockNumber = await publicClient.getBlockNumber();
		registeredWallet = (await readContract(publicClient, {
			address: IDENTITY_REGISTRY,
			abi: IDENTITY_ABI,
			functionName: "getAgentWallet",
			args: [BigInt(agentId)],
			blockNumber,
		})) as `0x${string}`;
		walletMatches = registeredWallet.toLowerCase() === account.address.toLowerCase();
		if (walletMatches) break;
		// Mismatch (typically a lagging-replica 0x0). Back off and re-read unless this
		// was the last attempt — the throw below handles a persistent mismatch.
		if (attempt < READ_ATTEMPTS) {
			await new Promise((resolve) => setTimeout(resolve, READ_BACKOFF_MS));
		}
	}
	if (!walletMatches) {
		throw new Error(
			`registered agentId ${agentId}, but getAgentWallet(${agentId}) is ${registeredWallet} after ${READ_ATTEMPTS} reads, not the signer ${account.address}. submit() would revert "not agent wallet". This is unexpected for a fresh mint — do not submit under this id. (Verify on the explorer: the mint tx ${hash} may have landed even if this read lags.)`,
		);
	}

	return {
		agentId,
		wallet: account.address,
		registry: IDENTITY_REGISTRY,
		chain: CHAIN.name,
		chainId: CHAIN.id,
		tokenURI: args.tokenURI ?? null,
		txHash: hash as Hex,
		summary: `Registered as agentId ${agentId} on ${CHAIN.name}. Your wallet ${account.address} is the agent's registered wallet, so you can submit to bounties under this id. Tx ${hash}.`,
	};
}
