import { describe, expect, it, vi } from "vitest";

import { TranscriptIndex } from "../extensions/starline/fixed-editor/transcript-index";

/** A leaf that renders a fixed number of rows. */
function makeLeaf(label: string, rows: number) {
	return {
		render: (width: number) => Array.from({ length: rows }, (_, i) => `${label}-${i}:${width}`),
	};
}

/** A leaf Pi's ctrl+o would reach. */
function makeBox(label: string, rows: number) {
	return { ...makeLeaf(label, rows), setExpanded: vi.fn() };
}

/** Pi's `Container.render`: its children, in order, and nothing of its own. */
function makeContainer(children: { render: (width: number) => string[] }[]) {
	return {
		children,
		render: (width: number) => children.flatMap((child) => child.render(width)),
	};
}

/** Render the tree the way the patched TUI.render does. */
function renderRoot(index: TranscriptIndex, children: { render: (w: number) => string[] }[]) {
	index.beginPass(children);
	const lines = children.flatMap((child) => child.render(80));
	index.endPass();
	return lines;
}

describe("TranscriptIndex", () => {
	it("maps a line to the box that drew it", () => {
		const first = makeBox("first", 3);
		const second = makeBox("second", 4);
		const chat = makeContainer([first, second]);
		const index = new TranscriptIndex();

		const lines = renderRoot(index, [chat]);

		expect(lines).toHaveLength(7);
		expect(index.hitTest(0)).toBe(first);
		expect(index.hitTest(2)).toBe(first);
		expect(index.hitTest(3)).toBe(second);
		expect(index.hitTest(6)).toBe(second);
		expect(index.hitTest(7)).toBeNull();
	});

	it("offsets the chat by whatever the containers above it drew", () => {
		const box = makeBox("box", 2);
		const header = makeContainer([makeLeaf("header", 5)]);
		const chat = makeContainer([box]);
		const index = new TranscriptIndex();

		renderRoot(index, [header, chat]);

		expect(index.hitTest(4)).toBeNull();
		expect(index.hitTest(5)).toBe(box);
		expect(index.rangeOf(box)).toEqual({ start: 5, end: 7 });
	});

	it("indexes nothing for children that are not expandable", () => {
		const chat = makeContainer([makeLeaf("plain", 3)]);
		const index = new TranscriptIndex();

		renderRoot(index, [chat]);

		expect(index.hitTest(0)).toBeNull();
	});

	it("re-indexes when the chat gains a child", () => {
		const first = makeBox("first", 2);
		const chat = makeContainer([first]);
		const index = new TranscriptIndex();
		renderRoot(index, [chat]);

		const second = makeBox("second", 2);
		chat.children.push(second);
		renderRoot(index, [chat]);

		expect(index.hitTest(2)).toBe(second);
	});

	it("indexes nothing after the chat is cleared", () => {
		const box = makeBox("box", 2);
		const chat = makeContainer([box]);
		const index = new TranscriptIndex();
		renderRoot(index, [chat]);

		chat.children.length = 0;
		renderRoot(index, [chat]);

		expect(index.hitTest(0)).toBeNull();
	});

	// A container whose own output does not add up to its children's cannot be
	// trusted to have composed them in order, and a wrong range would expand the
	// wrong box.
	it("drops a container's ranges when its own output disagrees", () => {
		const box = makeBox("box", 3);
		const liar = {
			children: [box],
			render: (width: number) => ["decoration", ...box.render(width)],
		};
		const index = new TranscriptIndex();

		renderRoot(index, [liar]);

		expect(index.hitTest(0)).toBeNull();
		expect(index.hitTest(1)).toBeNull();
	});

	it("leaves the components it is told to skip untouched", () => {
		const editor = makeBox("editor", 1);
		const original = editor.render;
		const index = new TranscriptIndex([editor]);

		index.beginPass([editor]);
		expect(editor.render).toBe(original);
		index.endPass();
	});

	it("is inert outside a pass, so a cluster render cannot pollute it", () => {
		const box = makeBox("box", 2);
		const chat = makeContainer([box]);
		const index = new TranscriptIndex();
		renderRoot(index, [chat]);

		// A render between frames — the pinned cluster's, say — must not shift the
		// ranges the last pass published.
		chat.render(80);
		expect(index.rangeOf(box)).toEqual({ start: 0, end: 2 });
	});

	it("keeps the last good ranges when a pass throws", () => {
		const box = makeBox("box", 2);
		const chat = makeContainer([box]);
		const index = new TranscriptIndex();
		renderRoot(index, [chat]);

		index.beginPass([chat]);
		index.abortPass();

		expect(index.hitTest(0)).toBe(box);
	});

	it("puts every render back, prototype methods included", () => {
		const box = makeBox("box", 2);
		const own = box.render;
		const chat = makeContainer([box]);
		const chatOwn = chat.render;
		const index = new TranscriptIndex();
		renderRoot(index, [chat]);
		expect(box.render).not.toBe(own);

		index.restore([chat]);

		expect(box.render).toBe(own);
		expect(chat.render).toBe(chatOwn);
		expect(index.hitTest(0)).toBeNull();
	});

	it("wraps a prototype render without leaving an own property behind", () => {
		class Box {
			setExpanded = vi.fn();
			render(width: number): string[] {
				return [`proto:${width}`];
			}
		}
		const box = new Box();
		const chat = makeContainer([box]);
		const index = new TranscriptIndex();
		renderRoot(index, [chat]);
		expect(index.hitTest(0)).toBe(box);

		index.restore([chat]);

		expect(Object.hasOwn(box, "render")).toBe(false);
		expect(box.render(80)).toEqual(["proto:80"]);
	});
});
