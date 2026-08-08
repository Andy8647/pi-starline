/**
 * Which of Pi's components rendered a given row of a container's output.
 *
 * `hit-test.ts` answers the same question from Pi's *layout* tree, and for
 * the editor and the transcript viewport that is the right tree. It cannot
 * answer it for a message inside the transcript, because there is no box to
 * find: `layoutComponent` (pi-tui's `layout.js`) only builds child boxes for
 * a component carrying a `LAYOUT_NODE`, which is `Stack` and `ScrollView` and
 * nothing else. Every message component extends `Container`, which has none,
 * so the whole transcript is one leaf box with `children: []` and a `lines`
 * array. Ownership inside that array has to come from the *component* tree.
 *
 * It can, exactly. `Container.render(width)` (pi-tui's `tui.ts`) renders each
 * child at the **same width** and concatenates the results in order, with no
 * gap, padding or reordering:
 *
 * ```ts
 * render(width: number): string[] {
 * 	const lines: string[] = [];
 * 	for (const child of this.children) {
 * 		for (const line of child.render(width)) lines.push(line);
 * 	}
 * 	return lines;
 * }
 * ```
 *
 * So a child occupies rows `[sum of its preceding siblings' rendered heights,
 * + its own rendered height)` of its parent's output, and the same rule
 * applies again inside a child that is itself a container. Rendering is the
 * only way to learn those heights — a component's height is whatever its
 * `render` returns.
 *
 * ## Why the walk verifies instead of trusting `children`
 *
 * A `Container` subclass may override `render`, and the ones that matter do:
 * `pi-toolbox` replaces `ToolExecutionComponent.prototype.render` with one
 * that draws `╭─╮ │ ╰─╯` around its children's lines. Its `children` are then
 * no longer a partition of its own rows at all — they are the *contents* of a
 * frame it added rows around. Descending on the strength of `children` alone
 * would attribute the frame's rows to whichever child happened to line up.
 *
 * So each step of the walk checks its own premise: a child's rendered lines
 * must appear **verbatim, in place** in the parent's output at the offset the
 * running total predicts. If they do, the offset is not an estimate, it is
 * the parent's own output read back. If they do not, the parent is not a
 * plain concatenator and the walk stops there — which is the correct answer,
 * because the parent is then the component that actually drew those rows.
 *
 * The check is a prefix check, and stops at the child containing the target
 * row: siblings after it are never rendered. That is cheaper than verifying
 * the whole parent and just as exact — matching `parent.lines[0 .. cursor +
 * height)` against the concatenation of children `0..k` establishes exactly
 * where child `k` sits, and nothing later in the parent's output can move it.
 *
 * ## Cost
 *
 * Every child up to the target row is rendered once, at each level. This runs
 * on a copy and on a click, never per frame — and components cache their own
 * renders (pi-tui's `Text` and `Markdown` keep a `cachedLines`; `pi-toolbox`
 * keeps a `__frameCache`), so a repeat render of an unchanged component is
 * usually a cache probe rather than real work. A `ComponentTree` also caches
 * every render it does, so asking about a hundred rows of one selection costs
 * one pass, not a hundred.
 *
 * Nothing here imports pi-tui: `ComponentLike` is the structural slice a
 * component has to expose for this to work, so the tests can build a real
 * component graph out of pi-tui's own `Container` and the extension does not
 * take a dependency on its class identities.
 */

/** The slice of a Pi component this module reads. */
export type ComponentLike = {
	children?: readonly unknown[];
	render(width: number): string[];
};

/**
 * One component's own rows, as an interval of the tree root's output.
 * `start` is inclusive and `end` exclusive, both in the root's row space;
 * `lines` are the component's own rendered rows, so `lines[row - start]` is
 * the text at root row `row`.
 */
export type ComponentSpan = {
	component: unknown;
	start: number;
	end: number;
	lines: readonly string[];
};

export type ComponentTree = {
	/** Root first, innermost last. Empty when `row` is outside the root. */
	pathAt(row: number): ComponentSpan[];
	/** The innermost component that rendered `row`. */
	ownerAt(row: number): ComponentSpan | undefined;
};

/** Whether `value` renders — the one method this module needs to call. */
export function isComponentLike(value: unknown): value is ComponentLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { render?: unknown }).render === "function"
	);
}

