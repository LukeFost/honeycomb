// ============================================================================
// Self-hosted x402 facilitator.
//
// No hosted x402 facilitator settles on Ethereum L1, so the Summon-a-TEE web
// route points at THIS service. It exposes the standard facilitator wire:
//
//   POST /verify   {x402Version, paymentPayload, paymentRequirements} -> VerifyResponse
//   POST /settle   {x402Version, paymentPayload, paymentRequirements} -> SettleResponse
//   GET  /supported                                                   -> SupportedResponse
//   GET  /health                                                      -> {ok, networks, relayer}
//
// All the protocol logic (EIP-3009 verify, transferWithAuthorization settle,
// re-verify, replay protection via the token's on-chain authorizationState)
// lives in @x402/evm's ExactEvmScheme. We only:
//   1. build the relayer signer (the gas-paying settlement EOA), and
//   2. register the exact scheme for the configured network(s), and
//   3. translate HTTP <-> the facilitator's verify()/settle().
//
// Replay protection is on-chain (USDC authorizationState), so there is no nonce
// store to run. The relayer wallet must hold native gas on the settlement chain.
// ============================================================================

import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { buildFacilitatorSigner, parseCaip2List } from "./signer.ts";

const PORT = Number(process.env.PORT ?? 4021);

// Settlement network(s). Default to Base Sepolia for the testnet proof; the
// integration step flips this to "eip155:1" (ETH mainnet, real USDC). Comma-
// separated to register several at once (e.g. "eip155:84532,eip155:1").
// parseCaip2List validates the CAIP-2 shape (throws on empty/malformed).
const NETWORKS = parseCaip2List(process.env.NETWORKS, "eip155:84532");

// One relayer signer per network (each binds a chain + RPC). They share the
// same relayer key/address; only the chain differs.
const facilitator = new x402Facilitator();
const relayers: Record<string, string> = {};
for (const network of NETWORKS) {
	const { signer, address, rpcUrl } = buildFacilitatorSigner(network);
	registerExactEvmScheme(facilitator, { signer, networks: network });
	relayers[network] = address;
	console.log(
		`[facilitator] registered exact scheme on ${network} ` +
			`relayer=${address} rpc=${rpcUrl ?? "(viem default public RPC)"}`,
	);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Parse + shape-check a {x402Version, paymentPayload, paymentRequirements} body. */
async function readFacilitatorRequest(req: Request): Promise<{
	paymentPayload: any;
	paymentRequirements: any;
}> {
	const body = (await req.json().catch(() => {
		throw new HttpError(400, "Body is not valid JSON.");
	})) as { paymentPayload?: unknown; paymentRequirements?: unknown };
	const { paymentPayload, paymentRequirements } = body ?? {};
	if (!paymentPayload || !paymentRequirements) {
		throw new HttpError(
			400,
			"Expected {x402Version, paymentPayload, paymentRequirements} in the body.",
		);
	}
	return { paymentPayload, paymentRequirements };
}

class HttpError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
	}
}

async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url);

	if (req.method === "GET" && url.pathname === "/health") {
		return json({ ok: true, networks: NETWORKS, relayers });
	}

	if (req.method === "GET" && url.pathname === "/supported") {
		// kinds/extensions/signers the facilitator advertises.
		return json(facilitator.getSupported());
	}

	if (req.method === "POST" && url.pathname === "/verify") {
		const { paymentPayload, paymentRequirements } = await readFacilitatorRequest(req);
		// ExactEvmScheme.verify checks the EIP-3009 signature, amount, asset,
		// payTo, time bounds, and that the authorization is still unused on-chain.
		const result = await facilitator.verify(paymentPayload, paymentRequirements);
		return json(result);
	}

	if (req.method === "POST" && url.pathname === "/settle") {
		const { paymentPayload, paymentRequirements } = await readFacilitatorRequest(req);
		// Re-verifies, then the relayer broadcasts transferWithAuthorization and
		// waits for the receipt. result.transaction is the real on-chain tx hash.
		const result = await facilitator.settle(paymentPayload, paymentRequirements);
		return json(result);
	}

	return json({ error: "not found" }, 404);
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		try {
			return await handle(req);
		} catch (err) {
			if (err instanceof HttpError) {
				return json({ error: err.message }, err.status);
			}
			// Honest failure: surface the real reason loudly (500), do not pretend
			// a verify/settle succeeded. The web route maps this to a buyer-visible
			// error rather than charging for an unprovable run.
			const message = err instanceof Error ? err.message : String(err);
			console.error("[facilitator] unhandled error:", err);
			return json({ error: message }, 500);
		}
	},
});

console.log(
	`[facilitator] listening on :${PORT}  networks=${NETWORKS.join(",")}  ` +
		`(POST /verify, POST /settle, GET /supported, GET /health)`,
);
