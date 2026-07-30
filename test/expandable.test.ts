import { describe, expect, it, vi } from "vitest";

import {
	isExpandableNode,
	isExpanded,
	isExpandHintRow,
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
