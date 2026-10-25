import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/starline/config";
import { installFooter } from "../extensions/starline/footer";
import { emptyGitStatus } from "../extensions/starline/git";
import { type PillInput, type PillSpan, renderPillBar } from "../extensions/starline/pill";
import { hasQueuedMessages, pillActionFor } from "../extensions/starline/pill-actions";
import { DEFAULT_PILL_CONFIG, type PillConfig } from "../extensions/starline/pill-config";
import { registerStarlineSettingsCommand } from "../extensions/starline/settings-command";
import { createInitialState } from "../extensions/starline/state";
import type { ThemeLike } from "../extensions/starline/style";

/** Colours are irrelevant to hit areas, so this theme renders everything as plain text. */
const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const plain = (text: string) => stripVTControlCharacters(text);

function spansOf(
	inputs: PillInput[],
	config: Partial<PillConfig>,
	width: number,
	ascii = true,
): { bar: string; spans: PillSpan[] } {
	const spans: PillSpan[] = [];
	const bar = renderPillBar(inputs, theme, "theme", { ...DEFAULT_PILL_CONFIG, ...config }, width, {
		ascii,
		onSpan: (span) => spans.push(span),
	});
	return { bar, spans };
}

const aa: PillInput = { key: "aa", text: "aa", spec: "" };
const bbb: PillInput = { key: "bbb", text: "bbb", spec: "" };

describe("pill spans", () => {
	it("records one span per pill, in columns of the rendered bar", () => {
		const { bar, spans } = spansOf([aa, bbb], { caps: "none", separator: "none" }, 80);
		// ascii drops caps and arrows, so the bar is exactly the padded pill text.
		expect(plain(bar)).toBe(" aa  bbb ");
		expect(spans).toEqual([
			{ key: "aa", startColumn: 0, endColumn: 4 },
			{ key: "bbb", startColumn: 4, endColumn: 9 },
		]);
	});

	it("tiles the whole bar, including caps and separators, with no dead cells", () => {
		const { bar, spans } = spansOf([aa, bbb], {}, 80, false);
		const width = visibleWidth(bar);
		expect(spans[0]?.startColumn).toBe(0);
		expect(spans.at(-1)?.endColumn).toBe(width);
		for (let index = 1; index < spans.length; index += 1) {
			expect(spans[index]?.startColumn).toBe(spans[index - 1]?.endColumn);
		}
	});

	it("counts CJK text by glyph width, not by string length", () => {
		const wide: PillInput = { key: "queue", text: "排队", spec: "" };
		const { bar, spans } = spansOf([wide, bbb], { caps: "none", separator: "none" }, 80);
		// " 排队 " is six cells: two ideographs, two spaces, two columns each.
		expect(spans[0]).toEqual({ key: "queue", startColumn: 0, endColumn: 6 });
		expect(spans[1]?.startColumn).toBe(6);
		expect(visibleWidth(bar)).toBe(11);
	});

	it("keeps a clipped pill's visible cells and drops one clipped away entirely", () => {
		const clipped = spansOf([aa, bbb], { caps: "none", separator: "none" }, 6);
		expect(plain(clipped.bar)).toBe(" aa  b");
		expect(clipped.spans).toEqual([
			{ key: "aa", startColumn: 0, endColumn: 4 },
			{ key: "bbb", startColumn: 4, endColumn: 6 },
		]);

		const gone = spansOf([aa, bbb], { caps: "none", separator: "none" }, 4);
		expect(gone.spans).toEqual([{ key: "aa", startColumn: 0, endColumn: 4 }]);
	});

	it("never reports a column the terminal does not draw", () => {
		for (const width of [1, 2, 3, 5, 7, 8, 40]) {
			const { bar, spans } = spansOf([aa, bbb], {}, width, false);
			for (const span of spans) {
				expect(span.startColumn).toBeLessThan(span.endColumn);
				expect(span.endColumn).toBeLessThanOrEqual(visibleWidth(bar));
			}
		}
	});

	it("reports nothing for an empty bar", () => {
		const spans: PillSpan[] = [];
		renderPillBar([], theme, "theme", DEFAULT_PILL_CONFIG, 80, {
			onSpan: (span) => spans.push(span),
		});
		expect(spans).toEqual([]);
	});
});

type FooterFactory = (...args: unknown[]) => {
	render(width: number): string[];
	handleMouse?: (event: Record<string, unknown>) => { handled?: boolean } | undefined;
	dispose?: () => void;
};

function makeFooter(options: { queued?: boolean; config?: ReturnType<typeof mergeConfig> } = {}) {
	let factory: FooterFactory | undefined;
	const custom = vi.fn();
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp/project",
		model: { id: "kimi", provider: "deepseek", contextWindow: 200_000 },
		sessionManager: { getSessionName: () => undefined },
		getContextUsage: () => undefined,
		hasPendingMessages: () => options.queued === true,
		ui: {
			theme,
			setFooter(next: FooterFactory | undefined) {
				factory = next;
			},
			custom,
			notify,
		},
	};

	const state = createInitialState(emptyGitStatus());
	state.modelLabel = "kimi";
	const config =
		options.config ??
		mergeConfig({
			footerStyle: "pill",
			pill: { segments: ["model", "queue"] },
			colorSources: { starship: "theme" },
		});

	installFooter(ctx as never, state, () => config, {
		setRequestRender() {},
		scheduleProjectRefresh() {},
	});

	const footer = factory?.({ requestRender() {} }, theme, {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map<string, string>(),
	});
	if (!footer) throw new Error("footer factory was not registered");
	return { footer, custom, notify, ctx };
}

