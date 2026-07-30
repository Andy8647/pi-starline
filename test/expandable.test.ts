import { describe, expect, it, vi } from "vitest";

import {
	isExpandableNode,
	isExpanded,
	isExpandHintRow,
	isFrameEdgeCell,
	isFrameRuleRow,
	isToggleTarget,
	isToggleTargetRow,
	toggleExpanded,
} from "../extensions/starline/fixed-editor/expandable";

describe("isExpandableNode", () => {
	it("recognises anything Pi's ctrl+o would reach", () => {
		expect(isExpandableNode({ setExpanded: () => {} })).toBe(true);
	});

	it("rejects everything else", () => {
		expect(isExpandableNode(undefined)).toBe(false);
		expect(isExpandableNode(null)).toBe(false);
		expect(isExpandableNode({})).toBe(false);
		expect(isExpandableNode({ setExpanded: true })).toBe(false);
	});
});

describe("toggleExpanded", () => {
	it("flips a component that exposes its own flag", () => {
		const node = { expanded: false, setExpanded: vi.fn() };
		expect(toggleExpanded(node)).toBe(true);
		expect(node.setExpanded).toHaveBeenCalledWith(true);
	});

	it("collapses one that is already expanded", () => {
		const node = { expanded: true, setExpanded: vi.fn() };
		toggleExpanded(node);
		expect(node.setExpanded).toHaveBeenCalledWith(false);
	});

	// A component that keeps its flag out of reach still has to toggle rather
	// than send `true` forever.
	it("remembers what it set when the flag cannot be read", () => {
		const calls: boolean[] = [];
		const node = { setExpanded: (value: boolean) => calls.push(value) };
		toggleExpanded(node);
		toggleExpanded(node);
		toggleExpanded(node);
		expect(calls).toEqual([true, false, true]);
	});

	it("reports failure when the component throws, so the click stays a no-op", () => {
		const node = {
			setExpanded: () => {
				throw new Error("nope");
			},
		};
		expect(toggleExpanded(node)).toBe(false);
	});

	it("reads the live flag, so Pi's own ctrl+o stays in charge", () => {
		const node = { expanded: true, setExpanded: () => {} };
		expect(isExpanded(node)).toBe(true);
	});
});

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

describe("isExpandHintRow", () => {
	it("takes every shape of Pi's hint", () => {
		expect(isExpandHintRow("... (24 earlier lines, ctrl+o to expand)")).toBe(true);
		expect(isExpandHintRow("... (7 more lines, ctrl+o to expand)")).toBe(true);
		expect(isExpandHintRow("read src/foo.ts (ctrl+o to expand)")).toBe(true);
		expect(isExpandHintRow("bash (ctrl+o to collapse)")).toBe(true);
	});

	// The key is rebindable, so the match cannot be anchored on ctrl+o.
	it("does not care which key is bound", () => {
		expect(isExpandHintRow("... (3 more lines, alt+e to expand)")).toBe(true);
	});

	it("ignores prose that merely mentions expanding", () => {
		expect(isExpandHintRow("we need to expand the test suite")).toBe(false);
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

describe("isToggleTargetRow", () => {
	it("is the frame and the hint, and nothing else", () => {
		expect(isToggleTargetRow("╭────────╮")).toBe(true);
		expect(isToggleTargetRow("│ ... (2 more lines, ctrl+o to expand) │")).toBe(true);
		expect(isToggleTargetRow("│ some output               │")).toBe(false);
	});
});

describe("isToggleTarget", () => {
	const ROW = "│ some output   │";

	it("adds the verticals to the rows that already qualified", () => {
		expect(isToggleTarget("╭────────╮", 4)).toBe(true);
		expect(isToggleTarget(ROW, 0)).toBe(true);
		expect(isToggleTarget(ROW, 4)).toBe(false);
	});
});
