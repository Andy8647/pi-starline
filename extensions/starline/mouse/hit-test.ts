/**
 * Which of Pi's components owns a screen cell.
 *
 * Pi's layout tree carries every component's rectangle, so a tool box is
 * identified by identity rather than by the shape of the text it drew. That is
 * what retires the old `frame.ts`, which recognised a box by counting `│` and
 * had to exclude markdown tables by hand.
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type BoxLike = {
	component?: unknown;
	rect: Rect;
	clip?: Rect;
	children?: readonly BoxLike[];
};

export function rectContains(rect: Rect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function visible(box: BoxLike, x: number, y: number): boolean {
	if (!rectContains(box.rect, x, y)) return false;
	// A box scrolled partly out of its container draws nothing outside the clip.
	return box.clip ? rectContains(box.clip, x, y) : true;
}

export type HitTestOptions = {
	/**
	 * Match on `rect` alone, ignoring `clip`.
	 *
	 * `clip` answers "is this cell painted right now" — pi-tui rewrites it on
	 * every frame to the intersection of the box with its scroll viewport
	 * (`updateClips` in `layout.js`), while `rect` stays in the content's own
	 * coordinates. So a question asked in *screen* space (which box drew the
	 * cell under the pointer) must honour it, and a question asked in
	 * *content* space (which component owns content row N of a scroll view)
	 * must not: content row N belongs to the same component whether or not the
	 * viewport happens to be showing it.
	 *
	 * Frame ownership used to be the caller; it moved to `component-tree.ts`,
	 * where the distinction cannot arise at all because a component graph has
	 * no clip to consult. This stays for the next content-space question asked
	 * of the layout tree — the distinction is a property of `clip`, not of the
	 * caller that first ran into it.
	 */
	ignoreClip?: boolean;
};

/** Root first, innermost last. Empty when the point is outside the root. */
export function boxesAt(root: BoxLike, x: number, y: number, options?: HitTestOptions): BoxLike[] {
	const hit = options?.ignoreClip
		? (box: BoxLike) => rectContains(box.rect, x, y)
		: (box: BoxLike) => visible(box, x, y);
	const path: BoxLike[] = [];
	let current: BoxLike | undefined = root;
	while (current && hit(current)) {
		path.push(current);
		current = current.children?.find(hit);
	}
	return path;
}

/**
 * The first box, depth first, whose component satisfies `predicate`.
 *
 * `boxFor` asks "which box is this component's", which is the question when
 * the component is itself a layout node. It is not always: a component with no
 * `LAYOUT_NODE` is folded into its parent's leaf box, so the box that *covers*
 * it belongs to an ancestor and the only way to recognise it is through that
 * ancestor. `editor-mouse.ts` is the caller that needs the looser question.
 */
export function boxMatching(
	root: BoxLike | undefined,
	predicate: (component: unknown) => boolean,
): BoxLike | undefined {
	if (!root) return undefined;
	if (predicate(root.component)) return root;
	for (const child of root.children ?? []) {
		const found = boxMatching(child, predicate);
		if (found) return found;
	}
	return undefined;
}

export function boxFor(root: BoxLike, component: unknown): BoxLike | undefined {
	return boxMatching(root, (candidate) => candidate === component);
}

export type ScrollBoxLike = BoxLike & {
	scrollView?: unknown;
	scrollContentLines?: readonly string[];
};

/**
 * The lines behind a scroll view, found by walking the layout tree. This is
 * `getScrollViewBox`'s own logic from `layout.js`, mirrored here in miniature
 * because it is not exported from pi-tui's published entry point.
 */
export function scrollContentLinesFor(
	root: ScrollBoxLike | undefined,
	scrollView: unknown,
): readonly string[] | undefined {
	if (!root) return undefined;
	if (root.scrollView === scrollView) return root.scrollContentLines;
	for (const child of root.children ?? []) {
		const found = scrollContentLinesFor(child as ScrollBoxLike, scrollView);
		if (found) return found;
	}
	return undefined;
}

/**
 * The box holding a scroll view's content — the same walk
 * `scrollContentLinesFor` does, returning the box rather than its rows. Two
 * things come off it that the lines alone cannot answer:
 *
 * - `rect.width` — the width its component was rendered at, which is what
 *   `createComponentTree` has to be given to reproduce the same row heights
 *   (`layoutComponent`'s "scroll" branch renders the content at
 *   `node.state.getContentWidth(width)` and sets `rect.width` to it).
 * - `rect.y` — where content row 0 sits on screen, for a caller asking in
 *   screen coordinates. It is `viewportY - scrollTop`: the "scroll" branch
 *   lays the child out at `y - scrollTop` and then translates it back by the
 *   same amount. That relation is pinned in
 *   `test/contract/transcript-layout.test.ts`.
 *
 * Like the rest of this module it currently has no production caller — the
 * screen-row-to-content-row conversion is what Task 8's click-to-expand needs
 * to find the component under a click.
 */
export function scrollContentOrigin(
	root: BoxLike | undefined,
	scrollView: unknown,
): BoxLike | undefined {
	if (!root) return undefined;
	if ((root as ScrollBoxLike).scrollView === scrollView) return root.children?.[0];
	for (const child of root.children ?? []) {
		const found = scrollContentOrigin(child, scrollView);
		if (found) return found;
	}
	return undefined;
}
