import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	frameEdgeColumns,
	frameFinderFor,
	frameRowsIn,
	isExpandableComponent,
} from "../../extensions/starline/mouse/frame-detection";
import type { BoxLike } from "../../extensions/starline/mouse/hit-test";
import { copyableLines } from "../../extensions/starline/mouse/selection-copy";
import {
	ExpandableText,
	FramedToolComponent,
	makeTranscript,
	plainMarkdownTheme,
	rowRangeOf,
} from "./component-graph";

/**
 * The layout box pi-tui actually builds for a transcript: one leaf, holding
 * the whole `Container`'s render, with **no children**. Every fixture this
 * feature was built on gave the frame its own nested box; none exists, which
 * is why frame ownership had to move off the layout tree. Reproduced here
 * from `document`'s own render so nothing is hand-counted.
 */
function transcriptBox(component: object, width: number, lines: readonly string[]): BoxLike {
	return {
		component,
		rect: { x: 0, y: 0, width, height: lines.length },
		children: [],
	};
}

/** What `selectionText` does to a full-width selection: slice, then trimEnd. */
function selectRows(lines: readonly string[], start: number, end: number): string[] {
	return lines.slice(start, end + 1).map((line) => line.trimEnd());
}

describe("isExpandableComponent", () => {
	it("is true for a component exposing setExpanded", () => {
		expect(isExpandableComponent(new FramedToolComponent())).toBe(true);
	});

	it("is false for the components that draw a table — Markdown has no setExpanded", () => {
		expect(isExpandableComponent(new Markdown("| a |\n| --- |\n", 1, 0, plainMarkdownTheme))).toBe(
			false,
		);
		expect(isExpandableComponent(new Container())).toBe(false);
		expect(isExpandableComponent(new Text("hi", 0, 0))).toBe(false);
	});

	it("is false for non-objects", () => {
		expect(isExpandableComponent(undefined)).toBe(false);
		expect(isExpandableComponent(null)).toBe(false);
		expect(isExpandableComponent("box")).toBe(false);
	});
});

