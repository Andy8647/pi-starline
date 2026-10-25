/**
 * The git state the last project refresh produced.
 *
 * The footer draws from it every render; the pill's bubble reads it on click, so
 * a click costs no `git status` of its own. `index.ts` sets it once per session
 * (the state object is mutated in place) and clears it on shutdown, so a bubble
 * opened after the session ended shows nothing rather than a stale tree.
 */

import type { GitStatusSummary } from "./git";

let current: GitStatusSummary | undefined;

export function setActiveGitStatus(status: GitStatusSummary | undefined): void {
	current = status;
}

export function activeGitStatus(): GitStatusSummary | undefined {
	return current;
}
