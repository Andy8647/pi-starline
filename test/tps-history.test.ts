import { describe, expect, it } from "vitest";
import {
	contextPercentAfter,
	MAX_TPS_POINTS,
	TPS_ENTRY_TYPE,
	TpsHistory,
	type TpsPoint,
	tpsChartLines,
	tpsSummary,
} from "../extensions/starline/tps-history";

function point(tps: number, percent: number, at = 0): TpsPoint {
	return { tps, percent, at };
}

describe("tps history", () => {
	it("records a measured turn and persists it", () => {
		const persisted: TpsPoint[] = [];
		const history = new TpsHistory((entry) => persisted.push(entry));
		history.record(point(42, 12));
		expect(history.all()).toHaveLength(1);
		expect(persisted).toEqual([point(42, 12)]);
	});

	it("drops a point that is not a rate", () => {
		const persisted: TpsPoint[] = [];
		const history = new TpsHistory((entry) => persisted.push(entry));
		history.record(point(0, 10));
		history.record(point(Number.NaN, 10));
		expect(history.all()).toHaveLength(0);
		expect(persisted).toHaveLength(0);
	});

	it("keeps the newest points when the buffer is full", () => {
		const history = new TpsHistory();
		for (let index = 0; index < MAX_TPS_POINTS + 5; index += 1) {
			history.record(point(index + 1, 1));
		}
		const points = history.all();
		expect(points).toHaveLength(MAX_TPS_POINTS);
		expect(points[points.length - 1].tps).toBe(MAX_TPS_POINTS + 5);
	});

	it("rebuilds from the session's own entries", () => {
		const history = new TpsHistory();
		history.restore([
			{ type: "message" },
			{ type: "custom", customType: TPS_ENTRY_TYPE, data: point(30, 5) },
			{ type: "custom", customType: "someone-else", data: point(99, 5) },
			{ type: "custom", customType: TPS_ENTRY_TYPE, data: { tps: "fast" } },
			{ type: "custom", customType: TPS_ENTRY_TYPE, data: point(50, 40, 100) },
		]);
		expect(history.all()).toEqual([point(30, 5), point(50, 40, 100)]);
	});

	it("draws eight plot rows and both axis lines", () => {
		const lines = tpsChartLines([point(42, 10), point(30, 50), point(55, 90)]);
		expect(lines).toHaveLength(10);
		expect(lines[8]).toContain("└");
		expect(lines[9]).toContain("0%");
		// The x axis ends at the fullest window the points saw, rounded up.
		expect(lines[9]).toContain("90%");
	});

	it("spreads an early session across the whole axis", () => {
		const lines = tpsChartLines([point(50, 2), point(50, 10)]);
		expect(lines[9]).toContain("10%");
		// 10% of a 10% axis is the right edge, not a tenth of the plot.
		expect(lines[0][6 + 39]).toBe("●");
	});

	it("puts a slow turn on the floor and a fast one at the top", () => {
		const slow = tpsChartLines([point(1, 0)]);
		// The y axis tops out at 10 for a rate this low, and the single point sits
		// on the bottom row, in the first column after the frame.
		expect(slow[7][6]).toBe("●");
		const fast = tpsChartLines([point(100, 100)]);
		expect(fast[0][6 + 39]).toBe("●");
	});

	it("marks the newest reply instead of counting it", () => {
		const lines = tpsChartLines([point(50, 50), point(50, 50)]);
		// Both land in one cell, and the newest one is a dot, not a density mark.
		expect(lines.join("\n")).toContain("●");
		expect(lines.join("\n")).not.toContain("+");
	});

	it("counts turns that land in one cell instead of hiding all but one", () => {
		const lines = tpsChartLines([point(50, 50), point(50, 50), point(10, 90)]);
		expect(lines.join("\n")).toContain("+");
	});

	it("summarises the latest reply and the average", () => {
		expect(tpsSummary([])).toBe("No replies measured yet.");
		expect(tpsSummary([point(40, 1), point(50, 2)])).toBe("last 50 t/s · avg 45 t/s · 2 msgs");
		expect(tpsSummary([point(40, 1)])).toBe("last 40 t/s · avg 40 t/s · 1 msg");
	});

	it("reads the context percentage a finished message leaves behind", () => {
		expect(contextPercentAfter({ totalTokens: 40_000 }, 200_000)).toBe(20);
		expect(contextPercentAfter({ input: 30_000, output: 5_000, cacheRead: 5_000 }, 200_000)).toBe(
			20,
		);
		expect(contextPercentAfter(undefined, 200_000)).toBeUndefined();
		expect(contextPercentAfter({ totalTokens: 40_000 }, undefined)).toBeUndefined();
		expect(contextPercentAfter({ totalTokens: 0 }, 200_000)).toBeUndefined();
	});
});
