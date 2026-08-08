import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	type ComponentLike,
	createComponentTree,
	isComponentLike,
	isExpandableComponent,
} from "../../extensions/starline/mouse/component-tree";
import {
	ExpandableText,
	FixedLines,
	FramedToolComponent,
	makeTranscript,
	plainMarkdownTheme,
	rowRangeOf,
	ThrowingComponent,
} from "./component-graph";

/** The components on a path, innermost last — what the assertions read. */
function chain(tree: ReturnType<typeof createComponentTree>, row: number): unknown[] {
	return tree.pathAt(row).map((span) => span.component);
}

describe("isComponentLike", () => {
	it("is true for anything that renders", () => {
		expect(isComponentLike(new Container())).toBe(true);
		expect(isComponentLike({ render: () => [] })).toBe(true);
	});

	it("is false for anything that does not", () => {
		// The non-scroll path hands over the layout root, whose `component` can
		// be anything at all; nothing may throw on it.
		expect(isComponentLike({})).toBe(false);
		expect(isComponentLike(undefined)).toBe(false);
		expect(isComponentLike(null)).toBe(false);
		expect(isComponentLike("container")).toBe(false);
	});
});

describe("createComponentTree over a real transcript", () => {
	it("maps every row to the component that rendered it", () => {
		// Ranges come from `rowRangeOf`, which finds each component's own
		// `render()` output inside the transcript's — no hand-written rows, so
		// this cannot drift from what pi-tui actually produced the way the
		// layout fixtures did.
		const { document, tool, table, width, lines } = makeTranscript();
		const tree = createComponentTree(document, width, lines);
		const toolRows = rowRangeOf(lines, tool, width);
		const tableRows = rowRangeOf(lines, table, width);

		expect(tree.ownerAt(0)?.component).toBeInstanceOf(Text);
		for (let row = toolRows.start; row < toolRows.end; row++) {
			expect(tree.ownerAt(row)?.component).toBe(tool);
		}
		for (let row = tableRows.start; row < tableRows.end; row++) {
			expect(tree.ownerAt(row)?.component).toBe(table);
		}
		// The whole transcript is accounted for, with no gap between them.
		expect(toolRows.end).toBe(tableRows.start);
		expect(tableRows.end).toBe(lines.length);
	});

	it("reports the span a component occupies, matching its own render", () => {
		const { document, tool, width, lines } = makeTranscript();
		const tree = createComponentTree(document, width, lines);
		const span = tree.ownerAt(rowRangeOf(lines, tool, width).start);

		expect(span?.component).toBe(tool);
		expect(span?.lines).toEqual(tool.render(width));
		expect(span?.end).toBe((span?.start ?? 0) + tool.render(width).length);
		expect(lines.slice(span?.start, span?.end)).toEqual(tool.render(width));
	});

	it("returns the ancestor chain, root first", () => {
		// Two nested plain containers, the shape interactive-mode.js builds
		// (documentContainer > chatContainer > message). A walk that only ever
		// looked one level down would return two entries here, not three.
		const { document, chat, tool, width, lines } = makeTranscript();
		const tree = createComponentTree(document, width, lines);

		expect(chain(tree, rowRangeOf(lines, tool, width).start)).toEqual([document, chat, tool]);
	});

	it("stops at a component whose render is not its children concatenated", () => {
		// The tool box wraps its children in a frame, so its `children` are the
		// contents of the box rather than a partition of its rows. Descending on
		// `children` alone would hand a frame row to the Text inside it; the
		// verification step is what makes the tool box itself the answer.
		const { document, tool, width, lines } = makeTranscript();
		const tree = createComponentTree(document, width, lines);
		const toolRows = rowRangeOf(lines, tool, width);

		expect(tool.children.length).toBeGreaterThan(0);
		for (let row = toolRows.start; row < toolRows.end; row++) {
			expect(tree.ownerAt(row)?.component).toBe(tool);
		}
	});

	it("answers nothing for a row outside the root", () => {
		const { document, width, lines } = makeTranscript();
		const tree = createComponentTree(document, width, lines);

		expect(tree.pathAt(-1)).toEqual([]);
		expect(tree.pathAt(lines.length)).toEqual([]);
		expect(tree.ownerAt(lines.length)).toBeUndefined();
	});
});

