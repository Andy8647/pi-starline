import { describe, expect, it } from "vitest";

import {
	frameContentSpan,
	isFrameEdgeCell,
	isFrameRuleRow,
	stripTrailingFrame,
} from "../extensions/starline/fixed-editor/frame";

describe("isFrameRuleRow", () => {
	it("takes a box's top and bottom rules", () => {
		expect(isFrameRuleRow("╭──────────╮")).toBe(true);
		expect(isFrameRuleRow("╰──────────╯")).toBe(true);
		expect(isFrameRuleRow("\x1b[32m╭────╮\x1b[0m")).toBe(true);
	});

	it("leaves body rows alone, so they keep double click for a word", () => {
		expect(isFrameRuleRow("│ $ rg -n 'foo'  │")).toBe(false);
		// A blank padding row is chrome, but it is not the frame.
		expect(isFrameRuleRow("│          │")).toBe(false);
		expect(isFrameRuleRow("plain text")).toBe(false);
		expect(isFrameRuleRow("─")).toBe(false);
	});
});

// An expanded box is often taller than the screen, which puts its rules out of
// reach; the side of the frame is on every row of it.
describe("isFrameEdgeCell", () => {
	const ROW = "│ some output   │";

	it("takes a click on either vertical", () => {
		expect(isFrameEdgeCell(ROW, 0)).toBe(true);
		expect(isFrameEdgeCell(ROW, ROW.length - 1)).toBe(true);
	});

	it("leaves the text between them alone", () => {
		expect(isFrameEdgeCell(ROW, 2)).toBe(false);
		expect(isFrameEdgeCell(ROW, 6)).toBe(false);
	});

	it("counts columns past escapes and wide glyphs", () => {
		expect(isFrameEdgeCell("\x1b[32m│\x1b[0m text", 0)).toBe(true);
		// The CJK pair takes two columns each, so the closing rule sits at 5.
		expect(isFrameEdgeCell("│中文│", 5)).toBe(true);
		expect(isFrameEdgeCell("│中文│", 3)).toBe(false);
	});

	it("is out of range past the end of the row", () => {
		expect(isFrameEdgeCell(ROW, 500)).toBe(false);
		expect(isFrameEdgeCell(ROW, -1)).toBe(false);
	});
});

// The distinction the whole module turns on: Pi's markdown draws tables the
// same way a box is drawn, and a table's pipes are its content.
describe("telling a box from a table", () => {
	const BOX = [
		"╭──────────────╮",
		"│ $ rg -n foo  │",
		"│              │",
		"│ src/a.ts:1   │",
		"╰──────────────╯",
	];
	const TABLE = [
		"┌─────┬─────┐",
		"│ a   │ b   │",
		"├─────┼─────┤",
		"│ 1   │ 2   │",
		"└─────┴─────┘",
	];

	it("takes a box's rules as rules", () => {
		expect(isFrameRuleRow(BOX[0])).toBe(true);
		expect(isFrameRuleRow(BOX[4])).toBe(true);
	});

	// The T-junctions are what make these a table's borders rather than a frame.
	it("does not take a table's borders as rules", () => {
		expect(isFrameRuleRow(TABLE[0])).toBe(false);
		expect(isFrameRuleRow(TABLE[2])).toBe(false);
		expect(isFrameRuleRow(TABLE[4])).toBe(false);
	});

	it("strips the frame off a box's rows", () => {
		expect(frameContentSpan(BOX, 1)).toEqual({ startCol: 2, endCol: 15, framed: true });
	});

	it("leaves every pipe of a table alone", () => {
		expect(frameContentSpan(TABLE, 1)).toEqual({
			startCol: 0,
			endCol: Number.POSITIVE_INFINITY,
			framed: false,
		});
		expect(frameContentSpan(TABLE, 3)?.framed).toBe(false);
	});

	it("leaves a table drawn inside a box with its pipes, minus the box", () => {
		const nested = [
			"╭────────────────────╮",
			"│ ┌─────┬─────┐      │",
			"│ │ a   │ b   │      │",
			"╰────────────────────╯",
		];
		const span = frameContentSpan(nested, 2);
		expect(span).toEqual({ startCol: 2, endCol: 21, framed: true });
	});
});

