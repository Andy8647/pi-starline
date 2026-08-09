/**
 * Wheel notches over the input box, against Pi's real layout engine.
 *
 * The layout is built the way `interactive-mode.js` builds it — a scroll view
 * over a dock `VStack`, with the editor inside a `Container` inside that dock —
 * and run through pi-tui's own `renderLayoutFrame`. That matters: the plan for
 * this task assumed the editor is a direct child of a stack and therefore has
 * its own `LayoutBox`. It is not, and it does not. `Container` carries no
 * `LAYOUT_NODE`, so the box the layout produces belongs to the *container*,
 * with `children: []` — the same finding `test/contract/transcript-layout.test.ts`
 * pinned for the transcript. These tests pin it for the editor, and pin the
 * resolution that works instead: the box whose component is the container the
 * live editor is mounted in, found by identity through `Container.children`.
 */

import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { afterEach, describe, expect, it } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import {
	editorBoxFor,
	setActiveEditor,
	wheelTarget,
} from "../../extensions/starline/mouse/editor-mouse";
import { type BoxLike, boxFor } from "../../extensions/starline/mouse/hit-test";
import { installMouse } from "../../extensions/starline/mouse/index";

const WIDTH = 40;
const HEIGHT = 12;
/** `editorVisibleLines(TERMINAL_ROWS)` — Pi's own `max(5, rows * 0.3)`. */
const TERMINAL_ROWS = 12;
const VISIBLE = 5;

/**
 * Enough of Pi's `Editor` to be both laid out and scrolled: it renders a window
 * of its own lines, and exposes the `state`/`buildVisualLineMap` surface
 * `editor-scroll.ts` reads. One logical line per visual line keeps the map
 * trivial — wrapping is Pi's concern and is covered in `editor-scroll.test.ts`.
 */
class FakeEditor {
	readonly state: { lines: string[]; cursorLine: number; cursorCol: number };
	scrollOffset = 0;
	lastWidth = WIDTH;
	preferredVisualCol: number | null = 3;
	snappedFromCursorCol: number | null = 7;

	constructor(lines: string[]) {
		this.state = { lines, cursorLine: 0, cursorCol: 0 };
	}

	buildVisualLineMap(_width: number) {
		return this.state.lines.map((line, index) => ({
			logicalLine: index,
			startCol: 0,
			length: line.length,
		}));
	}

	render(_width: number): string[] {
		const window = this.state.lines.slice(this.scrollOffset, this.scrollOffset + VISIBLE);
		while (window.length < VISIBLE) window.push("");
		return window;
	}

	invalidate(): void {}
}

function draft(count: number): string[] {
	return Array.from({ length: count }, (_value, index) => `draft ${index}`);
}

/** The dock shape `interactive-mode.js` builds, reduced to the editor slot. */
function renderFrame(container: Container) {
	const transcript = new Text(draft(40).join("\n"), 0, 0);
	const scroll = new ScrollView(transcript, { primary: true });
	const dock = new VStack([{ component: container, shrink: 1, minSize: 3 }]);
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	return renderLayoutFrame(root, WIDTH, HEIGHT, () => {}) as { root: BoxLike };
}

function mount(editor: FakeEditor) {
	const container = new Container();
	container.addChild(editor as unknown as Parameters<Container["addChild"]>[0]);
	return { container, frame: renderFrame(container) };
}

describe("the editor's place in Pi's real layout", () => {
	it("gives the editor no box of its own", () => {
		const editor = new FakeEditor(draft(20));
		const { frame } = mount(editor);

		// The premise this task was handed, falsified against the real engine.
		expect(boxFor(frame.root, editor)).toBeUndefined();
	});

	it("gives the container the editor is mounted in a box with the editor's rect", () => {
		const editor = new FakeEditor(draft(20));
		const { container, frame } = mount(editor);
		const box = editorBoxFor(frame.root, editor);

		expect(box?.component).toBe(container);
		expect(box?.children).toEqual([]);
		expect(box?.rect).toEqual({ x: 0, y: HEIGHT - VISIBLE, width: WIDTH, height: VISIBLE });
	});

	it("finds nothing once the editor is unmounted from its container", () => {
		const editor = new FakeEditor(draft(20));
		const { container, frame } = mount(editor);
		container.clear();

		expect(editorBoxFor(frame.root, editor)).toBeUndefined();
	});
});

