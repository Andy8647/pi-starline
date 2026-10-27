import { describe, expect, it } from "vitest";
import { buildElapsedLabel } from "../extensions/starline/format";
import { TurnClock } from "../extensions/starline/turn-clock";
import { modelPillLabel, setWorkingIndicator } from "../extensions/starline/working-indicator";

/** A stand-in for Pi's StatusIndicator, one spinner cell wide. */
function indicator(kind: string, frames: string[] = ["⣾"]) {
	return {
		kind,
		renderSpinnerInBorder: (width: number) => (frames[0] ?? "").slice(0, width),
	};
}

describe("TurnClock", () => {
	it("has no elapsed time until a run starts", () => {
		const clock = new TurnClock();
		expect(clock.running()).toBe(false);
		expect(clock.elapsedMs(1_000)).toBeUndefined();
		expect(clock.timing(1_000)).toEqual({});
	});

	it("measures from the moment the run began", () => {
		const clock = new TurnClock();
		clock.begin(1_000);
		expect(clock.running()).toBe(true);
		expect(clock.elapsedMs(13_000)).toBe(12_000);
		expect(clock.timing(13_000)).toEqual({ running: 12_000 });
	});

	it("keeps 0 distinct from not running", () => {
		const clock = new TurnClock();
		clock.begin(1_000);
		expect(clock.elapsedMs(1_000)).toBe(0);
	});

	// The whole point of the freeze: the number is still there the moment the
	// answer would be worth reading.
	it("keeps the total after the run ends", () => {
		const clock = new TurnClock();
		clock.begin(1_000);
		clock.end(13_000);
		expect(clock.elapsedMs(20_000)).toBeUndefined();
		expect(clock.timing(20_000)).toEqual({ last: 12_000 });
	});

	it("drops the previous total as soon as a new run starts", () => {
		const clock = new TurnClock();
		clock.begin(1_000);
		clock.end(13_000);
		clock.begin(50_000);
		expect(clock.timing(51_500)).toEqual({ running: 1_500 });
	});

	it("survives an end without a begin", () => {
		const clock = new TurnClock();
		clock.end(13_000);
		expect(clock.timing(20_000)).toEqual({});
	});

	it("forgets everything when the session does", () => {
		const clock = new TurnClock();
		clock.begin(1_000);
		clock.end(13_000);
		clock.clear();
		expect(clock.running()).toBe(false);
		expect(clock.timing(20_000)).toEqual({});
	});
});

describe("buildElapsedLabel", () => {
	it("reads seconds under a minute", () => {
		expect(buildElapsedLabel(45_000)).toBe("45s");
	});

	it("reads minutes and seconds under an hour", () => {
		expect(buildElapsedLabel((2 * 60 + 13) * 1000)).toBe("2m 13s");
	});

	it("drops the seconds past an hour", () => {
		expect(buildElapsedLabel((3600 + 5 * 60 + 40) * 1000)).toBe("1h 5m");
	});

	it("clamps a clock read before it was set", () => {
		expect(buildElapsedLabel(-5_000)).toBe("0s");
	});
});

describe("modelPillLabel", () => {
	it("is the plain pill when nothing has been timed", () => {
		setWorkingIndicator(undefined);
		expect(modelPillLabel("M", "claude", {})).toBe("M claude");
	});

	it("puts the spinner in the icon slot and the time after the name", () => {
		setWorkingIndicator(indicator("working"));
		expect(modelPillLabel("M", "claude", { timing: { running: 12_000 } })).toBe("⣾ claude 12s");
	});

	// The icon coming back is what says "not counting any more"; the number beside
	// it is the total the last run reached.
	it("freezes the total once the run ends", () => {
		setWorkingIndicator(undefined);
		expect(modelPillLabel("M", "claude", { timing: { last: 92_000 } })).toBe("M claude 1m 32s");
	});

	// The time is about the run, not about the animation: a hidden spinner still
	// leaves the pill counting.
	it("keeps the time when the animation is switched off", () => {
		setWorkingIndicator(indicator("working", []));
		expect(modelPillLabel("M", "claude", { timing: { running: 12_000 } })).toBe("M claude 12s");
	});

	it("follows the run rather than the previous total while working", () => {
		setWorkingIndicator(indicator("working"));
		expect(modelPillLabel("M", "claude", { timing: { running: 3_000, last: 92_000 } })).toBe(
			"⣾ claude 3s",
		);
	});

	it("stays out of a status that spells a sentence", () => {
		setWorkingIndicator(indicator("compaction"));
		expect(modelPillLabel("M", "claude", { timing: { last: 92_000 } })).toBe("M claude 1m 32s");
	});

	it("draws nothing without a model name", () => {
		setWorkingIndicator(indicator("working"));
		expect(modelPillLabel("M", "", { timing: { running: 12_000 } })).toBe("");
	});
});
