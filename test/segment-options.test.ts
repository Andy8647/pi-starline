import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/zentui/config";
import {
	buildContextDisplayLabel,
	buildTokenLabel,
	formatBareContextPercent,
} from "../extensions/zentui/format";

const totals = {
	input: 12_000,
	output: 3_000,
	cacheRead: 147_000,
	cacheWrite: 2_000,
	cost: 0.42,
	latestCacheHitRate: 87.3,
};

describe("segmentOptions parsing", () => {
	it("defaults to the existing rendering", () => {
		expect(defaultConfig.segmentOptions).toEqual({
			context: { format: "full" },
			tokens: { cache: "percent" },
		});
		expect(mergeConfig({}).segmentOptions).toEqual(defaultConfig.segmentOptions);
	});

	it("accepts the documented values", () => {
		expect(
			mergeConfig({ segmentOptions: { context: { format: "percent" } } }).segmentOptions,
		).toEqual({ context: { format: "percent" }, tokens: { cache: "percent" } });
		for (const cache of ["percent", "tokens", "off"] as const) {
			expect(
				mergeConfig({ segmentOptions: { tokens: { cache } } }).segmentOptions.tokens.cache,
			).toBe(cache);
		}
	});

	it("falls back to the default on anything unrecognised", () => {
		expect(
			mergeConfig({ segmentOptions: { context: { format: "bare" } } }).segmentOptions.context
				.format,
		).toBe("full");
		expect(
			mergeConfig({ segmentOptions: { tokens: { cache: 7 } } }).segmentOptions.tokens.cache,
		).toBe("percent");
		expect(mergeConfig({ segmentOptions: "yes" }).segmentOptions).toEqual(
			defaultConfig.segmentOptions,
		);
	});
});

describe("formatBareContextPercent", () => {
	it("rounds and clamps", () => {
		expect(formatBareContextPercent(6.2)).toBe("6%");
		expect(formatBareContextPercent(66.6)).toBe("67%");
		expect(formatBareContextPercent(-5)).toBe("0%");
		expect(formatBareContextPercent(10_000)).toBe("999%");
	});

	it("marks an unknown percentage", () => {
		expect(formatBareContextPercent(undefined)).toBe("?");
		expect(formatBareContextPercent(null)).toBe("?");
		expect(formatBareContextPercent(Number.NaN)).toBe("?");
	});
});

describe("context format", () => {
	const base = { percent: 6.2, contextWindow: 200_000 };

	it("keeps the window in full format, which is the default", () => {
		expect(buildContextDisplayLabel(base)).toBe("6%/200k");
		expect(buildContextDisplayLabel({ ...base, format: "full" })).toBe("6%/200k");
	});

	it("drops the window in percent format", () => {
		expect(buildContextDisplayLabel({ ...base, format: "percent" })).toBe("6%");
	});

	// contextStyle and format are orthogonal: the gauge is unaffected either way.
	it("composes with contextStyle", () => {
		const gauge = buildContextDisplayLabel({ ...base, style: "gauge", format: "percent" });
		expect(gauge).toBe(buildContextDisplayLabel({ ...base, style: "gauge", format: "full" }));

		expect(buildContextDisplayLabel({ ...base, style: "text+gauge", format: "percent" })).toMatch(
			/^\[.+\] 6%$/,
		);
		expect(buildContextDisplayLabel({ ...base, style: "text+gauge", format: "full" })).toMatch(
			/^\[.+\] 6%\/200k$/,
		);
	});

	it("still reports no context window regardless of format", () => {
		expect(buildContextDisplayLabel({ percent: 6, contextWindow: 0, format: "percent" })).toBe(
			"--",
		);
	});
});

describe("tokens cache format", () => {
	it("shows the hit rate by default, as before", () => {
		expect(buildTokenLabel(totals, "C")).toBe("↑12k ↓3.0k C 87.3%");
		expect(buildTokenLabel(totals, "C", "percent")).toBe("↑12k ↓3.0k C 87.3%");
	});

	it("shows the raw cache-read count in tokens mode", () => {
		expect(buildTokenLabel(totals, "C", "tokens")).toBe("↑12k ↓3.0k C 147k");
	});

	it("omits cache entirely in off mode", () => {
		expect(buildTokenLabel(totals, "C", "off")).toBe("↑12k ↓3.0k");
	});

	it("omits cache when there was none, in every mode", () => {
		const noCache = { ...totals, cacheRead: 0, cacheWrite: 0, latestCacheHitRate: undefined };
		for (const cache of ["percent", "tokens", "off"] as const) {
			expect(buildTokenLabel(noCache, "C", cache)).toBe("↑12k ↓3.0k");
		}
	});

	// A hit rate is only known for the latest turn; tokens mode has a count
	// regardless, so it still renders where percent mode cannot.
	it("renders in tokens mode even without a known hit rate", () => {
		const noRate = { ...totals, latestCacheHitRate: undefined };
		expect(buildTokenLabel(noRate, "C", "percent")).toBe("↑12k ↓3.0k");
		expect(buildTokenLabel(noRate, "C", "tokens")).toBe("↑12k ↓3.0k C 147k");
	});

	it("drops the icon separator when there is no icon", () => {
		expect(buildTokenLabel(totals, "", "tokens")).toBe("↑12k ↓3.0k 147k");
	});

	it("keeps the empty-usage placeholder", () => {
		const empty = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			latestCacheHitRate: undefined,
		};
		expect(buildTokenLabel(empty, "C", "off")).toBe("↑0 ↓0");
	});
});