describe("frameRowsIn over a real component graph", () => {
	it("owns a tool box's frame rows and nothing else", () => {
		const { document, tool, table, width, lines } = makeTranscript();
		const origin = transcriptBox(document, width, lines);
		const toolRows = rowRangeOf(lines, tool, width);
		const tableRows = rowRangeOf(lines, table, width);

		const owned = frameRowsIn(0, lines.length - 1, lines, origin);

		// The tool box's own leading spacer row is not part of its frame.
		expect(owned.has(toolRows.start)).toBe(false);
		for (let row = toolRows.start + 1; row < toolRows.end; row++) {
			expect(owned.has(row)).toBe(true);
		}
		for (let row = tableRows.start; row < tableRows.end; row++) {
			expect(owned.has(row)).toBe(false);
		}
		expect(owned.has(0)).toBe(false); // the plain Text message
	});

	it("copies a selection dragged across a frame and a table: no frame, every pipe", () => {
		// The case that started all of this. One selection covers the tool box
		// and the markdown table right under it; the box loses its border and
		// the table loses nothing at all.
		const { document, tool, table, width, lines } = makeTranscript();
		const origin = transcriptBox(document, width, lines);
		const start = rowRangeOf(lines, tool, width).start;
		const end = lines.length - 1;

		const owned = frameRowsIn(start, end, lines, origin);
		const copied = copyableLines(selectRows(lines, start, end), owned);

		expect(copied).toEqual([
			"", // the tool box's own spacer, left alone
			"hello from the tool",
			" ┌───┬───┐",
			" │ a │ b │",
			" ├───┼───┤",
			" │ c │ d │",
			" └───┴───┘",
		]);
		// Byte-identical, not merely pipe-preserving: the table's rows come back
		// exactly as pi-tui's Markdown rendered them.
		const tableRows = rowRangeOf(lines, table, width);
		expect(copied.slice(-5)).toEqual(selectRows(lines, tableRows.start, tableRows.end - 1));
	});

	it("leaves a lone table selection completely alone", () => {
		const { document, table, width, lines } = makeTranscript();
		const origin = transcriptBox(document, width, lines);
		const rows = rowRangeOf(lines, table, width);

		const owned = frameRowsIn(rows.start, rows.end - 1, lines, origin);

		expect(owned.size).toBe(0);
		expect(copyableLines(selectRows(lines, rows.start, rows.end - 1), owned)).toEqual(
			selectRows(lines, rows.start, rows.end - 1),
		);
	});

	it("does not depend on where the viewport is", () => {
		// The scroll-out-of-view leak, retired by construction rather than by an
		// option: the component graph has no `clip`, no `scrollTop` and no
		// screen rows in it, so "which component rendered content row N" cannot
		// change when the transcript scrolls between selecting and copying.
		// This asserts that the origin box's own geometry is not consulted for
		// anything but its width.
		const { document, tool, width, lines } = makeTranscript();
		const onScreen = transcriptBox(document, width, lines);
		const scrolledAway: BoxLike = {
			component: document,
			rect: { x: 0, y: -15, width, height: lines.length },
			clip: { x: 0, y: 0, width, height: 0 },
			children: [],
		};
		const rows = rowRangeOf(lines, tool, width);

		expect([...frameRowsIn(rows.start, rows.end - 1, lines, scrolledAway)]).toEqual([
			...frameRowsIn(rows.start, rows.end - 1, lines, onScreen),
		]);
	});

	it("does not treat an expandable component that drew no frame as one", () => {
		// `setExpanded` says "a frame could be drawn around this", not "one was".
		// Pi's own tool boxes are exactly this without pi-toolbox installed: a
		// background fill and no border glyphs. Their rows must come back
		// untouched, which is what keeps the structural gate from becoming a
		// licence to strip.
		const message = new ExpandableText(["plain tool output", "second line"]);
		const document = new Container();
		document.addChild(message);
		const width = 30;
		const lines = document.render(width);

		const owned = frameRowsIn(0, lines.length - 1, lines, transcriptBox(document, width, lines));

		expect(owned.size).toBe(0);
	});

	it("strips the frame a component drew, and treats a nested frame as its content", () => {
		// One box inside another: the walk stops at the outer box, because its
		// render is not its children concatenated, so the outer frame comes off
		// and the inner one survives as the content it is. That is the same rule
		// the table gets — anything a box drew *around* is content — and it is
		// as deep as this can honestly go, since the outer render is the last
		// place its rows can be read back verbatim.
		const inner = new FramedToolComponent();
		inner.addChild(new Text("inner", 0, 0));
		const outer = new FramedToolComponent();
		outer.addChild(inner);
		const document = new Container();
		document.addChild(outer);
		const width = 30;
		const lines = document.render(width);
		const origin = transcriptBox(document, width, lines);

		const owned = frameRowsIn(0, lines.length - 1, lines, origin);
		const copied = copyableLines(selectRows(lines, 0, lines.length - 1), owned);

		// The outer frame is 30 cells wide, the inner 28: exactly one frame's
		// worth of border has been removed.
		expect(copied.some((line) => line.length === width)).toBe(false);
		expect(copied).toContain(`╭${"─".repeat(width - 4)}╮`);
		expect(copied.some((line) => line.includes("inner"))).toBe(true);
	});

	it("answers nothing when the origin box has no component that renders", () => {
		// The non-scroll path used to hand over the layout root, whose
		// `component` is a VStack (or nothing at all). Nothing may throw.
		const bare: BoxLike = { rect: { x: 0, y: 0, width: 10, height: 1 }, children: [] };
		expect(frameRowsIn(0, 0, ["hello"], bare).size).toBe(0);
		expect(frameFinderFor(bare, ["hello"])(0)).toBeUndefined();
		expect(frameFinderFor(undefined, ["hello"])(0)).toBeUndefined();
		expect(frameFinderFor(bare, undefined)(0)).toBeUndefined();
	});
});

describe("frameEdgeColumns", () => {
	it("finds a frame's verticals at the content box's own edges", () => {
		const { document, tool, width, lines } = makeTranscript();
		const origin = transcriptBox(document, width, lines);
		const bodyRow = rowRangeOf(lines, tool, width).start + 2;

		expect(frameEdgeColumns(lines[bodyRow], origin)).toEqual({ left: 1, right: width - 2 });
	});

	it("returns nothing for a row that is not bounded by verticals", () => {
		const { document, width, lines } = makeTranscript();
		const origin = transcriptBox(document, width, lines);

		// A table row: its pipes are in the middle of the line, not at the
		// content box's own edges, so the highlight is never shrunk on it.
		expect(frameEdgeColumns(lines[lines.length - 1], origin)).toBeUndefined();
		expect(frameEdgeColumns(lines[0], origin)).toBeUndefined();
	});
});
