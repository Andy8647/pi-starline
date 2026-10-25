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
});

describe("pillBubblePlacement", () => {
	it("centres over the pill and turns the offset into a tail column", () => {
		const placement = pillBubblePlacement(anchor(), 30, 80);
		expect(placement.leftColumn).toBe(25);
		expect(placement.tailColumn).toBe(15);
		expect(placement.options).toMatchObject({
			width: 30,
			anchor: "bottom-left",
			offsetX: 25,
			offsetY: -1,
		});
	});

	it("clamps to the screen and lets the renderer pull the tail back inside", () => {
		const placement = pillBubblePlacement(anchor({ centerColumn: 78 }), 30, 80);
		expect(placement.leftColumn).toBe(49);
		expect(placement.tailColumn).toBe(29);

		const lines = renderPillBubble({
			content,
			width: 30,
			background: BACKGROUND,
			tailColumn: placement.tailColumn,
		});
		const bottom = lines.at(-1) ?? "";
		// width - 3 is the rightmost column a tail may occupy.
		expect(bottom.replace(/\x1b\[[0-9;]*m/g, "").indexOf("▽")).toBe(27);
	});

	it("centres and drops the tail when there is no pill to point at", () => {
		const placement = pillBubblePlacement(undefined, 30, 80);
		expect(placement.leftColumn).toBe(25);
		expect(placement.tailColumn).toBeUndefined();
	});
});

describe("renderPillBubble", () => {
	const render = (overrides: Partial<Parameters<typeof renderPillBubble>[0]> = {}) =>
		renderPillBubble({
			content,
			width: 40,
			background: BACKGROUND,
			foreground: "",
			tailColumn: 20,
			...overrides,
		});

	it("draws a solid block: every line is exactly as wide as the bubble", () => {
		const lines = render();
		expect(lines.length).toBeGreaterThanOrEqual(5);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
			expect(line).toContain(BACKGROUND);
		}
	});

	it("puts the title in the top border and the hint at the bottom", () => {
		const text = render()
			.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
			.join("\n");
		expect(text.split("\n")[0]).toContain("2 messages queued");
		expect(text).toContain("esc to close");
		expect(text).toContain("· first");
	});

	it("cuts the tail into the bottom border, never into a corner", () => {
		for (const tailColumn of [0, 1, 2, 20, 38, 39, 99]) {
			const bottom = (render({ tailColumn }).at(-1) ?? "").replace(/\x1b\[[0-9;]*m/g, "");
			const index = bottom.indexOf("▽");
			expect(index).toBeGreaterThanOrEqual(2);
			expect(index).toBeLessThanOrEqual(37);
			expect(bottom.startsWith("╰")).toBe(true);
			expect(bottom.endsWith("╯")).toBe(true);
			expect(bottom).not.toContain("▽▽");
		}
	});

	it("has no tail when no column is given", () => {
		expect(render({ tailColumn: undefined }).at(-1)).not.toContain("▽");
	});

	it("wraps long paragraphs instead of overflowing the box", () => {
		const lines = render({ content: { body: ["word ".repeat(40)] }, width: 30 });
		for (const line of lines) expect(visibleWidth(line)).toBe(30);
		expect(lines.length).toBeGreaterThan(5);
	});

	it("keeps the box aligned around wide characters", () => {
		const lines = render({ content: { body: ["排队消息测试"] }, width: 24 });
		for (const line of lines) expect(visibleWidth(line)).toBe(24);
	});
});

describe("showPillBubble", () => {
	function fakeContext(hasUI = true) {
		const custom = vi.fn().mockResolvedValue(undefined);
		return {
			custom,
			ctx: { hasUI, ui: { custom } } as never,
		};
	}

	it("opens an overlay above the pill and closes on escape", () => {
		const { ctx, custom } = fakeContext();
		showPillBubble(ctx, content, anchor());

		expect(custom).toHaveBeenCalledTimes(1);
		const [factory, options] = custom.mock.calls[0] ?? [];
		expect(options).toMatchObject({ overlay: true });
		const overlay = (options as { overlayOptions?: { offsetY?: number } }).overlayOptions;
		expect(overlay?.offsetY).toBe(-1);

		const done = vi.fn();
		const bubble = factory({}, {}, {}, done) as {
			render(width: number): string[];
			handleInput(data: string): void;
		};
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
});
