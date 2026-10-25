/**
 * The last anchors the footer rendered, so the keyboard path can point a bubble
 * at the same pill a click would have hit.
 *
 * A module-level singleton like `working-indicator.ts`: there is one footer per
 * session, it is the only writer, and actions only need "where is the pill for
 * this segment right now". Renders happen at several widths while the layout
 * measures, so the value is best-effort by design; the click path does not use it
 * (it has the exact span that was hit).
 */

import type { PillAnchor } from "./pill-bubble";

let anchors = new Map<string, PillAnchor>();

export function setPillAnchors(next: ReadonlyMap<string, PillAnchor>): void {
	anchors = new Map(next);
}

export function getPillAnchor(key: string): PillAnchor | undefined {
	return anchors.get(key);
}

export function clearPillAnchors(): void {
	anchors = new Map();
}
