import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { capEditorLines, renderCluster } from "../extensions/zentui/fixed-editor/cluster";
import { TerminalSplitCompositor } from "../extensions/zentui/fixed-editor/compositor";
import {
	clampScrollOffset,
	parseKeyboardScroll,
	parseMouseEvent,
	parseMouseScroll,
} from "../extensions/zentui/fixed-editor/input";
import {
	findEditorContainerIndex,
	inspectPiTui,
	type PiRenderableCapability,
} from "../extensions/zentui/fixed-editor/pi-compat";
import {
	highlightSelection,
	lineRangeAt,
	SelectionState,
	wordRangeAt,
} from "../extensions/zentui/fixed-editor/selection";
import {
	DISABLE_MOUSE,
	ENABLE_ALT_SCROLL,
	EXIT_ALT_SCREEN,
	emergencyTerminalReset,
	RESET_SCROLL_REGION,
	SHOW_CURSOR,
} from "../extensions/zentui/fixed-editor/terminal-modes";

function makeValidPiFixture() {
	let rawRows = 24;
	let inputListener:
		| ((data: string) => { consume?: boolean; data?: string } | undefined)
		| undefined;
	const inputListenerDisposer = vi.fn(() => {
		inputListener = undefined;
	});
	const removeInputListener = vi.fn(
		(listener: (data: string) => { consume?: boolean; data?: string } | undefined) => {
			if (inputListener === listener) inputListener = undefined;
		},
	);
	const terminalWrite = vi.fn();
	const makeRenderable = (label: string) => ({
		render(width: number) {
			return [`${label}:${width}`];
		},
	});
	const editorComponent = {
		getText: () => "",
		setText() {},
		handleInput() {},
	};
	const status = makeRenderable("status");
	const above = makeRenderable("above");
	const editor = { ...makeRenderable("editor"), children: [editorComponent] };
	const below = makeRenderable("below");
	const footer = makeRenderable("footer");
	const terminal = {
		columns: 80,
		rows: rawRows,
		write: terminalWrite,
	};
	Object.defineProperty(terminal, "rows", {
		configurable: true,
		enumerable: true,
		get: () => rawRows,
	});
	const rootRender = vi.fn((width: number) =>
		Array.from({ length: 30 }, (_, index) => `root-${index}:${width}`),
	);
	const doRender = vi.fn();
	const requestRender = vi.fn();
	const addInputListener = vi.fn(
		(listener: (data: string) => { consume?: boolean; data?: string } | undefined) => {
			inputListener = listener;
			return inputListenerDisposer;
		},
	);
	const tui = {
		children: [status, above, editor, below, footer],
		focusedComponent: editorComponent,
		terminal,
		render: rootRender,
		doRender,
		requestRender,
		addInputListener,
		removeInputListener,
		hasOverlay: () => false,
		overlayStack: [] as { hidden?: boolean }[],
		hardwareCursorRow: 4,
		previousViewportTop: 1,
	};
	return {
		tui,
		terminal,
		cluster: [status, above, editor, below, footer],
		terminalWrite,
		rootRender,
		doRender,
		requestRender,
		addInputListener,
		inputListenerDisposer,
		removeInputListener,
		getInputListener: () => inputListener,
		setRows: (rows: number) => {
			rawRows = rows;
		},
	};
}

