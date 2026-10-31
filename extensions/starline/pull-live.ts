/**
 * The pull state the last refresh produced.
 *
 * The footer draws from it every render and the bubble reads it on click, so a
 * click costs no forge call of its own. `index.ts` sets it once per session (the
 * object is mutated in place) and clears it on shutdown, so a bubble opened after
 * the session ended shows nothing rather than yesterday's branch.
 */

import type { PullSnapshot } from "./pull";

let current: PullSnapshot | undefined;

export function setActivePull(snapshot: PullSnapshot | undefined): void {
	current = snapshot;
}

export function activePull(): PullSnapshot | undefined {
	return current;
}
