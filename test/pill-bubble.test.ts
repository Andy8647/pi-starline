import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closePillBubble,
	isPillBubbleOpenFor,
	type PillAnchor,
	pillBubblePlacement,
	pillBubbleWidth,
	renderPillBubble,
	setPillBubbleAnimation,
	showPillBubble,
} from "../extensions/starline/pill-bubble";

const BACKGROUND = "\x1b[48;2;249;226;175m";
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

// A bubble left open by one test must not be closed during the next one.
afterEach(() => {
	closePillBubble();
});

const content = {
	title: "2 messages queued",
	body: ["· first", "· second"],
	hint: "esc to close",
};

function anchor(overrides: Partial<PillAnchor> = {}): PillAnchor {
	return {
		centerColumn: 40,
		terminalWidth: 80,
		background: BACKGROUND,
		foreground: "",
		...overrides,
	};
}

describe("pillBubbleWidth", () => {
	it("does not shrink below a readable minimum", () => {
		expect(pillBubbleWidth({ body: ["hi"] }, 80)).toBe(24);
	});

	it("grows with the content but stops at the ceiling", () => {
		expect(pillBubbleWidth({ body: ["x".repeat(200)] }, 200)).toBe(64);
	});

	it("never exceeds the terminal, so a narrow window still fits", () => {
		expect(pillBubbleWidth({ body: ["x".repeat(200)] }, 30)).toBe(26);
		expect(pillBubbleWidth({ body: ["x".repeat(200)] }, 10)).toBeLessThanOrEqual(8);
	});

	it("measures clickable lines by their text", () => {
		expect(pillBubbleWidth({ body: [{ text: "x".repeat(50), onSelect: () => {} }] }, 80)).toBe(54);
	});
});

describe("pillBubblePlacement", () => {
	it("starts a few columns left of the pill and opens its bottom edge over it", () => {
		const placement = pillBubblePlacement(anchor({ startColumn: 33, endColumn: 38 }), 30, 80);
		expect(placement.leftColumn).toBe(30);
		expect(placement.attached).toBe(true);
		expect(placement.tab).toEqual({ start: 3, end: 8 });
		expect(placement.options).toMatchObject({
			width: 30,
			anchor: "bottom-left",
			offsetX: 30,
			offsetY: -1,
		});
	});

	it("pushes the bubble left only as far as it needs to stay on screen", () => {
		const placement = pillBubblePlacement(
			anchor({ startColumn: 70, endColumn: 75, centerColumn: 74 }),
			30,
			80,
		);
		expect(placement.leftColumn).toBe(50);
		expect(placement.tab).toEqual({ start: 20, end: 25 });
	});

	it("closes the bottom when the pill is too close to the bubble's edge for a tab", () => {
		const atLeft = pillBubblePlacement(anchor({ startColumn: 0, endColumn: 6 }), 30, 80);
		expect(atLeft.leftColumn).toBe(0);
		expect(atLeft.tab).toBeUndefined();
		const atRight = pillBubblePlacement(anchor({ startColumn: 74, endColumn: 80 }), 30, 80);
		expect(atRight.tab).toBeUndefined();
	});

	it("centres on the pill when the anchor has no left edge", () => {
		const placement = pillBubblePlacement(anchor(), 30, 80);
		expect(placement.leftColumn).toBe(25);
		expect(placement.attached).toBe(true);
		expect(placement.tab).toBeUndefined();
	});

	it("centres and floats when there is no pill to sit on", () => {
		const placement = pillBubblePlacement(undefined, 30, 80);
		expect(placement.leftColumn).toBe(25);
		expect(placement.attached).toBe(false);
	});

	it("is wide enough for the opening over a wide pill", () => {
		const wide = anchor({ startColumn: 10, endColumn: 50 });
		expect(pillBubbleWidth({ body: ["hi"] }, 80, wide)).toBe(48);
	});
});