describe("Pi fixed-editor compatibility", () => {
	it.each([
		[
			"terminal",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.tui, "terminal"),
		],
		[
			"terminal write",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.terminal, "write"),
		],
		[
			"terminal rows",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.terminal, "rows"),
		],
		[
			"terminal columns",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.terminal, "columns"),
		],
		[
			"input listener",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.tui, "addInputListener"),
		],
		[
			"input listener removal",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.tui, "removeInputListener"),
		],
		[
			"children",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.tui, "children"),
		],
		[
			"editor layout",
			(fixture: ReturnType<typeof makeValidPiFixture>) => {
				Reflect.set(fixture.tui.children[2], "children", []);
			},
		],
		[
			"render",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.tui, "render"),
		],
		[
			"doRender",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.tui, "doRender"),
		],
		[
			"overlay visibility",
			(fixture: ReturnType<typeof makeValidPiFixture>) => {
				Reflect.deleteProperty(fixture.tui, "hasOverlay");
				Reflect.deleteProperty(fixture.tui, "overlayStack");
			},
		],
		[
			"hardware cursor row",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.tui, "hardwareCursorRow"),
		],
		[
			"viewport top",
			(fixture: ReturnType<typeof makeValidPiFixture>) =>
				Reflect.deleteProperty(fixture.tui, "previousViewportTop"),
		],
	] as const)("rejects a missing %s capability without side effects", (_name, removeCapability) => {
		const fixture = makeValidPiFixture();
		removeCapability(fixture);
		const render = fixture.tui.render;
		const doRender = fixture.tui.doRender;
		const write = fixture.terminal.write;

		expect(inspectPiTui(fixture.tui)).toBeUndefined();
		expect(fixture.terminalWrite).not.toHaveBeenCalled();
		expect(fixture.addInputListener).not.toHaveBeenCalled();
		expect(fixture.tui.render).toBe(render);
		expect(fixture.tui.doRender).toBe(doRender);
		expect(fixture.terminal.write).toBe(write);
	});

	it("fails closed when a private Pi getter or proxy trap throws", () => {
		const fixture = makeValidPiFixture();
		const throwingTui = new Proxy(fixture.tui, {
			get(target, property, receiver) {
				if (property === "children") throw new Error("private shape changed");
				return Reflect.get(target, property, receiver);
			},
		});

		expect(() => inspectPiTui(throwingTui)).not.toThrow();
		expect(inspectPiTui(throwingTui)).toBeUndefined();
		expect(fixture.terminalWrite).not.toHaveBeenCalled();
		expect(fixture.addInputListener).not.toHaveBeenCalled();
	});

	it("rejects non-configurable rows and non-writable render methods before writes", () => {
		const rowsFixture = makeValidPiFixture();
		const rowsDescriptor = Object.getOwnPropertyDescriptor(rowsFixture.terminal, "rows");
		Object.defineProperty(rowsFixture.terminal, "rows", { ...rowsDescriptor, configurable: false });
		expect(inspectPiTui(rowsFixture.tui)).toBeUndefined();
		expect(rowsFixture.terminalWrite).not.toHaveBeenCalled();

		const renderFixture = makeValidPiFixture();
		Object.defineProperty(renderFixture.tui, "render", {
			value: renderFixture.tui.render,
			configurable: true,
			writable: false,
		});
		expect(inspectPiTui(renderFixture.tui)).toBeUndefined();
		expect(renderFixture.terminalWrite).not.toHaveBeenCalled();

		const doRenderFixture = makeValidPiFixture();
		Object.defineProperty(doRenderFixture.tui, "doRender", {
			value: doRenderFixture.tui.doRender,
			configurable: true,
			writable: false,
		});
		expect(inspectPiTui(doRenderFixture.tui)).toBeUndefined();
		expect(doRenderFixture.terminalWrite).not.toHaveBeenCalled();

		const writeFixture = makeValidPiFixture();
		Object.defineProperty(writeFixture.terminal, "write", {
			value: writeFixture.terminal.write,
			configurable: true,
			writable: false,
		});
		expect(inspectPiTui(writeFixture.tui)).toBeUndefined();
		expect(writeFixture.terminalWrite).not.toHaveBeenCalled();

		const frozenFixture = makeValidPiFixture();
		Object.freeze(frozenFixture.tui.children[0]);
		expect(inspectPiTui(frozenFixture.tui)).toBeUndefined();
		expect(frozenFixture.terminalWrite).not.toHaveBeenCalled();
	});

	it("installs from verified capabilities and restores exact identities and descriptors", () => {
		const fixture = makeValidPiFixture();
		const capabilities = inspectPiTui(fixture.tui);
		expect(capabilities).toBeDefined();
		if (!capabilities) return;
		const render = fixture.tui.render;
		const doRender = fixture.tui.doRender;
		const write = fixture.terminal.write;
		const rowsDescriptor = Object.getOwnPropertyDescriptor(fixture.terminal, "rows");
		const clusterDescriptors = fixture.cluster.map((component) =>
			Object.getOwnPropertyDescriptor(component, "render"),
		);
		const compositor = new TerminalSplitCompositor(capabilities, () => ({
			enabled: true,
			mouseScroll: true,
			copyNotice: true,
			copyOnSelect: true,
			hardwareCursor: false,
			editorClickCursor: true,
			editorPaddingY: 1,
			editorTextColumn: 2,
		}));

		expect(compositor.install()).toBe(true);
		expect(fixture.tui.render).not.toBe(render);
		expect(fixture.tui.doRender).not.toBe(doRender);
		expect(fixture.terminal.write).not.toBe(write);
		expect(fixture.cluster.every((component) => component.render(80).length === 0)).toBe(true);
		expect(fixture.addInputListener).toHaveBeenCalledTimes(1);
		expect(fixture.terminalWrite).toHaveBeenCalledTimes(1);

		compositor.dispose();
		compositor.dispose();

		expect(fixture.tui.render).toBe(render);
		expect(fixture.tui.doRender).toBe(doRender);
		expect(fixture.terminal.write).toBe(write);
		expect(Object.getOwnPropertyDescriptor(fixture.terminal, "rows")).toEqual(rowsDescriptor);
		expect(
			fixture.cluster.map((component) => Object.getOwnPropertyDescriptor(component, "render")),
		).toEqual(clusterDescriptors);
		expect(fixture.inputListenerDisposer).toHaveBeenCalledTimes(1);
		expect(fixture.removeInputListener).not.toHaveBeenCalled();
		expect(fixture.getInputListener()).toBeUndefined();
		expect(fixture.terminalWrite).toHaveBeenCalledTimes(2);
	});

	it("rolls back patches when listener registration does not return cleanup", () => {
		const fixture = makeValidPiFixture();
		Reflect.set(
			fixture.tui,
			"addInputListener",
			vi.fn((listener: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				fixture.addInputListener(listener);
				return undefined;
			}),
		);
		const capabilities = inspectPiTui(fixture.tui);
		expect(capabilities).toBeDefined();
		if (!capabilities) return;
		const render = fixture.tui.render;
		const write = fixture.terminal.write;
		const compositor = new TerminalSplitCompositor(capabilities, () => ({
			enabled: true,
			mouseScroll: false,
			copyNotice: true,
			copyOnSelect: true,
			hardwareCursor: false,
			editorClickCursor: true,
			editorPaddingY: 1,
			editorTextColumn: 2,
		}));

		expect(compositor.install()).toBe(false);
		expect(fixture.tui.render).toBe(render);
		expect(fixture.terminal.write).toBe(write);
		expect(fixture.cluster.every((component) => component.render(80).length > 0)).toBe(true);
		expect(fixture.removeInputListener).toHaveBeenCalledTimes(1);
		expect(fixture.getInputListener()).toBeUndefined();
		expect(fixture.terminalWrite).not.toHaveBeenCalled();
	});

	it("keeps overlays visible and responds to rows, cursor, and wheel input", () => {
		const fixture = makeValidPiFixture();
		const capabilities = inspectPiTui(fixture.tui);
		if (!capabilities) throw new Error("expected valid fixture");
		const compositor = new TerminalSplitCompositor(capabilities, () => ({
			enabled: true,
			mouseScroll: true,
			copyNotice: true,
			copyOnSelect: true,
			hardwareCursor: false,
			editorClickCursor: true,
			editorPaddingY: 1,
			editorTextColumn: 2,
		}));
		expect(compositor.install()).toBe(true);
		const patchedRender = fixture.tui.render;
		const narrowRows = fixture.terminal.rows;
		fixture.setRows(40);
		expect(fixture.terminal.rows).toBeGreaterThan(narrowRows);

		fixture.tui.overlayStack = [{}];
		expect(patchedRender(80)).toEqual(fixture.rootRender(80));
		fixture.tui.overlayStack = [];
		fixture.setRows(12);
		patchedRender(80);
		fixture.terminal.write("update");
		expect(fixture.terminalWrite.mock.calls.at(-1)?.[0]).toContain("\u001b[4;1H");
		fixture.requestRender.mockClear();
		fixture.getInputListener()?.("\u001b[<64;1;1M");
		expect(fixture.requestRender).toHaveBeenCalled();
		compositor.dispose();
	});

	// Pi's own output passes through the compositor's write untouched and can
	// contain a hide-cursor sequence the compositor never observes, so tracking
	// visibility is not enough: editorCursor "terminal" removes the software
	// cursor, and without asserting the real one the editor showed no cursor at all.
	it("asserts the hardware cursor every frame in terminal cursor mode", () => {
		const fixture = makeValidPiFixture();
		fixture.cluster[2].render = () => [`editor${CURSOR_MARKER}`];
		const capabilities = inspectPiTui(fixture.tui);
		if (!capabilities) throw new Error("expected valid fixture");
		const compositor = new TerminalSplitCompositor(capabilities, () => ({
			enabled: true,
			mouseScroll: true,
			copyNotice: true,
			copyOnSelect: true,
			hardwareCursor: true,
			editorClickCursor: true,
			editorPaddingY: 1,
			editorTextColumn: 2,
		}));
		expect(compositor.install()).toBe(true);

		fixture.terminal.write("update");
		expect(fixture.terminalWrite.mock.calls.at(-1)?.[0]).toContain(SHOW_CURSOR);
		// Still asserted on the next frame, not just the first.
		fixture.terminal.write("update");
		expect(fixture.terminalWrite.mock.calls.at(-1)?.[0]).toContain(SHOW_CURSOR);

		compositor.dispose();
	});

	it("leaves cursor visibility alone in the software cursor modes", () => {
		const fixture = makeValidPiFixture();
		fixture.cluster[2].render = () => [`editor${CURSOR_MARKER}`];
		const capabilities = inspectPiTui(fixture.tui);
		if (!capabilities) throw new Error("expected valid fixture");
		const compositor = new TerminalSplitCompositor(capabilities, () => ({
			enabled: true,
			mouseScroll: true,
			copyNotice: true,
			copyOnSelect: true,
			hardwareCursor: false,
			editorClickCursor: true,
			editorPaddingY: 1,
			editorTextColumn: 2,
		}));
		expect(compositor.install()).toBe(true);

		fixture.terminal.write("update");
		expect(fixture.terminalWrite.mock.calls.at(-1)?.[0]).not.toContain(SHOW_CURSOR);

		compositor.dispose();
	});

	/**
	 * Pi's root render ends with blank rows of its own. Treating them as content
	 * pins a short transcript to the top of the region and leaves the gap sitting
	 * between it and the editor, which is what this used to look like.
	 */
	describe("anchoring a short transcript", () => {
		function visibleRegion(rootLines: string[]): string[] {
			const fixture = makeValidPiFixture();
			fixture.rootRender.mockImplementation(() => rootLines);
			const capabilities = inspectPiTui(fixture.tui);
			if (!capabilities) throw new Error("expected valid fixture");
			const compositor = new TerminalSplitCompositor(capabilities, () => ({
				enabled: true,
				mouseScroll: true,
				copyNotice: true,
				copyOnSelect: true,
				hardwareCursor: false,
				editorClickCursor: true,
				editorPaddingY: 1,
				editorTextColumn: 2,
			}));
			expect(compositor.install()).toBe(true);
			const rendered = (fixture.tui.render as (width: number) => string[])(80);
			compositor.dispose();
			return rendered;
		}

		it("puts the content against the editor, not at the top", () => {
			const region = visibleRegion(["only line"]);
			expect(region.at(-1)).toContain("only line");
			expect(region.slice(0, -1).every((line) => line.trim() === "")).toBe(true);
		});

		it("ignores the blank rows Pi appends", () => {
			const region = visibleRegion(["only line", "", "", ""]);
			expect(region.at(-1)).toContain("only line");
			expect(region.filter((line) => line.includes("only line"))).toHaveLength(1);
		});

		// Pi pads its rows out to the terminal width, so the rows after the last
		// message are runs of spaces rather than empty strings. Measuring by
		// visible width counts those as content and the gap comes back.
		it("ignores space-padded rows too", () => {
			const region = visibleRegion(["only line", " ".repeat(80), " ".repeat(80)]);
			expect(region.at(-1)).toContain("only line");
		});

		it("ignores rows that are only styling", () => {
			const region = visibleRegion(["only line", `\x1b[38;2;1;2;3m${" ".repeat(40)}\x1b[0m`]);
			expect(region.at(-1)).toContain("only line");
		});

		it("still shows the newest lines when the transcript overflows", () => {
			const many = Array.from({ length: 60 }, (_, index) => `line-${index}`);
			const region = visibleRegion(many);
			expect(region.at(-1)).toContain("line-59");
			expect(region.every((line) => line.trim() !== "")).toBe(true);
		});
	});

	it("clears the right-click mouse-resume timer on disposal", () => {
		vi.useFakeTimers();
		try {
			const fixture = makeValidPiFixture();
			const capabilities = inspectPiTui(fixture.tui);
			if (!capabilities) throw new Error("expected valid fixture");
			const compositor = new TerminalSplitCompositor(capabilities, () => ({
				enabled: true,
				mouseScroll: true,
				copyNotice: true,
				copyOnSelect: true,
				hardwareCursor: false,
				editorClickCursor: true,
				editorPaddingY: 1,
				editorTextColumn: 2,
			}));
			expect(compositor.install()).toBe(true);
			fixture.getInputListener()?.("\u001b[<2;1;1M");
			expect(fixture.terminalWrite.mock.calls.at(-1)?.[0]).toContain(DISABLE_MOUSE);

			compositor.dispose();
			const writesAfterDispose = fixture.terminalWrite.mock.calls.length;
			vi.advanceTimersByTime(1_200);
			expect(fixture.terminalWrite).toHaveBeenCalledTimes(writesAfterDispose);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("input", () => {
	describe("parseMouseScroll", () => {
		it("parses SGR wheel up", () => {
			expect(parseMouseScroll("\x1b[<64;10;5M")).toEqual({ direction: "up", amount: 3 });
		});

		it("parses SGR wheel down", () => {
			expect(parseMouseScroll("\x1b[<65;10;5M")).toEqual({ direction: "down", amount: 3 });
		});

		it("parses wheel with modifiers (shift bit)", () => {
			// 64 | 4 = 68 (wheel up with shift)
			expect(parseMouseScroll("\x1b[<68;10;5M")).toEqual({ direction: "up", amount: 3 });
		});

		it("returns undefined for non-mouse input", () => {
			expect(parseMouseScroll("\x1b[A")).toBeUndefined();
		});

		it("returns undefined for non-wheel mouse (button 0)", () => {
			expect(parseMouseScroll("\x1b[<0;10;5M")).toBeUndefined();
		});
	});

	describe("parseKeyboardScroll", () => {
		it("parses PgUp", () => {
			expect(parseKeyboardScroll("\x1b[5~")).toEqual({ action: "pageUp" });
		});

		it("parses PgDn", () => {
			expect(parseKeyboardScroll("\x1b[6~")).toEqual({ action: "pageDown" });
		});

		it("parses Enter as jumpBottom", () => {
			expect(parseKeyboardScroll("\r")).toEqual({ action: "jumpBottom" });
		});

		it("parses Ctrl+Shift+Up", () => {
			expect(parseKeyboardScroll("\x1b[1;6A")).toEqual({ action: "pageUp" });
		});

		it("parses Ctrl+Shift+Down", () => {
			expect(parseKeyboardScroll("\x1b[1;6B")).toEqual({ action: "pageDown" });
		});

		it("returns undefined for regular keys", () => {
			expect(parseKeyboardScroll("a")).toBeUndefined();
		});

		it("returns undefined for key release", () => {
			expect(parseKeyboardScroll("\x1b[5;2~")).toBeUndefined();
		});
	});

	describe("parseMouseEvent", () => {
		it("parses left button press", () => {
			const ev = parseMouseEvent("\x1b[<0;5;3M");
			expect(ev).toEqual({ button: "left", action: "press", col: 5, row: 3 });
		});

		it("parses left button drag (motion bit set)", () => {
			const ev = parseMouseEvent("\x1b[<32;10;5M");
			expect(ev).toEqual({ button: "left", action: "drag", col: 10, row: 5 });
		});

		it("parses left button release (lowercase m)", () => {
			const ev = parseMouseEvent("\x1b[<0;10;5m");
			expect(ev).toEqual({ button: "left", action: "release", col: 10, row: 5 });
		});

		it("parses right button press", () => {
			const ev = parseMouseEvent("\x1b[<2;7;4M");
			expect(ev).toEqual({ button: "right", action: "press", col: 7, row: 4 });
		});

		it("parses wheel up", () => {
			const ev = parseMouseEvent("\x1b[<64;1;1M");
			expect(ev).toEqual({ button: "wheel-up", action: "press", col: 1, row: 1 });
		});

		it("parses wheel down", () => {
			const ev = parseMouseEvent("\x1b[<65;1;1M");
			expect(ev).toEqual({ button: "wheel-down", action: "press", col: 1, row: 1 });
		});

		it("returns undefined for non-mouse input", () => {
			expect(parseMouseEvent("\x1b[A")).toBeUndefined();
		});
	});

	describe("clampScrollOffset", () => {
		it("clamps within range", () => {
			expect(clampScrollOffset(5, 10)).toBe(5);
		});

		it("clamps negative to 0", () => {
			expect(clampScrollOffset(-3, 10)).toBe(0);
		});

		it("clamps above max", () => {
			expect(clampScrollOffset(15, 10)).toBe(10);
		});

		it("handles maxOffset of 0", () => {
			expect(clampScrollOffset(5, 0)).toBe(0);
		});
	});
});

describe("terminal-modes", () => {
	describe("emergencyTerminalReset", () => {
		it("contains all reset sequences", () => {
			const reset = emergencyTerminalReset();
			expect(reset).toContain(EXIT_ALT_SCREEN);
			expect(reset).toContain(DISABLE_MOUSE);
			expect(reset).toContain(RESET_SCROLL_REGION);
			expect(reset).toContain(ENABLE_ALT_SCROLL);
			expect(reset).toContain(SHOW_CURSOR);
		});
	});
});

describe("cluster", () => {
	function makeComponent(lines: string[] = ["line"]) {
		return { render: () => lines, invalidate: () => {} };
	}

	function makeContainer(children: unknown[]) {
		return { render: () => [], invalidate: () => {}, children };
	}

	function makeCapability(lines: string[]): PiRenderableCapability {
		const target = makeComponent(lines);
		return {
			target,
			render: target.render,
			ownDescriptor: Object.getOwnPropertyDescriptor(target, "render"),
		};
	}

	function makeEditor() {
		return {
			render: () => ["editor"],
			invalidate: () => {},
			getText: () => "",
			setText: () => {},
			handleInput: () => {},
		};
	}

	describe("findEditorContainerIndex", () => {
		it("finds the container with an editor-like child", () => {
			const children = [makeComponent(), makeContainer([makeEditor()]), makeComponent()];
			expect(findEditorContainerIndex(children)).toBe(1);
		});

		it("returns undefined when no editor found", () => {
			const children = [makeComponent(), makeComponent()];
			expect(findEditorContainerIndex(children)).toBeUndefined();
		});

		it("prefers focused component's parent", () => {
			const editor = makeEditor();
			const containerA = makeContainer([editor]);
			const containerB = makeContainer([makeEditor()]);
			const children = [containerA, containerB];
			expect(findEditorContainerIndex(children, editor)).toBe(0);
		});
	});

	describe("capEditorLines", () => {
		it("keeps last N lines when no cursor marker", () => {
			const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
			const result = capEditorLines(lines, 5);
			expect(result).toHaveLength(5);
			expect(result[0]).toBe("line 5");
		});

		it("centers window on cursor row", () => {
			const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
			lines[15] = `line 15${CURSOR_MARKER}`;
			const result = capEditorLines(lines, 5);
			expect(result).toHaveLength(5);
			expect(result[4]).toContain("line 15");
		});

		it("returns all lines when under max", () => {
			const lines = ["a", "b", "c"];
			expect(capEditorLines(lines, 5)).toBe(lines);
		});
	});

	describe("renderCluster", () => {
		it("renders and concatenates all cluster components", () => {
			const cluster = {
				status: makeCapability(["status"]),
				aboveWidget: makeCapability(["above"]),
				editor: makeCapability(["editor-line"]),
				belowWidget: makeCapability(["below"]),
				footer: makeCapability(["footer"]),
			};
			const result = renderCluster(cluster, 80, 24);
			expect(result.lines).toEqual(["status", "above", "editor-line", "below", "footer"]);
		});

		it("extracts cursor position", () => {
			const cluster = {
				status: null,
				aboveWidget: null,
				editor: makeCapability([`hello${CURSOR_MARKER}world`]),
				belowWidget: null,
				footer: null,
			};
			const result = renderCluster(cluster, 80, 24);
			expect(result.cursor).toEqual({ row: 0, col: 5 });
			expect(result.lines[0]).toBe("helloworld");
		});

		it("caps editor lines when total exceeds maxHeight", () => {
			const manyLines = Array.from({ length: 30 }, (_, i) => `ed-${i}`);
			const cluster = {
				status: null,
				aboveWidget: null,
				editor: makeCapability(manyLines),
				belowWidget: null,
				footer: null,
			};
			// maxHeight = 10, maxRows = 9, so editor gets max 9 lines
			const result = renderCluster(cluster, 80, 10);
			expect(result.lines.length).toBeLessThanOrEqual(9);
		});

		it("preserves internal blank lines (copy-friendly editor padding)", () => {
			// In copy-friendly mode the editor renders truly empty strings as
			// padding: [border, "", text, "", meta, border]. These must survive.
			const editorFrame = ["border", "", "input text", "", "model provider", "border"];
			const cluster = {
				status: null,
				aboveWidget: null,
				editor: makeCapability(editorFrame),
				belowWidget: null,
				footer: null,
			};
			const result = renderCluster(cluster, 80, 24);
			expect(result.lines).toEqual(editorFrame);
		});

		it("strips trailing blank lines from components", () => {
			const cluster = {
				status: makeCapability(["status", "", ""]),
				aboveWidget: null,
				editor: makeCapability(["editor"]),
				belowWidget: null,
				footer: makeCapability(["footer", ""]),
			};
			const result = renderCluster(cluster, 80, 24);
			// Trailing blanks stripped, but content preserved
			expect(result.lines).toEqual(["status", "editor", "footer"]);
		});

		it("drops a component that renders nothing but blanks", () => {
			// Captured from a real Pi 0.82.1 frame: while the working spinner is up,
			// the above-editor widget container renders a single empty line. Keeping
			// it leaves a blank row between "Working..." and the editor border.
			const cluster = {
				status: makeCapability(["", " ⠋ Working...".padEnd(80, " ")]),
				aboveWidget: makeCapability([""]),
				editor: makeCapability(["─".repeat(80), "│ input", "│", "─".repeat(80)]),
				belowWidget: null,
				footer: makeCapability([" footer "]),
			};
			const result = renderCluster(cluster, 80, 24);
			expect(result.lines).toEqual([
				" ⠋ Working...".padEnd(80, " "),
				"─".repeat(80),
				"│ input",
				"│",
				"─".repeat(80),
				" footer ",
			]);
		});

		it("treats space-padded rows as blank when trimming a component", () => {
			// Pi pads its lines out to the full terminal width, so a "blank" row is
			// whitespace, not zero-width.
			const cluster = {
				status: makeCapability(["status"]),
				aboveWidget: makeCapability([" ".repeat(80), `\x1b[39m${" ".repeat(80)}`]),
				editor: makeCapability(["editor"]),
				belowWidget: null,
				footer: makeCapability(["footer", " ".repeat(80)]),
			};
			const result = renderCluster(cluster, 80, 24);
			expect(result.lines).toEqual(["status", "editor", "footer"]);
		});
	});
});

describe("selection", () => {
	describe("SelectionState", () => {
		it("starts and tracks selection", () => {
			const sel = new SelectionState();
			expect(sel.active).toBe(false);
			sel.start(5, 3);
			expect(sel.active).toBe(true);
			sel.extend(7, 10);
			expect(sel.active).toBe(true);
		});

		it("clears selection", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.clear();
			expect(sel.active).toBe(false);
		});

		it("getRangeForLine returns correct range", () => {
			const sel = new SelectionState();
			sel.start(2, 3);
			sel.extend(5, 8);
			// Line 1 is before selection
			expect(sel.getRangeForLine(1)).toBeNull();
			// Line 2 is start: cols 3..inf
			const r2 = sel.getRangeForLine(2);
			expect(r2?.startCol).toBe(3);
			expect(r2?.endCol).toBe(Number.POSITIVE_INFINITY);
			// Line 3 is middle: cols 0..inf
			const r3 = sel.getRangeForLine(3);
			expect(r3?.startCol).toBe(0);
			expect(r3?.endCol).toBe(Number.POSITIVE_INFINITY);
			// Line 5 is the end: through the cell at col 8, so exclusive end 9
			const r5 = sel.getRangeForLine(5);
			expect(r5?.startCol).toBe(0);
			expect(r5?.endCol).toBe(9);
			// Line 6 is after selection
			expect(sel.getRangeForLine(6)).toBeNull();
		});

		it("getSelectedText extracts text from lines", () => {
			const sel = new SelectionState();
			const lines = ["hello world", "foo bar baz", "qux"];
			sel.start(0, 2);
			sel.extend(1, 7);
			expect(sel.getSelectedText(lines)).toBe("llo world\nfoo bar");
		});

		// Anchor and focus are cells, not boundaries, so a selection that never
		// left its starting cell still covers that cell. A press that turns out to
		// be a click is the controller's business, not this class's.
		it("getSelectedText covers the single cell under the pointer", () => {
			const sel = new SelectionState();
			sel.start(0, 3);
			sel.extend(0, 3);
			expect(sel.getSelectedText(["hello"])).toBe("l");
		});

		it("getSelectedText strips ANSI codes", () => {
			const sel = new SelectionState();
			const lines = ["\x1b[32mhello\x1b[0m world"];
			sel.start(0, 0);
			sel.extend(0, 8);
			expect(sel.getSelectedText(lines)).toBe("hello wor");
		});

		it("handles reverse selection (drag upward)", () => {
			const sel = new SelectionState();
			const lines = ["line0", "line1", "line2"];
			sel.start(2, 3);
			sel.extend(0, 2);
			// Normalized to start=(0,2), end=(2,3) inclusive — both the cell the drag
			// started on and the cell it ended on are in.
			expect(sel.getSelectedText(lines)).toBe("ne0\nline1\nline");
		});
	});

	describe("wordRangeAt", () => {
		it("covers the word under the column", () => {
			expect(wordRangeAt("hello world", 2)).toEqual({ startCol: 0, endCol: 4 });
			expect(wordRangeAt("hello world", 8)).toEqual({ startCol: 6, endCol: 10 });
		});

		// The point of double click in a transcript is grabbing a path in one go.
		it("keeps a path or filename whole", () => {
			expect(wordRangeAt("see src/foo.ts:12 now", 10)).toEqual({ startCol: 4, endCol: 13 });
		});

		it("selects a run of whitespace as one", () => {
			expect(wordRangeAt("a   b", 2)).toEqual({ startCol: 1, endCol: 3 });
		});

		it("selects a lone punctuation cell by itself", () => {
			expect(wordRangeAt("(x)", 0)).toEqual({ startCol: 0, endCol: 0 });
		});

		it("stops at the left margin and off the end", () => {
			expect(wordRangeAt("│ hello", 3, 2)).toEqual({ startCol: 2, endCol: 6 });
			expect(wordRangeAt("hi", 5)).toBeNull();
			expect(wordRangeAt("│ hi", 0, 2)).toBeNull();
		});
	});

	describe("lineRangeAt", () => {
		it("covers the line without its trailing padding", () => {
			expect(lineRangeAt("hello   ")).toEqual({ startCol: 0, endCol: 4 });
		});

		it("starts at the left margin", () => {
			expect(lineRangeAt("│ hello  ", 2)).toEqual({ startCol: 2, endCol: 6 });
		});

		it("returns nothing for a blank line", () => {
			expect(lineRangeAt("     ")).toBeNull();
			expect(lineRangeAt("│    ", 2)).toBeNull();
		});
	});

	describe("highlightSelection", () => {
		it("applies inverse video to selected region", () => {
			const sel = new SelectionState();
			sel.start(0, 2);
			sel.extend(0, 5);
			const result = highlightSelection("hello world", 0, sel);
			expect(result).toContain("\x1b[48;5;240m");
			expect(result).toContain("\x1b[49m");
			expect(result).toBe("he\x1b[48;5;240mllo \x1b[49mworld");
		});

		it("does not modify non-selected lines", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 3);
			const result = highlightSelection("hello", 5, sel);
			expect(result).toBe("hello");
		});

		it("highlights full line for middle lines", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(2, 5);
			// Line 1 is a middle line — full highlight
			const result = highlightSelection("middle line", 1, sel);
			expect(result).toBe("\x1b[48;5;240mmiddle line\x1b[49m");
		});

		it("preserves ANSI colors in selected region", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 5);
			const result = highlightSelection("\x1b[32mhello\x1b[0m world", 0, sel);
			expect(result).toContain("\x1b[32m"); // green preserved
			expect(result).toContain("\x1b[48;5;240m"); // inverse added
			expect(result).toContain("\x1b[49m"); // inverse off
			expect(result).toContain("\x1b[0m"); // original reset preserved
			expect(result).toContain("hello");
			expect(result).toContain("world");
		});

		it("preserves ANSI colors outside selected region", () => {
			const sel = new SelectionState();
			sel.start(0, 6);
			sel.extend(0, 11);
			const result = highlightSelection("\x1b[32mhello\x1b[0m world", 0, sel);
			expect(result).toContain("\x1b[32mhello\x1b[0m"); // before selection unchanged
			expect(result).toContain("\x1b[48;5;240m"); // inverse on selected part
		});

		it("handles multiple SGR codes within selection", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 11);
			const input = "\x1b[1m\x1b[31mhello\x1b[0m world";
			const result = highlightSelection(input, 0, sel);
			expect(result).toContain("\x1b[1m"); // bold preserved
			expect(result).toContain("\x1b[31m"); // red preserved
			expect(result).toContain("\x1b[48;5;240m"); // inverse added
			expect(result).toContain("\x1b[49m"); // inverse off
		});

		// A reset inside the run wipes the tint for everything after it, which is
		// how a whole selected editor row ended up showing only its first cell.
		it("re-asserts the tint after a reset inside the selection", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 12);
			const result = highlightSelection("ab\x1b[0mcd\x1b[0mef world", 0, sel);
			expect(result).toBe(
				"\x1b[48;5;240mab\x1b[0m\x1b[48;5;240mcd\x1b[0m\x1b[48;5;240mef world\x1b[49m",
			);
		});

		it("does not re-assert the tint outside the selection", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 1);
			const result = highlightSelection("ab\x1b[0mcd", 0, sel);
			expect(result).toBe("\x1b[48;5;240mab\x1b[49m\x1b[0mcd");
		});

		// Real shape of a Pi editor row: coloured rail, two resets, then the text.
		it("tints an editor row's text but never its rail", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(2, 4);
			const row = "\x1b[38;2;203;166;247m│\x1b[0m\x1b[0m AAAA BBBB";
			const result = highlightSelection(row, 1, sel, 2);

			// The rail and the space after it stay untinted...
			expect(result.indexOf("\x1b[48;5;240m")).toBeGreaterThan(result.indexOf("│"));
			expect(result).toContain("\x1b[38;2;203;166;247m│\x1b[0m\x1b[0m ");
			// ...and the text after the resets is tinted all the way.
			expect(result).toContain("\x1b[48;5;240mAAAA BBBB");
			expect(result.endsWith("\x1b[49m")).toBe(true);
		});
	});

	describe("getSelectedText edge cases", () => {
		it("extracts URL from OSC 8 hyperlink", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 100);
			const line = "\x1b]8;;https://pi.dev/changelog\x1b\\Changelog:\x1b]8;;\x1b\\";
			const result = sel.getSelectedText([line]);
			expect(result).toContain("https://pi.dev/changelog");
			expect(result).toContain("Changelog:");
		});

		it("handles OSC 8 with BEL terminator", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 100);
			const line = "\x1b]8;;https://example.com\x07Click here\x1b]8;;\x07";
			const result = sel.getSelectedText([line]);
			expect(result).toContain("https://example.com");
		});

		it("handles OSC 8 with id parameter", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 100);
			const line = "\x1b]8;;id=42;https://example.com\x1b\\link\x1b]8;;\x1b\\";
			const result = sel.getSelectedText([line]);
			expect(result).toContain("https://example.com");
			expect(result).not.toContain("id=42");
		});

		it("does not duplicate URL when visible text is the URL", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 100);
			const line = "\x1b]8;;https://example.com\x1b\\https://example.com\x1b]8;;\x1b\\";
			const result = sel.getSelectedText([line]);
			expect(result).toBe("https://example.com");
		});

		it("handles OSC 8 with empty params (no URL)", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 100);
			const line = "\x1b]8;;\x1b\\plain text\x1b]8;;\x1b\\";
			const result = sel.getSelectedText([line]);
			expect(result).toBe("plain text");
		});

		it("handles multiple OSC 8 links on one line", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 100);
			const line =
				"\x1b]8;;https://a.com\x1b\\A\x1b]8;;\x1b\\ and \x1b]8;;https://b.com\x1b\\B\x1b]8;;\x1b\\";
			const result = sel.getSelectedText([line]);
			expect(result).toContain("https://a.com");
			expect(result).toContain("https://b.com");
		});

		it("preserves ANSI colors inside OSC 8 text", () => {
			const sel = new SelectionState();
			sel.start(0, 0);
			sel.extend(0, 100);
			const line = "\x1b]8;;https://example.com\x1b\\\x1b[32mClick\x1b[0m\x1b]8;;\x1b\\";
			const result = sel.getSelectedText([line]);
			expect(result).toContain("Click");
			expect(result).toContain("https://example.com");
			expect(result).not.toContain("\x1b[32m");
		});
	});
});
