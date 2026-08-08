import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import { activeSelectionHintText, installMouse } from "../../extensions/starline/mouse/index";

type SelectionBounds = { start: { row: number; col: number }; end: { row: number; col: number } };
type SelectionColumns = { start: number; end: number };

type FakeAltScreen = {
	selectionBounds: SelectionBounds | undefined;
	previousScreen: string[];
	copySelectionToClipboard(): void;
	getSelectionBounds(): SelectionBounds | undefined;
	getSelectionColumns(line: string, row: number, selection: SelectionBounds): SelectionColumns;
	handleViewportInput(data: string): { consume: boolean } | undefined;
	flash(message: string, durationMs?: number): void;
	routeWheel(): void;
	handleSelectionMouseEvent(): void;
	applySelection(): void;
	getWordSelection(): void;
};

/**
 * A minimal stand-in for `getSelectionColumns` — real enough to exercise
 * `selectionText`'s row-by-row loop without pulling in grapheme-boundary
 * handling, which is Pi's own concern and covered by
 * `test/mouse/__real-pi-verify` style checks against the actual prototype.
 */
function fakeSelectionColumns(
	line: string,
	row: number,
	selection: SelectionBounds,
): SelectionColumns {
	return {
		start: row === selection.start.row ? selection.start.col : 0,
		end: row === selection.end.row ? selection.end.col : line.length,
	};
}

function makePrototype(): { prototype: FakeAltScreen; calls: string[] } {
	const calls: string[] = [];
	const prototype: FakeAltScreen = {
		selectionBounds: { start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
		previousScreen: ["hello world"],
		getSelectionBounds() {
			return this.selectionBounds;
		},
		getSelectionColumns: fakeSelectionColumns,
		copySelectionToClipboard() {
			calls.push("copy");
			this.flash("Copied!");
		},
		handleViewportInput(data: string) {
			calls.push(`viewport:${data}`);
			return data === "\x03" ? undefined : { consume: true };
		},
		flash(message: string) {
			calls.push(`flash:${message}`);
		},
		routeWheel() {},
		handleSelectionMouseEvent() {},
		applySelection() {},
		getWordSelection() {},
	};
	return { prototype, calls };
}

function makeConfig(copyOnSelect: boolean, copyNotice: boolean): () => PolishedTuiConfig {
	return () =>
		({
			mouse: {
				copyOnSelect,
				copyNotice,
				enabled: true,
				wheelRouting: true,
				clickToExpandTools: true,
				pathAwareWords: true,
			},
		}) as PolishedTuiConfig;
}

describe("installMouse selectionPendingMode", () => {
	let requestRender: () => void;

	beforeEach(() => {
		requestRender = vi.fn();
	});

	it("arms instead of copying on release when copyOnSelect is false", () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
			requestRender,
		});

		prototype.copySelectionToClipboard();

		expect(calls).toEqual([]); // no real copy happened
		expect(activeSelectionHintText()).toBe("5 characters selected, ctrl+c to copy");
		expect(requestRender).toHaveBeenCalled();
		dispose();
	});

	it("calls through to the real copy when copyOnSelect is true", () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true, true),
			requestRender,
		});

		prototype.copySelectionToClipboard();

		expect(calls).toEqual(["copy", "flash:Copied!"]);
		dispose();
	});

	it("ctrl+c with a pending selection performs the real copy and clears", () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
			requestRender,
		});

		prototype.copySelectionToClipboard(); // arms
		const result = prototype.handleViewportInput("\x03");

		expect(result).toEqual({ consume: true });
		expect(calls).toEqual(["copy", "flash:Copied!"]);
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});

	it("ctrl+c with nothing pending falls through to Pi's own handler", () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
			requestRender,
		});

		const result = prototype.handleViewportInput("\x03");

		expect(result).toBeUndefined(); // Pi's own handler returns undefined for ctrl+c
		expect(calls).toEqual(["viewport:\x03"]);
		dispose();
	});

	it("suppresses the notice flash when copyNotice is off", () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, false),
			requestRender,
		});

		prototype.copySelectionToClipboard(); // arms
		prototype.handleViewportInput("\x03");

		expect(calls).toEqual(["copy"]);
		dispose();
	});

	it("a deselect clears a stale arm instead of leaving it to swallow ctrl+c", () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
			requestRender,
		});

		prototype.copySelectionToClipboard(); // release #1: real bounds, arms
		expect(activeSelectionHintText()).not.toBeNull();

		// release #2: a plain click elsewhere collapses the selection. Pi calls
		// copySelectionToClipboard unconditionally on every release; its own
		// getSelectionBounds() now returns undefined.
		prototype.selectionBounds = undefined;
		prototype.copySelectionToClipboard();
		expect(activeSelectionHintText()).toBeNull();

		calls.length = 0; // isolate what ctrl+c does from here
		const result = prototype.handleViewportInput("\x03");

		// The interrupt must reach Pi's real handler, not be consumed for a
		// no-op copy. Assert the predecessor actually ran, not just the shape
		// of the return value.
		expect(calls).toContain("viewport:\x03");
		expect(result).toBeUndefined();
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});

	it("ctrl+c does not consume when an armed selection has gone stale some other way", () => {
		// The same class of bug from the handleViewportInput side: state.pending
		// can be true while Pi's own selection is already gone through a path
		// that never calls copySelectionToClipboard (starting a new drag
		// overwrites selectionAnchor/selectionFocus directly). This simulates
		// that by mutating the bounds without a release in between.
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
			requestRender,
		});

		prototype.copySelectionToClipboard(); // arms
		expect(activeSelectionHintText()).not.toBeNull();

		prototype.selectionBounds = undefined; // Pi's selection is gone, unobserved

		calls.length = 0;
		const result = prototype.handleViewportInput("\x03");

		expect(calls).toContain("viewport:\x03");
		expect(result).toBeUndefined();
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});

	it("dispose removes the patches", () => {
		const { prototype } = makePrototype();
		const original = prototype.copySelectionToClipboard;
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
			requestRender,
		});
		dispose();
		expect(prototype.copySelectionToClipboard).toBe(original);
		expect(activeSelectionHintText()).toBeNull();
	});
});
