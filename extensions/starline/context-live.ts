/**
 * The context numbers the bar last drew.
 *
 * The pill itself shows one figure; the rest — window size, tokens used, session
 * totals, cache rate — is only on screen while the bubble is open. The footer
 * already computes all of it every render (including the streaming estimate), so
 * the bubble reads this instead of asking Pi again and disagreeing with the pill.
 *
 * Cleared on shutdown: a bubble opened after the session ended shows nothing
 * rather than the previous session's tokens.
 */

export type ContextSnapshot = {
	/** Usage as a percentage of the window, when a window is known. */
	percent?: number;
	contextWindow?: number;
	/** Tokens used, when known. */
	tokens?: number;
	/** Session totals, already formatted (`↑250k ↓193k`); "" when nothing ran. */
	tokenLabel?: string;
	/** Latest turn's cache hit rate, already formatted (`󰆼 99.9%`); "" when none. */
	cacheLabel?: string;
};

let current: ContextSnapshot | undefined;

export function setActiveContextSnapshot(snapshot: ContextSnapshot | undefined): void {
	current = snapshot;
}

export function activeContextSnapshot(): ContextSnapshot | undefined {
	return current;
}
