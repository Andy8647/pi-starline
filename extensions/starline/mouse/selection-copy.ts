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
 * A markdown table survives untouched by construction: its rows are rendered
 * by pi-tui's `Markdown`, which is not an expandable component, so the caller
 * never marks them and `stripFrameColumns` is a no-op unless told otherwise.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * The box-drawing glyphs that carry a vertical stroke: a frame's *side*, which
 * is what a body row is bounded by. Light, heavy, double, their dashed
 * variants, and the two light/heavy transitions — the whole vertical family of
 * the Unicode Box Drawing block, so a theme that draws its frames heavy or
 * double is recognised without another edit here.
 *
 * This is the counterpart to `BOX_DRAWING_RE` below, and keeping the two apart
 * is the point: the retired `fixed-editor/frame.ts` held one combined set with
 * `│` and `┃` in it, which is right for "is this cell a frame glyph" and wrong
 * for "is this row a rule" — a combined set would call `│ hello │` a rule the
 * moment its content happened to be box-drawing too.
 */
const VERTICAL_GLYPHS = "│┃║╎╏┆┇┊┋╽╿";
const VERTICAL_RE = new RegExp(`[${VERTICAL_GLYPHS}]`);

/**
 * The Unicode Box Drawing block (U+2500–U+257F) and nothing else. A rule row
 * is a line drawn entirely from it *with no vertical on it* — that absence is
 * what makes a rule a rule rather than a body row, and it is why the vertical
 * family is subtracted rather than the horizontal family enumerated.
 *
 * Enumerating was the earlier approach and it silently broke the feature: the
 * list held only the square-cornered glyphs (`┌┐└┘`), while every frame this
 * exists to strip is drawn by `pi-toolbox`, which draws rounded ones
 * (`╭${"─".repeat(n)}╮` / `╰${"─".repeat(n)}╯`, see its `frame.ts`). A
 * subtractive test cannot go stale that way — every corner, tee, cross and
 * horizontal in the block, at any weight, is covered by construction.
 */
const BOX_DRAWING_RE = /^[─-╿]+$/;

/** Whether a single cell is one of a frame's verticals — see `VERTICAL_GLYPHS`. */
export function isVerticalGlyph(char: string): boolean {
	return char.length === 1 && VERTICAL_GLYPHS.includes(char);
}

/** Whether a line is entirely a box frame's rule — a row a selection should skip, not copy. */
export function isRuleRow(line: string): boolean {
	const plain = stripTerminalSequences(line).trim();
	return plain.length > 0 && BOX_DRAWING_RE.test(plain) && !VERTICAL_RE.test(plain);
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
	if (isVerticalGlyph(body.slice(0, 1))) body = body.slice(1);
	if (body.startsWith(" ")) body = body.slice(1);
	if (isVerticalGlyph(body.slice(-1))) body = body.slice(0, -1);
	return body.trimEnd();
}

/**
 * The extracted rows of a selection, with a frame's rule rows dropped
 * entirely and a frame's body rows stripped of their verticals. `frameRows`
 * holds the indices into `lines` that the caller has determined are rows of
 * a box frame — see `frameRowsIn` in `frame-detection.ts` for how that set is
 * built from the component that rendered each row. It includes a frame's own
 * top and bottom rule rows, not just its body.
 *
 * A rule row is dropped only when its own index is in `frameRows` — not on
 * sight, the way an earlier version of this function did. A markdown table's
 * `┌─┬─┐` / `├─┼─┤` / `└─┴─┘` rows are rule rows by shape but are never in
 * `frameRows` (a table is rendered by `Markdown`, which has no `setExpanded`,
 * so it is never taken for a frame), so they survive a selection exactly like
 * any other table row — this is what makes "intact, pipes and all" actually
 * true, rather than true for the pipes alone while the borders vanished.
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
