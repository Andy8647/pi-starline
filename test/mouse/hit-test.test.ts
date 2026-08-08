import { describe, expect, it } from "vitest";
import {
	type BoxLike,
	boxesAt,
	boxFor,
	rectContains,
} from "../../extensions/starline/mouse/hit-test";

const editor = { name: "editor" };
const toolBox = { name: "toolBox" };
const transcript = { name: "transcript" };

const tree: BoxLike = {
	component: { name: "root" },
	rect: { x: 0, y: 0, width: 80, height: 24 },
	children: [
		{
			component: transcript,
			rect: { x: 0, y: 0, width: 80, height: 20 },
			children: [{ component: toolBox, rect: { x: 2, y: 5, width: 76, height: 6 }, children: [] }],
		},
		{ component: editor, rect: { x: 0, y: 20, width: 80, height: 4 }, children: [] },
	],
};

describe("rectContains", () => {
	it("includes the top-left corner and excludes the far edges", () => {
		const rect = { x: 2, y: 5, width: 4, height: 3 };
		expect(rectContains(rect, 2, 5)).toBe(true);
		expect(rectContains(rect, 5, 7)).toBe(true);
		expect(rectContains(rect, 6, 7)).toBe(false);
		expect(rectContains(rect, 5, 8)).toBe(false);
	});
});

describe("boxesAt", () => {
	it("returns the path from root to the innermost box", () => {
		const path = boxesAt(tree, 10, 6);
		expect(path.map((box) => box.component)).toEqual([tree.component, transcript, toolBox]);
	});

	it("stops at the editor when the pointer is below the transcript", () => {
		const path = boxesAt(tree, 10, 21);
		expect(path.at(-1)?.component).toBe(editor);
	});

	it("returns an empty path for a point outside the root", () => {
		expect(boxesAt(tree, 200, 200)).toEqual([]);
	});

	it("honours a clip rect narrower than the box", () => {
		const clipped: BoxLike = {
			component: { name: "clipped" },
			rect: { x: 0, y: 0, width: 80, height: 24 },
			clip: { x: 0, y: 0, width: 10, height: 24 },
			children: [],
		};
		expect(boxesAt(clipped, 5, 1)).toHaveLength(1);
		expect(boxesAt(clipped, 20, 1)).toHaveLength(0);
	});

	it("ignores clip on request, and descends into clipped-out children", () => {
		// Content-space questions ("which component owns content row N") must
		// not depend on where the viewport happens to be — see HitTestOptions.
		// The child here is scrolled entirely above the fold, the way pi-tui
		// leaves a scrolled transcript's boxes: rect in content coordinates,
		// clip collapsed onto the viewport.
		const child: BoxLike = {
			component: { name: "child" },
			rect: { x: 0, y: -15, width: 10, height: 3 },
			clip: { x: 0, y: 0, width: 10, height: 0 },
			children: [],
		};
		const content: BoxLike = {
			component: { name: "content" },
			rect: { x: 0, y: -15, width: 10, height: 24 },
			clip: { x: 0, y: 0, width: 10, height: 9 },
			children: [child],
		};
		expect(boxesAt(content, 0, -15)).toHaveLength(0);
		expect(boxesAt(content, 0, -15, { ignoreClip: true }).map((box) => box.component)).toEqual([
			content.component,
			child.component,
		]);
	});
});

describe("boxFor", () => {
	it("finds a box by component identity", () => {
		expect(boxFor(tree, editor)?.rect).toEqual({ x: 0, y: 20, width: 80, height: 4 });
	});

	it("returns undefined for a component that is not mounted", () => {
		expect(boxFor(tree, { name: "ghost" })).toBeUndefined();
	});
});
