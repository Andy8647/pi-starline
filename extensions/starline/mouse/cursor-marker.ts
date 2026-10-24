/**
 * A stopgap for Pi's cursor-marker leak during mouse selection.
 *
 * `TuiAltScreen.applySelection` cuts a selected row into `before` / `selected` /
 * `after` with `sliceByColumn`, and `sliceWithWidth` carries every escape sequence
 * that precedes a slice into it (`pendingAnsi`). The editor's caret marker
 * (`\x1b_pi:c\x07`, a zero-width APC) therefore gets copied into each later slice:
 * one marker becomes two or three.
 *
 * `extractCursorPosition` strips only the first copy per line and returns, so the
 * rest are written to the terminal. Ghostty only ends an APC on `ESC \`, treats the
 * `BEL` as payload, and swallows the bytes that follow — which shows up as
 * garbled text in and around the editor while dragging. Upstream issue
 * earendil-works/pi#9332; the fix is earendil-works/pi#9441, still unmerged as of
 * Pi 1.4.0.
 *
 * Starline makes this fire on every editor drag-select because
 * `editorClickToCaret` moves the caret to the press point, so the caret row is
 * always the row being dragged over. This module keeps the first marker per line
 * and drops the duplicates — the same thing #9441 does in `extractCursorPosition`,
 * from the outside. **Delete it once a Pi release contains #9441.**
 */

import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { installPrototypePatch } from "../prototype-patch-registry";

/**
 * Keep the first cursor marker on a line, drop the rest.
 *
 * The first one is the one `extractCursorPosition` reads the caret column from, so
 * keeping it preserves the caret exactly; the extras are what leak.
 */
export function dedupeCursorMarkers(lines: readonly string[]): string[] {
	return lines.map((line) => {
		const first = line.indexOf(CURSOR_MARKER);
		if (first === -1) return line;
		const head = line.slice(0, first + CURSOR_MARKER.length);
		const rest = line.slice(first + CURSOR_MARKER.length);
		return rest.includes(CURSOR_MARKER) ? head + rest.split(CURSOR_MARKER).join("") : line;
	});
}

/**
 * Installs the marker dedupe on `applySelection`, or does nothing on a build that
 * has no selection rendering at all. Returns the disposer, or undefined when there
 * was nothing to patch.
 */
export function installCursorMarkerDedupe(prototype: object): (() => void) | undefined {
	const target = prototype as Record<string, unknown>;
	if (typeof target.applySelection !== "function") return undefined;
	try {
		return installPrototypePatch(
			prototype,
			"applySelection",
			"selection-marker-dedupe",
			({ predecessor, receiver, args }) => {
				const result = Reflect.apply(predecessor, receiver, args);
				// Anything that is not the row array Pi documents is passed through
				// untouched: this patch exists to clean a frame, not to reshape one.
				if (!Array.isArray(result)) return result;
				return dedupeCursorMarkers(result as string[]);
			},
		);
	} catch {
		// An unpatchable method means the leak stays, which is exactly how Pi
		// behaves without Starline. Never fail an install over it.
		return undefined;
	}
}
