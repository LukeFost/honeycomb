// ============================================================================
// LPDecision — the generalized seam.
//
// This is the ONLY shape the executor consumes. It is deliberately
// chain-agnostic and protocol-agnostic: it describes WHAT a strategy decided,
// not HOW to encode it on any particular chain. A grader scores objects of
// this shape; the executor turns one into a real onchain position.
//
// The same pattern extends to trading (a future TradeDecision -> /quote+/swap
// on the Trading API). Keeping the decision abstract is what lets "the LP and
// the trader and etc" all flow through one executor.
// ============================================================================

/** A token leg of a pair. Addresses are checksummed or lowercase 0x strings. */
export type Token = {
	address: `0x${string}`;
	symbol?: string;
	decimals?: number;
};

/** Uniswap V3 fee tier in hundredths of a bip. */
export type FeeTier = 500 | 3000 | 10000 | 100;

/**
 * A price range for the position.
 *  - "full"      -> full-range LP (widest, simplest; no active management)
 *  - {tickLower, tickUpper} -> a concentrated range (must be tickSpacing-aligned)
 */
export type Range = "full" | { tickLower: number; tickUpper: number };

/** What the strategy decided to do with liquidity. */
export type LPAction = "provide" | "increase" | "decrease" | "claim";

/**
 * The generalized strategy output. A grader scores this; the executor renders
 * it into a real Uniswap LP transaction via the Developer Platform API.
 */
export type LPDecision = {
	action: LPAction;
	/** Which pair to provide into. */
	pair: { token0: Token; token1: Token };
	fee: FeeTier;
	/** Price range. Full-range by default keeps the strategy simple/general. */
	range: Range;
	/**
	 * Amount of the INDEPENDENT token to commit, in raw token units (wei-like).
	 * The API derives the paired amount from the current pool price.
	 */
	amount: string;
	/** Which side of the pair `amount` refers to. Defaults to token0. */
	independentSide?: "token0" | "token1";
};

/** Fee tier -> Uniswap V3 tick spacing. */
export const TICK_SPACING: Record<FeeTier, number> = {
	100: 1,
	500: 10,
	3000: 60,
	10000: 200,
};

/**
 * Full-range ticks for a fee tier: MIN_TICK (-887272) rounded INWARD to the
 * nearest multiple of tickSpacing, and its symmetric positive. The API rejects
 * non-aligned ticks with HTTP 500 "Invariant failed: TICK_LOWER".
 */
export function fullRangeTicks(fee: FeeTier): { tickLower: number; tickUpper: number } {
	const spacing = TICK_SPACING[fee];
	const MIN_TICK = -887272;
	const tickLower = Math.ceil(MIN_TICK / spacing) * spacing; // round toward 0
	return { tickLower, tickUpper: -tickLower };
}

/** Resolve a decision's Range into concrete, spacing-aligned ticks. */
export function resolveTicks(decision: LPDecision): { tickLower: number; tickUpper: number } {
	if (decision.range === "full") return fullRangeTicks(decision.fee);
	const spacing = TICK_SPACING[decision.fee];
	const { tickLower, tickUpper } = decision.range;
	if (tickLower % spacing !== 0 || tickUpper % spacing !== 0) {
		throw new Error(
			`range ticks must be multiples of tickSpacing ${spacing} for fee ${decision.fee} ` +
				`(got ${tickLower}/${tickUpper})`,
		);
	}
	return { tickLower, tickUpper };
}
