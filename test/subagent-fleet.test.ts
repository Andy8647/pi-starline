import { afterEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, subagentsBubbleContent } from "../extensions/starline/pill-actions";
import {
	createSubagentFleet,
	type EventBusLike,
	parseFleet,
	setActiveSubagentFleet,
	subagentsSegmentText,
} from "../extensions/starline/subagent-fleet";

/** A process-local bus like `pi.events`: synchronous delivery, unsubscribe handles. */
function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus: EventBusLike = {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel, data) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
	return {
		bus,
		listeners: (channel: string) => handlers.get(channel)?.size ?? 0,
		replyListeners: () =>
			[...handlers.entries()]
				.filter(([channel]) => channel.startsWith("subagents:rpc:v1:reply:"))
				.reduce((total, [, set]) => total + set.size, 0),
	};
}

type Entry = { agent: string; startedAt: number; model?: string; role?: string; tokens?: unknown };

/**
 * Stand in for pi-subagents' RPC bridge: answer `status` on the reply channel, on a
 * later tick, the way its async handler does.
 */
function answerStatus(bus: EventBusLike, fleet: () => { entries: Entry[]; totalActive?: number }) {
	const requests: unknown[] = [];
	bus.on("subagents:rpc:v1:request", (raw) => {
		requests.push(raw);
		const request = raw as { requestId: string; method: string };
		const current = fleet();
		queueMicrotask(() =>
			bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				success: true,
				data: {
					fleet: {
						version: 1,
						entries: current.entries,
						totalActive: current.totalActive ?? current.entries.length,
						omitted: 0,
					},
				},
			}),
		);
	});
	return requests;
}

afterEach(() => {
	setActiveSubagentFleet(undefined);
	vi.useRealTimers();
});

describe("parseFleet", () => {
	it("reads the versioned fleet record and keeps only what it understands", () => {
		const fleet = parseFleet({
			success: true,
			data: {
				fleet: {
					version: 1,
					totalActive: 3,
					omitted: 1,
					entries: [
						{
							key: "fleet-1",
							agent: "reviewer",
							model: "openai/gpt-x",
							startedAt: 1000,
							tokens: { total: 1500 },
						},
						{ agent: "", startedAt: 1 },
						{ agent: "no-start" },
						"junk",
					],
				},
			},
		});
		expect(fleet).toEqual({
			totalActive: 3,
			omitted: 1,
			entries: [
				{
					agent: "reviewer",
					role: undefined,
					model: "openai/gpt-x",
					effort: undefined,
					startedAt: 1000,
					tokens: 1500,
				},
			],
		});
	});

	it("rejects failures and unknown versions", () => {
		expect(parseFleet({ success: false, error: { code: "x" } })).toBeUndefined();
		expect(
			parseFleet({ success: true, data: { fleet: { version: 2, entries: [] } } }),
		).toBeUndefined();
		expect(parseFleet({ success: true, data: {} })).toBeUndefined();
		expect(parseFleet(undefined)).toBeUndefined();
	});
});

