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

vi.mock("../../extensions/starline/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/starline/config")>();
	return {
		...actual,
		ensureConfigExists: () => {},
		loadConfig: () => ({
			...actual.defaultConfig,
			projectRefreshIntervalMs: 0,
			// `statusLine: false` is load-bearing, not incidental — see the
			// hint test at the bottom of this file.
			features: { ...actual.defaultConfig.features, editor: false, statusLine: false },
			mouse: { ...actual.defaultConfig.mouse, enabled: mouseEnabled },
		}),
	};
});

import starline from "../../extensions/starline/index";

// Typed `private` in pi-tui's `.d.ts`, plain prototype functions at runtime —
// the same view `test/contract/mouse-install.test.ts` documents.
type TuiAltScreenPrototype = {
	copyActiveSelectionToClipboard: () => Promise<boolean>;
	handleViewportInput: (data: string) => { consume: boolean } | undefined;
	handleSelectionMouseEvent: (event: unknown) => void;
};
const prototype = TuiAltScreen.prototype as unknown as TuiAltScreenPrototype;

const originals = {
	copyActiveSelectionToClipboard: prototype.copyActiveSelectionToClipboard,
	handleViewportInput: prototype.handleViewportInput,
	handleSelectionMouseEvent: prototype.handleSelectionMouseEvent,
};

function expectRestored(): void {
	expect(prototype.copyActiveSelectionToClipboard).toBe(originals.copyActiveSelectionToClipboard);
	expect(prototype.handleViewportInput).toBe(originals.handleViewportInput);
	expect(prototype.handleSelectionMouseEvent).toBe(originals.handleSelectionMouseEvent);
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
			expectRestored();
		}
	});

	it("patches the real TuiAltScreen prototype on session_start", async () => {
		await startSession();

		expect(prototype.copyActiveSelectionToClipboard).not.toBe(
			originals.copyActiveSelectionToClipboard,
		);
		expect(prototype.handleViewportInput).not.toBe(originals.handleViewportInput);
		expect(prototype.handleSelectionMouseEvent).not.toBe(originals.handleSelectionMouseEvent);
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
	 * The hint is derived, so nothing about a release needs Starline's help: Pi
	 * 0.84.4's `copyOnSelect: false` keeps the selection highlighted and its own
	 * repaints put the hint on screen via the metadata row. This drives the real
	 * prototype the way a real session would — selection on the live renderer,
	 * one input event to register the instance — and reads the derived hint.
	 */
	it("derives the selection hint from the real prototype's own state", async () => {
		await startSession();

		const receiver = Object.create(TuiAltScreen.prototype) as {
			copyOnSelect: boolean;
			selectionAnchor: { row: number; col: number } | undefined;
			selectionFocus: { row: number; col: number } | undefined;
			previousScreen: string[];
			overlayStack: unknown[];
			handleViewportInput: (data: string) => { consume: boolean } | undefined;
			stopped: boolean;
		};
		receiver.copyOnSelect = false;
		receiver.previousScreen = ["hello world"];
		receiver.selectionAnchor = { row: 0, col: 0 };
		receiver.selectionFocus = { row: 0, col: 5 };
		receiver.overlayStack = [];
		receiver.stopped = true;

		// An input event registers the live instance the hint reads.
		receiver.handleViewportInput("");

		expect(activeSelectionHintText()).toContain("5 characters selected");

		await endSession();
		expect(activeSelectionHintText()).toBeNull();
	});

	it("stays out of a non-TUI context", async () => {
		await startSession(makeCtx({ hasUI: false }));

		expectRestored();
	});
});
