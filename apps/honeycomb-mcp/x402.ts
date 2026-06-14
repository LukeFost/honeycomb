// ============================================================================
// x402 settle client — the server-side leg of gasless bounty funding.
//
// A funder signs an EIP-3009 TransferWithAuthorization off-chain (no gas, no
// ETH). This helper hands that signed authorization to the self-hosted x402
// facilitator (apps/x402-facilitator), which RE-verifies it and broadcasts
// transferWithAuthorization with the relayer paying gas. The funder's USDC lands
// at `payTo` (the server's custodial wallet) with the funder never touching gas.
//
// The envelope shape is the one the @x402/evm ExactEvmScheme actually requires
// (proven e2e on Sepolia 2026-06-14, see apps/x402-facilitator/manual-fund-test.ts):
//   - paymentPayload embeds the requirements under `accepted`
//   - the value check reads requirements.amount (NOT maxAmountRequired) — set both
//   - extra.{name,version} drives the EIP-712 domain
//   - payload.payload.{signature,authorization} holds the signed EIP-3009 fields
//
// We talk to the facilitator over HTTP (same as apps/web summon) rather than
// importing @x402/* into the engine, so the engine stays dep-light and the
// facilitator can be a separately-deployed service.
// ============================================================================

import type { Address, Hex } from "viem";

// Facilitator base URL. Default matches apps/web (FACILITATOR_URL, :4021 local).
const FACILITATOR_URL = (process.env.FACILITATOR_URL ?? "http://localhost:4021").replace(/\/+$/, "");

const X402_VERSION = 2;

// CAIP-2 network for the settlement chain. Sepolia by default (the proven rail);
// the mainnet flip sets X402_NETWORK=eip155:1. Kept separate from HONEYCOMB_CHAIN
// so the funding chain and the escrow chain can be reasoned about independently.
export const X402_NETWORK = process.env.X402_NETWORK ?? "eip155:11155111";

// EIP-712 domain name+version of the funding token. MUST match the token's
// DOMAIN_SEPARATOR (MockUSDCv2 = "Mock USD Coin"/"2"). The facilitator rebuilds
// the domain from these to verify the funder's signature.
export const X402_TOKEN_NAME = process.env.X402_TOKEN_NAME ?? "Mock USD Coin";
export const X402_TOKEN_VERSION = process.env.X402_TOKEN_VERSION ?? "2";

// The EIP-3009 authorization a funder signs and echoes back at finalize. All
// numeric fields are decimal strings (uint256/bytes32 over JSON).
export type X402Authorization = {
	from: Address;
	to: Address;
	value: string;
	validAfter: string;
	validBefore: string;
	nonce: Hex;
};

// What a funder must sign: the EIP-712 typed-data the facilitator will verify.
// Returned by the draft so the funder (web button or agent) can sign without
// re-deriving the domain/types. Mirrors @x402/evm authorizationTypes.
export function transferAuthorizationTypedData(params: {
	token: Address;
	chainId: number;
	authorization: X402Authorization;
}) {
	return {
		domain: {
			name: X402_TOKEN_NAME,
			version: X402_TOKEN_VERSION,
			chainId: params.chainId,
			verifyingContract: params.token,
		},
		types: {
			TransferWithAuthorization: [
				{ name: "from", type: "address" },
				{ name: "to", type: "address" },
				{ name: "value", type: "uint256" },
				{ name: "validAfter", type: "uint256" },
				{ name: "validBefore", type: "uint256" },
				{ name: "nonce", type: "bytes32" },
			],
		},
		primaryType: "TransferWithAuthorization" as const,
		message: params.authorization,
	};
}

// Build the PaymentRequirements the facilitator checks the authorization against.
// `amount` is the load-bearing field (the value check); maxAmountRequired is set
// to the same value for spec-shape completeness.
export function buildPaymentRequirements(params: {
	token: Address;
	payTo: Address;
	amount: string; // 6-decimal token base units, decimal string
	resource: string;
	description: string;
}) {
	return {
		scheme: "exact",
		network: X402_NETWORK,
		asset: params.token,
		payTo: params.payTo,
		amount: params.amount,
		maxAmountRequired: params.amount,
		resource: params.resource,
		description: params.description,
		mimeType: "application/json",
		maxTimeoutSeconds: 120,
		extra: { name: X402_TOKEN_NAME, version: X402_TOKEN_VERSION },
	};
}

type FacResult = { status: number; json: any };

async function facPost(path: string, body: unknown): Promise<FacResult> {
	let res: Response;
	try {
		res = await fetch(`${FACILITATOR_URL}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (e) {
		// Network-level failure reaching the facilitator: surface it loudly rather
		// than letting a settle look like it just "didn't succeed".
		throw new Error(
			`x402 facilitator unreachable at ${FACILITATOR_URL}${path}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	const text = await res.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text.slice(0, 500) };
	}
	return { status: res.status, json };
}

// Verify + settle a signed EIP-3009 authorization through the facilitator. On
// success returns the real on-chain settlement tx hash. Throws (loud) on any
// invalid/failed step — NEVER returns a soft "didn't work" that a caller might
// mistake for a funded bounty.
export async function settleAuthorization(params: {
	requirements: ReturnType<typeof buildPaymentRequirements>;
	signature: Hex;
	authorization: X402Authorization;
}): Promise<{ transaction: Hex; payer: Address; amount: string }> {
	const paymentPayload = {
		x402Version: X402_VERSION,
		scheme: "exact",
		network: X402_NETWORK,
		accepted: params.requirements,
		payload: {
			signature: params.signature,
			authorization: params.authorization,
		},
	};
	const envelope = {
		x402Version: X402_VERSION,
		paymentPayload,
		paymentRequirements: params.requirements,
	};

	// 1) VERIFY — refuse to settle an authorization the facilitator rejects.
	const verify = await facPost("/verify", envelope);
	if (verify.status !== 200) {
		throw new Error(`facilitator /verify returned ${verify.status}: ${verify.json?.error ?? "unknown error"}`);
	}
	if (!verify.json?.isValid) {
		throw new Error(`payment authorization not valid: ${verify.json?.invalidReason ?? "unspecified"}`);
	}

	// 2) SETTLE — relayer broadcasts transferWithAuthorization, pays gas.
	const settle = await facPost("/settle", envelope);
	if (settle.status !== 200) {
		throw new Error(`facilitator /settle returned ${settle.status}: ${settle.json?.error ?? "unknown error"}`);
	}
	if (!settle.json?.success) {
		throw new Error(`payment settlement failed: ${settle.json?.errorReason ?? "unspecified"}`);
	}
	const transaction = settle.json?.transaction;
	if (typeof transaction !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transaction)) {
		throw new Error("settlement reported success but returned no valid transaction hash");
	}
	return {
		transaction: transaction as Hex,
		payer: (settle.json?.payer ?? params.authorization.from) as Address,
		amount: (settle.json?.amount ?? params.requirements.amount) as string,
	};
}
