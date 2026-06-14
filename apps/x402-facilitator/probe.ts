// ============================================================================
// probe.ts -- offline sanity check of the facilitator wiring.
//
// Boots the same registration the server does, then prints getSupported() and
// the relayer address per network. NO network call, NO payment -- this just
// proves the scheme registered cleanly and the relayer key resolves. Run:
//
//   NETWORKS=eip155:84532 RELAYER_PRIVATE_KEY=0x.. bun run probe.ts
//   (or omit RELAYER_PRIVATE_KEY to read it from the login Keychain)
// ============================================================================

import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { buildFacilitatorSigner, parseCaip2List } from "./signer.ts";

const NETWORKS = parseCaip2List(process.env.NETWORKS, "eip155:84532");

const facilitator = new x402Facilitator();
for (const network of NETWORKS) {
	const { signer, address, chain, rpcUrl } = buildFacilitatorSigner(network);
	registerExactEvmScheme(facilitator, { signer, networks: network });
	console.log(
		`registered ${network} (${chain.name})  relayer=${address}  ` +
			`signers=${JSON.stringify(signer.getAddresses())}  rpc=${rpcUrl ?? "default"}`,
	);
}

console.log("\ngetSupported():");
console.log(JSON.stringify(facilitator.getSupported(), null, 2));
console.log("\nOK: facilitator registered all networks and resolved the relayer key.");
