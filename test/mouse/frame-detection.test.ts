import { describe, expect, it } from "vitest";
import {
	frameBoxAt,
	frameRowsIn,
	isExpandableComponent,
} from "../../extensions/starline/mouse/frame-detection";
import type { BoxLike } from "../../extensions/starline/mouse/hit-test";
import { copyableLines } from "../../extensions/starline/mouse/selection-copy";
import { toolboxFrame } from "./toolbox-frame";

const expandable = { setExpanded: () => {} };

describe("isExpandableComponent", () => {
	it("is true for a component exposing setExpanded", () => {
		expect(isExpandableComponent(expandable)).toBe(true);
	});

	it("is false for a component with no setExpanded — a markdown table's component", () => {
		expect(isExpandableComponent({})).toBe(false);
	});

	it("is false for non-objects", () => {
		expect(isExpandableComponent(undefined)).toBe(false);
		expect(isExpandableComponent(null)).toBe(false);
		expect(isExpandableComponent("box")).toBe(false);
	});
});

describe("frameBoxAt", () => {
	it("matches a rule-capped box whose component is expandable", () => {
		const box: BoxLike = {
			component: expandable,
			rect: { x: 0, y: 0, width: 10, height: 3 },
			children: [],
		};
		const lines = ["┌────────┐", "│ hello  │", "└────────┘"];
		expect(frameBoxAt(box, 2, 1, (row) => lines[row])).toBe(box);
	});

	it("does not match a rule-capped box whose component is not expandable — an isolated markdown table", () => {
		// Same rule-capped shape a real frame has, but the component is what a
		// lone-table `Markdown` block would produce: no `setExpanded`. This is
		// the exact case the reviewer found reachable before this fix — the
		// rule-row check alone could not tell a table's own borders from a
		// frame's.
		const tableBox: BoxLike = {
			component: {},
			rect: { x: 0, y: 0, width: 10, height: 3 },
			children: [],
		};
		const lines = ["┌────────┐", "│ hello  │", "└────────┘"];
		expect(frameBoxAt(tableBox, 2, 1, (row) => lines[row])).toBeUndefined();
	});

	it("matches pi-toolbox's rounded frame — the shape that actually ships", () => {
		// The Critical regression: RULE_ROW_RE listed only square corners
		// (┌┐└┘), so `╭───╮` was not a rule row, `frameBoxAt` never matched a
		// real tool box, and the whole feature was inert in production while
		// every fixture in this suite passed. Anything that narrows the glyph
		// set back to square corners fails here.
		const box: BoxLike = {
			component: expandable,
			rect: { x: 0, y: 0, width: 10, height: 3 },
			children: [],
		};
		const lines = toolboxFrame("hello");
		expect(frameBoxAt(box, 2, 1, (row) => lines[row])).toBe(box);
	});

	it("does not match a box with no component at all", () => {
		const box: BoxLike = { rect: { x: 0, y: 0, width: 10, height: 3 }, children: [] };
		const lines = ["┌────────┐", "│ hello  │", "└────────┘"];
		expect(frameBoxAt(box, 2, 1, (row) => lines[row])).toBeUndefined();
	});

	it("resolves the innermost frame when one is nested inside another", () => {
		// Regression for the extraction: this nesting behaviour existed before
		// frameBoxAt moved out of index.ts, and must still hold after.
		const inner: BoxLike = {
			component: expandable,
			rect: { x: 1, y: 1, width: 10, height: 3 },
			children: [],
		};
		const outer: BoxLike = {
			component: expandable,
			rect: { x: 0, y: 0, width: 12, height: 5 },
			children: [inner],
		};
		const lines = [
			"┌──────────┐", // outer top rule (row 0)
			"┌────────┐", // inner top rule (row 1)
			"│ hi     │", // inner body (row 2)
			"└────────┘", // inner bottom rule (row 3)
			"└──────────┘", // outer bottom rule (row 4)
		];
		const lineAt = (row: number) => lines[row];
		expect(frameBoxAt(outer, 3, 2, lineAt)).toBe(inner);
	});
});

describe("frameRowsIn + copyableLines", () => {
	it("strips a rounded pi-toolbox frame end to end", () => {
		const origin: BoxLike = {
			component: expandable,
			rect: { x: 0, y: 0, width: 10, height: 3 },
			children: [],
		};
		const lines = toolboxFrame("hello");
		expect(copyableLines(lines, frameRowsIn(0, 2, lines, origin))).toEqual(["hello"]);
	});

	it("resolves ownership for rows scrolled outside the clip", () => {
		// Finding B, in the geometry pi-tui actually produces. Probed against
		// the real `renderLayoutFrame`: a transcript scrolled by 15 rows gives
		// the scroll content box `rect.y === -15` with `clip` pinned to the
		// viewport at `{y: 0, height: 9}`. Selection rows are content rows
		// captured at mouse-down; `clip` is whatever the viewport shows at copy
		// time. Honouring it made `boxesAt` return an empty path for every row
		// above the fold, so the frame went unrecognised and its `╭────╮` was
		// copied verbatim — the original bug, brought back by scrolling.
		//
		// No other fixture in this suite sets `clip` at all, so `visible()`
		// short-circuits to true everywhere and none of them can catch this.
		const frame: BoxLike = {
			component: expandable,
			rect: { x: 0, y: -15, width: 10, height: 3 },
			// Zero-height: this frame is entirely above the fold, drawing nothing.
			clip: { x: 0, y: 0, width: 10, height: 0 },
			children: [],
		};
		const content: BoxLike = {
			// The transcript Container — not itself expandable, so ownership can
			// only come from the frame nested inside it.
			component: {},
			rect: { x: 0, y: -15, width: 10, height: 24 },
			clip: { x: 0, y: 0, width: 10, height: 9 },
			children: [frame],
		};
		const lines = [...toolboxFrame("hello"), ...Array.from({ length: 21 }, (_, i) => `row ${i}`)];

		const owned = frameRowsIn(0, 2, lines, content);

		expect([...owned].sort()).toEqual([0, 1, 2]);
		expect(copyableLines(lines.slice(0, 3), owned)).toEqual(["hello"]);
	});

	it("marks a tool box's body row as owned, so the copy is stripped", () => {
		const origin: BoxLike = {
			component: expandable,
			rect: { x: 0, y: 0, width: 10, height: 3 },
			children: [],
		};
		const lines = ["┌────────┐", "│ hello  │", "└────────┘"];
		const owned = frameRowsIn(0, 2, lines, origin);
		expect(copyableLines(lines, owned)).toEqual(["hello"]);
	});

	it("keeps a lone markdown table intact — pipes, borders, and separator", () => {
		// The scenario from the review: a markdown block that is only a table
		// produces a box whose own top and bottom rows are rule rows, same as a
		// real frame's. Its component (no setExpanded) is what must keep this
		// from being treated as one.
		const table: BoxLike = {
			component: {},
			rect: { x: 0, y: 0, width: 9, height: 5 },
			children: [],
		};
		const lines = ["┌───┬───┐", "│ a │ b │", "├───┼───┤", "│ c │ d │", "└───┴───┘"];
		const owned = frameRowsIn(0, 4, lines, table);
		expect(owned.size).toBe(0);
		// Every row survives byte-identical: not just the body rows' pipes, but
		// the table's own top border, header separator, and bottom border too.
		// copyableLines only drops a rule row when its own index is in
		// frameRows — none of this table's rows ever are.
		expect(copyableLines(lines, owned)).toEqual(lines);
	});
});
