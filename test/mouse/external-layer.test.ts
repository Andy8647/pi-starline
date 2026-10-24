import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../extensions/starline/config";
import { installMouse } from "../../extensions/starline/mouse";
import { externalMouseLayer } from "../../extensions/starline/mouse/external-layer";

/**
 * `@xzzpig/pi-mouse-events` patches the same `TuiAltScreen` methods Starline does.
 * Two layers would both answer every notch, click and copy, so Starline stands
 * down when that extension is present and says so once.
 */

const KEY = Symbol.for("pi-mouse-events.api.v2");

function withExternalLayer<T>(value: unknown, run: () => T): T {
	const scope = globalThis as Record<PropertyKey, unknown>;
	const had = scope[KEY];
	scope[KEY] = value;
	try {
		return run();
	} finally {
		if (had === undefined) delete scope[KEY];
		else scope[KEY] = had;
	}
}

describe("externalMouseLayer", () => {
	it("is undefined when nothing publishes the key", () => {
		expect(externalMouseLayer({})).toBeUndefined();
	});

	it("is undefined for an object from a different contract major", () => {
		expect(
			externalMouseLayer({ [KEY]: { version: 1 } } as Record<PropertyKey, unknown>),
		).toBeUndefined();
		expect(
			externalMouseLayer({ [KEY]: "not an object" } as Record<PropertyKey, unknown>),
		).toBeUndefined();
	});

	it("names the extension when the contract matches", () => {
		expect(externalMouseLayer({ [KEY]: { version: 2 } } as Record<PropertyKey, unknown>)).toEqual({
			name: "@xzzpig/pi-mouse-events",
			version: 2,
		});
	});
});

describe("installMouse when another extension owns the mouse layer", () => {
	function makePrototype() {
		const calls: string[] = [];
		const prototype = {
			terminal: { rows: 24 },
			currentLayout: undefined,
			routeWheel() {
				calls.push("routeWheel");
			},
			handleSelectionMouseEvent() {
				calls.push("press");
			},
			handleViewportInput() {
				calls.push("input");
				return undefined;
			},
			copyActiveSelectionToClipboard: async () => false,
			getSelectionBounds: () => undefined,
			getSelectionColumns: () => ({ start: 0, end: 0 }),
			hasActiveSelection: () => false,
			getCopyOnSelect: () => true,
			hasOverlay: () => false,
			requestRender() {},
			flash() {},
			applySelection() {
				calls.push("applySelection");
				return [];
			},
		};
		return { prototype, calls };
	}

	it("leaves every mouse method untouched and warns once", () => {
		const { prototype } = makePrototype();
		const originalWheel = prototype.routeWheel;
		const originalPress = prototype.handleSelectionMouseEvent;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		withExternalLayer({ version: 2 }, () => {
			installMouse(prototype, { getConfig: () => defaultConfig })();
			installMouse(prototype, { getConfig: () => defaultConfig })();
		});

		const messages = warn.mock.calls.map((call) => String(call[0])).join("\n");
		warn.mockRestore();

		expect(prototype.routeWheel).toBe(originalWheel);
		expect(prototype.handleSelectionMouseEvent).toBe(originalPress);
		expect(messages).toContain("pi-mouse-events");
		// Once per process, however many times the install runs.
		expect(messages.match(/owns Pi's mouse layer/g)).toHaveLength(1);
	});

	it("still cleans the selection render, which is not mouse input", () => {
		const { prototype } = makePrototype();
		const originalApply = prototype.applySelection;
		vi.spyOn(console, "warn").mockImplementation(() => {});

		withExternalLayer({ version: 2 }, () => {
			installMouse(prototype, { getConfig: () => defaultConfig });
		});
		vi.restoreAllMocks();

		expect(prototype.applySelection).not.toBe(originalApply);
	});

	it("patches as usual when the key is missing or from another major", () => {
		for (const value of [undefined, { version: 1 }]) {
			const { prototype } = makePrototype();
			const originalWheel = prototype.routeWheel;
			const dispose = withExternalLayer(value, () =>
				installMouse(prototype, { getConfig: () => defaultConfig }),
			);
			expect(prototype.routeWheel).not.toBe(originalWheel);
			dispose();
		}
	});
});
