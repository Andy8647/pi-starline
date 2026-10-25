import { stripVTControlCharacters } from "node:util";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/starline/config";
import { installFooter } from "../extensions/starline/footer";
import { emptyGitStatus } from "../extensions/starline/git";
import { forgetLiveSession, installLiveSessionCapture } from "../extensions/starline/live-session";
import { installPointerShape } from "../extensions/starline/mouse/pointer-shape";
import { type PillInput, type PillSpan, renderPillBar } from "../extensions/starline/pill";
import {
	hasQueuedMessages,
	pillActionFor,
	queuedSegmentText,
	runPillAction,
} from "../extensions/starline/pill-actions";
import { closePillBubble } from "../extensions/starline/pill-bubble";
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

afterEach(() => {
	forgetLiveSession();
	// A bubble counts as open from the moment it is shown; one left over would
	// turn the next test's click on the same pill into a close.
	closePillBubble();
});

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

/** Spans carry the pill's colours too; column tests do not care about them. */
function columns(spans: PillSpan[]): Array<Pick<PillSpan, "key" | "startColumn" | "endColumn">> {
	return spans.map(({ key, startColumn, endColumn }) => ({ key, startColumn, endColumn }));
}

const aa: PillInput = { key: "aa", text: "aa", spec: "" };
const bbb: PillInput = { key: "bbb", text: "bbb", spec: "" };

