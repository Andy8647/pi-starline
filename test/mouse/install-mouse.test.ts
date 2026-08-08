import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import { activeSelectionHintText, installMouse } from "../../extensions/starline/mouse/index";

type SelectionBounds = { start: { row: number; col: number }; end: { row: number; col: number } };

type FakeAltScreen = {
	selectionText: string;
	selectionBounds: SelectionBounds | undefined;
	copySelectionToClipboard(): void;
	getSelectionBounds(): SelectionBounds | undefined;
	handleViewportInput(data: string): { consume: boolean } | undefined;
	flash(message: string, durationMs?: number): void;
	routeWheel(): void;
	handleSelectionMouseEvent(): void;
	applySelection(): void;
	getWordSelection(): void;
};

function makePrototype(): { prototype: FakeAltScreen; calls: string[] } {
	const calls: string[] = [];
	const prototype: FakeAltScreen = {
		selectionText: "",
		selectionBounds: { start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
		getSelectionBounds() {
			return this.selectionBounds;
		},
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