describe("frameContentSpan", () => {
	const BOX = ["╭────────────╮", "│ hello      │", "│            │", "╰────────────╯"];

	it("drops a rule row entirely", () => {
		expect(frameContentSpan(BOX, 0)).toBeNull();
		expect(frameContentSpan(BOX, 3)).toBeNull();
	});

	// The blank row between two paragraphs of a tool result is content: dropping
	// it would run them together in the copy.
	it("keeps a box's padding row rather than dropping it", () => {
		// Not null, so the line survives; what is inside the frame is spaces,
		// which the caller trims away into the empty line it should be.
		const span = frameContentSpan(BOX, 2);
		expect(span?.framed).toBe(true);
		expect(BOX[2].slice(span?.startCol ?? 0, span?.endCol ?? 0).trim()).toBe("");
	});

	it("leaves an ordinary line whole, indentation included", () => {
		const lines = ["some text", "    indented"];
		expect(frameContentSpan(lines, 1)).toEqual({
			startCol: 0,
			endCol: Number.POSITIVE_INFINITY,
			framed: false,
		});
	});

	// Only the rule proves a box. A quote bar has none above it, so its text is
	// left exactly as rendered.
	it("leaves a blockquote bar alone", () => {
		const lines = ["a paragraph", "│ quoted text", "│ more quote"];
		expect(frameContentSpan(lines, 1)?.framed).toBe(false);
		expect(frameContentSpan(lines, 2)?.framed).toBe(false);
	});

	it("finds the rule several rows up", () => {
		const lines = ["╭────────────╮", ...Array.from({ length: 40 }, () => "│ output     │")];
		expect(frameContentSpan(lines, 40)?.framed).toBe(true);
	});

	it("gives up on a row with no rule above it at all", () => {
		const lines = Array.from({ length: 5 }, () => "│ output     │");
		expect(frameContentSpan(lines, 4)?.framed).toBe(false);
	});

	it("reads ANSI-styled rows by visible column", () => {
		const lines = ["╭────────────╮", "\x1b[32m│\x1b[0m hello      \x1b[32m│\x1b[0m"];
		expect(frameContentSpan(lines, 1)).toEqual({ startCol: 2, endCol: 13, framed: true });
	});

	it("answers the same for a repeated ask", () => {
		const lines = [...BOX];
		expect(frameContentSpan(lines, 1)).toEqual(frameContentSpan(lines, 1));
	});

	// Asked for in order, a row takes the answer worked out for the one above it
	// rather than scanning again; that shortcut has to agree with the long way.
	it("agrees whether the lines are asked for in order or one at a time", () => {
		const build = () => [
			"before the box",
			"╭────────────╮",
			...Array.from({ length: 30 }, (_, i) => `│ line ${String(i).padEnd(5)}│`),
			"╰────────────╯",
			"after the box",
			"│ a quote bar",
		];
		const inOrder = build();
		const ordered = inOrder.map((_, index) => frameContentSpan(inOrder, index));
		const alone = build().map((_, index) => frameContentSpan(build(), index));

		expect(ordered).toEqual(alone);
		expect(ordered[5]?.framed).toBe(true);
		expect(ordered.at(-1)?.framed).toBe(false);
	});
});

// Extraction expands OSC 8 hyperlinks into `text url`, so the copied text has
// grown past the columns it was rendered at — the closing glyph has not moved.
describe("stripTrailingFrame", () => {
	it("takes the closing vertical and its padding off", () => {
		expect(stripTrailingFrame("hello        │")).toBe("hello");
		expect(stripTrailingFrame("hello │ ")).toBe("hello");
	});

	it("leaves text that merely ends in something else", () => {
		expect(stripTrailingFrame("hello")).toBe("hello");
		expect(stripTrailingFrame("a │ b")).toBe("a │ b");
	});
});