describe("pill spans", () => {
	it("records one span per pill, in columns of the rendered bar", () => {
		const { bar, spans } = spansOf([aa, bbb], { caps: "none", separator: "none" }, 80);
		// ascii drops caps and arrows, so the bar is exactly the padded pill text.
		expect(plain(bar)).toBe(" aa  bbb ");
		expect(columns(spans)).toEqual([
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

	it("marks where each pill's own colour starts, past the first pill's cap", () => {
		const { spans } = spansOf([aa, bbb], { caps: "round" }, 80, false);
		// The round cap is the first pill's hit area but drawn on the terminal's
		// background; the body starts one cell in. Later pills start solid.
		expect(spans[0]?.startColumn).toBe(0);
		expect(spans[0]?.bodyStartColumn).toBe(1);
		expect(spans[1]?.bodyStartColumn).toBe(spans[1]?.startColumn);
	});

	it("counts CJK text by glyph width, not by string length", () => {
		const wide: PillInput = { key: "queue", text: "排队", spec: "" };
		const { bar, spans } = spansOf([wide, bbb], { caps: "none", separator: "none" }, 80);
		// " 排队 " is six cells: two ideographs, two spaces, two columns each.
		expect(columns(spans)[0]).toEqual({ key: "queue", startColumn: 0, endColumn: 6 });
		expect(spans[1]?.startColumn).toBe(6);
		expect(visibleWidth(bar)).toBe(11);
	});

	it("keeps a clipped pill's visible cells and drops one clipped away entirely", () => {
		const clipped = spansOf([aa, bbb], { caps: "none", separator: "none" }, 6);
		expect(plain(clipped.bar)).toBe(" aa  b");
		expect(columns(clipped.spans)).toEqual([
			{ key: "aa", startColumn: 0, endColumn: 4 },
			{ key: "bbb", startColumn: 4, endColumn: 6 },
		]);

		const gone = spansOf([aa, bbb], { caps: "none", separator: "none" }, 4);
		expect(columns(gone.spans)).toEqual([{ key: "aa", startColumn: 0, endColumn: 4 }]);
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
			pill: { segments: ["cwd", "queue"] },
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

type BubbleFactory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (result: void) => void,
) => { render(width: number): string[]; handleInput(data: string): void };

/** The queue pill's default Nerd Font icon (fa-inbox). */
const QUEUE_ICON = "\uf01c";

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
		// The cwd pill is a read-out: it is drawn, it just does nothing.
		const x = columnOf(line, "project");

		expect(footer.handleMouse?.({ type: "click", x, y: 0, width })).toBeUndefined();
		expect(footer.handleMouse?.({ type: "press", x, y: 0, width })).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});

	it("asks for a hand pointer over a pill that does something, and only there", () => {
		class Renderer {
			terminal = { write: vi.fn() };
			event: Record<string, unknown> = {};
			handleMouseEvent(_raw: unknown): void {
				footer.handleMouse?.(this.event);
			}
		}
		const { footer, custom } = makeFooter({ queued: true });
		const dispose = installPointerShape(Renderer.prototype);
		try {
			const line = footer.render(width)[0] ?? "";
			const renderer = new Renderer();
			const hover = { button: 35, x: 0, y: 0, release: false };

			renderer.event = { type: "move", x: columnOf(line, "queued"), y: 0, width };
			renderer.handleMouseEvent(hover);
			renderer.event = { type: "move", x: columnOf(line, "project"), y: 0, width };
			renderer.handleMouseEvent(hover);

			expect(renderer.terminal.write.mock.calls.map(([data]) => data)).toEqual([
				"\x1b]22;pointer\x1b\\",
				"\x1b]22;default\x1b\\",
			]);
			// Hovering opens nothing.
			expect(custom).not.toHaveBeenCalled();
		} finally {
			dispose?.();
		}
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

	it("has no queue pill when nothing is queued", () => {
		const { footer, custom } = makeFooter({ queued: false });
		const line = footer.render(width)[0] ?? "";
		expect(plain(line)).not.toContain("queued");
		expect(footer.handleMouse?.({ type: "click", x: 1, y: 0, width })).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});
});

describe("pill actions", () => {
	it("only builtin segments have actions; a status with the same key does not", () => {
		expect(pillActionFor("queue")).toBeTypeOf("function");
		expect(pillActionFor("thinking")).toBeTypeOf("function");
		expect(pillActionFor("model")).toBeTypeOf("function");
		expect(pillActionFor("cwd")).toBeUndefined();
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

	it("shows the icon and the count, and keeps a word when either is missing", async () => {
		const queued = { hasPendingMessages: () => true } as never;
		expect(queuedSegmentText({ hasPendingMessages: () => false } as never, QUEUE_ICON)).toBe("");
		// No live session: the count is unknown, so the pill says what it can.
		expect(queuedSegmentText(queued, QUEUE_ICON)).toBe(`${QUEUE_ICON} queued`);
		expect(queuedSegmentText(queued)).toBe("queued");

		const prototype = AgentSession.prototype as unknown as { prompt: unknown };
		const originalPrompt = prototype.prompt;
		prototype.prompt = vi.fn(async () => {});
		const dispose = installLiveSessionCapture();
		try {
			const session = {
				getSteeringMessages: () => ["a", "b"],
				getFollowUpMessages: () => ["c"],
			};
			await (prototype.prompt as (this: unknown, text: string) => Promise<void>).call(
				session,
				"hi",
			);
			expect(queuedSegmentText(queued, QUEUE_ICON)).toBe(`${QUEUE_ICON} 3`);
			// No icon (ascii): a bare digit would be a mystery, so the word stays.
			expect(queuedSegmentText(queued)).toBe("3 queued");
		} finally {
			dispose();
			prototype.prompt = originalPrompt;
			forgetLiveSession();
		}
	});

	it("points the bubble at the pill it was opened from", () => {
		const { footer, custom } = makeFooter({ queued: true });
		const line = footer.render(80)[0] ?? "";
		const x = columnOf(line, QUEUE_ICON);
		footer.handleMouse?.({ type: "click", x, y: 0, width: 80 });

		const [factory, options] = custom.mock.calls[0] ?? [];
		expect(factory).toBeTypeOf("function");
		const overlay = (options as { overlayOptions?: Record<string, unknown> }).overlayOptions;
		// One row up, so the bubble's last line sits right on top of the pill.
		expect(overlay?.offsetY).toBe(-1);
		expect(overlay?.anchor).toBe("bottom-left");
		// Three columns of edge left of the pill's first coloured cell (the pad
		// before the icon), so the bottom edge can open over the pill like a tab.
		expect(overlay?.offsetX).toBe(x - 1 - 3);
	});

	it("closes the pill's own bubble on a second click, and opens it on a third", () => {
		const width = 80;
		const { footer, custom } = makeFooter({ queued: true });
		const line = footer.render(width)[0] ?? "";
		const x = columnOf(line, "queued");
		const done = vi.fn();

		footer.handleMouse?.({ type: "click", x, y: 0, width });
		expect(custom).toHaveBeenCalledTimes(1);
		// Mounting the overlay is what makes it the open bubble.
		const [factory] = custom.mock.calls[0] ?? [];
		(factory as BubbleFactory)({}, theme, {}, done);

		expect(footer.handleMouse?.({ type: "click", x, y: 0, width })).toEqual({ handled: true });
		expect(done).toHaveBeenCalledTimes(1);
		expect(custom).toHaveBeenCalledTimes(1);

		footer.handleMouse?.({ type: "click", x, y: 0, width });
		expect(custom).toHaveBeenCalledTimes(2);
	});

	it("falls back to explaining the wait when the session is not readable", () => {
		const { footer, custom } = makeFooter({ queued: true });
		const line = footer.render(80)[0] ?? "";
		footer.handleMouse?.({ type: "click", x: columnOf(line, "queued"), y: 0, width: 80 });

		const [factory, options] = custom.mock.calls[0] ?? [];
		const done = vi.fn();
		const width = (options as { overlayOptions?: { width?: number } }).overlayOptions?.width ?? 64;
		const bubble = (factory as BubbleFactory)({}, theme, {}, done);
		const lines = bubble.render(width);
		const text = lines.map(plain).join("\n");

		expect(text).toContain("Queued messages");
		expect(text).toContain("esc to close");
		expect(lines.every((entry) => visibleWidth(entry) === width)).toBe(true);

		bubble.handleInput("\x1b");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("lists the queued messages when the live session is readable", async () => {
		// Patch over a stub predecessor, so calling the wrapper captures a fake
		// session without running Pi's real prompt.
		const prototype = AgentSession.prototype as unknown as { prompt: unknown };
		const originalPrompt = prototype.prompt;
		prototype.prompt = vi.fn(async () => {});
		const dispose = installLiveSessionCapture();
		try {
			const session = {
				getSteeringMessages: () => ["first  thing", "second"],
				getFollowUpMessages: () => [],
			};
			await (prototype.prompt as (this: unknown, text: string) => Promise<void>).call(
				session,
				"hi",
			);

			const { footer, custom } = makeFooter({ queued: true });
			const line = footer.render(80)[0] ?? "";
			// With the session readable the pill carries the count, not the word.
			expect(plain(line)).toContain(`${QUEUE_ICON} 2`);
			expect(plain(line)).not.toContain("queued");
			footer.handleMouse?.({ type: "click", x: columnOf(line, QUEUE_ICON), y: 0, width: 80 });

			const [factory, options] = custom.mock.calls[0] ?? [];
			const width =
				(options as { overlayOptions?: { width?: number } }).overlayOptions?.width ?? 64;
			const bubble = (factory as BubbleFactory)({}, theme, {}, vi.fn());
			const text = bubble.render(width).map(plain).join("\n");

			expect(text).toContain("2 messages queued");
			expect(text).toContain("first thing");
			expect(text).toContain("second");
		} finally {
			dispose();
			prototype.prompt = originalPrompt;
			forgetLiveSession();
		}
	});

	it("keeps the queue bubble current while it is open", async () => {
		const prototype = AgentSession.prototype as unknown as { prompt: unknown };
		const originalPrompt = prototype.prompt;
		prototype.prompt = vi.fn(async () => {});
		const dispose = installLiveSessionCapture();
		vi.useFakeTimers();
		try {
			let steering = ["first"];
			const session = { getSteeringMessages: () => steering, getFollowUpMessages: () => [] };
			await (prototype.prompt as (this: unknown, text: string) => Promise<void>).call(
				session,
				"hi",
			);
			const custom = vi.fn().mockResolvedValue(undefined);
			const ctx = { hasUI: true, hasPendingMessages: () => true, ui: { custom } } as never;
			runPillAction(pillActionFor("queue") as never, ctx);

			const [factory, options] = custom.mock.calls[0] ?? [];
			const tui = { requestRender: vi.fn() };
			const bubble = (factory as BubbleFactory)(tui, theme, {}, vi.fn());
			const width = (options as { overlayOptions: { width: number } }).overlayOptions.width;
			expect(bubble.render(width).map(plain).join("\n")).toContain("1 message queued");

			steering = ["first", "second"];
			await vi.advanceTimersByTimeAsync(1_000);
			expect(tui.requestRender).toHaveBeenCalled();
			expect(bubble.render(width).map(plain).join("\n")).toContain("2 messages queued");

			steering = [];
			await vi.advanceTimersByTimeAsync(1_000);
			expect(bubble.render(width).map(plain).join("\n")).toContain("Nothing is queued.");
		} finally {
			vi.useRealTimers();
			dispose();
			prototype.prompt = originalPrompt;
			forgetLiveSession();
		}
	});

	/** Capture a fake session with these levels, run `body`, then put Pi back. */
	async function withThinkingSession(
		levels: string[],
		current: string,
		body: (session: { setThinkingLevel: ReturnType<typeof vi.fn> }) => void,
	): Promise<void> {
		const prototype = AgentSession.prototype as unknown as { prompt: unknown };
		const originalPrompt = prototype.prompt;
		prototype.prompt = vi.fn(async () => {});
		const dispose = installLiveSessionCapture();
		try {
			const session = {
				thinkingLevel: current,
				getAvailableThinkingLevels: () => levels,
				setThinkingLevel: vi.fn(),
			};
			await (prototype.prompt as (this: unknown, text: string) => Promise<void>).call(
				session,
				"hi",
			);
			body(session);
		} finally {
			dispose();
			prototype.prompt = originalPrompt;
			forgetLiveSession();
		}
	}

	const pillAnchor = {
		startColumn: 18,
		centerColumn: 20,
		terminalWidth: 80,
		background: "\x1b[48;5;3m",
		foreground: "",
	};

	it("opens the level list on click without changing the level", async () => {
		await withThinkingSession(["off", "low", "high", "xhigh"], "high", (session) => {
			const custom = vi.fn().mockResolvedValue(undefined);
			runPillAction(
				pillActionFor("thinking") as never,
				{ hasUI: true, ui: { custom } } as never,
				pillAnchor,
			);
			expect(session.setThinkingLevel).not.toHaveBeenCalled();

			const [factory, options] = custom.mock.calls[0] ?? [];
			const width =
				(options as { overlayOptions?: { width?: number } }).overlayOptions?.width ?? 40;
			const bubble = (factory as BubbleFactory)(
				{},
				theme,
				{},
				vi.fn(),
			) as ReturnType<BubbleFactory> & {
				handleMouse(event: { type: string; x: number; y: number }): unknown;
			};
			const lines = bubble.render(width).map(plain);
			expect(lines.join("\n")).not.toContain("off");
			expect(lines.some((line) => line.includes("● high"))).toBe(true);

			// Every level is a target; another level picks it.
			const low = lines.findIndex((line) => line.includes("○ low"));
			bubble.handleMouse({ type: "click", x: 3, y: low });
			expect(session.setThinkingLevel).toHaveBeenCalledWith("low");
		});
	});

	it("opens the level list on the current level, so ↑ goes to the one before it", async () => {
		await withThinkingSession(["off", "low", "medium", "high", "max"], "high", (session) => {
			const custom = vi.fn().mockResolvedValue(undefined);
			runPillAction(
				pillActionFor("thinking") as never,
				{ hasUI: true, ui: { custom } } as never,
				pillAnchor,
			);
			const [factory, options] = custom.mock.calls[0] ?? [];
			const width =
				(options as { overlayOptions?: { width?: number } }).overlayOptions?.width ?? 40;
			const bubble = (factory as BubbleFactory)({}, theme, {}, vi.fn());
			const highlighted = () =>
				plain(bubble.render(width).find((line) => line.includes("\x1b[48;5;3m")) ?? "");

			// Opens with the current level highlighted, not with nothing.
			expect(highlighted()).toContain("● high");
			bubble.handleInput("\x1b[A");
			expect(highlighted()).toContain("○ medium");
			bubble.handleInput("\r");
			expect(session.setThinkingLevel).toHaveBeenCalledWith("medium");
		});
	});

	it("steps to the next level from the command and reports the step", async () => {
		await withThinkingSession(["off", "low", "high", "xhigh"], "high", (session) => {
			const custom = vi.fn().mockResolvedValue(undefined);
			runPillAction(
				pillActionFor("thinking") as never,
				{ hasUI: true, ui: { custom } } as never,
				pillAnchor,
				"command",
			);
			const [factory, options] = custom.mock.calls[0] ?? [];
			const width =
				(options as { overlayOptions?: { width?: number } }).overlayOptions?.width ?? 40;
			const bubble = (factory as BubbleFactory)({}, theme, {}, vi.fn());
			expect(bubble.render(width).map(plain).join("\n")).toContain("high → xhigh");
			expect(session.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		});
	});

	it("reports the current level when the session cannot cycle it", () => {
		const custom = vi.fn().mockResolvedValue(undefined);
		const action = pillActionFor("thinking");
		runPillAction(
			action as never,
			{ hasUI: true, thinkingLevel: "medium", ui: { custom } } as never,
			{
				centerColumn: 20,
				terminalWidth: 80,
				background: "\x1b[48;5;3m",
				foreground: "",
			},
		);

		const [factory, options] = custom.mock.calls[0] ?? [];
		const width = (options as { overlayOptions?: { width?: number } }).overlayOptions?.width ?? 40;
		const bubble = (factory as BubbleFactory)({}, theme, {}, vi.fn());
		expect(bubble.render(width).map(plain).join("\n")).toContain("Current level: medium");
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

		const custom = vi.fn().mockResolvedValue(undefined);
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
