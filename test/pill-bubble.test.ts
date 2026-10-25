import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closePillBubble,
	type PillAnchor,
	pillBubblePlacement,
	pillBubbleWidth,
	renderPillBubble,
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
	it("lines the bubble up with the pill's left edge, on the footer row", () => {
		const placement = pillBubblePlacement(anchor({ startColumn: 33 }), 30, 80);
		expect(placement.leftColumn).toBe(33);
		expect(placement.attached).toBe(true);
		expect(placement.options).toMatchObject({
			width: 30,
			anchor: "bottom-left",
			offsetX: 33,
			offsetY: -1,
		});
	});

	it("pushes the bubble left only as far as it needs to stay on screen", () => {
		const placement = pillBubblePlacement(anchor({ startColumn: 70, centerColumn: 74 }), 30, 80);
		expect(placement.leftColumn).toBe(50);
		expect(placement.attached).toBe(true);
	});

	it("centres on the pill when the anchor has no left edge", () => {
		const placement = pillBubblePlacement(anchor(), 30, 80);
		expect(placement.leftColumn).toBe(25);
		expect(placement.attached).toBe(true);
	});

	it("centres and floats when there is no pill to sit on", () => {
		const placement = pillBubblePlacement(undefined, 30, 80);
		expect(placement.leftColumn).toBe(25);
		expect(placement.attached).toBe(false);
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
			...overrides,
		});

	it("paints every line edge to edge, so the block is solid", () => {
		const lines = render();
		expect(lines.length).toBeGreaterThanOrEqual(5);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
		}
		// The top edge is the fill colour drawn on the terminal's own background;
		// every row below it carries the pill background.
		expect(lines[0]).not.toContain(BACKGROUND);
		for (const line of lines.slice(1)) expect(line).toContain(BACKGROUND);
	});

	it("draws no corners, outline or tail, only a half-row top edge", () => {
		const lines = render().map(strip);
		expect(lines[0]).toBe("▄".repeat(40));
		expect(lines.join("\n")).not.toMatch(/[▗▖▝▘▼╭╮╰╯]/u);
	});

	it("puts the title inside the block", () => {
		const lines = render().map(strip);
		expect(lines[1]).toContain("2 messages queued");
		expect(lines.join("\n")).toContain("esc to close");
		expect(lines.join("\n")).toContain("· first");
	});

	it("leaves the bottom open when it sits on its pill", () => {
		const lines = render().map(strip);
		expect(lines.at(-1)).toContain("esc to close");
	});

	it("closes the bottom with a half-row edge when it floats", () => {
		const lines = render({ attached: false });
		expect(strip(lines.at(-1) ?? "")).toBe("▀".repeat(40));
		expect(lines.at(-1)).not.toContain(BACKGROUND);
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
