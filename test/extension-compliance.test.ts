import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	ModelSelectorComponent,
	SettingsSelectorComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultConfig,
	type ExtensionStatusPlacement,
	type PolishedTuiConfig,
} from "../extensions/starline/config";
import { installFooter } from "../extensions/starline/footer";
import { emptyGitStatus } from "../extensions/starline/git";
import starline from "../extensions/starline/index";
import { STARLINE_PROTOTYPE_PATCH_REGISTRY } from "../extensions/starline/prototype-patch-registry";
import {
	installSelectorBorderStyle,
	patchSelectorBorderStyle,
} from "../extensions/starline/selector-border";
import { SessionLifecycle } from "../extensions/starline/session-lifecycle";
import { registerStarlineSettingsCommand } from "../extensions/starline/settings-command";
import { createInitialState } from "../extensions/starline/state";
import { PolishedEditor, WrappedPolishedEditor } from "../extensions/starline/ui";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type FooterFactory = (...args: unknown[]) => {
	render(width: number): string[];
	dispose?: () => void;
};

const originalUserMessageRender = UserMessageComponent.prototype.render;
const originalUserMessageInvalidate = UserMessageComponent.prototype.invalidate;
const originalModelSelectorRender = ModelSelectorComponent.prototype.render;
const originalSettingsSelectorRender = SettingsSelectorComponent.prototype.render;
const inactiveSessionLifecycle = new SessionLifecycle();

function makeTheme(): Theme {
	return {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
		italic(text: string) {
			return text;
		},
		underline(text: string) {
			return text;
		},
		strikethrough(text: string) {
			return text;
		},
		getThinkingBorderColor() {
			return (text: string) => text;
		},
	} as unknown as Theme;
}

function makeTaggedTheme(prefix = ""): Theme {
	return {
		fg(color: string, text: string) {
			return `[${prefix}${color}]${text}`;
		},
		bold(text: string) {
			return `[${prefix}bold]${text}`;
		},
		italic(text: string) {
			return text;
		},
		underline(text: string) {
			return text;
		},
		strikethrough(text: string) {
			return text;
		},
		getThinkingBorderColor(level: string) {
			return (text: string) => `[${prefix}thinking:${level}]${text}`;
		},
	} as unknown as Theme;
}

function makeStrictTheme(): Theme {
	const knownColors = new Set([
		"accent",
		"border",
		"borderMuted",
		"error",
		"mdCode",
		"mdCodeBlock",
		"mdCodeBlockBorder",
		"mdHeading",
		"mdHr",
		"mdLink",
		"mdLinkUrl",
		"mdListBullet",
		"mdQuote",
		"mdQuoteBorder",
		"muted",
		"success",
		"syntaxFunction",
		"syntaxKeyword",
		"text",
		"userMessageText",
		"warning",
	]);

	return {
		fg(color: string, text: string) {
			if (!knownColors.has(color)) {
				throw new Error(`Unknown theme color: ${color}`);
			}
			return `[${color}]${text}`;
		},
		bold(text: string) {
			return `[bold]${text}`;
		},
		italic(text: string) {
			return text;
		},
		underline(text: string) {
			return text;
		},
		strikethrough(text: string) {
			return text;
		},
		getThinkingBorderColor() {
			return (text: string) => text;
		},
	} as unknown as Theme;
}

function configWithColorSources(
	colorSources: Partial<PolishedTuiConfig["colorSources"]>,
): PolishedTuiConfig {
	return {
		...defaultConfig,
		colorSources: {
			...defaultConfig.colorSources,
			...colorSources,
		},
	};
}

function configWithColors(
	colors: Partial<PolishedTuiConfig["colors"]>,
	colorSources: Partial<PolishedTuiConfig["colorSources"]> = {},
): PolishedTuiConfig {
	return {
		...defaultConfig,
		colors: {
			...defaultConfig.colors,
			...colors,
		},
		colorSources: {
			...defaultConfig.colorSources,
			...colorSources,
		},
	};
}

function configWithExtensionStatuses(
	extensionStatuses: Partial<PolishedTuiConfig["extensionStatuses"]>,
): PolishedTuiConfig {
	return {
		...defaultConfig,
		extensionStatuses: {
			...defaultConfig.extensionStatuses,
			...extensionStatuses,
			placements: {
				...defaultConfig.extensionStatuses.placements,
				...(extensionStatuses.placements ?? {}),
			},
		},
	};
}

function configWithFeatures(features: Partial<PolishedTuiConfig["features"]>): PolishedTuiConfig {
	return {
		...defaultConfig,
		features: {
			...defaultConfig.features,
			...features,
		},
	};
}

function stripPromptMarks(line: string): string {
	return line.replaceAll(/\x1b]133;[ABC]\x07/g, "").replaceAll(/\x1b\[[0-9;]*m/g, "");
}

function stripTestTags(line: string): string {
	return (
		stripPromptMarks(line)
			.replaceAll(/\[[^\]]+\]/g, "")
			// Pi's zero-width APC markers (the cursor: `pi:c` before 1.4, the
			// `pi:fc` … `pi:/fc` pair around the cursor cell from 1.4 on).
			.replaceAll(/\x1b_[^\x07]*\x07/g, "")
	);
}

function loadExtension(options: { thinkingLevel?: string; commands?: Map<string, unknown> } = {}) {
	const handlers = new Map<string, Handler[]>();
	starline({
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerCommand(name: string, command: unknown) {
			options.commands?.set(name, command);
		},
		getThinkingLevel() {
			return options.thinkingLevel ?? "off";
		},
	} as never);
	return handlers;
}

async function emit(handlers: Map<string, Handler[]>, eventName: string, ctx: unknown) {
	for (const handler of handlers.get(eventName) ?? []) {
		await handler({}, ctx);
	}
}

function makeContext(overrides: Record<string, unknown> = {}) {
	const theme = makeTheme();
	let editorComponent: unknown;
	const ui = {
		theme,
		setFooter() {},
		setEditorComponent(factory: unknown) {
			editorComponent = factory;
		},
		getEditorComponent() {
			return editorComponent;
		},
	};
	const overrideUi = overrides.ui && typeof overrides.ui === "object" ? overrides.ui : undefined;
	return {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		model: { id: "claude-sonnet", provider: "anthropic", contextWindow: 200_000 },
		sessionManager: { getBranch: () => [], getSessionName: () => undefined },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		ui: overrideUi ? { ...ui, ...overrideUi } : ui,
		...overrides,
		...(overrideUi ? { ui: { ...ui, ...overrideUi } } : {}),
	};
}

afterEach(() => {
	UserMessageComponent.prototype.render = originalUserMessageRender;
	UserMessageComponent.prototype.invalidate = originalUserMessageInvalidate;
	delete (UserMessageComponent.prototype as unknown as Record<PropertyKey, unknown>)[
		STARLINE_PROTOTYPE_PATCH_REGISTRY
	];

	ModelSelectorComponent.prototype.render = originalModelSelectorRender;
	SettingsSelectorComponent.prototype.render = originalSettingsSelectorRender;
	for (const selectorPrototype of [
		ModelSelectorComponent.prototype,
		SettingsSelectorComponent.prototype,
	]) {
		delete (selectorPrototype as unknown as Record<PropertyKey, unknown>)[
			STARLINE_PROTOTYPE_PATCH_REGISTRY
		];
	}
});

