import { describe, expect, it } from "vitest";
import { copyableLines, stripFrameColumns } from "../../extensions/starline/mouse/selection-copy";

describe("stripFrameColumns", () => {
	it("removes the verticals from a framed row", () => {
		expect(stripFrameColumns("│ read src/foo.ts │", true)).toBe("read src/foo.ts");
	});

	it("leaves a markdown table alone", () => {
		// A table is not a frame: its rows are never owned by a box component.
		expect(stripFrameColumns("| a | b |", false)).toBe("| a | b |");
	});

	it("leaves an unframed row that happens to contain a vertical", () => {
		expect(stripFrameColumns("grep 'a│b' file", false)).toBe("grep 'a│b' file");
	});
});

describe("copyableLines", () => {
	it("drops the rules and unwraps the body", () => {
		const lines = ["┌────────┐", "│ hello  │", "│ world  │", "└────────┘"];
		expect(copyableLines(lines, new Set([0, 1, 2, 3]))).toEqual(["hello", "world"]);
	});

	it("keeps rows outside the frame verbatim", () => {
		const lines = ["before", "│ inside │", "after"];
		expect(copyableLines(lines, new Set([1]))).toEqual(["before", "inside", "after"]);
	});
});