describe("createComponentTree structural cases", () => {
	it("recurses to arbitrary depth through nested containers", () => {
		const leaf = new FixedLines(["deep"]);
		const level3 = new Container();
		level3.addChild(leaf);
		const level2 = new Container();
		level2.addChild(new FixedLines(["pad"]));
		level2.addChild(level3);
		const level1 = new Container();
		level1.addChild(level2);

		const tree = createComponentTree(level1, 20);

		expect(chain(tree, 1)).toEqual([level1, level2, level3, leaf]);
		expect(tree.ownerAt(1)?.start).toBe(1);
		expect(tree.ownerAt(1)?.end).toBe(2);
	});

	it("treats a component with no children as a leaf owning its whole range", () => {
		const leaf: ComponentLike = { render: () => ["a", "b", "c"] };
		const tree = createComponentTree(leaf, 20);

		expect(tree.pathAt(2)).toEqual([{ component: leaf, start: 0, end: 3, lines: ["a", "b", "c"] }]);
	});

	it("treats a child whose render throws as zero rows, and keeps going", () => {
		// One bad component must not take down a copy — and must not shift the
		// rows of the ones after it either, which is the part a bare try/catch
		// around the whole walk would get wrong.
		const before = new FixedLines(["before"]);
		const after = new FixedLines(["after"]);
		const parent = new Container();
		parent.addChild(before);
		parent.addChild(new ThrowingComponent());
		parent.addChild(after);

		const tree = createComponentTree(parent, 20, ["before", "after"]);

		expect(tree.ownerAt(0)?.component).toBe(before);
		expect(tree.ownerAt(1)?.component).toBe(after);
	});

	it("does not loop on a component that contains itself", () => {
		const cyclic = new Container();
		cyclic.addChild(cyclic);

		const tree = createComponentTree(cyclic, 20, ["only row"]);

		expect(tree.pathAt(0).length).toBeLessThanOrEqual(2);
	});

	it("renders only as far as the row it was asked about", () => {
		// Cost claim, asserted rather than described: a selection near the top
		// of a long transcript must not render everything below it.
		const renders: string[] = [];
		const parent = new Container();
		for (const name of ["a", "b", "c", "d"]) {
			parent.addChild({
				invalidate: () => {},
				render: () => {
					renders.push(name);
					return [name];
				},
			});
		}

		const tree = createComponentTree(parent, 20, ["a", "b", "c", "d"]);
		expect(tree.ownerAt(1)?.lines).toEqual(["b"]);
		expect(renders).toEqual(["a", "b"]);
	});

	it("reuses one render across every row of one tree", () => {
		let renders = 0;
		const child = {
			invalidate: () => {},
			render: () => {
				renders++;
				return ["x", "y", "z"];
			},
		};
		const parent = new Container();
		parent.addChild(child);

		const tree = createComponentTree(parent, 20, ["x", "y", "z"]);
		tree.ownerAt(0);
		tree.ownerAt(1);
		tree.ownerAt(2);

		expect(renders).toBe(1);
	});

	it("uses the width it was given, not the one a component prefers", () => {
		// The transcript is rendered at the scroll content box's width, which is
		// narrower than the terminal when a scrollbar is showing. Measuring at
		// the wrong width gives the wrong heights and every row below shifts.
		const tool = new FramedToolComponent();
		tool.addChild(new Text("some text that wraps at a narrow width", 0, 0));
		const parent = new Container();
		parent.addChild(tool);

		const wide = createComponentTree(parent, 60).ownerAt(1);
		const narrow = createComponentTree(parent, 20).ownerAt(1);

		expect(wide?.lines).toEqual(tool.render(60));
		expect(narrow?.lines).toEqual(tool.render(20));
		expect(narrow?.end).toBeGreaterThan(wide?.end ?? 0);
	});
});

describe("isExpandableComponent", () => {
	it("is true for a component exposing a callable setExpanded", () => {
		expect(isExpandableComponent(new FramedToolComponent())).toBe(true);
		// Looks nothing like a box, and that is the point: the duck type answers
		// "can this expand", never "did this draw a border".
		expect(isExpandableComponent(new ExpandableText(["plain output"]))).toBe(true);
	});

	it("is false for pi-tui's own leaf components", () => {
		expect(isExpandableComponent(new Markdown("| a |\n| --- |\n", 1, 0, plainMarkdownTheme))).toBe(
			false,
		);
		expect(isExpandableComponent(new Container())).toBe(false);
		expect(isExpandableComponent(new Text("hi", 0, 0))).toBe(false);
	});

	it("is false for non-objects and for a non-callable setExpanded", () => {
		expect(isExpandableComponent(undefined)).toBe(false);
		expect(isExpandableComponent(null)).toBe(false);
		expect(isExpandableComponent("box")).toBe(false);
		expect(isExpandableComponent({ setExpanded: true })).toBe(false);
	});
});