describe("renderPillBubble", () => {
	const render = (overrides: Partial<Parameters<typeof renderPillBubble>[0]> = {}) =>
		renderPillBubble({
			content,
			width: 40,
			background: BACKGROUND,
			foreground: "",
			attached: true,
			tab: { start: 4, end: 10 },
			...overrides,
		});

	it("draws a rounded outline of even width, in the pill's colour, with nothing filled", () => {
		const lines = render();
		for (const line of lines) expect(visibleWidth(line)).toBe(40);
		const plain = lines.map(strip);
		expect(plain[0]?.startsWith("╭")).toBe(true);
		expect(plain[0]?.endsWith("╮")).toBe(true);
		for (const line of plain.slice(1, -1)) {
			expect(line.startsWith("│")).toBe(true);
			expect(line.endsWith("│")).toBe(true);
		}
		// The pill's colour is only ever a foreground: no row is filled.
		expect(lines.join("")).not.toContain(BACKGROUND);
		expect(lines[0]).toContain("\x1b[38;2;249;226;175m");
	});

	it("carries the title in the top edge", () => {
		const top = strip(render()[0] ?? "");
		expect(top.startsWith("╭─ 2 messages queued ─")).toBe(true);
		const lines = render().map(strip);
		expect(lines.join("\n")).toContain("esc to close");
		expect(lines.join("\n")).toContain("· first");
	});

	it("opens the bottom edge over the pill, like a folder tab", () => {
		expect(strip(render().at(-1) ?? "")).toBe(`╰──┘${" ".repeat(6)}└${"─".repeat(28)}╯`);
	});

	it("closes the bottom without a tab", () => {
		expect(strip(render({ tab: undefined }).at(-1) ?? "")).toBe(`╰${"─".repeat(38)}╯`);
	});

	it("fills the selected target with the pill's colour, and only that row", () => {
		const lines = render({
			content: {
				body: ["plain", { text: "one", onSelect: () => {} }, { text: "two", onSelect: () => {} }],
			},
			selected: 1,
		});
		const filled = lines.filter((line) => line.includes(BACKGROUND));
		expect(filled).toHaveLength(1);
		expect(strip(filled[0] ?? "")).toContain("two");
		expect(visibleWidth(filled[0] ?? "")).toBe(40);
	});

	it("wraps long paragraphs instead of overflowing", () => {
		const lines = render({ content: { body: ["word ".repeat(40)] }, width: 30 });
		for (const line of lines) expect(visibleWidth(line)).toBe(30);
		expect(lines.length).toBeGreaterThan(5);
	});

	it("keeps the block aligned around wide characters", () => {
		const lines = render({ content: { body: ["排队消息测试"] }, width: 24 });
		for (const line of lines) expect(visibleWidth(line)).toBe(24);
	});

	it("underlines a clickable line and leaves plain text alone", () => {
		const lines = render({
			content: {
				body: ["plain", { text: "▸ selectable", onSelect: () => {} }],
			},
		});
		const underlined = lines.filter((line) => line.includes("\x1b[4m"));
		expect(underlined).toHaveLength(1);
		expect(strip(underlined[0] ?? "")).toContain("▸ selectable");
		// The margin is not part of the target's underline.
		const [, afterUnderline] = (underlined[0] ?? "").split("\x1b[4m");
		expect(strip(afterUnderline ?? "").startsWith("▸ selectable")).toBe(true);
	});
});

type BubbleComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse?(event: { type?: string; x: number; y: number }): { handled?: boolean } | undefined;
};

function fakeContext(hasUI = true) {
	const custom = vi.fn().mockResolvedValue(undefined);
	return {
		custom,
		ctx: { hasUI, ui: { custom } } as never,
	};
}

function openBubble(
	custom: ReturnType<typeof vi.fn>,
	done: ReturnType<typeof vi.fn>,
): BubbleComponent {
	const factory = custom.mock.calls.at(-1)?.[0] as (...args: unknown[]) => BubbleComponent;
	return factory({}, {}, {}, done);
}

