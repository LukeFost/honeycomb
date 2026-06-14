// ============================================================================
// create_bounty_draft: step 1 of gasless ("x402") bounty funding.
//
// Computes the bounty's on-chain commitment (testsHash / budget / deadline /
// specCid) WITHOUT broadcasting and WITHOUT spending the server's USDC, stashes
// it as a draft, and hands the funder an x402 402-challenge: the PaymentRequirements
// plus the EIP-712 typed-data to sign. The funder signs an EIP-3009
// TransferWithAuthorization off-chain (no gas, no ETH), then calls finalize_bounty
// with the signature — at which point the facilitator relayer pulls the funder's
// USDC into the server's custodial wallet (Option A: payTo = OWNER) and the server
// opens the bounty on-chain, reimbursed by the USDC it just received.
//
// This is the agent-native + web-Fund-button front door: the draft IS the 402.
// ============================================================================

import { resolveBountyConfig, type CreateBountyArgs, createBountyInput } from "./createBounty.ts";
import { putDraft } from "./draftStore.ts";
import { CHAIN, USDC, walletFromEnv } from "../chain.ts";
import {
	buildPaymentRequirements,
	transferAuthorizationTypedData,
	X402_NETWORK,
	X402_TOKEN_NAME,
	X402_TOKEN_VERSION,
} from "../x402.ts";
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";

// The draft tool takes the SAME bounty-shaping inputs as create_bounty (reward,
// deadline, dir, spec, keys). Funding-specific knobs (token, payTo) are derived,
// not caller-supplied: payTo is always the server's own custodial wallet so the
// settled USDC reimburses the createBounty the server is about to broadcast.
export const createBountyDraftInput = createBountyInput;

export async function createBountyDraft(args: CreateBountyArgs) {
	// 1. Resolve the on-chain params exactly as create_bounty would — but stop
	//    before any wallet/tx. testsHash, budget, deadline, specCid are now fixed.
	const cfg = await resolveBountyConfig(args);

	// 2. payTo = the server's OWN wallet (custodial Option A). Derived from
	//    SEP_PRIVATE_KEY, never hardcoded: the funder's USDC lands here and
	//    reimburses the createBounty the server broadcasts at finalize. walletFromEnv
	//    throws loud if SEP_PRIVATE_KEY is unset — funding can't work without it.
	const { account } = walletFromEnv();
	const payTo = account.address as Address;
	const token = USDC as Address;
	const chainId = CHAIN.id;
	const amount = cfg.budget.toString(); // 6-decimal base units == the reward

	const resource = `honeycomb:bounty-draft`;
	const description = `Fund Honeycomb bounty: ${cfg.reward} USDC reward, deadline ${new Date(
		Number(cfg.deadline) * 1000,
	).toISOString()}`;

	// 3. Stash the draft so finalize settles against THESE params, not a re-resolve.
	const draft = putDraft({ cfg, payTo, token, amount, chainId, resource, description });

	// 4. Build the x402 challenge the funder responds to:
	//    - paymentRequirements: what the facilitator checks the signed auth against
	//    - typedData: the exact EIP-712 the funder signs (TransferWithAuthorization)
	//      from -> payTo, value == amount, with a fresh random nonce + time window.
	const paymentRequirements = buildPaymentRequirements({
		token,
		payTo,
		amount,
		resource,
		description,
	});

	// A nonce + validity window scaffold the funder fills `from` into before signing.
	// nonce is a fresh random bytes32 (EIP-3009 replay key); the window opens now and
	// closes at the draft's TTL so a stale draft's signature can't be replayed later.
	const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
	const validAfter = "0";
	const validBefore = Math.floor(draft.expiresAt / 1000).toString();

	// The funder substitutes their own address for `from`. We return a template with
	// from left as the zero address to make it explicit this is funder-supplied.
	const authorizationTemplate = {
		from: ("0x" + "00".repeat(20)) as Address,
		to: payTo,
		value: amount,
		validAfter,
		validBefore,
		nonce,
	};

	const typedData = transferAuthorizationTypedData({
		token,
		chainId,
		authorization: authorizationTemplate,
	});

	return {
		draftId: draft.draftId,
		expiresAt: draft.expiresAt,
		expiresAtISO: new Date(draft.expiresAt).toISOString(),
		// --- the x402 402-challenge ---
		x402Version: 2,
		network: X402_NETWORK,
		accepts: [paymentRequirements],
		// What the funder signs. They MUST set message.from = their wallet, keep every
		// other field as-is, then call finalize_bounty with {draftId, signature,
		// authorization}.
		typedData,
		authorizationTemplate,
		// Echo the resolved bounty shape so a UI can show what's being funded.
		bounty: {
			rewardUSDC: cfg.reward,
			budget: cfg.budget.toString(),
			deadline: Number(cfg.deadline),
			deadlineISO: new Date(Number(cfg.deadline) * 1000).toISOString(),
			testsHash: cfg.testsHash,
			specCid: cfg.specCid,
			attesterKey: cfg.attesterKey,
			makerPubKey: cfg.makerPubKey,
		},
		// Funding rail facts (handy for the web signer / debugging).
		token,
		tokenName: X402_TOKEN_NAME,
		tokenVersion: X402_TOKEN_VERSION,
		chainId,
		payTo,
	};
}
