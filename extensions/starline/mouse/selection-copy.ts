/**
 * Turning a raw selection extraction into copyable text.
 *
 * `mouse/index.ts` already extracts one string per selected row, the same way
 * Pi's own `copySelectionToClipboard` does (`getSelectionColumns` +
 * `sliceByColumn` + `stripTerminalSequences`, see that module's docstring).
 * What Pi does not do is know that some of those rows are a box's own frame
 * rather than its content. This module is where that gets fixed, working
 * purely on the extracted text: whether a row *belongs* to a frame is decided
 * by the caller from Pi's layout tree (which component owns the row), not
 * here — this module only removes the frame glyphs once told which rows
 * carry them.
 *
 * A markdown table survives untouched by construction: its rows are plain
 * text from the `Markdown` component, never owned by a box whose top and
 * bottom are box-drawing rules, so the caller never marks them, and
 * `stripFrameColumns` is a no-op unless told otherwise.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * A frame's own rule row: nothing on it but the glyphs a border draws its
 * corners and horizontals from. Deliberately without `│` — a rule has no
 * vertical on it, that is what makes it a *rule* rather than a body row.
 */
const RULE_ROW_RE = /^[┌└├┬┴┼─┐┘┤]+$/;

/** Whether a line is entirely a box frame's rule — a row a selection should skip, not copy. */
export function isRuleRow(line: string): boolean {
	const plain = stripTerminalSequences(line).trim();
	return plain.length > 0 && RULE_ROW_RE.test(plain);
}

/**
 * Removes one frame vertical and its padding from each end of `line`, when
 * `ownedByFrame` says this row is a body row of a box. Left alone otherwise —
 * in particular, a table row is passed with `ownedByFrame: false`, so its own
 * `│` separators are never touched.
 */
export function stripFrameColumns(line: string, ownedByFrame: boolean): string {
	if (!ownedByFrame) return line;
	let body = line;
	if (body.startsWith("│")) body = body.slice(1);
	if (body.startsWith(" ")) body = body.slice(1);
	if (body.endsWith("│")) body = body.slice(0, -1);
	return body.trimEnd();
}

/**
 * The extracted rows of a selection, with a frame's rule rows dropped
 * entirely and a frame's body rows stripped of their verticals. `frameRows`
 * holds the indices into `lines` that the caller has determined are rows of
 * a box frame — see `mouse/index.ts` (`frameRowsIn`, in `frame-detection.ts`)
 * for how that set is built from Pi's layout tree, which includes a frame's
 * own top and bottom rule rows, not just its body (see that module's
 * docstring on `frameBoxAt`).
 *
 * A rule row is dropped only when its own index is in `frameRows` — not on
 * sight, the way an earlier version of this function did. A markdown table's
 * `┌─┬─┐` / `├─┼─┤` / `└─┴─┘` rows are rule rows by shape but are never in
 * `frameRows` (a table's component has no `setExpanded`, so `frameBoxAt`
 * never matches it), so they now survive a selection exactly like any other
 * table row — this is what makes "intact, pipes and all" actually true,
 * rather than true for the pipes alone while the borders vanished.
 */
export function copyableLines(lines: readonly string[], frameRows: ReadonlySet<number>): string[] {
	const result: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const owned = frameRows.has(index);
		if (owned && isRuleRow(line)) continue;
		result.push(stripFrameColumns(line, owned));
	}
	return result;
}
