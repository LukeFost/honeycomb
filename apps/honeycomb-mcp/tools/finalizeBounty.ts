// ============================================================================
// finalize_bounty: step 2 of gasless ("x402") bounty funding.
//
// The funder has signed the EIP-3009 TransferWithAuthorization from the draft's
// 402-challenge. This tool:
//   1. looks the draft back up (fails loud if unknown/expired)
//   2. rebuilds the SAME PaymentRequirements the funder signed against
//   3. settles the signed authorization through the facilitator — the relayer
//      broadcasts transferWithAuthorization and pays gas, pulling the funder's
//      USDC into the server's custodial wallet (payTo = OWNER)
//   4. ONLY THEN broadcasts createBounty on-chain with the draft's exact params,
//      reimbursed by the USDC just received
//
// Ordering is load-bearing: settle BEFORE create. If create ran first and settle
// failed, the server would have opened a bounty it paid for out of its own pocket.
// Settling first means the server is whole before it spends. If create fails AFTER
// a successful settle, we surface that loudly (the funder's USDC is in the custodial
// wallet, the bounty is not open) rather than swallowing it — a stuck-funds state a
// human must reconcile, not a silent success.
// ============================================================================

import { broadcastBounty } from "./createBounty.ts";
import { consumeDraft, getDraft } from "./draftStore.ts";
import { buildPaymentRequirements, settleAuthorization, type X402Authorization } from "../x402.ts";
import type { Address, Hex } from "viem";

export const finalizeBountyInput = {
	draftId: {
		type: "string",
		description: "The draftId returned by create_bounty_draft. Identifies the funding params to settle against.",
	},
	signature: {
		type: "string",
		description: "The funder's EIP-712 signature over the draft's TransferWithAuthorization typed-data (0x-hex).",
	},
	authorization: {
		type: "object",
		description:
			"The signed EIP-3009 authorization: {from, to, value, validAfter, validBefore, nonce}. MUST match what was signed — `from` is the funder's wallet, the rest are the draft's authorizationTemplate verbatim.",
	},
} as const;

export async function finalizeBounty(args: {
	draftId: string;
	signature: Hex;
	authorization: X402Authorization;
}) {
	if (!args.draftId) throw new Error("draftId is required");
	if (!args.signature) throw new Error("signature is required");
	if (!args.authorization) throw new Error("authorization is required");

	// 1. Recover the draft. Loud failure on unknown/expired — never settle a payment
	//    against params we can't reproduce.
	const draft = getDraft(args.draftId);
	if (!draft) {
		throw new Error(`draft not found or expired: ${args.draftId} (drafts live ~15 min; re-run create_bounty_draft)`);
	}

	// 2. Sanity-check the echoed authorization against the draft so a funder can't
	//    (accidentally or otherwise) redirect the funds or change the amount. The
	//    facilitator re-verifies the signature too, but matching here fails fast with
	//    a clear reason instead of an opaque facilitator rejection.
	const auth = args.authorization;
	if (auth.to.toLowerCase() !== draft.payTo.toLowerCase()) {
		throw new Error(`authorization.to ${auth.to} does not match draft payTo ${draft.payTo}`);
	}
	if (auth.value !== draft.amount) {
		throw new Error(`authorization.value ${auth.value} does not match draft amount ${draft.amount}`);
	}

	// 3. Rebuild the requirements the funder signed against (same inputs as the draft).
	const requirements = buildPaymentRequirements({
		token: draft.token as Address,
		payTo: draft.payTo as Address,
		amount: draft.amount,
		resource: draft.resource,
		description: draft.description,
	});

	// 4. SETTLE (gasless). Relayer pulls funder USDC -> custodial wallet, pays gas.
	//    settleAuthorization throws loud on any invalid/failed step.
	const settlement = await settleAuthorization({
		requirements,
		signature: args.signature,
		authorization: auth,
	});

	// 5. The server is now reimbursed. Broadcast createBounty with the draft's EXACT
	//    params. If THIS throws, the funder's USDC is already in the custodial wallet
	//    and the bounty is NOT open — surface that explicitly so it's reconciled, not
	//    mistaken for a clean failure.
	let created;
	try {
		created = await broadcastBounty(draft.cfg);
	} catch (e) {
		throw new Error(
			`PAYMENT SETTLED (tx ${settlement.transaction}) but createBounty FAILED: ${
				e instanceof Error ? e.message : String(e)
			}. Funder USDC is in the custodial wallet ${draft.payTo}; bounty is NOT open. Reconcile manually.`,
		);
	}

	// 6. Done — burn the draft so the same signed auth can't be replayed into a second
	//    bounty (the EIP-3009 nonce already prevents a second settle, but consuming the
	//    draft makes the one-shot intent explicit).
	consumeDraft(args.draftId);

	return {
		...created,
		funded: true,
		gasless: true,
		funder: settlement.payer,
		settlementTx: settlement.transaction,
		settledAmount: settlement.amount,
	};
}
