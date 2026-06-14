// ============================================================================
// In-memory draft store for the x402 gasless bounty-funding flow.
//
// create_bounty_draft computes a bounty's on-chain params (testsHash, budget,
// deadline, specCid) and stashes them here under a generated draftId, returning
// an x402 402-challenge for the funder to sign. finalize_bounty looks the draft
// back up by id, settles the funder's signed payment, and broadcasts createBounty
// with these EXACT params — so the funder pays for precisely what they committed
// to, not whatever a second resolve might recompute.
//
// Deliberately IN-MEMORY, not the Neon DB: funding is a within-seconds two-step
// handshake, and keeping it dep-light means the funding path has no DB to be down.
// TRADEOFF (stated loud): a server restart between draft and finalize drops the
// draft and the funder must re-draft. That is acceptable for a seconds-long flow;
// it is NOT durable state. If finalize ever needs to survive a restart, move this
// to a table — do not silently rely on this surviving a redeploy.
// ============================================================================

import { randomBytes } from "node:crypto";
import type { BountyConfig } from "./createBounty.ts";

// How long a draft stays claimable before it is swept. A funder signs + finalizes
// in seconds; 15 min is generous slack for a human clicking a web Fund button.
const DRAFT_TTL_MS = 15 * 60 * 1000;

export type BountyDraft = {
	draftId: string;
	cfg: BountyConfig;
	// The funding params echoed back in the 402 challenge, so finalize can rebuild
	// the SAME PaymentRequirements the funder signed against without recomputing.
	payTo: string;
	token: string;
	amount: string; // 6-decimal base units, decimal string
	chainId: number;
	resource: string;
	description: string;
	createdAt: number;
	expiresAt: number;
};

const drafts = new Map<string, BountyDraft>();

// Drop expired drafts. Called opportunistically on every put/get so the map can't
// grow unbounded even without a background timer (we avoid a setInterval so the
// store has zero lifecycle to manage in a short-lived serverless invocation).
function sweep(now: number) {
	for (const [id, d] of drafts) {
		if (d.expiresAt <= now) drafts.delete(id);
	}
}

export function putDraft(
	draft: Omit<BountyDraft, "draftId" | "createdAt" | "expiresAt">,
): BountyDraft {
	const now = Date.now();
	sweep(now);
	const draftId = "draft_" + randomBytes(12).toString("hex");
	const full: BountyDraft = {
		...draft,
		draftId,
		createdAt: now,
		expiresAt: now + DRAFT_TTL_MS,
	};
	drafts.set(draftId, full);
	return full;
}

// Look a draft up by id. Returns null if unknown OR expired (sweeps first) so the
// caller can fail loud with a clear "draft not found or expired" rather than
// settling a payment against stale params.
export function getDraft(draftId: string): BountyDraft | null {
	const now = Date.now();
	sweep(now);
	return drafts.get(draftId) ?? null;
}

// Remove a draft once it's been finalized (or to cancel). Idempotent.
export function consumeDraft(draftId: string): void {
	drafts.delete(draftId);
}

export { DRAFT_TTL_MS };
