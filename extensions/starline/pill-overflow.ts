/**
 * What the bar had to leave out, so the `+N` counter can say what it counted.
 *
 * The bar drops whole pills when the terminal is too narrow for all of them, and
 * stands a counter in their place. Which pills those were is only known to the
 * render — it depends on the width, on the text of every segment that frame — so
 * the render records it here and the counter's action reads it, the same way
 * `pill-anchors.ts` hands the keyboard path the geometry the footer computed.
 *
 * A singleton like that one: one footer per session, one writer, and the reader
 * only needs "what is not on screen right now". Renders happen at several widths
 * while the layout measures, so the value is best-effort by design; it is only
 * read when a bubble opens on the counter, which is drawn at the width that
 * produced it.
 */

import type { PillOverflow } from "./pill";

let rows: readonly PillOverflow[] = [];

export function setPillOverflowRows(next: readonly PillOverflow[]): void {
	rows = next;
}

/** The pills that are not on the bar, in bar order. */
export function activePillOverflowRows(): readonly PillOverflow[] {
	return rows;
}
