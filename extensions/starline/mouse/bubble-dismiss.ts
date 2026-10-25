/**
 * A click anywhere outside an open pill bubble puts it away.
 *
 * A bubble is a popover, not a panel: it covers the transcript while it is open
 * and the way out should be wherever the user's pointer already is. Escape, a
 * second click on the pill, and another pill all already close it; the rest of
 * the screen — the editor, the transcript, an empty row — did nothing, so a
 * bubble stayed up until one of those three happened.
 *
 * The click has to be read before Pi dispatches it, because the thing under the
 * pointer is a component that knows nothing about bubbles. There is exactly one
 * patch on the renderer's mouse entry (`pointer-shape.ts`, adapter
 * `mouse-pointer-shape`) and the registry holds one behaviour per method, so this
 * subscribes to the events that patch publishes instead of taking a second one.
 * Nothing here consumes the event: the click goes on to move the caret, select a
 * line, or whatever else it was going to do.
 *
 * The footer row is handled by the footer itself, which knows which cells are
 * pills: a press there either belongs to a clickable pill (its own toggle or
 * replacement) or lands on padding, a gap or an inert read-out, and that last
 * case closes the bubble too. So the geometry check below stays off that row —
 * closing on the press here as well would make the same pill's second click
 * close and immediately reopen.
 */

import { activePillBubbleGeometry, closePillBubble, type PillBubbleGeometry } from "../pill-bubble";
import {
	isPointerPress,
	observePointerEvents,
	type PointerEventRaw,
	type PointerReceiver,
} from "./pointer-events";

/** Rows between the bottom of the screen and the footer: none. */
const FOOTER_LAST_ROW = 1;

/**
 * Whether this pointer event lands outside the bubble's rectangle.
 *
 * The rectangle is resolved against the terminal as it is now, not as it was when
 * the bubble opened, so a window that grew keeps the bubble on its footer. A
 * press on the footer row never counts here: the footer decides that row cell by
 * cell, because it is the one place that knows where its pills are.
 */
export function isOutsideBubble(
	event: PointerEventRaw,
	geometry: PillBubbleGeometry | undefined,
	terminalRows: number | undefined,
): boolean {
	if (!geometry || geometry.width <= 0 || geometry.height <= 0) return false;
	if (terminalRows === undefined || !Number.isFinite(terminalRows)) return false;
	if (!isPointerPress(event)) return false;

	// The overlay is anchored to the bottom with a one-row gap for the footer, so
	// its last row is that many rows above the screen's last one.
	const bottomRow = terminalRows - FOOTER_LAST_ROW - geometry.bottomOffset;
	const topRow = bottomRow - geometry.height + 1;
	const left = geometry.leftColumn;
	const right = left + geometry.width;

	// The bar itself: its pills toggle and replace their own bubbles, and the rest
	// of the row is the footer's to dismiss from (see `handleMouse` there).
	if (event.y === terminalRows - FOOTER_LAST_ROW) return false;

	return event.y < topRow || event.y > bottomRow || event.x < left || event.x >= right;
}

/**
 * Close the open bubble when a press lands outside it.
 *
 * Returns the disposer. Harmless on a Pi without component mouse events: no
 * events are ever published, so nothing happens and the bubble keeps its other
 * three ways out.
 */
export function installPillBubbleDismiss(): () => void {
	return observePointerEvents((event, receiver: PointerReceiver | undefined) => {
		const geometry = activePillBubbleGeometry();
		if (!geometry) return;
		if (!isOutsideBubble(event, geometry, receiver?.terminal?.rows)) return;
		closePillBubble();
	});
}
