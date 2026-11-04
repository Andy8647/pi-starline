/**
 * Whether this rate is slow, normal or fast *for this session*.
 *
 * A fixed threshold would not travel: 30 t/s is a fast local model and a slow
 * frontier one, so an absolute cut-off would paint the same colour on both and
 * say nothing. What the pill can honestly answer is "faster or slower than this
 * session usually replies", which is the median of its finished messages. The
 * median rather than the mean so one stalled message or one unusually fast one
 * does not move the reference.
 *
 * The three tiers colour the pill from `colors.tpsSlow`, `colors.tps` and
 * `colors.tpsFast`; `colors.tps` is the tier that was on the pill before the
 * other two existed, so an existing config keeps its own colour for a normal rate.
 *
 * Hysteresis is not decoration. The rate arrives a couple of times a second
 * while a message streams and wanders across any threshold it sits near; without
 * a band to clear on the way out, the pill blinks between two colours mid
 * message. So a tier is entered at the outer edge and left at an inner one.
 */

export type TpsTier = "slow" | "normal" | "fast";

/** Median of fewer messages than this says nothing about "usual". */
export const MIN_TPS_SAMPLES = 4;

/** Entered 30% above the median, left once back inside 15%. */
const ENTER_FAST = 1.3;
const LEAVE_FAST = 1.15;
/** Entered 30% below the median, left once back inside 15%. */
const ENTER_SLOW = 0.7;
const LEAVE_SLOW = 0.85;

let tier: TpsTier = "normal";

/**
 * Forget the tier, for a session that is starting over. The band is only
 * meaningful within one session's usual rate.
 */
export function resetTpsTier(): void {
	tier = "normal";
}

/**
 * The middle rate of a session, or undefined while there is too little to say.
 *
 * `values` are the finished messages' rates, one point per measured message.
 */
export function medianTps(values: readonly number[]): number | undefined {
	const rates = values.filter((value) => Number.isFinite(value) && value > 0);
	if (rates.length < MIN_TPS_SAMPLES) return undefined;
	const sorted = [...rates].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	if (sorted.length % 2 === 1) return sorted[middle];
	return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * The tier for a rate shown against the session's median.
 *
 * A missing rate or a median that cannot be formed leaves the pill on `normal`:
 * there is nothing to compare against, so claiming "fast" or "slow" would be a
 * guess dressed up as a reading. The band resets with it, so a number that
 * reappears later starts from the middle instead of from a stale edge.
 */
export function tpsTierFor(value: number | undefined, median: number | undefined): TpsTier {
	if (value === undefined || !Number.isFinite(value) || median === undefined || !(median > 0)) {
		tier = "normal";
		return tier;
	}

	const ratio = value / median;
	// Leaving a tier needs less than entering it (see the header): everything
	// inside the inner edge is "usual", everything outside the outer edge is not.
	if (tier === "fast" && ratio < LEAVE_FAST) tier = "normal";
	else if (tier === "slow" && ratio > LEAVE_SLOW) tier = "normal";

	if (tier === "normal") {
		if (ratio >= ENTER_FAST) tier = "fast";
		else if (ratio <= ENTER_SLOW) tier = "slow";
	}

	return tier;
}
