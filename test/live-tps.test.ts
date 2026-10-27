import type { AssistantMessage, AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTpsLabel } from "../extensions/starline/format";
import { estimateTokens, LiveTpsController } from "../extensions/starline/live-tps";

/**
 * Fake clocks start here rather than at 0: `vi.setSystemTime(0)` is indistinguishable
 * from "now" for the fake clock, and a base far from the epoch keeps the arithmetic
 * in each test readable.
 */
const T0 = 1_000_000;

function usage(patch: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...patch,
	};
}

function assistantMessage(output = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: usage({ output }),
		stopReason: "stop",
		timestamp: 1,
	};
}

function delta(kind: "text_delta" | "thinking_delta" | "toolcall_delta" = "text_delta") {
	return {
		type: kind,
		contentIndex: 0,
		delta: "x",
		partial: assistantMessage(),
	} as AssistantMessageEvent;
}

/** Two deltas one second apart, then the message completes with `output` tokens. */
function streamOneSecond(tps: LiveTpsController, output: number): boolean {
	vi.setSystemTime(T0);
	tps.observe(delta());
	vi.setSystemTime(T0 + 1_000);
	tps.observe(delta());
	vi.setSystemTime(T0 + 1_000);
	return tps.complete(output);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("live decode throughput", () => {
	it("measures output tokens across the streaming window", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		vi.setSystemTime(T0);
		tps.observe(delta());
		vi.setSystemTime(T0 + 1_000);
		tps.observe(delta());
		vi.setSystemTime(T0 + 2_000);
		expect(tps.complete(200)).toBe(true);
		// 200 tokens over the 2 s between the first delta and the message ending.
		expect(tps.value()).toBeCloseTo(100, 5);
	});

	it("counts thinking and tool-call deltas, not just text", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		vi.setSystemTime(T0);
		tps.observe(delta("thinking_delta"));
		vi.setSystemTime(T0 + 1_000);
		tps.observe(delta("toolcall_delta"));
		vi.setSystemTime(T0 + 1_000);
		expect(tps.complete(50)).toBe(true);
		expect(tps.value()).toBeCloseTo(50, 5);
	});

	it("shows an estimate while the message streams, then the real value", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		vi.setSystemTime(T0);
		// "x" estimates at a quarter token.
		tps.observe(delta());
		vi.setSystemTime(T0 + 600);
		expect(tps.observe(delta())).toBe(true);
		expect(tps.value()).toBeCloseTo(0.5 / 0.6, 3);
		expect(tps.streaming()).toBe(true);

		vi.setSystemTime(T0 + 1_000);
		expect(tps.complete(100)).toBe(true);
		expect(tps.value()).toBeCloseTo(100, 5);
		expect(tps.streaming()).toBe(false);
	});

	it("does not rewrite the live value more often than it can be read", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		vi.setSystemTime(T0);
		tps.observe(delta());
		vi.setSystemTime(T0 + 500);
		expect(tps.observe(delta())).toBe(true);
		vi.setSystemTime(T0 + 550);
		expect(tps.observe(delta())).toBe(false);
		vi.setSystemTime(T0 + 1_100);
		expect(tps.observe(delta())).toBe(true);
	});

	it("keeps the live window dark until it is long enough to divide by", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		vi.setSystemTime(T0);
		tps.observe(delta());
		vi.setSystemTime(T0 + 399);
		expect(tps.observe(delta())).toBe(false);
		expect(tps.value()).toBeUndefined();
	});

	it("estimates CJK text as roughly one token per glyph", () => {
		expect(estimateTokens("你好")).toBe(2);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("好abcd")).toBeCloseTo(2, 5);
	});

	it("skips a single-chunk reply instead of inventing a rate", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		vi.setSystemTime(T0);
		tps.observe(delta());
		vi.setSystemTime(T0 + 1_000);
		expect(tps.complete(500)).toBe(false);
		expect(tps.value()).toBeUndefined();
	});

	it("skips a window too short to divide by", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		vi.setSystemTime(T0);
		tps.observe(delta());
		vi.setSystemTime(T0 + 20);
		tps.observe(delta());
		vi.setSystemTime(T0 + 20);
		expect(tps.complete(200)).toBe(false);
		expect(tps.value()).toBeUndefined();
	});

	it("ignores a message with no output tokens", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		// No reported count: the live estimate is all there is, so it stays on the
		// pill rather than the number going blank at the end of the message.
		expect(streamOneSecond(tps, 0)).toBe(false);
		expect(tps.value()).toBeCloseTo(0.5, 5);
	});

	it("ignores a completion with no streamed window", () => {
		const tps = new LiveTpsController();
		expect(tps.complete(120)).toBe(false);
		expect(tps.value()).toBeUndefined();
	});

	it("keeps the last value across turns until a new measurement lands", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		expect(streamOneSecond(tps, 100)).toBe(true);
		expect(tps.value()).toBeCloseTo(100, 5);

		// A new run starts: the window resets, the pill keeps showing the old rate.
		tps.beginTurn();
		expect(tps.value()).toBeCloseTo(100, 5);

		// An aborted message ends without a completion, leaving the old value alone.
		vi.setSystemTime(T0 + 2_000);
		expect(tps.value()).toBeCloseTo(100, 5);

		// A finished message replaces it.
		vi.setSystemTime(T0 + 3_000);
		tps.observe(delta());
		vi.setSystemTime(T0 + 4_000);
		tps.observe(delta());
		vi.setSystemTime(T0 + 4_000);
		tps.complete(40);
		expect(tps.value()).toBeCloseTo(40, 5);
	});

	it("forgets the value on clear", () => {
		vi.useFakeTimers();
		const tps = new LiveTpsController();
		expect(streamOneSecond(tps, 100)).toBe(true);
		tps.clear();
		expect(tps.value()).toBeUndefined();
	});

	it("ignores a message_update without a streaming event", () => {
		const tps = new LiveTpsController();
		expect(() => tps.observe(undefined)).not.toThrow();
		expect(tps.value()).toBeUndefined();
	});
});

describe("tps label", () => {
	it("formats sub-10 rates with one decimal and larger ones as integers", () => {
		expect(buildTpsLabel(4.26)).toBe("4.3 t/s");
		expect(buildTpsLabel(9.94)).toBe("9.9 t/s");
		expect(buildTpsLabel(41.6)).toBe("42 t/s");
		expect(buildTpsLabel(0)).toBe("");
		expect(buildTpsLabel(undefined)).toBe("");
		expect(buildTpsLabel(Number.NaN)).toBe("");
	});
});
