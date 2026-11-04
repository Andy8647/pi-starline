import { beforeEach, describe, expect, it } from "vitest";
import {
	MIN_TPS_SAMPLES,
	medianTps,
	resetTpsTier,
	tpsTierFor,
} from "../extensions/starline/tps-tier";

beforeEach(() => {
	resetTpsTier();
});

describe("medianTps", () => {
	it("says nothing until there are enough messages to have a usual rate", () => {
		expect(medianTps([10, 20, 30])).toBeUndefined();
		expect(medianTps([])).toBeUndefined();
		expect(MIN_TPS_SAMPLES).toBe(4);
	});

	it("takes the middle value of an odd count", () => {
		expect(medianTps([10, 20, 30, 40, 500])).toBe(30);
	});

	it("averages the middle pair of an even count", () => {
		expect(medianTps([10, 20, 30, 40])).toBe(25);
	});

	it("is not dragged by one very fast or very slow message", () => {
		expect(medianTps([20, 21, 22, 23, 900])).toBe(22);
		expect(medianTps([1, 20, 21, 22, 23])).toBe(21);
	});

	it("ignores rates that are not rates", () => {
		expect(medianTps([0, -5, Number.NaN, 10, 10, 10, 10])).toBe(10);
	});
});

describe("tpsTierFor", () => {
	it("is normal when there is nothing to compare against", () => {
		expect(tpsTierFor(50, undefined)).toBe("normal");
		expect(tpsTierFor(undefined, 40)).toBe("normal");
		expect(tpsTierFor(50, 0)).toBe("normal");
	});

	it("calls a rate 30% off the median fast or slow", () => {
		expect(tpsTierFor(52, 40)).toBe("fast");
		expect(tpsTierFor(28, 40)).toBe("slow");
		expect(tpsTierFor(44, 40)).toBe("normal");
	});

	it("stays in the tier until the rate is back inside 15%", () => {
		expect(tpsTierFor(52, 40)).toBe("fast");
		// 47 / 40 = 1.18: outside "usual" but not back over the 1.15 edge.
		expect(tpsTierFor(47, 40)).toBe("fast");
		expect(tpsTierFor(45, 40)).toBe("normal");
	});

	it("crosses from fast to slow in one step when the rate collapses", () => {
		expect(tpsTierFor(52, 40)).toBe("fast");
		expect(tpsTierFor(8, 40)).toBe("slow");
	});

	it("forgets the band when the rate disappears, so it cannot come back stale", () => {
		expect(tpsTierFor(52, 40)).toBe("fast");
		expect(tpsTierFor(undefined, 40)).toBe("normal");
		// Back on screen at 1.2× the median: inside the band, so normal, not fast.
		expect(tpsTierFor(48, 40)).toBe("normal");
	});

	it("tracks a session that speeds up: the median moves with it", () => {
		// Usual rate 40, this message at 60: fast.
		expect(tpsTierFor(60, medianTps([38, 40, 41, 42]))).toBe("fast");
		resetTpsTier();
		// The same 60 is unremarkable once the session's median has climbed.
		expect(tpsTierFor(60, medianTps([55, 58, 60, 62]))).toBe("normal");
	});
});