describe("Pi docs compliance", () => {
	it("uses the current @earendil-works Pi packages instead of the old @mariozechner scope", () => {
		const files = [
			"package.json",
			"extensions/starline/config.ts",
			"extensions/starline/index.ts",
			"extensions/starline/ui.ts",
		];
		const content = files.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

		expect(content).not.toContain("@mariozechner/");
		expect(content).toContain("@earendil-works/");
	});

	it("does not install interactive TUI components when ctx.hasUI is false", async () => {
		const handlers = loadExtension();
		const throwingUi = {
			theme: makeTheme(),
			setFooter() {
				throw new Error("setFooter should not be called without UI");
			},
			setEditorComponent() {
				throw new Error("setEditorComponent should not be called without UI");
			},
		};
		const ctx = makeContext({ hasUI: false, ui: throwingUi });

		await expect(emit(handlers, "session_start", ctx)).resolves.toBeUndefined();
	});

	it("does not install interactive TUI components in non-TUI UI modes", async () => {
		const handlers = loadExtension();
		let footerInstalled = false;
		let editorInstalled = false;
		const ctx = makeContext({
			mode: "rpc",
			ui: {
				theme: makeTheme(),
				setFooter() {
					footerInstalled = true;
				},
				setEditorComponent() {
					editorInstalled = true;
				},
				getEditorComponent() {
					return undefined;
				},
			},
		});

		await emit(handlers, "session_start", ctx);

		expect(footerInstalled).toBe(false);
		expect(editorInstalled).toBe(false);
	});

	it("treats missing ctx.mode as legacy TUI for older Pi runtimes", async () => {
		const handlers = loadExtension();
		let editorFactory: unknown;
		const ctx = makeContext({
			mode: undefined,
			ui: {
				theme: makeTheme(),
				setFooter() {},
				setEditorComponent(factory: unknown) {
					editorFactory = factory;
				},
				getEditorComponent() {
					return editorFactory;
				},
			},
		});

		await emit(handlers, "session_start", ctx);

		expect(editorFactory).toBeTypeOf("function");
	});

	it("does not install user-message rendering when ctx.hasUI is false", async () => {
		const handlers = loadExtension();
		const ctx = makeContext({ hasUI: false });

		await emit(handlers, "session_start", ctx);

		expect(UserMessageComponent.prototype.render).toBe(originalUserMessageRender);
	});

	it("wraps an editor component already installed by another extension", async () => {
		const handlers = loadExtension();
		const existingEditorFactory = () => ({
			render: (width: number) => ["─".repeat(width), "base editor", "─".repeat(width)],
			invalidate() {},
			handleInput() {},
			getText: () => "",
			setText() {},
		});
		let editorFactory: unknown = existingEditorFactory;
		let setEditorCalls = 0;
		const ctx = makeContext({
			ui: {
				theme: makeTheme(),
				setFooter() {},
				setEditorComponent(factory: unknown) {
					setEditorCalls += 1;
					editorFactory = factory;
				},
				getEditorComponent() {
					return editorFactory;
				},
			},
		});

		await emit(handlers, "session_start", ctx);

		expect(setEditorCalls).toBe(1);
		expect(editorFactory).not.toBe(existingEditorFactory);
		expect(editorFactory).toBeTypeOf("function");
		const editor = (
			editorFactory as (...args: unknown[]) => ReturnType<typeof existingEditorFactory>
		)(
			{ requestRender() {}, terminal: { rows: 24, cols: 80 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
		);
		expect(editor.render(80).join("\n")).toContain("base editor");
	});

	it("restores a wrapped editor component on shutdown", async () => {
		const handlers = loadExtension();
		const existingEditorFactory = () => ({
			render: (width: number) => ["─".repeat(width), "base editor", "─".repeat(width)],
			invalidate() {},
			handleInput() {},
			getText: () => "",
			setText() {},
		});
		let editorFactory: unknown = existingEditorFactory;
		let setEditorCalls = 0;
		const ctx = makeContext({
			ui: {
				theme: makeTheme(),
				setFooter() {},
				setEditorComponent(factory: unknown) {
					setEditorCalls += 1;
					editorFactory = factory;
				},
				getEditorComponent() {
					return editorFactory;
				},
			},
		});

		await emit(handlers, "session_start", ctx);
		expect(editorFactory).not.toBe(existingEditorFactory);

		await emit(handlers, "session_shutdown", ctx);
		await emit(handlers, "session_shutdown", ctx);

		expect(editorFactory).toBe(existingEditorFactory);
		expect(setEditorCalls).toBe(2);
	});

	it("cleans up when start and shutdown use distinct context wrappers", async () => {
		const handlers = loadExtension();
		const runner = {
			editorFactory: undefined as unknown,
			setEditorCalls: 0,
			footerClears: 0,
		};
		let startContextStale = false;
		const makeUiWrapper = (isStale: () => boolean) => ({
			theme: makeTheme(),
			setFooter(factory: unknown) {
				if (isStale()) throw new Error("stale start ctx setFooter");
				if (factory === undefined) runner.footerClears += 1;
			},
			setEditorComponent(factory: unknown) {
				if (isStale()) throw new Error("stale start ctx setEditorComponent");
				runner.setEditorCalls += 1;
				runner.editorFactory = factory;
			},
			getEditorComponent() {
				if (isStale()) throw new Error("stale start ctx getEditorComponent");
				return runner.editorFactory;
			},
		});
		const startCtx = makeContext({ ui: makeUiWrapper(() => startContextStale) });
		const shutdownCtx = makeContext({ ui: makeUiWrapper(() => false) });
		expect(shutdownCtx).not.toBe(startCtx);
		expect(shutdownCtx.ui).not.toBe(startCtx.ui);

		await emit(handlers, "session_start", startCtx);
		expect(runner.editorFactory).toBeTypeOf("function");
		startContextStale = true;
		await expect(emit(handlers, "session_shutdown", shutdownCtx)).resolves.toBeUndefined();
		await emit(handlers, "session_shutdown", shutdownCtx);

		expect(runner.editorFactory).toBeUndefined();
		expect(runner.setEditorCalls).toBe(2);
		expect(runner.footerClears).toBe(1);
	});

	it("refreshes a stale Starline editor factory on extension reload instead of adopting old closures", async () => {
		const firstHandlers = loadExtension();
		let editorFactory: unknown;
		let setEditorCalls = 0;
		const ctx = makeContext({
			ui: {
				theme: makeTheme(),
				setFooter() {},
				setEditorComponent(factory: unknown) {
					setEditorCalls += 1;
					editorFactory = factory;
				},
				getEditorComponent() {
					return editorFactory;
				},
			},
		});

		await emit(firstHandlers, "session_start", ctx);
		const firstFactory = editorFactory;

		const secondHandlers = loadExtension();
		await emit(secondHandlers, "session_start", ctx);

		expect(setEditorCalls).toBe(2);
		expect(editorFactory).not.toBe(firstFactory);
		expect(editorFactory).toBeTypeOf("function");
	});

	it("refreshes a stale wrapped Starline editor without wrapping the old Starline wrapper", async () => {
		const firstHandlers = loadExtension();
		let baseFactoryCalls = 0;
		const existingEditorFactory = () => {
			baseFactoryCalls += 1;
			return {
				render: (width: number) => ["─".repeat(width), "base editor", "─".repeat(width)],
				invalidate() {},
				handleInput() {},
				getText: () => "",
				setText() {},
			};
		};
		let editorFactory: unknown = existingEditorFactory;
		let setEditorCalls = 0;
		const ctx = makeContext({
			ui: {
				theme: makeTheme(),
				setFooter() {},
				setEditorComponent(factory: unknown) {
					setEditorCalls += 1;
					editorFactory = factory;
				},
				getEditorComponent() {
					return editorFactory;
				},
			},
		});

		await emit(firstHandlers, "session_start", ctx);
		const firstWrappedFactory = editorFactory;

		const secondHandlers = loadExtension();
		await emit(secondHandlers, "session_start", ctx);

		expect(setEditorCalls).toBe(2);
		expect(editorFactory).not.toBe(firstWrappedFactory);
		expect(editorFactory).not.toBe(existingEditorFactory);
		const editor = (
			editorFactory as (...args: unknown[]) => ReturnType<typeof existingEditorFactory>
		)(
			{ requestRender() {}, terminal: { rows: 24, cols: 80 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
		);
		const rendered = editor.render(80).join("\n");

		expect(baseFactoryCalls).toBe(1);
		expect(rendered.match(/base editor/g)).toHaveLength(1);
		expect(rendered.split("\n").filter((line) => /^─+$/.test(line.trim()))).toHaveLength(2);
	});

	it("re-wraps an editor component that loads after Starline", async () => {
		const handlers = loadExtension();
		const laterEditorFactory = () => ({
			render: (width: number) => ["─".repeat(width), "late vim editor", "─".repeat(width)],
			invalidate() {},
			handleInput() {},
			getText: () => "",
			setText() {},
			getMode: () => "normal",
		});
		let editorFactory: unknown;
		const ctx = makeContext({
			ui: {
				theme: makeTheme(),
				setFooter() {},
				setEditorComponent(factory: unknown) {
					editorFactory = factory;
				},
				getEditorComponent() {
					return editorFactory;
				},
			},
		});

		await emit(handlers, "session_start", ctx);
		const originalStarlineFactory = editorFactory;
		editorFactory = laterEditorFactory;

		await new Promise((resolve) => setTimeout(resolve, 1));

		expect(editorFactory).not.toBe(originalStarlineFactory);
		expect(editorFactory).not.toBe(laterEditorFactory);
		expect(editorFactory).toBeTypeOf("function");
		const editor = (editorFactory as (...args: unknown[]) => ReturnType<typeof laterEditorFactory>)(
			{ requestRender() {}, terminal: { rows: 24, cols: 80 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
		);
		expect(editor.render(80).join("\n")).toContain("late vim editor");
		expect(editor.render(80).join("\n")).toContain("NORMAL");
	});

	it("does not reconcile an editor after its session shuts down", async () => {
		vi.useFakeTimers();
		try {
			const handlers = loadExtension();
			const laterEditorFactory = () => ({
				render: () => ["later"],
				invalidate() {},
				handleInput() {},
				getText: () => "",
				setText() {},
			});
			let editorFactory: unknown;
			let stale = false;
			const ctx = makeContext({
				ui: {
					theme: makeTheme(),
					setFooter() {
						if (stale) throw new Error("stale setFooter");
					},
					setEditorComponent(factory: unknown) {
						if (stale) throw new Error("stale setEditorComponent");
						editorFactory = factory;
					},
					getEditorComponent() {
						if (stale) throw new Error("stale getEditorComponent");
						return editorFactory;
					},
				},
			});

			await emit(handlers, "session_start", ctx);
			editorFactory = laterEditorFactory;
			await emit(handlers, "session_shutdown", ctx);
			stale = true;

			expect(() => vi.runAllTimers()).not.toThrow();
			expect(editorFactory).toBe(laterEditorFactory);
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders selector top and bottom borders from the editor color source", () => {
		const prototype = {
			render(width: number) {
				return ["─".repeat(width), "body", "─".repeat(width)];
			},
		};

		patchSelectorBorderStyle(
			prototype,
			() => makeTaggedTheme(),
			() => defaultConfig,
		);
		const lines = prototype.render(8);

		expect(lines[0]).toContain("[borderMuted]────────");
		expect(stripTestTags(lines[0])).toBe("────────");
		expect(lines[1]).toBe("body");
		expect(lines.at(-1)).toContain("[borderMuted]────────");

		const terminalPrototype = {
			render(width: number) {
				return ["─".repeat(width), "body", "─".repeat(width)];
			},
		};

		patchSelectorBorderStyle(
			terminalPrototype,
			() => makeTaggedTheme(),
			() => configWithColorSources({ editor: "terminal" }),
		);
		const terminalLines = terminalPrototype.render(8);

		expect(terminalLines[0]).toContain("\u001b[90m────────");
		expect(stripPromptMarks(terminalLines[0])).toBe("────────");
		expect(terminalLines[1]).toBe("body");
		expect(terminalLines.at(-1)).toContain("\u001b[90m────────");
	});

	it("does not clobber selector lines that are not borders", () => {
		const prototype = {
			render(width: number) {
				return ["Selector title", "─".repeat(width), "help text"];
			},
		};

		patchSelectorBorderStyle(
			prototype,
			() => makeTaggedTheme(),
			() => defaultConfig,
		);

		expect(prototype.render(8)).toEqual(["Selector title", "────────", "help text"]);
	});

	it("selector cleanup restores its exact predecessor and is idempotent", () => {
		const prototype = {
			render(width: number) {
				return ["─".repeat(width), "body", "─".repeat(width)];
			},
		};
		const predecessor = prototype.render;
		const cleanup = patchSelectorBorderStyle(
			prototype,
			() => makeTaggedTheme(),
			() => defaultConfig,
		);

		expect(prototype.render(8)[0]).toContain("[borderMuted]────────");
		cleanup();
		cleanup();
		expect(prototype.render).toBe(predecessor);
	});

	it("does not stack selector wrappers and ignores stale cleanup", () => {
		const predecessor = vi.fn((width: number) => ["─".repeat(width), "body", "─".repeat(width)]);
		const prototype = { render: predecessor };
		const firstCleanup = patchSelectorBorderStyle(
			prototype,
			() => makeTaggedTheme("first:"),
			() => defaultConfig,
		);
		const wrapper = prototype.render;
		const secondCleanup = patchSelectorBorderStyle(
			prototype,
			() => makeTaggedTheme("second:"),
			() => defaultConfig,
		);

		expect(prototype.render).toBe(wrapper);
		firstCleanup();
		const rendered = prototype.render(8);
		expect(rendered[0]).toContain("[second:borderMuted]────────");
		expect(rendered[0]).not.toContain("first:");
		expect(predecessor).toHaveBeenCalledTimes(1);
		secondCleanup();
		expect(prototype.render).toBe(predecessor);
	});

	it("preserves a later selector replacement and its predecessor chain", () => {
		const predecessor = (width: number) => ["─".repeat(width), "body", "─".repeat(width)];
		const prototype = { render: predecessor };
		const getTheme = vi.fn(() => makeTaggedTheme());
		const cleanup = patchSelectorBorderStyle(prototype, getTheme, () => defaultConfig);
		const starlineWrapper = prototype.render;
		const thirdParty = function thirdParty(this: unknown, width: number): string[] {
			return ["third-party", ...starlineWrapper.call(this, width)];
		};
		prototype.render = thirdParty;

		cleanup();
		getTheme.mockClear();

		expect(prototype.render).toBe(thirdParty);
		expect(prototype.render(4)).toEqual(["third-party", "────", "body", "────"]);
		expect(getTheme).not.toHaveBeenCalled();
	});

	it("deactivates an older selector record hidden inside a third-party predecessor chain", () => {
		const predecessor = (width: number) => ["─".repeat(width), "body", "─".repeat(width)];
		const prototype = { render: predecessor };
		const firstTheme = vi.fn(() => makeTaggedTheme("first:"));
		const secondTheme = vi.fn(() => makeTaggedTheme("second:"));
		const cleanupFirst = patchSelectorBorderStyle(prototype, firstTheme, () => defaultConfig);
		const firstWrapper = prototype.render;
		const thirdParty = function thirdParty(this: unknown, width: number): string[] {
			return ["third-party", ...firstWrapper.call(this, width)];
		};
		prototype.render = thirdParty;
		const cleanupSecond = patchSelectorBorderStyle(prototype, secondTheme, () => defaultConfig);

		cleanupFirst();
		cleanupSecond();
		firstTheme.mockClear();
		secondTheme.mockClear();

		expect(prototype.render).toBe(thirdParty);
		expect(prototype.render(4)).toEqual(["third-party", "────", "body", "────"]);
		expect(firstTheme).not.toHaveBeenCalled();
		expect(secondTheme).not.toHaveBeenCalled();
	});

	it("restores model and settings selector prototypes independently", () => {
		const modelPredecessor = ModelSelectorComponent.prototype.render;
		const settingsPredecessor = SettingsSelectorComponent.prototype.render;
		const cleanup = installSelectorBorderStyle(
			() => makeTaggedTheme(),
			() => defaultConfig,
		);
		const modelStarlineWrapper = ModelSelectorComponent.prototype.render;
		const thirdPartyModelRender = function thirdPartyModelRender(
			this: unknown,
			width: number,
		): string[] {
			return modelStarlineWrapper.call(this as never, width);
		};
		ModelSelectorComponent.prototype.render = thirdPartyModelRender;

		cleanup();

		expect(ModelSelectorComponent.prototype.render).toBe(thirdPartyModelRender);
		expect(SettingsSelectorComponent.prototype.render).toBe(settingsPredecessor);
		expect(ModelSelectorComponent.prototype.render).not.toBe(modelPredecessor);
	});

	it("keeps custom footer output within the requested render width", async () => {
		const handlers = loadExtension();
		let footerFactory: FooterFactory | undefined;
		const ui = {
			theme: makeTheme(),
			setFooter(factory: FooterFactory | undefined) {
				footerFactory = factory;
			},
			setEditorComponent() {},
		};
		const ctx = makeContext({ ui });

		await emit(handlers, "session_start", ctx);

		expect(footerFactory).toBeTypeOf("function");
		const footer = footerFactory?.({ requestRender() {} }, makeTheme(), {
			onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map<string, string>(),
		});
		const lines = footer?.render(1) ?? [];

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= 1)).toBe(true);
		footer?.dispose?.();
		await emit(handlers, "session_shutdown", ctx);
	});

	it("does not crash when config colors contain Starship modifiers", () => {
		let footerFactory: FooterFactory | undefined;
		const ctx = makeContext({
			cwd: "/tmp/project",
			ui: {
				theme: makeStrictTheme(),
				setFooter(factory: FooterFactory | undefined) {
					footerFactory = factory;
				},
				setEditorComponent() {},
			},
		});
		const state = createInitialState(emptyGitStatus());
		state.contextLabel = "1%/200k";
		state.tokenLabel = "↑1 ↓2";
		state.costLabel = "$0.001";

		installFooter(ctx as never, state, () => defaultConfig, {
			setRequestRender() {},
			scheduleProjectRefresh() {},
		});

		const footer = footerFactory?.({ requestRender() {} }, makeStrictTheme(), {
			onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map<string, string>(),
		});

		expect(() => footer?.render(120)).not.toThrow();
		expect(footer?.render(120).join("\n")).toContain("[muted]");
	});

	it("strips plugin ANSI and control sequences before rendering third-party statuses", () => {
		let footerFactory: FooterFactory | undefined;
		const ctx = makeContext({
			cwd: "/tmp/project",
			ui: {
				theme: makeTheme(),
				setFooter(factory: FooterFactory | undefined) {
					footerFactory = factory;
				},
				setEditorComponent() {},
			},
		});
		const state = createInitialState(emptyGitStatus());
		state.contextLabel = "1%/200k";
		state.tokenLabel = "↑1 ↓2";
		state.costLabel = "$0.001";

		installFooter(ctx as never, state, () => defaultConfig, {
			setRequestRender() {},
			scheduleProjectRefresh() {},
		});

		const footer = footerFactory?.({ requestRender() {} }, makeTheme(), {
			onBranchChange: () => () => {},
			getExtensionStatuses: () =>
				new Map<string, string>([["ansi", "\x1b[31mred\x1b[0m\nnext\tline"]]),
		});
		const rendered = footer?.render(160).join("\n") ?? "";

		expect(rendered).toContain("red next line");
		expect(rendered).not.toContain("\x1b[31m");
		expect(rendered).not.toContain("\nnext\tline");
	});

	it("keeps custom editor output within the requested render width", () => {
		const editor = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 80 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTheme(),
			() => defaultConfig,
		);

		const lines = editor.render(1);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= 1)).toBe(true);
	});

	it("renders the package version pill only when the bar lists it", () => {
		let footerFactory: FooterFactory | undefined;
		const ctx = makeContext({
			cwd: "/tmp/project",
			ui: {
				theme: makeTheme(),
				setFooter(factory: FooterFactory | undefined) {
					footerFactory = factory;
				},
				setEditorComponent() {},
			},
		});

		const renderWithPackage = (enabled: boolean) => {
			const state = createInitialState(emptyGitStatus());
			state.packageVersion = enabled ? { ecosystem: "nodejs", version: "1.2.3" } : undefined;
			const config: PolishedTuiConfig = {
				...defaultConfig,
				pill: {
					...defaultConfig.pill,
					segments: enabled ? ["packageVersion"] : ["cwd"],
				},
			};
			installFooter(ctx as never, state, () => config, {
				setRequestRender() {},
				scheduleProjectRefresh() {},
			});
			const footer = footerFactory?.({ requestRender() {} }, makeTheme(), {
				onBranchChange: () => () => {},
				getExtensionStatuses: () => new Map(),
			});
			return footer?.render(200).join("\n") ?? "";
		};

		expect(renderWithPackage(true)).toContain("1.2.3");
		expect(renderWithPackage(false)).not.toContain("1.2.3");
	});

	it("git commit segment shows hash on detached HEAD and hides it on a branch", () => {
		let footerFactory: FooterFactory | undefined;
		const ctx = makeContext({
			cwd: "/tmp/project",
			ui: {
				theme: makeTheme(),
				setFooter(factory: FooterFactory | undefined) {
					footerFactory = factory;
				},
				setEditorComponent() {},
			},
		});
		const OID = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		const renderFor = (detached: boolean, onlyDetached: boolean) => {
			const state = createInitialState(emptyGitStatus());
			state.branch = detached ? undefined : "main";
			state.commit = { oid: OID, detached, tag: null };
			state.contextLabel = "1%/200k";
			state.tokenLabel = "↑1 ↓2";
			state.costLabel = "$0";
			const config: PolishedTuiConfig = {
				...defaultConfig,
				pill: { ...defaultConfig.pill, segments: ["gitCommit"] },
				git: { ...defaultConfig.git, commit: { hashLength: 7, onlyDetached, showTag: true } },
			};
			installFooter(ctx as never, state, () => config, {
				setRequestRender() {},
				scheduleProjectRefresh() {},
			});
			const footer = footerFactory?.({ requestRender() {} }, makeTheme(), {
				onBranchChange: () => () => {},
				getExtensionStatuses: () => new Map(),
			});
			return footer?.render(200).join("\n") ?? "";
		};

		// Detached → the short hash, no parentheses: a pill is not a text line.
		expect(renderFor(true, true)).toContain(OID.slice(0, 7));
		expect(renderFor(true, true)).not.toContain(`(${OID.slice(0, 7)})`);
		// On branch with onlyDetached → hidden.
		expect(renderFor(false, true)).not.toContain(OID.slice(0, 7));
		// On branch with onlyDetached=false → the hash shows.
		expect(renderFor(false, false)).toContain(OID.slice(0, 7));
	});

	it("git metrics segment renders +added −deleted and hides at 0/0", () => {
		let footerFactory: FooterFactory | undefined;
		const ctx = makeContext({
			cwd: "/tmp/project",
			ui: {
				theme: makeTheme(),
				setFooter(factory: FooterFactory | undefined) {
					footerFactory = factory;
				},
				setEditorComponent() {},
			},
		});
		const renderFor = (added: number, deleted: number) => {
			const state = createInitialState(emptyGitStatus());
			state.metrics = { added, deleted };
			state.contextLabel = "1%/200k";
			state.tokenLabel = "↑1 ↓2";
			state.costLabel = "$0";
			const config: PolishedTuiConfig = {
				...defaultConfig,
				pill: { ...defaultConfig.pill, segments: ["gitMetrics"] },
			};
			installFooter(ctx as never, state, () => config, {
				setRequestRender() {},
				scheduleProjectRefresh() {},
			});
			const footer = footerFactory?.({ requestRender() {} }, makeTheme(), {
				onBranchChange: () => () => {},
				getExtensionStatuses: () => new Map(),
			});
			return footer?.render(200).join("\n") ?? "";
		};

		expect(renderFor(12, 3)).toContain("+12");
		expect(renderFor(12, 3)).toContain("−3");
		// 0/0 → hidden (onlyNonzero default).
		expect(renderFor(0, 0)).not.toContain("+0");
		expect(renderFor(0, 0)).not.toContain("−0");
	});
	it("renders editor rails with theme accent and borderMuted borders", () => {
		const editor = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => defaultConfig,
		);

		const lines = editor.render(120);
		const rendered = lines.join("\n");

		expect(rendered).toContain("[borderMuted]────");
		expect(rendered).toContain("[accent]│");
		// Rule, padding, the text row, padding, rule: nothing under the text.
		expect(lines).toHaveLength(5);
		expect(stripTestTags(lines.at(-2) ?? "").trim()).toBe("│");
	});

	it("hides editor rails in copy-friendly mode", () => {
		const editor = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => configWithFeatures({ copyFriendly: true }),
		);

		const rendered = editor.render(120).join("\n");

		expect(rendered).not.toContain("│");
		expect(rendered).not.toContain("❯");
		expect(rendered).toContain("[borderMuted]────");
	});

	it("puts Vim status at the right end of the top rule in rail and copy-friendly modes", () => {
		for (const copyFriendly of [false, true]) {
			const config = configWithFeatures({ copyFriendly });
			const editor = new WrappedPolishedEditor(
				{
					render: (width: number) => ["─".repeat(width), "", "─".repeat(width)],
					invalidate() {},
					handleInput() {},
					getText: () => "",
					setText() {},
					getMode: () => "insert",
				},
				makeTheme(),
				() => config,
			);

			const lines = editor.render(32);
			expect(stripTestTags(lines[0] ?? "")).toMatch(/^─+ INSERT {2}──$/);
			expect(lines.filter((line) => line.includes("INSERT"))).toHaveLength(1);
			expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
		}
	});

	it("ends the copy-friendly frame with the padding row, not a metadata row", () => {
		const editor = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => configWithFeatures({ copyFriendly: true }),
		);

		const lines = editor.render(120);
		expect(lines).toHaveLength(5);
		expect(lines.at(-2)).toBe("");
		expect(stripTestTags(lines.at(-3) ?? "").trim()).toBe("");
	});

	it("uses custom copy-friendly editor prompt icon and color", () => {
		const editor = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => ({
				...defaultConfig,
				icons: { ...defaultConfig.icons, editorPrompt: "›" },
				colors: { ...defaultConfig.colors, editorPrompt: "warning" },
				features: { ...defaultConfig.features, copyFriendly: true },
			}),
		);

		const rendered = editor.render(120).join("\n");

		expect(rendered).toContain("[warning]›");
		expect(rendered).not.toContain("❯");
		expect(rendered).not.toContain("│");
	});

	it("keeps terminal editor chrome available when configured", () => {
		const editor = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => configWithColorSources({ editor: "terminal" }),
		);

		const rendered = editor.render(120).join("\n");

		expect(rendered).toContain("\u001b[90m────");
		expect(rendered).toContain("\u001b[34m│\u001b[0m");
	});

	it("renders custom editor accent and border colors", () => {
		const editor = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() =>
				configWithColors({
					editorAccent: "warning",
					editorBorder: "error",
				}),
		);

		const rendered = editor.render(120).join("\n");

		expect(rendered).toContain("[warning]│");
		expect(rendered).toContain("[error]────");
	});

	it("wraps a vim editor by delegating input and rendering a mode segment", () => {
		const inputs: string[] = [];
		let text = "hello";
		let mode = "normal";
		const base = {
			render(width: number) {
				return ["─".repeat(width), text, `${"─".repeat(Math.max(0, width - 8))} NORMAL `];
			},
			invalidate() {},
			handleInput(data: string) {
				inputs.push(data);
				if (data === "i") mode = "insert";
			},
			getText() {
				return text;
			},
			setText(next: string) {
				text = next;
			},
			getMode() {
				return mode;
			},
		};
		const editor = new WrappedPolishedEditor(
			base,
			// Plain: the tagged theme's tags count as width and would clip the rule.
			makeTheme(),
			() => defaultConfig,
		);

		editor.handleInput("i");
		editor.handleInput("j");
		editor.handleInput("k");
		editor.setText("changed");
		const rendered = editor.render(120).join("\n");

		expect(inputs).toEqual(["i", "j", "k"]);
		expect(editor.getText()).toBe("changed");
		expect(rendered).toContain("changed");
		expect(rendered.split("\n")[0]).toMatch(/─ INSERT {2}──$/);
		expect(rendered.match(/INSERT/g)).toHaveLength(1);
	});

	it("unwraps a branded nested editor into a single frame", () => {
		const config = defaultConfig;
		const inner = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => config,
		);
		inner.setText("typed text");
		const editor = new WrappedPolishedEditor(inner as never, makeTaggedTheme(), () => config);

		const lines = editor.render(120);
		const rendered = lines.join("\n");

		expect(rendered.match(/typed text/g)).toHaveLength(1);
		expect(lines.filter((line) => /^─+$/.test(stripTestTags(line).trim()))).toHaveLength(2);
	});

	it("unwraps branded copy-friendly frames into a single frame", () => {
		const config = configWithFeatures({ copyFriendly: true });
		const inner = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => config,
		);
		inner.setText("typed text");
		const editor = new WrappedPolishedEditor(inner as never, makeTaggedTheme(), () => config);

		const rendered = editor.render(120).join("\n");
		expect(rendered.match(/typed text/g)).toHaveLength(1);
		expect(
			rendered.split("\n").filter((line) => /^─+$/.test(stripTestTags(line).trim())),
		).toHaveLength(2);
		expect(rendered).not.toContain("│");
	});

	it("unwraps branded frames without keeping the inner editor's filler rows", () => {
		const config = { ...defaultConfig, editorMinRows: 3 };
		const inner = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => config,
		);
		const editor = new WrappedPolishedEditor(inner as never, makeTaggedTheme(), () => config);

		const lines = editor.render(120);
		// Rule, padding, one text row and two filler rows, padding, rule — the
		// inner editor's filler is not taken for draft lines and padded again.
		expect(lines).toHaveLength(7);
		expect(lines.filter((line) => /^─+$/.test(stripTestTags(line).trim()))).toHaveLength(2);
		expect(lines.slice(1, -1).every((line) => stripTestTags(line).trim() === "│")).toBe(true);
	});

	it("unwraps a branded frame whose top rule carries a status", () => {
		let mode = "insert";
		const base = {
			render: (width: number) => ["─".repeat(width), "typed text", "─".repeat(width)],
			invalidate() {},
			handleInput() {},
			getText: () => "typed text",
			setText() {},
			getMode: () => mode,
		};
		// Plain: the tagged theme's tags count as width and would clip the rule.
		const inner = new WrappedPolishedEditor(base, makeTheme(), () => defaultConfig);
		const outer = new WrappedPolishedEditor(inner as never, makeTheme(), () => defaultConfig);

		for (const next of ["insert", "normal"]) {
			mode = next;
			const lines = outer.render(120);
			const rendered = lines.join("\n");
			expect(rendered.match(/typed text/g)).toHaveLength(1);
			expect(rendered.match(new RegExp(next.toUpperCase(), "g"))).toHaveLength(1);
			expect(lines[0]).toMatch(new RegExp(`─ ${next.toUpperCase()} {2}──$`));
			expect(lines).toHaveLength(5);
		}
	});

	it("preserves a user blank line while unwrapping branded editor chrome", () => {
		const inner = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => defaultConfig,
		);
		inner.setText("\ntyped text");
		const editor = new WrappedPolishedEditor(
			inner as never,
			makeTaggedTheme(),
			() => defaultConfig,
		);

		const lines = editor.render(120);
		const textIndex = lines.findIndex((line) => line.includes("typed text"));

		expect(textIndex).toBe(3);
		expect(stripTestTags(lines[textIndex - 2] ?? "").trim()).toBe("│");
		expect(stripTestTags(lines[textIndex - 1] ?? "").trim()).toBe("│");
	});

	it("does not accumulate stale chrome across repeated nested renders", () => {
		let config = defaultConfig;
		const inner = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => config,
		);
		const editor = new WrappedPolishedEditor(inner as never, makeTaggedTheme(), () => config);
		const assertSingleFrame = (lines: string[]) => {
			expect(lines.filter((line) => /^─+$/.test(stripTestTags(line).trim()))).toHaveLength(2);
		};

		inner.setText("first draft");
		const first = editor.render(120);
		expect(first.join("\n").match(/first draft/g)).toHaveLength(1);
		assertSingleFrame(first);

		inner.setText("second draft");
		config = { ...config, editorMinRows: 4, editorPaddingY: 0 };
		const second = editor.render(120);
		const secondText = second.join("\n");
		expect(secondText.match(/second draft/g)).toHaveLength(1);
		expect(secondText).not.toContain("first draft");
		expect(second).toHaveLength(6);
		assertSingleFrame(second);

		config = { ...config, editorMinRows: 1 };
		const third = editor.render(120);
		expect(third).toHaveLength(3);
		assertSingleFrame(third);
	});

	it("preserves every autocomplete row outside multiply wrapped branded frames", () => {
		const config = defaultConfig;
		const base = new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTaggedTheme(),
			() => config,
		);
		base.setText("typed");
		const autocomplete = base as unknown as {
			autocompleteState: string;
			autocompleteList: { render: (width: number) => string[] };
		};
		autocomplete.autocompleteState = "force";
		autocomplete.autocompleteList = {
			render: () => ["suggestion-one", "suggestion-two", "suggestion-three"],
		};
		const inner = new WrappedPolishedEditor(base as never, makeTaggedTheme(), () => config);
		const outer = new WrappedPolishedEditor(inner as never, makeTaggedTheme(), () => config);

		const lines = outer.render(120);
		const rendered = lines.join("\n");
		const bottom = lines.findLastIndex((line) => /^─+$/.test(stripTestTags(line).trim()));
		expect(rendered.match(/typed/g)).toHaveLength(1);
		expect(lines.filter((line) => /^─+$/.test(stripTestTags(line).trim()))).toHaveLength(2);
		for (const suggestion of ["suggestion-one", "suggestion-two", "suggestion-three"]) {
			expect(rendered.match(new RegExp(suggestion, "g"))).toHaveLength(1);
			expect(lines.findIndex((line) => line.includes(suggestion))).toBeGreaterThan(bottom);
		}
	});

	it("keeps an unbranded third-party editor's content as it is", () => {
		const staleMeta = "claude-sonnet  Anthropic  xhigh";
		const base = {
			render: (width: number) => ["─".repeat(width), staleMeta, "─".repeat(width)],
			invalidate() {},
			handleInput() {},
			getText: () => staleMeta,
			setText() {},
		};
		const editor = new WrappedPolishedEditor(base, makeTaggedTheme(), () => defaultConfig);

		const rendered = editor.render(120).join("\n");
		expect(rendered.match(/claude-sonnet {2}Anthropic {2}xhigh/g)).toHaveLength(1);
	});

	it("proxies mutable editor callbacks and app-action state to the wrapped editor", () => {
		const base = {
			render: (width: number) => ["─".repeat(width), "", "─".repeat(width)],
			invalidate() {},
			handleInput() {},
			getText: () => "",
			setText() {},
		} as {
			render: (width: number) => string[];
			invalidate: () => void;
			handleInput: (data: string) => void;
			getText: () => string;
			setText: (text: string) => void;
			onSubmit?: (text: string) => void;
			onEscape?: () => void;
			actionHandlers?: Map<unknown, () => void>;
		};
		const editor = new WrappedPolishedEditor(base, makeTheme(), () => defaultConfig);
		const onSubmit = vi.fn();
		const onEscape = vi.fn();
		const actionHandlers = new Map<unknown, () => void>();

		editor.onSubmit = onSubmit;
		editor.onEscape = onEscape;
		editor.actionHandlers = actionHandlers;

		expect(base.onSubmit).toBe(onSubmit);
		expect(base.onEscape).toBe(onEscape);
		expect(base.actionHandlers).toBe(actionHandlers);
	});

	it("registers the Starline settings command", () => {
		const commands = new Map<string, unknown>();
		loadExtension({ commands });

		expect(commands.has("starline")).toBe(true);
	});

	it("does not use interactive UI when the Starline settings command has no UI", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		let notified = false;
		let customOpened = false;

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
			},
		);

		await command?.handler("", {
			hasUI: false,
			ui: {
				notify() {
					notified = true;
				},
				custom() {
					customOpened = true;
				},
			},
		});

		expect(notified).toBe(false);
		expect(customOpened).toBe(false);
	});

	it("does not open interactive Starline settings outside TUI mode", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		let customOpened = false;

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
			},
		);

		await command?.handler("", {
			hasUI: true,
			mode: "rpc",
			ui: {
				notify() {},
				custom() {
					customOpened = true;
				},
			},
		});

		expect(customOpened).toBe(false);
	});

	it("toggles the editor from direct Starline slash-command arguments", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		const featureChanges: Partial<PolishedTuiConfig["features"]>[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		let renderRequests = 0;

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures(patch) {
					featureChanges.push(patch);
					return { applied: true };
				},
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {
					renderRequests += 1;
				},
			},
		);

		await command?.handler("editor disable", {
			hasUI: true,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		});

		expect(featureChanges).toEqual([{ editor: false }]);
		expect(renderRequests).toBe(1);
		expect(notifications).toEqual([{ message: "Editor: disabled", level: "info" }]);
	});

	it("toggles the status line from direct Starline slash-command arguments", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		const featureChanges: Partial<PolishedTuiConfig["features"]>[] = [];

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures(patch) {
					featureChanges.push(patch);
					return { applied: true };
				},
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
			},
		);

		await command?.handler("status line off", { hasUI: false });

		expect(featureChanges).toEqual([{ statusLine: false }]);
	});

	it("toggles copy-friendly mode from direct Starline slash-command arguments", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		const featureChanges: Partial<PolishedTuiConfig["features"]>[] = [];
		const notifications: Array<{ message: string; level: string }> = [];

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures(patch) {
					featureChanges.push(patch);
					return { applied: true };
				},
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
			},
		);

		await command?.handler("copy-friendly enable", {
			hasUI: true,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		});

		expect(featureChanges).toEqual([{ copyFriendly: true }]);
		expect(notifications).toEqual([{ message: "Copy-friendly mode: enabled", level: "info" }]);
	});

	it("shows when an editor toggle needs reload because another extension owns the editor", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		const notifications: Array<{ message: string; level: string }> = [];

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures: () => ({
					applied: false,
					reason:
						"another extension is currently managing the editor; reload Pi to apply this change",
				}),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
			},
		);

		await command?.handler("editor disable", {
			hasUI: true,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		});

		expect(notifications).toEqual([
			{
				message:
					"Editor: disabled (another extension is currently managing the editor; reload Pi to apply this change)",
				level: "info",
			},
		]);
	});

	it("closes the Starline settings UI before applying an editor feature change", async () => {
		vi.useFakeTimers();
		try {
			let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
			let doneCalls = 0;
			const doneCallsAtFeatureChange: number[] = [];
			const sessionLifecycle = new SessionLifecycle();
			sessionLifecycle.start();

			registerStarlineSettingsCommand(
				{
					registerCommand(_name: string, options: unknown) {
						command = options as typeof command;
					},
				} as never,
				{
					sessionLifecycle,
					getConfig: () => defaultConfig,
					setColorSources() {},
					setUiFeatures() {
						doneCallsAtFeatureChange.push(doneCalls);
						return { applied: true };
					},
					setIconMode() {},
					setContextStyle() {},
					setPathDisplay() {},
					setPillSegments() {},
					setGitBranch() {},
					getActiveExtensionStatuses: () => new Map<string, string>(),
					setExtensionStatusPlacement() {},
					setExtensionStatusColorMode() {},
					setMouseConfig() {},
					requestRender() {},
					settingsListTheme: {
						label: (text) => text,
						value: (text) => text,
						description: (text) => text,
						cursor: "> ",
						hint: (text) => text,
					},
				},
			);

			await command?.handler("", {
				hasUI: true,
				mode: "tui",
				ui: {
					theme: makeTaggedTheme(),
					notify() {},
					async custom(factory: (...args: unknown[]) => unknown) {
						const component = factory({ requestRender() {} }, makeTaggedTheme(), {}, () => {
							doneCalls += 1;
						}) as { handleInput?: (data: string) => void };
						component.handleInput?.("\t");
						component.handleInput?.(" ");
					},
				},
			});

			expect(doneCalls).toBe(1);
			expect(doneCallsAtFeatureChange).toEqual([]);

			vi.runAllTimers();

			expect(doneCallsAtFeatureChange).toEqual([1]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not update a settings value when persistence fails", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		const attemptedPatches: Partial<PolishedTuiConfig["features"]>[] = [];
		const notifications: string[] = [];
		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures(patch) {
					attemptedPatches.push(patch);
					throw new Error("config is corrupt");
				},
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
				settingsListTheme: {
					label: (text) => text,
					value: (text) => text,
					description: (text) => text,
					cursor: "> ",
					hint: (text) => text,
				},
			},
		);

		await command?.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: makeTaggedTheme(),
				notify(message: string) {
					notifications.push(message);
				},
				async custom(factory: (...args: unknown[]) => unknown) {
					const component = factory({ requestRender() {} }, makeTaggedTheme(), {}, () => {}) as {
						handleInput?: (data: string) => void;
					};
					component.handleInput?.("\t");
					component.handleInput?.("\x1b[B");
					component.handleInput?.(" ");
					component.handleInput?.("\x1b[B");
					component.handleInput?.(" ");
				},
			},
		});

		expect(attemptedPatches).toEqual([{ statusLine: false }, { statusLine: false }]);
		expect(notifications).toEqual([
			"Could not update Starline settings: config is corrupt",
			"Could not update Starline settings: config is corrupt",
		]);
	});

	it("drops a deferred settings editor swap after session shutdown", async () => {
		vi.useFakeTimers();
		try {
			let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
			let featureChanges = 0;
			let stale = false;
			const sessionLifecycle = new SessionLifecycle();
			sessionLifecycle.start();
			registerStarlineSettingsCommand(
				{
					registerCommand(_name: string, options: unknown) {
						command = options as typeof command;
					},
				} as never,
				{
					sessionLifecycle,
					getConfig: () => defaultConfig,
					setColorSources() {},
					setUiFeatures() {
						featureChanges += 1;
						return { applied: true };
					},
					setIconMode() {},
					setContextStyle() {},
					setPathDisplay() {},
					setPillSegments() {},
					setGitBranch() {},
					getActiveExtensionStatuses: () => new Map<string, string>(),
					setExtensionStatusPlacement() {},
					setExtensionStatusColorMode() {},
					setMouseConfig() {},
					requestRender() {},
					settingsListTheme: {
						label: (text) => text,
						value: (text) => text,
						description: (text) => text,
						cursor: "> ",
						hint: (text) => text,
					},
				},
			);
			const ctx = {
				hasUI: true,
				mode: "tui",
				ui: {
					theme: makeTaggedTheme(),
					notify() {
						if (stale) throw new Error("stale notify");
					},
					async custom(factory: (...args: unknown[]) => unknown) {
						const component = factory({ requestRender() {} }, makeTaggedTheme(), {}, () => {}) as {
							handleInput?: (data: string) => void;
						};
						component.handleInput?.("\t");
						component.handleInput?.(" ");
					},
				},
			};

			await command?.handler("", ctx);
			sessionLifecycle.shutdown();
			stale = true;

			expect(() => vi.runAllTimers()).not.toThrow();
			expect(featureChanges).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders Starline settings with mode-aware top and bottom borders", async () => {
		const settingsWidth = 160;
		async function renderSettings(config: PolishedTuiConfig) {
			let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
			let lines: string[] = [];

			registerStarlineSettingsCommand(
				{
					registerCommand(_name: string, options: unknown) {
						command = options as typeof command;
					},
				} as never,
				{
					sessionLifecycle: inactiveSessionLifecycle,
					getConfig: () => config,
					setColorSources() {},
					setUiFeatures: () => ({ applied: true }),
					setIconMode() {},
					setContextStyle() {},
					setPathDisplay() {},
					setPillSegments() {},
					setGitBranch() {},
					getActiveExtensionStatuses: () => new Map<string, string>(),
					setExtensionStatusPlacement() {},
					setExtensionStatusColorMode() {},
					setMouseConfig() {},
					requestRender() {},
					settingsListTheme: {
						label: (text) => text,
						value: (text) => text,
						description: (text) => text,
						cursor: "> ",
						hint: (text) => text,
					},
				},
			);

			await command?.handler("", {
				hasUI: true,
				mode: "tui",
				ui: {
					theme: makeTaggedTheme(),
					notify() {},
					async custom(factory: (...args: unknown[]) => unknown) {
						const component = factory({ requestRender() {} }, makeTaggedTheme(), {}, () => {}) as {
							render?: (width: number) => string[];
						};
						lines = component.render?.(settingsWidth) ?? [];
					},
				},
			});

			return lines;
		}

		const themeLines = await renderSettings(defaultConfig);
		expect(themeLines[0]).toContain("[borderMuted]────");
		expect(themeLines.join("\n")).toContain("Coloring");
		expect(themeLines.join("\n")).toContain("Features");
		expect(themeLines.join("\n")).toContain("Layout");
		expect(themeLines.join("\n")).toContain("Extension segments");
		expect(themeLines.join("\n")).toContain("Tab/Shift+Tab to switch sections");
		expect(themeLines.at(-1)).toContain("[borderMuted]────");
		expect(themeLines.every((line) => visibleWidth(stripTestTags(line)) <= settingsWidth)).toBe(
			true,
		);

		const terminalLines = await renderSettings(configWithColorSources({ editor: "terminal" }));
		expect(terminalLines[0]).toContain("\u001b[90m────");
		expect(terminalLines.at(-1)).toContain("\u001b[90m────");
		expect(
			terminalLines.every((line) => visibleWidth(stripPromptMarks(line)) <= settingsWidth),
		).toBe(true);
	});

	it("renders Starline settings without using invalid theme color tokens", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
				settingsListTheme: {
					label: (text) => text,
					value: (text) => text,
					description: (text) => text,
					cursor: "> ",
					hint: (text) => text,
				},
			},
		);

		await expect(
			command?.handler("", {
				hasUI: true,
				mode: "tui",
				ui: {
					theme: makeStrictTheme(),
					notify() {},
					async custom(factory: (...args: unknown[]) => unknown) {
						const component = factory({ requestRender() {} }, makeStrictTheme(), {}, () => {}) as {
							render?: (width: number) => string[];
						};
						component.render?.(40);
					},
				},
			}),
		).resolves.toBeUndefined();
	});

	it("cycles branch length presets and returns custom JSON values to full", async () => {
		const run = async (
			maxLength: PolishedTuiConfig["git"]["branch"]["maxLength"],
			presses: number,
		) => {
			let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
			const changes: Array<PolishedTuiConfig["git"]["branch"]["maxLength"]> = [];
			registerStarlineSettingsCommand(
				{
					registerCommand(_name: string, options: unknown) {
						command = options as typeof command;
					},
				} as never,
				{
					sessionLifecycle: inactiveSessionLifecycle,
					getConfig: () => ({
						...defaultConfig,
						git: { ...defaultConfig.git, branch: { maxLength } },
					}),
					setColorSources() {},
					setUiFeatures: () => ({ applied: true }),
					setIconMode() {},
					setContextStyle() {},
					setPathDisplay() {},
					setPillSegments() {},
					setGitBranch(patch) {
						if (patch.maxLength !== undefined) changes.push(patch.maxLength);
					},
					getActiveExtensionStatuses: () => new Map<string, string>(),
					setExtensionStatusPlacement() {},
					setExtensionStatusColorMode() {},
					setMouseConfig() {},
					requestRender() {},
					settingsListTheme: {
						label: (text) => text,
						value: (text) => text,
						description: (text) => text,
						cursor: "> ",
						hint: (text) => text,
					},
				},
			);
			await command?.handler("", {
				hasUI: true,
				mode: "tui",
				ui: {
					theme: makeTheme(),
					notify() {},
					async custom(factory: (...args: unknown[]) => unknown) {
						const component = factory({ requestRender() {} }, makeTheme(), {}, () => {}) as {
							handleInput?: (data: string) => void;
						};
						component.handleInput?.("\t");
						component.handleInput?.("\t");
						for (let index = 0; index < 3; index += 1) component.handleInput?.("\x1b[B");
						for (let index = 0; index < presses; index += 1) component.handleInput?.(" ");
					},
				},
			});
			return changes;
		};

		expect(await run("full", 6)).toEqual([10, 20, 30, 40, 50, "full"]);
		expect(await run(17, 1)).toEqual(["full"]);
	});

	it("keeps the Starline settings command open after applying a change", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		const changes: Partial<PolishedTuiConfig["colorSources"]>[] = [];
		let dependencyRenderRequests = 0;
		let tuiRenderRequests = 0;
		let doneCalls = 0;

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources(patch) {
					changes.push(patch);
				},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {
					dependencyRenderRequests += 1;
				},
				settingsListTheme: {
					label: (text) => text,
					value: (text) => text,
					description: (text) => text,
					cursor: "> ",
					hint: (text) => text,
				},
			},
		);

		await command?.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: makeTaggedTheme(),
				notify() {},
				async custom(factory: (...args: unknown[]) => unknown) {
					const component = factory(
						{
							requestRender() {
								tuiRenderRequests += 1;
							},
						},
						makeTaggedTheme(),
						{},
						() => {
							doneCalls += 1;
						},
					) as { handleInput?: (data: string) => void };
					component.handleInput?.("\x1b[B");
					component.handleInput?.(" ");
				},
			},
		});

		expect(changes).toEqual([{ editor: "terminal" }]);
		expect(dependencyRenderRequests).toBe(1);
		expect(tuiRenderRequests).toBe(1);
		expect(doneCalls).toBe(0);
	});

	it("cycles the editor chrome color source on its own", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		const changes: Partial<PolishedTuiConfig["colorSources"]>[] = [];
		let rendered = "";

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => configWithColorSources({ editor: "theme" }),
				setColorSources(patch) {
					changes.push(patch);
				},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
				settingsListTheme: {
					label: (text) => text,
					value: (text) => text,
					description: (text) => text,
					cursor: "> ",
					hint: (text) => text,
				},
			},
		);

		await command?.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: makeTaggedTheme(),
				notify() {},
				async custom(factory: (...args: unknown[]) => unknown) {
					const component = factory({ requestRender() {} }, makeTaggedTheme(), {}, () => {}) as {
						render?: (width: number) => string[];
						handleInput?: (data: string) => void;
					};
					rendered = component.render?.(80).join("\n") ?? "";
					component.handleInput?.("\x1b[B");
					component.handleInput?.(" ");
				},
			},
		});

		expect(rendered).toContain("Editor and selectors");
		expect(rendered).not.toContain("mixed");
		expect(changes).toEqual([{ editor: "terminal" }]);
	});

	function navigateToExtensionSegmentsSection(component: { handleInput?: (data: string) => void }) {
		// Coloring → Features → Layout → Pills → Extension segments
		component.handleInput?.("\t");
		component.handleInput?.("\t");
		component.handleInput?.("\t");
		component.handleInput?.("\t");
	}

	it("cycles extension segments tabs backward with shift+tab", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		let rendered = "";

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
				settingsListTheme: {
					label: (text) => text,
					value: (text) => text,
					description: (text) => text,
					cursor: "> ",
					hint: (text) => text,
				},
			},
		);

		await command?.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: makeTaggedTheme(),
				notify() {},
				async custom(factory: (...args: unknown[]) => unknown) {
					const component = factory({ requestRender() {} }, makeTaggedTheme(), {}, () => {}) as {
						render?: (width: number) => string[];
						handleInput?: (data: string) => void;
					};
					navigateToExtensionSegmentsSection(component);
					component.handleInput?.("\x1b[Z");
					rendered = component.render?.(120).join("\n") ?? "";
				},
			},
		});

		expect(rendered).toContain("Directory");
		expect(rendered).not.toContain("No active statuses");
	});

	it("renders active third-party statuses in the extension segments tab", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		let rendered = "";

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () =>
					new Map<string, string>([
						["alpha", "A"],
						["beta", "B"],
					]),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
				settingsListTheme: {
					label: (text) => text,
					value: (text) => text,
					description: (text) => text,
					cursor: "> ",
					hint: (text) => text,
				},
			},
		);

		await command?.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: makeTaggedTheme(),
				notify() {},
				async custom(factory: (...args: unknown[]) => unknown) {
					const component = factory({ requestRender() {} }, makeTaggedTheme(), {}, () => {}) as {
						render?: (width: number) => string[];
						handleInput?: (data: string) => void;
					};
					navigateToExtensionSegmentsSection(component);
					rendered = component.render?.(80).join("\n") ?? "";
				},
			},
		});

		expect(rendered).toContain("alpha");
		expect(rendered).toContain("beta");
		expect(rendered).toContain("right");
	});

	it("shows a read-only empty extension segments tab", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		let rendered = "";
		const placements: Array<{ key: string; placement: ExtensionStatusPlacement }> = [];

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>(),
				setExtensionStatusPlacement(key, placement) {
					placements.push({ key, placement });
				},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
				settingsListTheme: {
					label: (text) => text,
					value: (text) => text,
					description: (text) => text,
					cursor: "> ",
					hint: (text) => text,
				},
			},
		);

		await command?.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: makeTaggedTheme(),
				notify() {},
				async custom(factory: (...args: unknown[]) => unknown) {
					const component = factory({ requestRender() {} }, makeTaggedTheme(), {}, () => {}) as {
						render?: (width: number) => string[];
						handleInput?: (data: string) => void;
					};
					navigateToExtensionSegmentsSection(component);
					rendered = component.render?.(120).join("\n") ?? "";
					component.handleInput?.("\x1b");
				},
			},
		});

		expect(rendered).toContain("No active statuses");
		expect(rendered).toContain("ctx.ui.setStatus()");
		expect(placements).toEqual([]);
	});

	it("cycles active third-party status placement from the extension segments tab", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		const placements: Array<{ key: string; placement: ExtensionStatusPlacement }> = [];
		let dependencyRenderRequests = 0;
		let tuiRenderRequests = 0;

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () => defaultConfig,
				setColorSources() {},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>([["alpha", "ok"]]),
				setExtensionStatusPlacement(key, placement) {
					placements.push({ key, placement });
				},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {
					dependencyRenderRequests += 1;
				},
				settingsListTheme: {
					label: (text) => text,
					value: (text) => text,
					description: (text) => text,
					cursor: "> ",
					hint: (text) => text,
				},
			},
		);

		await command?.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: makeTaggedTheme(),
				notify() {},
				async custom(factory: (...args: unknown[]) => unknown) {
					const component = factory(
						{
							requestRender() {
								tuiRenderRequests += 1;
							},
						},
						makeTaggedTheme(),
						{},
						() => {},
					) as { handleInput?: (data: string) => void };
					navigateToExtensionSegmentsSection(component);
					component.handleInput?.(" ");
				},
			},
		});

		// The cycle is off → left → middle → right → off, so the first press from
		// the default "right" wraps around to "off".
		expect(placements).toEqual([{ key: "alpha", placement: "off" }]);
		expect(dependencyRenderRequests).toBe(1);
		expect(tuiRenderRequests).toBe(5);
	});

	it("does not show inactive saved placements in the extension segments tab", async () => {
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		let rendered = "";

		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: unknown) {
					command = options as typeof command;
				},
			} as never,
			{
				sessionLifecycle: inactiveSessionLifecycle,
				getConfig: () =>
					configWithExtensionStatuses({
						placements: { active: "middle", inactive: "left" },
					}),
				setColorSources() {},
				setUiFeatures: () => ({ applied: true }),
				setIconMode() {},
				setContextStyle() {},
				setPathDisplay() {},
				setPillSegments() {},
				setGitBranch() {},
				getActiveExtensionStatuses: () => new Map<string, string>([["active", "ok"]]),
				setExtensionStatusPlacement() {},
				setExtensionStatusColorMode() {},
				setMouseConfig() {},
				requestRender() {},
				settingsListTheme: {
					label: (text) => text,
					value: (text) => text,
					description: (text) => text,
					cursor: "> ",
					hint: (text) => text,
				},
			},
		);

		await command?.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: makeTaggedTheme(),
				notify() {},
				async custom(factory: (...args: unknown[]) => unknown) {
					const component = factory({ requestRender() {} }, makeTaggedTheme(), {}, () => {}) as {
						render?: (width: number) => string[];
						handleInput?: (data: string) => void;
					};
					navigateToExtensionSegmentsSection(component);
					rendered = component.render?.(80).join("\n") ?? "";
				},
			},
		});

		expect(rendered).toContain("active");
		expect(rendered).toContain("middle");
		expect(rendered).not.toContain("inactive");
	});
});
