/**
 * Verifies Task 5's mouse patches against the REAL installed
 * `TuiAltScreen.prototype` — not a fake. `pi-tui-contract.test.ts` checks that
 * the methods Starline touches still exist with the right shape; this checks
 * that `installMouse`'s patches actually compose correctly with Pi's real
 * method bodies: the real `getSelectionColumns`/`copySelectionToClipboard`
 * column math, the real OSC 52 write, the real `handleViewportInput`
 * ctrl+c-falls-through behavior.
 *
 * Every test disposes its own install in an `afterEach` and asserts the
 * prototype is back to the exact function references it started with —
 * leaving a patched shared prototype behind would poison every test that
 * runs after this file.
 */
import { Container, ScrollView, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { afterEach, describe, expect, it } from "vitest";
import { setActiveEditor } from "../../extensions/starline/mouse/editor-mouse";
import { activeSelectionHintText, installMouse } from "../../extensions/starline/mouse/index";

// `copySelectionToClipboard`/`handleViewportInput` are typed `private` in
// pi-tui's `.d.ts` even though they are plain functions on the prototype at
// runtime (TypeScript `private` is erased, not enforced) — the same fact
// `pi-tui-contract.test.ts` documents. This local view exposes them so the
// test can call and reassign them directly, the way Pi's own internals do.
type TuiAltScreenPrototype = {
	copySelectionToClipboard: () => void;
	handleViewportInput: (data: string) => { consume: boolean } | undefined;
	handleSelectionMouseEvent: (event: unknown) => void;
	getWordSelection: (point: unknown) => unknown;
	routeWheel: (event: unknown) => void;
};
const prototype = TuiAltScreen.prototype as unknown as TuiAltScreenPrototype;

const originalCopy = prototype.copySelectionToClipboard;
const originalViewportInput = prototype.handleViewportInput;
const originalMouseEvent = prototype.handleSelectionMouseEvent;
const originalWordSelection = prototype.getWordSelection;
const originalRouteWheel = prototype.routeWheel;

type RealReceiver = {
	selectionAnchor: { row: number; col: number } | undefined;
	selectionFocus: { row: number; col: number } | undefined;
	previousScreen: string[];
	terminal: { write: (data: string) => void };
	flashes: { flash: (message: string) => void };
	copySelectionToClipboard: () => void;
	handleViewportInput: (data: string) => { consume: boolean } | undefined;
	// `TuiBase.requestRender` is inherited, not stubbed: the patches call it on
	// the receiver, so this file exercises Pi's real one.
	requestRender: (force?: boolean) => void;
	renderRequested: boolean;
	stopped: boolean;
};

function makeReceiver(previousScreen: string[]): { instance: RealReceiver; written: string[] } {
	const written: string[] = [];
	const instance = Object.create(TuiAltScreen.prototype) as RealReceiver;
	instance.selectionAnchor = undefined;
	instance.selectionFocus = undefined;
	instance.previousScreen = previousScreen;
	instance.terminal = { write: (data: string) => written.push(data) };
	instance.flashes = { flash: () => {} };
	instance.renderRequested = false;
	// `requestRender` defers the actual frame to `scheduleRender` on the next
	// tick, which returns immediately when the TUI is stopped. This keeps the
	// real method's observable effect (`renderRequested`) without letting a
	// detached receiver try to paint a terminal it does not have.
	instance.stopped = true;
	return { instance, written };
}

function decodeOsc52(data: string): string {
	const match = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(data);
	return Buffer.from(match?.[1] ?? "", "base64").toString();
}

describe("mouse patches against the real TuiAltScreen.prototype", () => {
	let dispose: (() => void) | undefined;

	afterEach(() => {
		// try/finally so the restoration check still runs — and still reports
		// clearly — even if a test body throws before calling dispose, or if
		// dispose itself throws. A patch left on this shared prototype would
		// poison every test that runs after this file, invisibly, depending on
		// run order, so this assertion is not optional.
		try {
			dispose?.();
		} finally {
			dispose = undefined;
			expect(prototype.copySelectionToClipboard).toBe(originalCopy);
			expect(prototype.handleViewportInput).toBe(originalViewportInput);
			// Every method `installMouse` may touch, not only the two this file
			// exercises: the real prototype is shared with every other test file.
			expect(prototype.handleSelectionMouseEvent).toBe(originalMouseEvent);
			expect(prototype.getWordSelection).toBe(originalWordSelection);
			expect(prototype.routeWheel).toBe(originalRouteWheel);
			setActiveEditor(undefined);
		}
	});

	it("installs on the real prototype and restores it on dispose", () => {
		dispose = installMouse(prototype, {
			getConfig: () => ({ mouse: { copyOnSelect: false, copyNotice: true } }) as never,
		});

		expect(prototype.copySelectionToClipboard).not.toBe(originalCopy);
		expect(prototype.handleViewportInput).not.toBe(originalViewportInput);
	});

	it("withholds the real copy on release, then performs it byte-exact on ctrl+c", () => {
		dispose = installMouse(prototype, {
			getConfig: () => ({ mouse: { copyOnSelect: false, copyNotice: true } }) as never,
		});

		const { instance, written } = makeReceiver([
			"hello world   ", // trailing spaces must be trimmed, matching Pi's own .trimEnd()
			"second row here",
			"end",
		]);
		instance.selectionAnchor = { row: 0, col: 2 };
		instance.selectionFocus = { row: 2, col: 3 };

		instance.copySelectionToClipboard(); // release: armed, nothing written yet
		expect(written).toEqual([]);

		const expectedText = ["llo world", "second row here", "end"].join("\n");
		expect(activeSelectionHintText()).toBe(
			`${expectedText.length} characters selected, ctrl+c to copy`,
		);

		const result = instance.handleViewportInput("\x03");
		expect(result).toEqual({ consume: true });
		expect(written).toHaveLength(1);
		expect(decodeOsc52(written[0])).toBe(expectedText);
		expect(activeSelectionHintText()).toBeNull();
	});

	it("falls through to Pi's real ctrl+c handling when nothing is pending", () => {
		dispose = installMouse(prototype, {
			getConfig: () => ({ mouse: { copyOnSelect: false, copyNotice: true } }) as never,
		});

		const { instance, written } = makeReceiver(["hello"]);
		// No selectionAnchor/selectionFocus set — getSelectionBounds() is undefined.

		const result = instance.handleViewportInput("\x03");

		// Pi's real handleViewportInput does not consume a bare ctrl+c — this is
		// what keeps interrupt working.
		expect(result).toBeUndefined();
		expect(written).toEqual([]);
	});
});

/**
 * The wheel path, driven the way a terminal drives it: a raw SGR sequence into
 * the real `handleViewportInput`, which runs Pi's own `parseWheelEvent` and
 * hands the result to the patched `routeWheel`. Nothing about the event shape
 * is asserted from the plan here — if `parseWheelEvent`'s output ever stops
 * matching what the patch reads, these go red.
 */
const WIDTH = 40;
const HEIGHT = 12;
const EDITOR_ROWS = 5;

/** A scrollable draft, and enough of Pi's `Editor` to be laid out and scrolled. */
class FakeEditor {
	readonly state = {
		lines: Array.from({ length: 20 }, (_value, index) => `draft ${index}`),
		cursorLine: 0,
		cursorCol: 0,
	};
	scrollOffset = 0;
	lastWidth = WIDTH;
	preferredVisualCol: number | null = null;
	snappedFromCursorCol: number | null = null;

	buildVisualLineMap(_width: number) {
		return this.state.lines.map((line, index) => ({
			logicalLine: index,
			startCol: 0,
			length: line.length,
		}));
	}

	render(_width: number): string[] {
		const window = this.state.lines.slice(this.scrollOffset, this.scrollOffset + EDITOR_ROWS);
		while (window.length < EDITOR_ROWS) window.push("");
		return window;
	}

	invalidate(): void {}
}

/** `\x1b[<65;col;rowM` — bit 64 is a wheel report, direction bit 1 is down. */
function wheelDown(x: number, y: number): string {
	return `\x1b[<65;${x + 1};${y + 1}M`;
}

function makeWheelReceiver() {
	const editor = new FakeEditor();
	const container = new Container();
	container.addChild(editor as unknown as Parameters<Container["addChild"]>[0]);
	const transcript = new Text(Array.from({ length: 40 }, (_v, i) => `line ${i}`).join("\n"), 0, 0);
	const scroll = new ScrollView(transcript, { primary: true, follow: "end" });
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{
			component: new VStack([{ component: container, shrink: 1, minSize: 3 }]),
			basis: "auto",
			grow: 0,
			shrink: 1,
			minSize: 1,
		},
	]);
	const instance = Object.create(TuiAltScreen.prototype) as Record<string, unknown> & {
		handleViewportInput: (data: string) => { consume: boolean } | undefined;
	};
	instance.currentLayout = renderLayoutFrame(root, WIDTH, HEIGHT, () => {});
	instance.terminal = { rows: HEIGHT, columns: WIDTH, write: () => {} };
	instance.wheelScrollLines = 3;
	instance.overlayStack = [];
	instance.scrollbarHover = undefined;
	instance.scrollbarDrag = undefined;
	instance.stopped = true;
	setActiveEditor({ component: editor, scrollable: editor });
	return { instance, editor, scroll };
}

