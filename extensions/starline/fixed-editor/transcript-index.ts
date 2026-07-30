/**
 * Which transcript line belongs to which component.
 *
 * A click arrives as a screen row, and turning that into "this tool box" needs
 * the line ranges each component contributed to the frame. Pi's root render is
 * a flat `string[]`, but the composition behind it is strict: `Container.render`
 * concatenates its children in order and adds nothing of its own. So a counter
 * threaded through one render pass yields exact ranges.
 *
 * The counting lives in a transparent wrapper around each component's `render`,
 * rather than in a second render pass of our own — a markdown or tool box
 * render is far too expensive to do twice a frame, and a second pass could
 * disagree with the first anyway.
 *
 * Nested accounting is checked against the parent's own output: when the two
 * disagree — a container that renders its children out of order, or not at all
 * — that parent's ranges are dropped instead of trusted, and the click falls
 * back to doing nothing.
 *
 * @internal
 */

import { type ExpandableNode, isExpandableNode } from "./expandable";

type Renderable = { render: (width: number) => string[] };

type IndexedRange = {
	node: ExpandableNode;
	/** First root line of the component, inclusive. */
	start: number;
	/** One past its last root line. */
	end: number;
};

const WRAPPED = Symbol("starline.transcriptIndexWrapped");

type WrappedRenderable = Renderable & {
	[WRAPPED]?: { descriptor: PropertyDescriptor | undefined; original: Renderable["render"] };
};

function isRenderable(value: unknown): value is WrappedRenderable {
	if (typeof value !== "object" || value === null) return false;
	return typeof (value as Renderable).render === "function";
}

function childrenOf(value: unknown): unknown[] | null {
	if (typeof value !== "object" || value === null) return null;
	const children = (value as { children?: unknown }).children;
	return Array.isArray(children) ? children : null;
}

export class TranscriptIndex {
	/** Ranges from the last completed render pass. */
	private ranges: IndexedRange[] = [];
	/** Ranges being collected by the pass in flight. */
	private collected: IndexedRange[] = [];
	/** Whether a pass is in flight; wrappers are inert outside one. */
	private collecting = false;
	private cursor = 0;

	/**
	 * Components whose render is owned by someone else — the pinned cluster,
	 * which the compositor hides and restores itself. Wrapping those would put
	 * two patches on one method and make the restore order matter.
	 */
	private readonly skip: ReadonlySet<unknown>;

	constructor(skip: Iterable<unknown> = []) {
		this.skip = new Set([...skip].filter((entry) => entry !== null && entry !== undefined));
	}

	/**
	 * Install or refresh the wrappers and start a pass. Children come and go
	 * across a session — a new message, a compaction clearing the chat — so the
	 * tree is walked every frame. That is one array pass plus a symbol check per
	 * component, and no render work.
	 */
	beginPass(rootChildren: unknown[]): void {
		this.collected = [];
		this.cursor = 0;
		for (const child of rootChildren) {
			if (this.skip.has(child)) continue;
			this.wrap(child, true);
			for (const grandchild of childrenOf(child) ?? []) this.wrap(grandchild, false);
		}
		this.collecting = true;
	}

	/** Finish the pass and publish its ranges. */
	endPass(): void {
		this.collecting = false;
		this.ranges = this.collected;
	}

	/** Abandon the pass without publishing, leaving the last good ranges up. */
	abortPass(): void {
		this.collecting = false;
		this.collected = [];
	}

	/** The expandable component covering this root line, if any. */
	hitTest(line: number): ExpandableNode | null {
		for (const range of this.ranges) {
			if (line >= range.start && line < range.end) return range.node;
		}
		return null;
	}

	/** Root line range of a component, for callers that need to keep it in view. */
	rangeOf(node: ExpandableNode): { start: number; end: number } | null {
		for (const range of this.ranges) {
			if (range.node === node) return { start: range.start, end: range.end };
		}
		return null;
	}

	/** Take the wrappers off every component still in the tree. */
	restore(rootChildren: unknown[]): void {
		this.collecting = false;
		this.ranges = [];
		this.collected = [];
		for (const child of rootChildren) {
			this.unwrap(child);
			for (const grandchild of childrenOf(child) ?? []) this.unwrap(grandchild);
		}
	}

	private wrap(value: unknown, isParent: boolean): void {
		if (!isRenderable(value) || value[WRAPPED]) return;
		const descriptor = Object.getOwnPropertyDescriptor(value, "render");
		if (descriptor && (!("value" in descriptor) || descriptor.writable !== true)) return;
		if (!descriptor && !Object.isExtensible(value)) return;

		const target = value;
		const original = target.render.bind(target) as Renderable["render"];

		const wrapper = (width: number): string[] => {
			if (!this.collecting) return original(width);
			const start = this.cursor;
			const savedRanges = this.collected.length;
			const lines = original(width);
			const length = Array.isArray(lines) ? lines.length : 0;
			if (isParent) {
				// The parent's own output is the authority. When the children did
				// not add up to it, their ranges cannot be trusted.
				if (this.cursor !== start + length) this.collected.length = savedRanges;
			} else if (isExpandableNode(target)) {
				this.collected.push({ node: target, start, end: start + length });
			}
			this.cursor = start + length;
			return lines;
		};

		Object.defineProperty(target, "render", {
			configurable: true,
			enumerable: descriptor?.enumerable ?? false,
			writable: true,
			value: wrapper,
		});
		Object.defineProperty(target, WRAPPED, {
			configurable: true,
			enumerable: false,
			writable: true,
			value: { descriptor, original },
		});
	}

	private unwrap(value: unknown): void {
		if (!isRenderable(value)) return;
		const mark = value[WRAPPED];
		if (!mark) return;
		if (mark.descriptor) {
			Object.defineProperty(value, "render", mark.descriptor);
		} else {
			Reflect.deleteProperty(value, "render");
		}
		Reflect.deleteProperty(value, WRAPPED);
	}
}
