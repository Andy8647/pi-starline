import { CURSOR_MARKER, sliceByColumn } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	dedupeCursorMarkers,
	installCursorMarkerDedupe,
} from "../../extensions/starline/mouse/cursor-marker";

/**
 * Pi's `applySelection` reassembles a row from three `sliceByColumn` slices, and
 * `sliceWithWidth` carries every preceding escape sequence into each later slice —
 * the editor's zero-width caret marker included. `extractCursorPosition` strips
 * only the first copy, so the extras reach the terminal, and a terminal that only
 * ends APC on `ESC \` (Ghostty) swallows the text after them.
 *
 * This is the workaround for earendil-works/pi#9332 until #9441 ships.
 */

describe("dedupeCursorMarkers", () => {
	// The exact shape from the upstream report: one marker, sliced three ways.
	it("collapses the copies three slices produce", () => {
		const line = `ab${CURSOR_MARKER}cdefghij`;
		const before = sliceByColumn(line, 0, 4, true);
		const selected = sliceByColumn(line, 4, 2, true);
		const after = sliceByColumn(line, 6, 4, true);
		const [deduped] = dedupeCursorMarkers([`${before}${selected}${after}`]);

		expect(deduped?.split(CURSOR_MARKER)).toHaveLength(2);
		expect(deduped?.split(CURSOR_MARKER).join("")).toBe("abcdefghij");
	});

	it("keeps the first marker where it was, so the caret column does not move", () => {
		const line = `ab${CURSOR_MARKER}c${CURSOR_MARKER}d${CURSOR_MARKER}e`;
		const [deduped] = dedupeCursorMarkers([line]);

		expect(deduped?.indexOf(CURSOR_MARKER)).toBe(line.indexOf(CURSOR_MARKER));
		expect(deduped?.split(CURSOR_MARKER)).toHaveLength(2);
	});

	it("leaves every other row exactly as it was", () => {
		const rows = ["plain row", `one ${CURSOR_MARKER} marker`, ""];
		expect(dedupeCursorMarkers(rows)).toEqual(rows);
	});

	it("does not disturb styling around the marker", () => {
		const line = `\u001b[31mab${CURSOR_MARKER}c${CURSOR_MARKER}d\u001b[0m`;
		const [deduped] = dedupeCursorMarkers([line]);

		expect(deduped).toBe(`\u001b[31mab${CURSOR_MARKER}cd\u001b[0m`);
	});
});

describe("installCursorMarkerDedupe", () => {
	it("cleans the rows applySelection returns, and passes the arguments through", () => {
		const calls: unknown[][] = [];
		const prototype = {
			applySelection(screen: string[], layout?: unknown) {
				calls.push([screen, layout]);
				return [`a${CURSOR_MARKER}b${CURSOR_MARKER}c`, "plain"];
			},
		};

		const dispose = installCursorMarkerDedupe(prototype);
		const rows = (prototype.applySelection as (s: string[], l?: unknown) => string[])(["x"], "L");

		expect(rows).toEqual([`a${CURSOR_MARKER}bc`, "plain"]);
		expect(calls).toEqual([[["x"], "L"]]);
		dispose?.();
	});

	it("gives the original back when disposed", () => {
		const prototype = {
			applySelection: () => [`a${CURSOR_MARKER}b${CURSOR_MARKER}c`],
		};
		const dispose = installCursorMarkerDedupe(prototype);
		dispose?.();
		expect(prototype.applySelection()).toEqual([`a${CURSOR_MARKER}b${CURSOR_MARKER}c`]);
	});

	it("does nothing on a build without selection rendering", () => {
		expect(installCursorMarkerDedupe({})).toBeUndefined();
		expect(installCursorMarkerDedupe({ applySelection: "not a function" })).toBeUndefined();
	});

	it("passes anything that is not a row array straight through", () => {
		const prototype = { applySelection: () => ({ odd: true }) };
		const dispose = installCursorMarkerDedupe(prototype);
		expect((prototype.applySelection as () => unknown)()).toEqual({ odd: true });
		dispose?.();
	});
});
