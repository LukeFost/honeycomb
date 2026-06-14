// ============================================================================
// Relayer signer for the self-hosted x402 facilitator.
//
// The facilitator is the party that SETTLES on-chain: it calls
// USDC.transferWithAuthorization(...) and PAYS THE GAS. The buyer only signs
// EIP-3009 typed data in MetaMask; they never send a transaction. So the
// relayer EOA loaded here is the gas-paying wallet -- it needs native ETH on
// whatever chain we settle on (Base Sepolia for the testnet proof, ETH L1 for
// the real demo).
//
// We build a viem walletClient (account + chain + transport) extended with
// publicActions (so it can readContract / verifyTypedData / waitForReceipt /
// getCode), then wrap it with the x402 library's own `toFacilitatorEvmSigner`,
// which adds the `getAddresses()` shim the facilitator expects. We deliberately
// do NOT hand-roll the FacilitatorEvmSigner surface -- using the library's
// adapter keeps us bound to its verified contract.
// ============================================================================

import {
	createWalletClient,
	http,
	publicActions,
	type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, baseSepolia, sepolia, base } from "viem/chains";
import { toFacilitatorEvmSigner } from "@x402/evm";

/** CAIP-2 network id -> viem chain. Extend as we add settlement targets. */
const CHAIN_BY_NETWORK: Record<string, Chain> = {
	"eip155:1": mainnet,
	"eip155:8453": base,
	"eip155:84532": baseSepolia,
	"eip155:11155111": sepolia,
};

export function chainForNetwork(network: string): Chain {
	const chain = CHAIN_BY_NETWORK[network];
	if (!chain) {
		throw new Error(
			`No viem chain mapped for network "${network}". ` +
				`Known: ${Object.keys(CHAIN_BY_NETWORK).join(", ")}.`,
		);
	}
	return chain;
}

/**
 * A CAIP-2 chain id, e.g. "eip155:1". This is the exact template-literal type
 * @x402's registerExactEvmScheme expects for `networks`, so narrowing to it lets
 * us pass env-derived strings honestly (no blind cast): `parseCaip2List` below
 * validates the shape at runtime before the type narrows.
 */
export type Caip2 = `${string}:${string}`;

/** True iff `s` is a non-empty "namespace:reference" pair (CAIP-2 shape). */
function isCaip2(s: string): s is Caip2 {
	const i = s.indexOf(":");
	// One colon, with a non-empty namespace and a non-empty reference.
	return i > 0 && i < s.length - 1 && s.indexOf(":", i + 1) === -1;
}

/**
 * Split a comma-separated env value into validated CAIP-2 ids. Throws loudly on
 * an empty list or any malformed entry rather than casting blindly -- a bad
 * network string would otherwise surface as an opaque scheme-registration error.
 */
export function parseCaip2List(raw: string | undefined, fallback: string): Caip2[] {
	const parts = (raw ?? fallback)
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean);
	if (parts.length === 0) {
		throw new Error("No networks configured. Set e.g. NETWORKS=eip155:84532 or eip155:1.");
	}
	const bad = parts.filter((p) => !isCaip2(p));
	if (bad.length > 0) {
		throw new Error(
			`Malformed CAIP-2 network id(s): ${bad.join(", ")}. ` +
				`Expected "namespace:reference", e.g. eip155:1.`,
		);
	}
	return parts as Caip2[];
}

/**
 * Read the relayer private key. Env wins (for CI / the CS box, which has no
 * macOS Keychain); otherwise fall back to the login Keychain via `security`.
 * The value is used in-process only -- never logged, never returned by an
 * endpoint. Honest failure: if neither source has it, THROW (no silent default
 * key, which would settle from the wrong wallet or with no funds).
 */
export function loadRelayerKey(): `0x${string}` {
	const fromEnv = process.env.RELAYER_PRIVATE_KEY?.trim();
	if (fromEnv) return normalizePk(fromEnv, "env RELAYER_PRIVATE_KEY");

	const service = process.env.RELAYER_KEYCHAIN_SERVICE?.trim() || "rfq-cfd-deployer-pk";
	const proc = Bun.spawnSync([
		"security",
		"find-generic-password",
		"-a",
		process.env.USER ?? "",
		"-s",
		service,
		"-w",
	]);
	const fromKeychain = new TextDecoder().decode(proc.stdout).trim();
	if (fromKeychain) return normalizePk(fromKeychain, `Keychain service "${service}"`);

	throw new Error(
		`Relayer key not found. Set RELAYER_PRIVATE_KEY env, or store it in the ` +
			`login Keychain under service "${service}" (override with ` +
			`RELAYER_KEYCHAIN_SERVICE). The relayer is the gas-paying settlement wallet.`,
	);
}

function normalizePk(raw: string, source: string): `0x${string}` {
	const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
	if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(`Relayer key from ${source} is not a 32-byte hex private key.`);
	}
	return hex as `0x${string}`;
}

/** Resolve an RPC URL for a network: env override -> viem chain default. */
export function rpcForNetwork(network: string, chain: Chain): string | undefined {
	// Per-network override, e.g. RPC_URL_EIP155_1 ; then a generic RPC_URL.
	const key = `RPC_URL_${network.replace(/[:]/g, "_").toUpperCase()}`;
	return process.env[key]?.trim() || process.env.RPC_URL?.trim() || undefined;
}

/**
 * Build the FacilitatorEvmSigner the x402 ExactEvmScheme needs, bound to one
 * settlement network. Returns the signer plus the relayer address so callers
 * can log/fund-check it.
 */
export function buildFacilitatorSigner(network: string) {
	const chain = chainForNetwork(network);
	const account = privateKeyToAccount(loadRelayerKey());
	const rpcUrl = rpcForNetwork(network, chain);

	const walletClient = createWalletClient({
		account,
		chain,
		transport: http(rpcUrl), // undefined -> viem uses the chain's default public RPC
	}).extend(publicActions);

	// The wallet client already has the address, readContract, verifyTypedData,
	// writeContract, sendTransaction, waitForTransactionReceipt, getCode. The
	// adapter wraps the single `.account.address` into getAddresses().
	const signer = toFacilitatorEvmSigner({
		...walletClient,
		address: account.address,
	} as never);

	return { signer, address: account.address, chain, rpcUrl };
}
