/**
 * The extension entry point actually installing the mouse patches.
 *
 * Task 5 built `installMouse` and Task 8a is what finally calls it, so this is
 * the test that would have failed for every commit in between: it drives the
 * real `session_start`/`session_shutdown` handlers and checks the real
 * `TuiAltScreen.prototype` — the same prototype the running Pi renders through
 * — rather than a fake target that nobody's mouse ever reaches.
 *
 * Restoration is asserted just as strictly as installation. A patch left on
 * this shared prototype would leak into every test file that runs after this
 * one, so each test disposes and re-checks the original function references.
 */
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

let mouseEnabled = true;

vi.mock("../../extensions/starline/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/starline/config")>();
	return {
		...actual,
		ensureConfigExists: () => {},
		loadConfig: () => ({
			...actual.defaultConfig,
			projectRefreshIntervalMs: 0,
			features: { ...actual.defaultConfig.features, editor: false, statusLine: false },
			mouse: { ...actual.defaultConfig.mouse, enabled: mouseEnabled },
		}),
	};
});

import starline from "../../extensions/starline/index";

// Typed `private` in pi-tui's `.d.ts`, plain prototype functions at runtime —
// the same view `test/contract/mouse-install.test.ts` documents.
type TuiAltScreenPrototype = {
	copySelectionToClipboard: () => void;
	handleViewportInput: (data: string) => { consume: boolean } | undefined;
	handleSelectionMouseEvent: (event: unknown) => void;
	getWordSelection: (point: unknown) => unknown;
};
const prototype = TuiAltScreen.prototype as unknown as TuiAltScreenPrototype;

const originals = {
	copySelectionToClipboard: prototype.copySelectionToClipboard,
	handleViewportInput: prototype.handleViewportInput,
	handleSelectionMouseEvent: prototype.handleSelectionMouseEvent,
	getWordSelection: prototype.getWordSelection,
};

function expectRestored(): void {
	expect(prototype.copySelectionToClipboard).toBe(originals.copySelectionToClipboard);
	expect(prototype.handleViewportInput).toBe(originals.handleViewportInput);
	expect(prototype.handleSelectionMouseEvent).toBe(originals.handleSelectionMouseEvent);
	expect(prototype.getWordSelection).toBe(originals.getWordSelection);
}

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function loadExtension() {
	const handlers = new Map<string, Handler[]>();
	starline({
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand() {},
		getThinkingLevel() {
			return "off";
		},
	} as never);
	return handlers;
}

async function emit(handlers: Map<string, Handler[]>, name: string, ctx: unknown) {
	for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
}

/**
 * A TUI context with no `setWidget`, so `installFixedEditorProbe` returns
 * before touching anything — this file is about the mouse wiring, and the
 * compositor is Task 11's to remove.
 */
function makeCtx(overrides: { hasUI?: boolean; mode?: string } = {}) {
	let editorFactory: unknown;
	return {
		hasUI: overrides.hasUI ?? true,
		mode: overrides.mode ?? "tui",
		cwd: process.cwd(),
		model: { id: "test", provider: "anthropic", contextWindow: 10_000 },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => null,
		ui: {
			theme: {} as never,
			setFooter() {},
			setEditorComponent(factory: unknown) {
				editorFactory = factory;
			},
			getEditorComponent() {
				return editorFactory;
			},
		},
	};
}

describe("extension wiring of installMouse", () => {
	afterEach(() => {
		mouseEnabled = true;
		expectRestored();
	});

	it("patches the real TuiAltScreen prototype on session_start", async () => {
		const handlers = loadExtension();
		const ctx = makeCtx();

		await emit(handlers, "session_start", ctx);
		expect(prototype.copySelectionToClipboard).not.toBe(originals.copySelectionToClipboard);
		expect(prototype.handleViewportInput).not.toBe(originals.handleViewportInput);
		expect(prototype.handleSelectionMouseEvent).not.toBe(originals.handleSelectionMouseEvent);
		expect(prototype.getWordSelection).not.toBe(originals.getWordSelection);

		await emit(handlers, "session_shutdown", ctx);
	});

	it("installs nothing when mouse.enabled is false", async () => {
		mouseEnabled = false;
		const handlers = loadExtension();
		const ctx = makeCtx();

		await emit(handlers, "session_start", ctx);
		expectRestored();

		await emit(handlers, "session_shutdown", ctx);
	});

	it("leaves the prototype clean after two session_starts and one shutdown", async () => {
		// A second session_start must not stack a second set of patches whose
		// disposer nobody holds: the shutdown below has to fully undo both.
		const handlers = loadExtension();
		const ctx = makeCtx();

		await emit(handlers, "session_start", ctx);
		await emit(handlers, "session_start", ctx);
		expect(prototype.handleViewportInput).not.toBe(originals.handleViewportInput);

		await emit(handlers, "session_shutdown", ctx);
	});

	it("stays out of a non-TUI context", async () => {
		const handlers = loadExtension();
		const ctx = makeCtx({ hasUI: false });

		await emit(handlers, "session_start", ctx);
		expectRestored();

		await emit(handlers, "session_shutdown", ctx);
	});
});