describe("the wheel patch against the real TuiAltScreen.prototype", () => {
	let dispose: (() => void) | undefined;

	afterEach(() => {
		try {
			dispose?.();
		} finally {
			dispose = undefined;
			setActiveEditor(undefined);
			expect(prototype.routeWheel).toBe(originalRouteWheel);
		}
	});

	function install() {
		dispose = installMouse(prototype, {
			getConfig: () => ({ mouse: { wheelRouting: true, copyOnSelect: true } }) as never,
		});
	}

	it("scrolls the input box for a notch Pi parsed out of a real SGR sequence", () => {
		const { instance, editor, scroll } = makeWheelReceiver();
		// Parked at the top, so a notch that leaked through to Pi's routing would
		// move it and be caught below rather than being absorbed by the end stop.
		scroll.scrollTo(0);
		install();

		const result = instance.handleViewportInput(wheelDown(10, HEIGHT - 1));

		expect(result).toEqual({ consume: true });
		expect(editor.scrollOffset).toBe(3);
		expect(scroll.scrollTop).toBe(0);
	});

	it("leaves a notch over the transcript to Pi's own routing", () => {
		const { instance, editor, scroll } = makeWheelReceiver();
		scroll.scrollTo(0);
		install();

		instance.handleViewportInput(wheelDown(10, 0));

		expect(editor.scrollOffset).toBe(0);
		expect(scroll.scrollTop).toBeGreaterThan(0);
	});
});