describe("showPillBubble", () => {
	it("opens an overlay above the pill and closes on escape", () => {
		const { ctx, custom } = fakeContext();
		showPillBubble(ctx, content, anchor());

		expect(custom).toHaveBeenCalledTimes(1);
		const [factory, options] = custom.mock.calls[0] ?? [];
		expect(options).toMatchObject({ overlay: true });
		const overlay = (options as { overlayOptions?: { offsetY?: number } }).overlayOptions;
		expect(overlay?.offsetY).toBe(-1);

		const done = vi.fn();
		const bubble = (factory as (...args: unknown[]) => BubbleComponent)({}, {}, {}, done);
		expect(bubble.render(30).length).toBeGreaterThan(0);
		bubble.handleInput("\x1b");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("remembers which pill opened it, until it closes", () => {
		const { ctx, custom } = fakeContext();
		showPillBubble(ctx, content, anchor({ key: "queue" }));
		const bubble = openBubble(custom, vi.fn());
		expect(isPillBubbleOpenFor("queue")).toBe(true);
		expect(isPillBubbleOpenFor("thinking")).toBe(false);
		bubble.handleInput("\x1b");
		expect(isPillBubbleOpenFor("queue")).toBe(false);
	});

	it("does nothing without a UI", () => {
		const { ctx, custom } = fakeContext(false);
		showPillBubble(ctx, content, anchor());
		expect(custom).not.toHaveBeenCalled();
	});

	it("replaces an open bubble instead of stacking a second one", () => {
		const { ctx, custom } = fakeContext();
		showPillBubble(ctx, content, anchor());
		const done = vi.fn();
		const first = custom.mock.calls[0]?.[0] as (...args: unknown[]) => unknown;
		first({}, {}, {}, done);

		showPillBubble(ctx, { ...content, title: "second" }, anchor());
		expect(done).toHaveBeenCalledTimes(1);
		expect(custom).toHaveBeenCalledTimes(2);
	});

	it("runs a clickable row's callback on click, and closes the bubble", () => {
		const onSelect = vi.fn();
		const { ctx, custom } = fakeContext();
		showPillBubble(
			ctx,
			{
				title: "Balance",
				body: ["5h: 42%", { text: "▸ details", onSelect }],
				hint: "esc to close",
			},
			anchor(),
		);
		const done = vi.fn();
		const bubble = openBubble(custom, done);
		const lines = bubble.render(40);
		const row = lines.findIndex((line) => strip(line).includes("▸ details"));

		expect(bubble.handleMouse?.({ type: "press", x: 3, y: row })).toEqual({ handled: true });
		expect(onSelect).not.toHaveBeenCalled();
		expect(bubble.handleMouse?.({ type: "click", x: 3, y: row })).toEqual({ handled: true });
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("leaves clicks on plain rows and outside the bubble unhandled", () => {
		const { ctx, custom } = fakeContext();
		showPillBubble(ctx, { body: ["plain", { text: "▸ details", onSelect: vi.fn() }] }, anchor());
		const bubble = openBubble(custom, vi.fn());
		bubble.render(40);

		expect(bubble.handleMouse?.({ type: "click", x: 3, y: 1 })).toBeUndefined();
		expect(bubble.handleMouse?.({ type: "click", x: 3, y: 99 })).toBeUndefined();
	});
});

describe("bubble handle", () => {
	type Mounted = BubbleComponent & { dispose(): void };

	/** Mount the overlay the latest `custom` call asked for, with a renderer that can repaint. */
	function mount(custom: ReturnType<typeof vi.fn>, index = -1) {
		const call = index < 0 ? custom.mock.calls.at(index) : custom.mock.calls[index];
		const [factory, options] = call ?? [];
		const tui = { requestRender: vi.fn() };
		const done = vi.fn();
		const bubble = (factory as (...args: unknown[]) => Mounted)(tui, {}, {}, done);
		const width = (options as { overlayOptions: { width: number } }).overlayOptions.width;
		return { bubble, tui, done, width };
	}

	it("is closed from the start without a UI, and says so to onClose at once", () => {
		const { ctx } = fakeContext(false);
		const handle = showPillBubble(ctx, content, anchor());
		const onClose = vi.fn();
		handle.onClose(onClose);
		expect(handle.isOpen()).toBe(false);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("reads function content again on refresh and repaints in place", () => {
		const { ctx, custom } = fakeContext();
		let count = 1;
		const handle = showPillBubble(ctx, () => ({ body: [`count ${count}`] }), anchor());
		const { bubble, tui, width } = mount(custom);
		expect(bubble.render(width).map(strip).join("\n")).toContain("count 1");

		count = 2;
		handle.refresh();
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(bubble.render(width).map(strip).join("\n")).toContain("count 2");
	});

	it("reopens wider when a line outgrows it, then takes the old overlay down", () => {
		const { ctx, custom } = fakeContext();
		let text = "short";
		const handle = showPillBubble(ctx, () => ({ body: [text] }), anchor());
		const first = mount(custom);

		text = "x".repeat(40);
		handle.refresh();
		expect(custom).toHaveBeenCalledTimes(2);
		// Until the wider one is up, the narrower one stays.
		expect(first.done).not.toHaveBeenCalled();
		const second = mount(custom);
		expect(second.width).toBeGreaterThan(first.width);
		expect(first.done).toHaveBeenCalledTimes(1);
		// Pi disposing the replaced overlay is not the bubble closing.
		first.bubble.dispose();
		expect(handle.isOpen()).toBe(true);

		// And it does not narrow again.
		text = "short";
		handle.refresh();
		expect(custom).toHaveBeenCalledTimes(2);
	});

	it("runs onClose once, whichever way the bubble ends", () => {
		const endings: Array<(parts: ReturnType<typeof mount>, handle: { close(): void }) => void> = [
			({ bubble }) => bubble.handleInput("\x1b"),
			(_parts, handle) => handle.close(),
			({ bubble }) => bubble.dispose(),
			() => closePillBubble(),
		];
		for (const end of endings) {
			const { ctx, custom } = fakeContext();
			const handle = showPillBubble(ctx, content, anchor());
			const parts = mount(custom);
			const onClose = vi.fn();
			handle.onClose(onClose);
			end(parts, handle);
			handle.close();
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(handle.isOpen()).toBe(false);
		}
	});

	it("closes the first bubble's handle when a second one replaces it", () => {
		const { ctx, custom } = fakeContext();
		const first = showPillBubble(ctx, content, anchor({ key: "queue" }));
		mount(custom);
		const onClose = vi.fn();
		first.onClose(onClose);

		showPillBubble(ctx, content, anchor({ key: "thinking" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(isPillBubbleOpenFor("thinking")).toBe(true);
	});

	it("ignores refresh once closed, and keeps the old content when the source throws", () => {
		const { ctx, custom } = fakeContext();
		let fail = false;
		const read = vi.fn(() => {
			if (fail) throw new Error("source broke");
			return { body: ["steady"] };
		});
		const handle = showPillBubble(ctx, read, anchor());
		const { bubble, width } = mount(custom);

		fail = true;
		handle.refresh();
		expect(bubble.render(width).map(strip).join("\n")).toContain("steady");

		handle.close();
		const calls = read.mock.calls.length;
		handle.refresh();
		expect(read.mock.calls.length).toBe(calls);
	});
});

describe("choosing a target", () => {
	type Interactive = BubbleComponent & { dispose(): void };
	const DOWN = "\x1b[B";
	const UP = "\x1b[A";
	const ENTER = "\r";

	function open(onOne = vi.fn(), onTwo = vi.fn()) {
		const { ctx, custom } = fakeContext();
		const handle = showPillBubble(
			ctx,
			{
				title: "Pick",
				body: ["plain", { text: "one", onSelect: onOne }, { text: "two", onSelect: onTwo }],
				hint: "esc to close",
			},
			anchor(),
		);
		const [factory, options] = custom.mock.calls.at(-1) ?? [];
		const tui = { requestRender: vi.fn() };
		const done = vi.fn();
		const bubble = (factory as (...args: unknown[]) => Interactive)(tui, {}, {}, done);
		const width = (options as { overlayOptions: { width: number } }).overlayOptions.width;
		const selectedText = () =>
			strip(bubble.render(width).find((line) => line.includes(BACKGROUND)) ?? "");
		return { bubble, tui, done, handle, width, selectedText, onOne, onTwo };
	}

	it("steps through the targets with the arrow keys, wrapping, and runs one with Enter", () => {
		const { bubble, done, selectedText, onOne, onTwo } = open();
		expect(selectedText()).toBe("");
		bubble.handleInput(DOWN);
		expect(selectedText()).toContain("one");
		bubble.handleInput(DOWN);
		expect(selectedText()).toContain("two");
		bubble.handleInput(DOWN);
		expect(selectedText()).toContain("one");
		bubble.handleInput(UP);
		expect(selectedText()).toContain("two");

		bubble.handleInput(ENTER);
		expect(onTwo).toHaveBeenCalledTimes(1);
		expect(onOne).not.toHaveBeenCalled();
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("starts from the bottom when the first key is up", () => {
		const { bubble, selectedText, width } = open();
		// Keys act on the targets of the last render; Pi always renders before input.
		bubble.render(width);
		bubble.handleInput(UP);
		expect(selectedText()).toContain("two");
	});

	it("closes on Enter with nothing selected, running nothing", () => {
		const { bubble, done, onOne, onTwo } = open();
		bubble.handleInput(ENTER);
		expect(done).toHaveBeenCalledTimes(1);
		expect(onOne).not.toHaveBeenCalled();
		expect(onTwo).not.toHaveBeenCalled();
	});

	it("selects the target under the pointer, so the mouse and the keys agree", () => {
		const { bubble, tui, width, selectedText } = open();
		const row = bubble.render(width).findIndex((line) => strip(line).includes("one"));
		expect(bubble.handleMouse?.({ type: "move", x: 3, y: row })).toEqual({ handled: true });
		expect(selectedText()).toContain("one");
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
		// Moving within the same target does not repaint again.
		bubble.handleMouse?.({ type: "move", x: 5, y: row });
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
		bubble.handleInput(DOWN);
		expect(selectedText()).toContain("two");
	});
});

describe("opening animation", () => {
	afterEach(() => {
		setPillBubbleAnimation(0);
		vi.useRealTimers();
	});

	it("unfolds upward from the pill, a row at a time, then stops repainting", async () => {
		vi.useFakeTimers();
		setPillBubbleAnimation(90);
		const { ctx, custom } = fakeContext();
		const onSelect = vi.fn();
		showPillBubble(
			ctx,
			{ title: "Pick", body: [{ text: "one", onSelect }, "two", "three"], hint: "esc" },
			anchor(),
		);
		const [factory, options] = custom.mock.calls.at(-1) ?? [];
		const tui = { requestRender: vi.fn() };
		const bubble = (factory as (...args: unknown[]) => BubbleComponent)(tui, {}, {}, vi.fn());
		const width = (options as { overlayOptions: { width: number } }).overlayOptions.width;

		const first = bubble.render(width).map(strip);
		expect(first).toHaveLength(1);
		// The row that shows first is the one on the pill: the bottom edge.
		expect(first[0]?.startsWith("╰")).toBe(true);
		// Not yet drawn, so not yet clickable.
		expect(bubble.handleMouse?.({ type: "click", x: 3, y: 0 })).toBeUndefined();

		await vi.advanceTimersByTimeAsync(48);
		const middle = bubble.render(width).length;
		expect(middle).toBeGreaterThan(1);
		expect(middle).toBeLessThan(6);

		await vi.advanceTimersByTimeAsync(100);
		const full = bubble.render(width).map(strip);
		expect(full).toHaveLength(6);
		expect(full[0]?.startsWith("╭─ Pick")).toBe(true);
		const repaints = tui.requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(200);
		expect(tui.requestRender.mock.calls.length).toBe(repaints);

		// Targets line up with the rows once it is whole.
		bubble.handleMouse?.({ type: "click", x: 3, y: 1 });
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("does not animate a reopen for width", () => {
		setPillBubbleAnimation(90);
		const { ctx, custom } = fakeContext();
		let text = "short";
		const handle = showPillBubble(ctx, () => ({ body: [text] }), anchor());
		const [first] = custom.mock.calls.at(-1) ?? [];
		(first as (...args: unknown[]) => BubbleComponent)({ requestRender: vi.fn() }, {}, {}, vi.fn());

		text = "x".repeat(50);
		handle.refresh();
		const [second, options] = custom.mock.calls.at(-1) ?? [];
		const bubble = (second as (...args: unknown[]) => BubbleComponent)(
			{ requestRender: vi.fn() },
			{},
			{},
			vi.fn(),
		);
		const width = (options as { overlayOptions: { width: number } }).overlayOptions.width;
		expect(bubble.render(width)).toHaveLength(3);
	});
});
