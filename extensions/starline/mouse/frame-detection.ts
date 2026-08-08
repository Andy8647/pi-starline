/**
 * Deciding which rows of a selection are a box frame.
 *
 * Ownership comes from the *component* tree (`component-tree.ts`), not the
 * layout tree. It used to come from the layout tree, through `boxesAt`, and
 * that route cannot work: pi-tui gives a component its own layout box only
 * when it carries a `LAYOUT_NODE`, which is `Stack` and `ScrollView` and
 * nothing else. Every framed message component extends `Container`, so the
 * whole transcript is a single leaf box with `children: []` — there has never
 * been a box for a tool box to be found at. `component-tree.ts`'s docstring
 * has the mechanics and the proof that its row ranges are exact.
 *
 * The layout tree is still how we *get* there: it holds the transcript's leaf
 * box, whose `component` is the transcript `Container`, whose `rect.width` is
 * the width that container was rendered at, and whose rows are the
 * `scrollContentLines` a selection is extracted from.
 *
 * Every function here depends on nothing but a `BoxLike` tree, a component
 * graph and text — no `installPrototypePatch`, no receiver — which is what
 * makes the ownership decision itself directly testable, separately from
 * `index.ts`'s orchestration of when it gets called. See
 * `test/mouse/frame-detection.test.ts`.
 */

import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { type ComponentSpan, createComponentTree, isComponentLike } from "./component-tree";
import type { BoxLike } from "./hit-test";
import { isRuleRow, isVerticalGlyph } from "./selection-copy";

/**
 * The child laid out behind a scroll view, in the same tree walk
 * `scrollContentLinesFor` already does in `hit-test.ts` — mirrored here
 * rather than imported because that helper returns the rendered lines, and
 * this call site needs the box itself. Two things come off it:
 *
 * - `rect.width` — the width its component was rendered at, which is what
 *   `createComponentTree` has to be given to reproduce the same row heights
 *   (`layoutComponent`'s "scroll" branch renders the content at
 *   `node.state.getContentWidth(width)` and sets `rect.width` to it).
 * - `rect.y` — where content row 0 sits on screen, for the one caller that
 *   asks in screen coordinates (the highlight path). It is
 *   `viewportY - scrollTop`: the "scroll" branch lays the child out at
 *   `y - scrollTop` and then translates it back by the same amount.
 *
 * The copy path needs neither conversion — a selection's rows already *are*
 * content rows, and content row R is row R of the component tree.
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

/** A row carrying no visible characters — padding, not content. */
function isBlankRow(line: string): boolean {
	return stripTerminalSequences(line).trim().length === 0;
}

/** A frame's own rows, inclusive, in the row space of the component tree. */
export type FrameSpan = { component: unknown; top: number; bottom: number };

/**
 * The frame inside one component's own rendered rows, if it drew one.
 *
 * The test is the one every round of this feature has used: the component's
 * first and last rendered rows are box-drawing rules. The only concession to
 * what actually ships is that blank rows are skipped first — `pi-toolbox`'s
 * patched render opens with `const out: string[] = [""]` and Pi's own
 * `ToolExecutionComponent.render` does the same, so a real tool box's literal
 * first row is a spacer, not `╭────╮`.
 *
 * Rows outside `[top, bottom]` belong to the component but not to its frame,
 * and are left alone — the leading spacer, and any image rows appended after
 * the bottom rule (`pi-toolbox` keeps images outside the frame because their
 * lines carry terminal graphics payloads that padding would corrupt).
 */
function frameSpanOf(span: ComponentSpan): FrameSpan | undefined {
	const lines = span.lines;
	let first = 0;
	let last = lines.length - 1;
	while (first <= last && isBlankRow(lines[first] ?? "")) first++;
	while (last > first && isBlankRow(lines[last] ?? "")) last--;
	if (last <= first) return undefined;
	if (!isRuleRow(lines[first] ?? "") || !isRuleRow(lines[last] ?? "")) return undefined;
	return { component: span.component, top: span.start + first, bottom: span.start + last };
}

/** Answers "is this row inside a box frame" for one component graph. */
export type FrameFinder = (row: number) => FrameSpan | undefined;