/** Column of `needle` in a rendered footer line; SGR sequences have no width. */
function columnOf(line: string, needle: string): number {
	const index = plain(line).indexOf(needle);
	if (index < 0) throw new Error(`"${needle}" is not on the footer line`);
	return index;
}

describe("footer pill clicks", () => {
	const width = 80;

	it("runs the segment's action on a click", () => {
		const { footer, custom } = makeFooter({ queued: true });
		const line = footer.render(width)[0] ?? "";
		const x = columnOf(line, "queued");

		expect(footer.handleMouse?.({ type: "click", x, y: 0, width })).toEqual({ handled: true });
		expect(custom).toHaveBeenCalledTimes(1);
	});

	it("claims the press but does not act on it, so a drag is not a click", () => {
		const { footer, custom } = makeFooter({ queued: true });
		const line = footer.render(width)[0] ?? "";
		const x = columnOf(line, "queued");

		expect(footer.handleMouse?.({ type: "press", x, y: 0, width })).toEqual({ handled: true });
		expect(custom).not.toHaveBeenCalled();
	});

	it("leaves a segment without an action unhandled", () => {
		const { footer, custom } = makeFooter({ queued: true });
		const line = footer.render(width)[0] ?? "";
		// The model pill is a read-out: it is drawn, it just does nothing.
		const x = columnOf(line, "kimi");

		expect(footer.handleMouse?.({ type: "click", x, y: 0, width })).toBeUndefined();
		expect(footer.handleMouse?.({ type: "press", x, y: 0, width })).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});

	it("lets a click outside the bar or off its row fall through", () => {
		const { footer, custom } = makeFooter({ queued: true });
		const line = footer.render(width)[0] ?? "";
		const end = visibleWidth(line);

		// The footer pads the bar with one column on each side.
		expect(footer.handleMouse?.({ type: "click", x: 0, y: 0, width })).toBeUndefined();
		expect(footer.handleMouse?.({ type: "click", x: end + 5, y: 0, width })).toBeUndefined();
		expect(footer.handleMouse?.({ type: "click", x: end - 1, y: 1, width })).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});

	it("ignores a click whose width does not match the render it was matched against", () => {
		const { footer, custom } = makeFooter({ queued: true });
		footer.render(width);

		expect(footer.handleMouse?.({ type: "click", x: 5, y: 0, width: width - 1 })).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});

	it("has no targets in the text footer", () => {
		const { footer, custom } = makeFooter({
			queued: true,
			// `$queue` in a text format renders the same word, without a hit area.
			config: mergeConfig({ footerStyle: "text", footerFormat: "$queue" }),
		});
		const line = footer.render(width)[0] ?? "";
		const x = columnOf(line, "queued");

		expect(footer.handleMouse?.({ type: "click", x, y: 0, width })).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});

	it("has no queue pill when nothing is queued", () => {
		const { footer, custom } = makeFooter({ queued: false });
		const line = footer.render(width)[0] ?? "";
		expect(plain(line)).not.toContain("queued");
		expect(footer.handleMouse?.({ type: "click", x: 1, y: 0, width })).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});
});

describe("queue action", () => {
	it("only builtin segments have actions; a status with the same key does not", () => {
		expect(pillActionFor("queue")).toBeTypeOf("function");
		expect(pillActionFor("model")).toBeUndefined();
		expect(pillActionFor("gitBranch")).toBeUndefined();
		expect(pillActionFor("extensionStatus:queue")).toBeUndefined();
	});

	it("reads the queued flag and degrades when the runtime does not offer it", () => {
		expect(hasQueuedMessages({ hasPendingMessages: () => true } as never)).toBe(true);
		expect(hasQueuedMessages({ hasPendingMessages: () => false } as never)).toBe(false);
		expect(hasQueuedMessages({} as never)).toBe(false);
		expect(
			hasQueuedMessages({
				hasPendingMessages: () => {
					throw new Error("stale context");
				},
			} as never),
		).toBe(false);
	});

	it("explains the queue without inventing a count, and closes on escape", async () => {
		const { footer, custom } = makeFooter({ queued: true });
		const line = footer.render(80)[0] ?? "";
		footer.handleMouse?.({ type: "click", x: columnOf(line, "queued"), y: 0, width: 80 });

		const factory = custom.mock.calls[0]?.[0] as
			| ((
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: void) => void,
			  ) => { render(width: number): string[]; handleInput(data: string): void })
			| undefined;
		expect(factory).toBeTypeOf("function");

		const done = vi.fn();
		const panel = factory?.({ requestRender() {} }, theme, {}, done);
		const lines = panel?.render(50) ?? [];
		const text = lines.map(plain).join("\n");

		expect(text).toContain("Queued messages");
		expect(text).toContain("esc to close");
		expect(text).not.toMatch(/\b\d+\s+queued/);
		expect(lines.every((entry) => visibleWidth(entry) <= 50)).toBe(true);

		panel?.handleInput("\x1b");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("is reachable from the keyboard as /starline queue", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: { handler: typeof handler }) {
					handler = options.handler;
				},
			} as never,
			{ getConfig: () => defaultConfig, requestRender() {} } as never,
		);

		const custom = vi.fn();
		const notify = vi.fn();
		const ctx = {
			hasUI: true,
			mode: "tui",
			hasPendingMessages: () => true,
			ui: { theme, custom, notify },
		};

		await handler?.("queue", ctx);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();

		await handler?.("queue", { ...ctx, hasPendingMessages: () => false });
		expect(notify).toHaveBeenCalledWith("No messages are queued", "info");
	});
});