describe("subagent fleet", () => {
	it("asks for status on refresh and reports a change in the count", async () => {
		vi.useFakeTimers();
		const { bus } = createBus();
		let entries: Entry[] = [{ agent: "scout", startedAt: 1 }];
		const requests = answerStatus(bus, () => ({ entries }));
		const onChange = vi.fn();
		const fleet = createSubagentFleet(bus, { onChange, delayMs: 10 });

		fleet.refresh();
		await vi.advanceTimersByTimeAsync(10);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ version: 1, method: "status", params: {} });
		expect(fleet.snapshot().totalActive).toBe(1);
		expect(fleet.available()).toBe(true);
		expect(onChange).toHaveBeenCalledTimes(1);

		// Same count: nothing for the footer to redraw.
		fleet.refresh();
		await vi.advanceTimersByTimeAsync(10);
		expect(onChange).toHaveBeenCalledTimes(1);

		entries = [];
		fleet.refresh();
		await vi.advanceTimersByTimeAsync(10);
		expect(fleet.snapshot().totalActive).toBe(0);
		expect(onChange).toHaveBeenCalledTimes(2);
		fleet.dispose();
	});

	it("collapses a burst of lifecycle events into one request", async () => {
		vi.useFakeTimers();
		const { bus } = createBus();
		const requests = answerStatus(bus, () => ({ entries: [] }));
		const fleet = createSubagentFleet(bus, { onChange: () => {}, delayMs: 10 });

		bus.emit("subagent:async-started", {});
		bus.emit("subagent:child-status", {});
		bus.emit("subagent:child-status", {});
		await vi.advanceTimersByTimeAsync(10);
		expect(requests).toHaveLength(1);
		fleet.dispose();
	});

	it("stays empty and unavailable when nothing answers", async () => {
		vi.useFakeTimers();
		const { bus, replyListeners } = createBus();
		const fleet = createSubagentFleet(bus, { onChange: () => {}, delayMs: 10 });

		const pending = fleet.fetch(50);
		expect(replyListeners()).toBe(1);
		await vi.advanceTimersByTimeAsync(50);
		await expect(pending).resolves.toBeUndefined();
		expect(fleet.available()).toBe(false);
		expect(fleet.snapshot().totalActive).toBe(0);
		// The reply listener does not outlive its timeout.
		expect(replyListeners()).toBe(0);
		fleet.dispose();
	});

	it("counts as available once pi-subagents announces itself", () => {
		const { bus } = createBus();
		const fleet = createSubagentFleet(bus, { onChange: () => {} });
		bus.emit("subagents:rpc:v1:ready", {});
		expect(fleet.available()).toBe(true);
		fleet.dispose();
	});

	it("drops its listeners and pending requests when disposed", async () => {
		const { bus, listeners } = createBus();
		const fleet = createSubagentFleet(bus, { onChange: () => {} });
		const pending = fleet.fetch(10_000);
		fleet.dispose();
		await expect(pending).resolves.toBeUndefined();
		expect(listeners("subagent:async-started")).toBe(0);
		expect(listeners("subagents:rpc:v1:ready")).toBe(0);
	});

	it("gives the pill a count, and no pill at zero", async () => {
		vi.useFakeTimers();
		const { bus } = createBus();
		let entries: Entry[] = [
			{ agent: "a", startedAt: 1 },
			{ agent: "b", startedAt: 2 },
		];
		answerStatus(bus, () => ({ entries }));
		const fleet = createSubagentFleet(bus, { onChange: () => {}, delayMs: 1 });
		setActiveSubagentFleet(fleet);

		expect(subagentsSegmentText()).toBe("");
		fleet.refresh();
		await vi.advanceTimersByTimeAsync(1);
		expect(subagentsSegmentText()).toBe("2 agents");

		entries = [{ agent: "a", startedAt: 1 }];
		fleet.refresh();
		await vi.advanceTimersByTimeAsync(1);
		expect(subagentsSegmentText()).toBe("1 agent");
	});
});

describe("subagents bubble", () => {
	it("lists each run with its model, elapsed time and tokens", () => {
		const content = subagentsBubbleContent(
			{
				totalActive: 3,
				omitted: 0,
				entries: [
					{ agent: "reviewer", model: "openai/gpt-x", startedAt: 0, tokens: 12_400 },
					{ agent: "worker", role: "lint", startedAt: 55_000, tokens: 0 },
				],
			},
			200_000,
		);
		expect(content.title).toBe("3 subagents running");
		expect(content.body).toEqual([
			"· reviewer · gpt-x · 3m 20s · 12k tok",
			"· lint (worker) · 2m 25s",
			"· +1 more",
		]);
	});

	it("says so when the fleet emptied before the click landed", () => {
		const content = subagentsBubbleContent({ totalActive: 0, omitted: 0, entries: [] });
		expect(content.body).toEqual(["Nothing is running."]);
	});

	it("formats elapsed time for a glance", () => {
		expect(formatElapsed(-5)).toBe("0s");
		expect(formatElapsed(45_000)).toBe("45s");
		expect(formatElapsed(192_000)).toBe("3m 12s");
		expect(formatElapsed(3_900_000)).toBe("1h 05m");
	});
});