describe("wheelTarget", () => {
	it("routes to the editor when the pointer is over it", () => {
		const editor = new FakeEditor(draft(20));
		const { frame } = mount(editor);

		expect(wheelTarget(frame.root, editor, 10, HEIGHT - 1)).toBe("editor");
	});

	it("routes to the transcript otherwise", () => {
		const editor = new FakeEditor(draft(20));
		const { frame } = mount(editor);

		expect(wheelTarget(frame.root, editor, 10, 0)).toBe("transcript");
	});

	it("routes to the transcript when the editor is not mounted", () => {
		const editor = new FakeEditor(draft(20));
		const { frame } = mount(editor);

		expect(wheelTarget(frame.root, new FakeEditor(draft(3)), 10, HEIGHT - 1)).toBe("transcript");
	});

	it("routes to the transcript when there is no layout yet", () => {
		const editor = new FakeEditor(draft(20));

		expect(wheelTarget(undefined, editor, 10, HEIGHT - 1)).toBe("transcript");
	});
});

type WheelEvent = { direction: number; x: number; y: number };

type FakeAltScreen = {
	currentLayout?: { root: BoxLike };
	terminal: { rows: number };
	wheelScrollLines: number;
	overlay: boolean;
	routeWheel(event: WheelEvent): void;
	hasOverlay(): boolean;
	requestRender(): void;
	handleViewportInput(): void;
	handleSelectionMouseEvent(): void;
	copySelectionToClipboard(): void;
	getWordSelection(): void;
	getSelectionSourceLine(): string;
	getSelectionBounds(): undefined;
	getSelectionColumns(): { start: number; end: number };
	flash(): void;
};

function makePrototype(): { prototype: FakeAltScreen; routed: WheelEvent[]; renders: number[] } {
	const routed: WheelEvent[] = [];
	const renders: number[] = [];
	const prototype: FakeAltScreen = {
		terminal: { rows: TERMINAL_ROWS },
		wheelScrollLines: 3,
		overlay: false,
		routeWheel(event) {
			routed.push(event);
		},
		hasOverlay() {
			return this.overlay;
		},
		requestRender() {
			renders.push(1);
		},
		handleViewportInput() {},
		handleSelectionMouseEvent() {},
		copySelectionToClipboard() {},
		getWordSelection() {},
		getSelectionSourceLine: () => "",
		getSelectionBounds: () => undefined,
		getSelectionColumns: () => ({ start: 0, end: 0 }),
		flash() {},
	};
	return { prototype, routed, renders };
}

function makeConfig(wheelRouting: boolean): () => PolishedTuiConfig {
	return () =>
		({
			mouse: {
				enabled: true,
				wheelRouting,
				copyOnSelect: true,
				copyNotice: true,
				clickToExpandTools: false,
				pathAwareWords: false,
			},
		}) as PolishedTuiConfig;
}

const disposers: Array<() => void> = [];

afterEach(() => {
	while (disposers.length > 0) disposers.pop()?.();
	setActiveEditor(undefined);
});

function install(prototype: object, wheelRouting = true) {
	const dispose = installMouse(prototype, { getConfig: makeConfig(wheelRouting) });
	disposers.push(dispose);
	return dispose;
}

