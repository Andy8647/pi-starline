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
import { activeSelectionHintText } from "../../extensions/starline/mouse/index";

let mouseEnabled = true;
let copyOnSelect = false;

vi.mock("../../extensions/starline/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/starline/config")>();
	return {
		...actual,
		ensureConfigExists: () => {},
		loadConfig: () => ({
			...actual.defaultConfig,
			projectRefreshIntervalMs: 0,
			// `statusLine: false` is load-bearing, not incidental — see the
			// repaint test at the bottom of this file.
			features: { ...actual.defaultConfig.features, editor: false, statusLine: false },
			mouse: { ...actual.defaultConfig.mouse, enabled: mouseEnabled, copyOnSelect },
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
 * A minimal TUI context for exercising the real `session_start` /
 * `session_shutdown` handlers: the mouse installer probes for the editor
 * shape and degrades cleanly when it is absent, so a bare context is enough
 * to prove the wiring and its restoration.
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
	// The session a test opened, so teardown can close it even when an assertion
	// throws first. A patch left on this shared prototype would poison every test
	// file that runs after this one, invisibly and depending on run order.
	let open: { handlers: Map<string, Handler[]>; ctx: unknown } | undefined;

	async function startSession(ctx = makeCtx()) {
		const handlers = loadExtension();
		open = { handlers, ctx };
		await emit(handlers, "session_start", ctx);
		return { handlers, ctx };
	}

	async function endSession() {
		if (!open) return;
		const { handlers, ctx } = open;
		open = undefined;
		await emit(handlers, "session_shutdown", ctx);
	}

	afterEach(async () => {
		try {
			await endSession();
		} finally {
			mouseEnabled = true;
			copyOnSelect = false;
			expectRestored();
		}
	});

	it("patches the real TuiAltScreen prototype on session_start", async () => {
		await startSession();

		expect(prototype.copySelectionToClipboard).not.toBe(originals.copySelectionToClipboard);
		expect(prototype.handleViewportInput).not.toBe(originals.handleViewportInput);
		expect(prototype.handleSelectionMouseEvent).not.toBe(originals.handleSelectionMouseEvent);
		expect(prototype.getWordSelection).not.toBe(originals.getWordSelection);
	});

	it("installs nothing when mouse.enabled is false", async () => {
		mouseEnabled = false;
		await startSession();

		expectRestored();
	});

	it("leaves the prototype clean after two session_starts and one shutdown", async () => {
		// A second session_start must not stack a second set of patches whose
		// disposer nobody holds: the one shutdown in teardown has to undo both.
		const { handlers, ctx } = await startSession();
		await emit(handlers, "session_start", ctx);

		expect(prototype.handleViewportInput).not.toBe(originals.handleViewportInput);
	});

	/**
	 * The gap this file did not catch the first time.
	 *
	 * The wiring originally passed the extension's own `refresh` as the patches'
	 * repaint callback. `refresh` calls `requestFooterRender`, which is only ever
	 * set inside `installStatusLine` — so with `features.statusLine` off (exactly
	 * what this file's config mock configures) arming a selection asked nobody to
	 * repaint, and the pending hint sat invisible until some unrelated frame
	 * arrived. The hint lives in the editor's metadata row, so the footer was
	 * never the right thing to depend on.
	 *
	 * This asserts the real effect rather than that a stub was called: a real
	 * receiver off the real prototype, Pi's own inherited `requestRender`, and
	 * `renderRequested` — the flag Pi's own method sets — flipping on release.
	 */
	it("asks the renderer to repaint on release even with the statusline off", async () => {
		await startSession();

		const receiver = Object.create(TuiAltScreen.prototype) as {
			selectionAnchor: { row: number; col: number } | undefined;
			selectionFocus: { row: number; col: number } | undefined;
			previousScreen: string[];
			terminal: { write: (data: string) => void };
			flashes: { flash: (message: string) => void };
			copySelectionToClipboard: () => void;
			renderRequested: boolean;
			stopped: boolean;
		};
		const written: string[] = [];
		receiver.previousScreen = ["hello world"];
		receiver.terminal = { write: (data: string) => written.push(data) };
		receiver.flashes = { flash: () => {} };
		receiver.selectionAnchor = { row: 0, col: 0 };
		receiver.selectionFocus = { row: 0, col: 5 };
		receiver.renderRequested = false;
		// `requestRender` defers the frame itself to `scheduleRender` on the next
		// tick, which returns immediately while stopped. That leaves the real
		// method's observable effect without a detached receiver trying to paint.
		receiver.stopped = true;

		// The release. Pi calls this itself when the button comes up.
		receiver.copySelectionToClipboard();

		expect(written).toEqual([]); // armed, not copied
		expect(activeSelectionHintText()).toBe("5 characters selected, ctrl+c to copy");
		// Pi's own `requestRender` ran, with no footer installed anywhere. Under
		// the original wiring this stayed false.
		expect(receiver.renderRequested).toBe(true);

		await endSession();
		expect(activeSelectionHintText()).toBeNull();
	});

	it("stays out of a non-TUI context", async () => {
		await startSession(makeCtx({ hasUI: false }));

		expectRestored();
	});
});