/**
 * A `FrameFinder` over the component graph `origin`'s box rendered, with
 * `sourceLines` as that render's output.
 *
 * Build one per question (a copy, a click, one `applySelection` call) and let
 * it go: it holds a `ComponentTree`, which caches renders and has no
 * invalidation. Returns a finder that always answers `undefined` when there
 * is nothing to walk — no box, no lines, or a box whose `component` does not
 * render (the transcript's own root `VStack`, say, reached through the
 * non-scroll path). Nothing else in this module has to special-case that.
 *
 * The walk is innermost-first, and an expandable component that did *not*
 * draw a frame does not stop it — an expandable ancestor further out can
 * still own the row. A frame nested inside another frame therefore resolves
 * to the outer one, because that is where the component tree stops: the inner
 * box's rows only exist inside the outer box's own render, wrapped. One
 * frame's worth of border comes off, and what it was drawn around stays, the
 * same way a table inside a box stays.
 *
 * Note what is not consulted: `clip`. These are content rows, captured at
 * mouse-down and unchanged afterwards, while `clip` is rewritten every frame
 * to whatever the viewport shows. A frame scrolled out of view is still the
 * frame that rendered its rows, and the component tree has no way to think
 * otherwise — the bug where scrolling between selecting and pressing ctrl+c
 * brought the border back cannot be expressed on this route.
 */
export function frameFinderFor(
	origin: BoxLike | undefined,
	sourceLines: readonly string[] | undefined,
): FrameFinder {
	const component = origin?.component;
	if (!origin || !sourceLines || !isComponentLike(component)) return () => undefined;
	const tree = createComponentTree(component, origin.rect.width, sourceLines);
	return (row) => {
		const path = tree.pathAt(row);
		for (let index = path.length - 1; index >= 0; index--) {
			const span = path[index];
			if (!isExpandableComponent(span.component)) continue;
			const frame = frameSpanOf(span);
			if (frame) return frame;
		}
		return undefined;
	};
}

/**
 * Which rows of a `rowStart..rowEnd` extraction are rows of a box frame, as
 * indices into that extraction (0-based, matching what `copyableLines`
 * expects). `sourceLines` and `origin` are the transcript's rendered rows and
 * the layout box that produced them; `sourceLines[row]` is content row `row`,
 * which is also row `row` of the component tree.
 *
 * The set includes the frame's own top and bottom rules, not just its body:
 * `copyableLines` drops a rule row only when its index is in here, which is
 * what keeps a markdown table's `┌─┬─┐` while losing a tool box's `╭────╮`.
 */
export function frameRowsIn(
	rowStart: number,
	rowEnd: number,
	sourceLines: readonly string[],
	origin: BoxLike,
): ReadonlySet<number> {
	const owned = new Set<number>();
	const frameAt = frameFinderFor(origin, sourceLines);
	for (let row = rowStart; row <= rowEnd; row++) {
		const frame = frameAt(row);
		if (frame && row >= frame.top && row <= frame.bottom) owned.add(row - rowStart);
	}
	return owned;
}

/** The single visible character at a terminal column, ANSI stripped. */
function charAtColumn(line: string, column: number): string {
	return stripTerminalSequences(sliceByColumn(line, column, 1, true));
}

/**
 * The columns a frame's own verticals occupy on `line`, precisely.
 *
 * `box` is the box the frame was rendered inside — the transcript's content
 * box — and a frame spans it edge to edge, because `Container.render` hands
 * every child the full width and `pi-toolbox`'s `drawFrame` pads its body to
 * it. So the verticals sit at `rect.x` and `rect.x + rect.width - 1`. Unlike
 * `stripFrameColumns`, which works on already-sliced text and can look at the
 * ends of the string, this reads the *full* row at those absolute columns —
 * through `sliceByColumn` rather than plain string indexing, because `rect.x`
 * is a terminal-cell column and a wide or multi-code-unit character earlier
 * on the line would put the two out of step.
 *
 * Returns `undefined` when either column is not a vertical, which is also how
 * a row that the scrollbar has painted over degrades: no shrink, rather than
 * a wrong one.
 */
export function frameEdgeColumns(
	line: string,
	box: BoxLike,
): { left: number; right: number } | undefined {
	const leftCol = box.rect.x;
	const rightCol = box.rect.x + box.rect.width - 1;
	if (rightCol <= leftCol) return undefined;
	if (!isVerticalGlyph(charAtColumn(line, leftCol))) return undefined;
	if (!isVerticalGlyph(charAtColumn(line, rightCol))) return undefined;
	const left = charAtColumn(line, leftCol + 1) === " " ? leftCol + 2 : leftCol + 1;
	const right = charAtColumn(line, rightCol - 1) === " " ? rightCol - 1 : rightCol;
	return { left, right };
}