describe("the mouse-wheel patch", () => {
	function arrange(lines: number) {
		const editor = new FakeEditor(draft(lines));
		const { frame } = mount(editor);
		const { prototype, routed, renders } = makePrototype();
		prototype.currentLayout = frame;
		setActiveEditor({ component: editor, scrollable: editor });
		return { editor, prototype, routed, renders };
	}

	it("scrolls the input box instead of the transcript", () => {
		const { editor, prototype, routed, renders } = arrange(20);
		install(prototype);

		prototype.routeWheel({ direction: 1, x: 10, y: HEIGHT - 1 });

		expect(editor.scrollOffset).toBe(3);
		expect(routed).toEqual([]);
		expect(renders).toHaveLength(1);
	});

	it("drags the caret into the new window so the next frame keeps the offset", () => {
		const { editor, prototype } = arrange(20);
		install(prototype);

		prototype.routeWheel({ direction: 1, x: 10, y: HEIGHT - 1 });

		// Pi re-derives `scrollOffset` from the caret on every render, so an
		// offset the caret is not inside of is undone by the very next frame.
		expect(editor.state.cursorLine).toBe(3);
		expect(editor.preferredVisualCol).toBeNull();
		expect(editor.snappedFromCursorCol).toBeNull();
	});

	it("lets the transcript have a notch that landed outside the input box", () => {
		const { editor, prototype, routed, renders } = arrange(20);
		install(prototype);

		prototype.routeWheel({ direction: -1, x: 10, y: 0 });

		expect(editor.scrollOffset).toBe(0);
		expect(routed).toHaveLength(1);
		expect(renders).toHaveLength(0);
	});

	it("lets the transcript have a notch over a draft that fits", () => {
		const { editor, prototype, routed } = arrange(VISIBLE);
		install(prototype);

		prototype.routeWheel({ direction: 1, x: 10, y: HEIGHT - 1 });

		expect(editor.scrollOffset).toBe(0);
		expect(routed).toHaveLength(1);
	});

	it("keeps the notch once the box is scrolled to its end", () => {
		// Chaining on to the transcript at the boundary would make the box feel
		// like it slipped out from under the pointer.
		const { editor, prototype, routed } = arrange(20);
		install(prototype);
		editor.scrollOffset = 15;
		editor.state.cursorLine = 19;

		prototype.routeWheel({ direction: 1, x: 10, y: HEIGHT - 1 });

		expect(editor.scrollOffset).toBe(15);
		expect(routed).toEqual([]);
	});

	it("lets the transcript have every notch when wheelRouting is off", () => {
		const { editor, prototype, routed } = arrange(20);
		install(prototype, false);

		prototype.routeWheel({ direction: 1, x: 10, y: HEIGHT - 1 });

		expect(editor.scrollOffset).toBe(0);
		expect(routed).toHaveLength(1);
	});

	it("lets the transcript have a notch aimed at an overlay", () => {
		const { editor, prototype, routed } = arrange(20);
		prototype.overlay = true;
		install(prototype);

		prototype.routeWheel({ direction: 1, x: 10, y: HEIGHT - 1 });

		expect(editor.scrollOffset).toBe(0);
		expect(routed).toHaveLength(1);
	});

	it("lets the transcript have every notch when no editor is registered", () => {
		const { editor, prototype, routed } = arrange(20);
		setActiveEditor(undefined);
		install(prototype);

		prototype.routeWheel({ direction: 1, x: 10, y: HEIGHT - 1 });

		expect(editor.scrollOffset).toBe(0);
		expect(routed).toHaveLength(1);
	});

	it("lets the transcript have a malformed wheel event", () => {
		const { prototype, routed } = arrange(20);
		install(prototype);

		(prototype.routeWheel as (event: unknown) => void)({ direction: 1, x: "10", y: 0 });

		expect(routed).toHaveLength(1);
	});

	it("puts routeWheel back when the install is disposed", () => {
		const { editor, prototype, routed } = arrange(20);
		install(prototype)();

		prototype.routeWheel({ direction: 1, x: 10, y: HEIGHT - 1 });

		expect(editor.scrollOffset).toBe(0);
		expect(routed).toHaveLength(1);
	});
});
