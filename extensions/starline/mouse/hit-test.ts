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

/** Root first, innermost last. Empty when the point is outside the root. */
export function boxesAt(root: BoxLike, x: number, y: number): BoxLike[] {
	const path: BoxLike[] = [];
	let current: BoxLike | undefined = root;
	while (current && visible(current, x, y)) {
		path.push(current);
		current = current.children?.find((child) => visible(child, x, y));
	}
	return path;
}

export function boxFor(root: BoxLike, component: unknown): BoxLike | undefined {
	if (root.component === component) return root;
	for (const child of root.children ?? []) {
		const found = boxFor(child, component);
		if (found) return found;
	}
	return undefined;
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