/**
 * Whether `component` is one of Pi's expandable message components — the duck
 * type for "clicking this could expand or collapse it". Verified against the
 * installed `pi-coding-agent`: `bash-execution`, `branch-summary-message`,
 * `compaction-summary-message`, `custom-entry`, `custom-message`,
 * `skill-invocation-message` and `tool-execution` all expose `setExpanded`;
 * pi-tui's own leaf components (`Text`, `Markdown`, `Container`) expose none.
 *
 * Note what this does *not* say: nothing about how the component looks. It
 * was briefly used to infer that a component had drawn a border, which is
 * exactly the inference frame-free selection was cut for — `setExpanded` says
 * a box could be expanded, never that a box was drawn. It is kept for the
 * question it can answer, which is Task 8's.
 */
export function isExpandableComponent(component: unknown): boolean {
	return (
		typeof component === "object" &&
		component !== null &&
		typeof (component as { setExpanded?: unknown }).setExpanded === "function"
	);
}

function childrenOf(component: unknown): readonly unknown[] {
	const children = (component as { children?: unknown }).children;
	return Array.isArray(children) ? children : [];
}

/**
 * A component's rendered rows, memoised, and never able to take a copy down
 * with it: a component whose `render` throws (or returns something that is
 * not an array of lines) is treated as zero rows tall. Its siblings keep
 * their own offsets, because a zero-height child advances the running total
 * by zero — the same thing a component that legitimately renders nothing
 * does, which both `ToolExecutionComponent` (`if (this.hideComponent) return
 * []`) and `pi-toolbox`'s framed render already do routinely.
 */
function renderOnce(
	component: unknown,
	width: number,
	cache: Map<unknown, readonly string[]>,
): readonly string[] {
	const cached = cache.get(component);
	if (cached) return cached;
	let lines: readonly string[] = [];
	if (isComponentLike(component)) {
		try {
			const rendered = component.render(width);
			if (Array.isArray(rendered)) lines = rendered;
		} catch {
			lines = [];
		}
	}
	cache.set(component, lines);
	return lines;
}

/**
 * The child of `parent` that rendered `row`, or `undefined` when `parent`
 * turns out not to be a plain concatenation of its children (see the module
 * docstring) or has no child there.
 */
function childSpanAt(
	parent: ComponentSpan,
	row: number,
	width: number,
	cache: Map<unknown, readonly string[]>,
): ComponentSpan | undefined {
	let cursor = parent.start;
	for (const child of childrenOf(parent.component)) {
		const lines = renderOnce(child, width, cache);
		for (let offset = 0; offset < lines.length; offset++) {
			if (parent.lines[cursor - parent.start + offset] !== lines[offset]) return undefined;
		}
		if (row >= cursor && row < cursor + lines.length) {
			return { component: child, start: cursor, end: cursor + lines.length, lines };
		}
		cursor += lines.length;
	}
	return undefined;
}

/**
 * A row→component map over the component graph rooted at `root`, rendered at
 * `width`.
 *
 * `width` must be the width `root` was actually rendered at — for the
 * transcript that is the scroll content box's `rect.width`, which is what
 * pi-tui passed to `renderCached` when it produced `scrollContentLines`.
 * `rootLines` is that same output when the caller already holds it (the
 * selection path does), which saves re-rendering the entire transcript to
 * learn something it was just handed; omit it and the root renders once.
 *
 * The returned tree caches every render it performs, so it is worth keeping
 * for the whole of one question (a selection's rows) and throwing away after
 * — it holds no invalidation logic and will happily hand back stale rows if
 * kept across a component update.
 */
export function createComponentTree(
	root: ComponentLike,
	width: number,
	rootLines?: readonly string[],
): ComponentTree {
	const cache = new Map<unknown, readonly string[]>();
	if (rootLines) cache.set(root, rootLines);

	const pathAt = (row: number): ComponentSpan[] => {
		if (!Number.isInteger(row) || row < 0) return [];
		const lines = renderOnce(root, width, cache);
		if (row >= lines.length) return [];
		const path: ComponentSpan[] = [{ component: root, start: 0, end: lines.length, lines }];
		// A component that is its own descendant would otherwise loop here.
		const seen = new Set<unknown>([root]);
		let current = path[0];
		for (;;) {
			const child = childSpanAt(current, row, width, cache);
			if (!child || seen.has(child.component)) break;
			seen.add(child.component);
			path.push(child);
			current = child;
		}
		return path;
	};

	return { pathAt, ownerAt: (row) => pathAt(row).at(-1) };
}
