/**
 * Deciding which rows of a selection are a box frame, from Pi's layout tree.
 *
 * Every function here depends on nothing but a `BoxLike` tree and text —
 * no `installPrototypePatch`, no receiver, no Pi internals — which is what
 * makes the ownership decision itself directly testable, separately from
 * `index.ts`'s orchestration of when it gets called. See
 * `test/mouse/frame-detection.test.ts`.
 */

import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { type BoxLike, boxesAt } from "./hit-test";
import { isRuleRow } from "./selection-copy";

/**
 * The child laid out behind a scroll view, in the same tree walk
 * `scrollContentLinesFor` already does in `hit-test.ts` — mirrored here
 * rather than imported because that helper returns the rendered lines, and
 * this call site needs the box itself: its `rect.y` is where content row 0
 * of those lines sits in the same coordinate space every other box in the
 * tree uses (see `layoutComponent`'s "scroll" branch in pi-tui's
 * `layout.js`, which lays the child out at `y - scrollTop` and then
 * translates it back by the same amount, leaving `rect.y` at
 * `viewportY - scrollTop`). That is what makes `frameRowsIn` below able to
 * hit-test a scrolled-content row without re-deriving Pi's own scroll math.
 */
export function scrollContentOrigin(
	root: BoxLike | undefined,
	scrollView: unknown,
): BoxLike | undefined {
	if (!root) return undefined;
	const scrollBox = root as BoxLike & { scrollView?: unknown };
	if (scrollBox.scrollView === scrollView) return root.children?.[0];
	for (const child of root.children ?? []) {
		const found = scrollContentOrigin(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

/** The visible column of the first non-space character, or 0 for a blank line. */
export function probeColumn(line: string): number {
	const index = stripTerminalSequences(line).search(/\S/);
	return index >= 0 ? index : 0;
}

/**
 * Whether `component` is the kind of thing a box frame is drawn around: one
 * of Pi's expandable message/tool components, which is what `pi-toolbox`
 * patches to draw `╭─╮ │ ╰─╯` in the first place (it wraps
 * `ToolExecutionComponent.prototype`). Verified against the installed
 * `pi-coding-agent`: `bash-execution`, `branch-summary-message`,
 * `compaction-summary-message`, `custom-entry`, `custom-message`,
 * `skill-invocation-message`, and `tool-execution` all expose `setExpanded`;
 * `node_modules/@earendil-works/pi-tui/dist/components/markdown.js` — which
 * draws a table's own `┌─┬─┐` / `├─┼─┤` / `└─┴─┘` — exposes none. This is the
 * same duck type Task 8 uses to decide what a click expands, so the two
 * features agree on what a "box" is.
 *
 * Deliberately a positive test ("is this an expandable box") rather than a
 * negative one ("is this not a table"): the latter is exactly the
 * shape-of-text special-casing this task exists to retire.
 */
export function isExpandableComponent(component: unknown): boolean {
	return (
		typeof component === "object" &&
		component !== null &&
		typeof (component as { setExpanded?: unknown }).setExpanded === "function"
	);
}

/**
 * The box that owns the row at `screenY`, when that box is frame-shaped: its
 * own top and bottom rows (read back through `lineAt`, in whatever row space
 * `origin`'s rect coordinates share with it) are nothing but box-drawing
 * rules, *and* its component is expandable (`isExpandableComponent`).
 * Ownership itself comes entirely from the layout tree via `boxesAt` — the
 * text check only confirms the box we already found is rule-capped, and the
 * component check confirms it is the kind of thing a frame is drawn around.
 * Walked innermost-first so a frame nested inside another frame is judged by
 * the one immediately around the row.
 *
 * The component check is what keeps a markdown table from ever matching: a
 * `Markdown` block that is only a table produces a box whose own first and
 * last rows genuinely are rule rows (`┌─┬─┐` / `└─┴─┘` match the same glyph
 * set a real frame's rules do), so the rule-row check alone is not enough —
 * see `isExpandableComponent`'s docstring for what closes that gap.
 */
export function frameBoxAt(
	origin: BoxLike,
	x: number,
	screenY: number,
	lineAt: (row: number) => string | undefined,
): BoxLike | undefined {
	const path = boxesAt(origin, x, screenY);
	for (let index = path.length - 1; index >= 0; index--) {
		const box = path[index];
		if (box.rect.height < 2) continue;
		if (!isExpandableComponent(box.component)) continue;
		const top = box.rect.y;
		const bottom = box.rect.y + box.rect.height - 1;
		if (isRuleRow(lineAt(top) ?? "") && isRuleRow(lineAt(bottom) ?? "")) return box;
	}
	return undefined;
}

/**
 * Which rows of a `rowStart..rowEnd` extraction are body rows of a box
 * frame, as indices into that extraction (0-based, matching what
 * `copyableLines` expects). `sourceLines` and `origin` share one row space:
 * `sourceLines[row]` is the text at `origin.rect.y + row`.
 */
export function frameRowsIn(
	rowStart: number,
	rowEnd: number,
	sourceLines: readonly string[],
	origin: BoxLike,
): ReadonlySet<number> {
	const owned = new Set<number>();
	const lineAt = (screenY: number) => sourceLines[screenY - origin.rect.y];
	for (let row = rowStart; row <= rowEnd; row++) {
		const line = sourceLines[row] ?? "";
		const screenY = origin.rect.y + row;
		if (frameBoxAt(origin, probeColumn(line), screenY, lineAt)) owned.add(row - rowStart);
	}
	return owned;
}

/** The single visible character at a terminal column, ANSI stripped. */
export function charAtColumn(line: string, column: number): string {
	return stripTerminalSequences(sliceByColumn(line, column, 1, true));
}

/**
 * The columns a frame's own verticals occupy on `line`, precisely: `box`'s
 * `rect.x` and `rect.x + rect.width - 1` are exactly where the layout tree
 * says this box's border sits, so — unlike `stripFrameColumns`, which works
 * on already-sliced text and can just look at the ends of the string — this
 * reads the *full* row at those absolute columns. Goes through `sliceByColumn`
 * rather than plain string indexing because `rect.x` is a terminal-cell
 * column, and a wide or multi-code-unit character earlier on the line would
 * put those two out of step.
 */
export function frameEdgeColumns(
	line: string,
	box: BoxLike,
): { left: number; right: number } | undefined {
	const leftCol = box.rect.x;
	const rightCol = box.rect.x + box.rect.width - 1;
	if (rightCol <= leftCol) return undefined;
	if (charAtColumn(line, leftCol) !== "│" || charAtColumn(line, rightCol) !== "│") return undefined;
	const left = charAtColumn(line, leftCol + 1) === " " ? leftCol + 2 : leftCol + 1;
	const right = charAtColumn(line, rightCol - 1) === " " ? rightCol - 1 : rightCol;
	return { left, right };
}
