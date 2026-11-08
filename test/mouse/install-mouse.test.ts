import { describe, expect, it } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import { activeSelectionHintText, installMouse } from "../../extensions/starline/mouse/index";

type SelectionBounds = {
	start: { row: number; col: number; scrollView?: unknown };
	end: { row: number; col: number };
};

type FakeAltScreen = {
	selectionBounds: SelectionBounds | undefined;
	previousScreen: string[];
	copyOnSelect: boolean;
	copyActiveSelectionToClipboard(): Promise<boolean>;
	getCopyOnSelect(): boolean;
	getActiveSelectionText(): string | undefined;
	getSelectionBounds(): SelectionBounds | undefined;
	handleViewportInput(data: string): { consume: boolean } | undefined;
	flash(message: string, durationMs?: number): void;
	hasOverlay(): boolean;
	routeWheel(): void;
	handleSelectionMouseEvent(): void;
	applySelection(): void;
	requestRender(): void;
};

function makePrototype(): { prototype: FakeAltScreen; calls: string[]; renders: string[] } {
	const calls: string[] = [];
	// Kept out of `calls` so the exact-sequence assertions below stay about what
	// Pi's own methods did, not about repaints.
	const renders: string[] = [];
	const prototype: FakeAltScreen = {
		selectionBounds: { start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
		previousScreen: ["hello world"],
		copyOnSelect: false,
		getCopyOnSelect() {
			return this.copyOnSelect;
		},
		getActiveSelectionText() {
			const selection = this.selectionBounds;
			return selection && this.previousScreen[0].slice(selection.start.col, selection.end.col);
		},
		getSelectionBounds() {
			return this.selectionBounds;
		},
		async copyActiveSelectionToClipboard() {
			calls.push("copy");
			this.flash("Copied!");
			return true;
		},
		handleViewportInput(data: string) {
			calls.push(`viewport:${data}`);
			return data === "\x03" ? undefined : { consume: true };
		},
		flash(message: string) {
			calls.push(`flash:${message}`);
		},
		hasOverlay() {
			return false;
		},
		routeWheel() {},
		handleSelectionMouseEvent() {},
		applySelection() {},
		requestRender() {
			renders.push("render");
		},
	};
	return { prototype, calls, renders };
}

function makeConfig(copyNotice: boolean): () => PolishedTuiConfig {
	return () =>
		({
			icons: { rail: "│" },
			mouse: {
				copyNotice,
				enabled: true,
				wheelRouting: true,
			},
		}) as PolishedTuiConfig;
}

/**
 * The hint is derived from Pi 0.84.4's own select-without-copy state. The
 * receiver has to be registered first — `installMouse` sees the prototype, and
 * the live instance is captured from the first `handleViewportInput` call.
 */
function registerReceiver(prototype: FakeAltScreen): void {
	prototype.handleViewportInput("");
}

describe("installMouse selectionHint", () => {
	it("shows the hint while the renderer is not auto-copying and a selection exists", () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true),
		});
		registerReceiver(prototype);

		expect(activeSelectionHintText()).toContain("5 characters selected");
		// Nothing copied, nothing flashed — the release did not reach us at all.
		expect(calls).toEqual(["viewport:"]);

		dispose();
		expect(activeSelectionHintText()).toBeNull();
	});

	it("no hint while the renderer auto-copies", () => {
		const { prototype } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true),
		});
		registerReceiver(prototype);

		prototype.copyOnSelect = true;
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});

	it("no hint without a selection", () => {
		const { prototype } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true),
		});
		registerReceiver(prototype);

		prototype.selectionBounds = undefined;
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});

	it("counts Pi's selection text, so what pi-tidy takes out of it is not in the number", () => {
		// pi-tidy wraps this method to drop its frames. The hint has to count what
		// the copy will send, not what the rows on screen hold.
		const { prototype } = makePrototype();
		const dispose = installMouse(prototype, { getConfig: makeConfig(true) });
		registerReceiver(prototype);

		prototype.getActiveSelectionText = () => "hi";
		expect(activeSelectionHintText()).toContain("2 characters selected");
		dispose();
	});

	it("does not install without Pi 0.84.4's selection APIs, and the copy patch still does", () => {
		// Dropping `getCopyOnSelect`/`getActiveSelectionText` takes `selectionHint`
		// with it — no hint — while `editorBufferCopy` needs neither and still
		// answers the copy.
		const { prototype } = makePrototype();
		const {
			getCopyOnSelect: _droppedA,
			getActiveSelectionText: _droppedB,
			...withoutApi
		} = prototype;
		const original = withoutApi.copyActiveSelectionToClipboard;

		const dispose = installMouse(withoutApi, {
			getConfig: makeConfig(true),
		});

		expect(withoutApi.copyActiveSelectionToClipboard).not.toBe(original);
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});
});

describe("installMouse in the transcript", () => {
	it("leaves a transcript selection's copy to Pi: frames are pi-tidy's business", async () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, { getConfig: makeConfig(true) });
		prototype.previousScreen = ["╭─ label ─╮", "│ hello   │", "╰─────────╯"];
		prototype.selectionBounds = {
			start: { row: 0, col: 0, scrollView: { name: "transcript" } },
			end: { row: 2, col: 11 },
		};

		await prototype.copyActiveSelectionToClipboard();

		expect(calls).toEqual(["copy", "flash:Copied!"]);
		dispose();
	});
});

describe("installMouse gating for editorClickToCaret", () => {
	it("patches handleViewportInput when editorClickToCaret is the only editor feature enabled", () => {
		// A Pi build that has moved copyActiveSelectionToClipboard disables
		// editorBufferCopy (which requires it), but NOT
		// editorClickToCaret. The range-delete half of editorClickToCaret lives
		// on the handleViewportInput patch inside installCopying, so the gating
		// must install it even when that feature is off — otherwise the
		// caret installs while its delete silently never exists, exactly the
		// half-working install the capability table's rule forbids.
		const { prototype, calls } = makePrototype();
		const extended = prototype as FakeAltScreen & {
			hasOverlay: () => boolean;
		};
		extended.hasOverlay = () => false;
		// The capability probe looks at the object itself and its prototype
		// chain; removing the method makes isPatchable report it missing.
		delete (extended as Partial<FakeAltScreen>).copyActiveSelectionToClipboard;

		const originalViewportInput = prototype.handleViewportInput;
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true),
		});

		// handleViewportInput is patched: backspace with no selection still
		// falls through to Pi's own handler (the wrapper calls predecessor).
		expect(prototype.handleViewportInput).not.toBe(originalViewportInput);
		calls.length = 0;
		prototype.handleViewportInput("\x7f");
		expect(calls).toEqual(["viewport:\x7f"]);
		dispose();
		// dispose removes the patch again.
		expect(prototype.handleViewportInput).toBe(originalViewportInput);
	});
});
