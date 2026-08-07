import { describe, expect, it } from "vitest";

import { inspectPiTui } from "../extensions/starline/fixed-editor/pi-compat";

/**
 * Pi 0.84 stopped handing extensions the live renderer. `ctx.ui` is now a Proxy
 * over it, so Pi can swap `TuiMainScreen` for `TuiAltScreen` when the TUI mode
 * changes. That Proxy forwards `get` and `set` but defines no `defineProperty`
 * trap — the one the compositor installs its patches through. Without the
 * round-trip probe in `pi-compat`, `inspectPiTui` reported the layout as
 * supported, the render patches silently landed on the Proxy's own empty target,
 * and the compositor went on to blank the editor and footer that only those
 * patches would have drawn again.
 */

/** A component the cluster scan will accept. */
function makeRenderable(rows = 1) {
	return { render: (width: number) => Array.from({ length: rows }, () => `${width}`) };
}

function makeEditor() {
	return {
		...makeRenderable(),
		getText: () => "",
		setText: () => {},
		handleInput: () => {},
	};
}

/** A renderer shaped the way `inspectPiTui` expects to find one. */
function makeTui() {
	const editor = makeEditor();
	const editorContainer = { ...makeRenderable(), children: [editor] };
	return {
		terminal: {
			write: (_data: string) => {},
			get rows() {
				return 40;
			},
			columns: 100,
		},
		children: [
			{ ...makeRenderable(), children: [] },
			{ ...makeRenderable(), children: [] },
			editorContainer,
			{ ...makeRenderable(), children: [] },
			{ ...makeRenderable(), children: [] },
		],
		focusedComponent: editor,
		render: (_width: number) => [] as string[],
		doRender: () => {},
		addInputListener: () => () => {},
		removeInputListener: () => {},
		hasOverlay: () => false,
		overlayStack: [] as unknown[],
		hardwareCursorRow: 0,
		previousViewportTop: 0,
	};
}

/** Copied from Pi 0.84 `interactive-mode.ts` `createInteractiveTuiReference`. */
function wrapLikePi084<T extends object>(getTui: () => T): T {
	return new Proxy({} as T, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const current = getTui();
				const method = Reflect.get(current, property, current);
				if (typeof method !== "function") throw new TypeError("not callable");
				return Reflect.apply(method, current, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui() as object, property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui() as object),
	});
}

describe("inspectPiTui", () => {
	it("accepts a renderer whose methods can actually be patched", () => {
		expect(inspectPiTui(makeTui())).toBeDefined();
	});

	it("rejects a renderer reached through Pi 0.84's swap Proxy", () => {
		const tui = makeTui();
		expect(inspectPiTui(wrapLikePi084(() => tui))).toBeUndefined();
	});

	it("leaves the renderer untouched after rejecting it", () => {
		const tui = makeTui();
		const originalDoRender = tui.doRender;
		const originalWrite = tui.terminal.write;
		const originalEditorRender = tui.children[2].render;

		inspectPiTui(wrapLikePi084(() => tui));

		expect(tui.doRender).toBe(originalDoRender);
		expect(tui.terminal.write).toBe(originalWrite);
		expect(tui.children[2].render).toBe(originalEditorRender);
	});

	it("restores every probed method on the accepted path too", () => {
		const tui = makeTui();
		const originalDoRender = tui.doRender;
		const originalRender = tui.render;
		const originalWrite = tui.terminal.write;

		expect(inspectPiTui(tui)).toBeDefined();

		expect(tui.doRender).toBe(originalDoRender);
		expect(tui.render).toBe(originalRender);
		expect(tui.terminal.write).toBe(originalWrite);
	});

	it("rejects a renderer whose methods are frozen", () => {
		const tui = makeTui();
		Object.defineProperty(tui, "doRender", {
			value: tui.doRender,
			writable: false,
			configurable: false,
		});
		expect(inspectPiTui(tui)).toBeUndefined();
	});
});
