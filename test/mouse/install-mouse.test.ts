import { Container, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolishedTuiConfig } from "../../extensions/starline/config";
import { activeSelectionHintText, installMouse } from "../../extensions/starline/mouse/index";
import { FramedToolComponent } from "./component-graph";

type SelectionBounds = {
	start: { row: number; col: number; scrollView?: unknown };
	end: { row: number; col: number };
};
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

function decodeOsc52(data: string): string {
	const match = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(data);
	return Buffer.from(match?.[1] ?? "", "base64").toString();
}

const FRAME_WIDTH = 12;

/**
 * A selection over a real tool box, in the layout Pi really builds.
 *
 * The transcript is a `Container` (pi-tui's own) holding one framed,
 * expandable component, and the rows come from calling `render` on it — not
 * from a hand-written array, and not from a layout tree with a box per
 * message, which is the shape this fixture used to describe and which pi-tui
 * never produces. The only hand-built part is the layout tree above the
 * content box, which is exactly what `renderLayoutFrame` returns for
 * `VStack(ScrollView(document))`; that shape is pinned against the real engine
 * in `test/contract/transcript-layout.test.ts`.
 *
 * The selection deliberately starts at the frame's top rule rather than at the
 * component's first row, because a tool box opens with a blank spacer row
 * (`pi-toolbox`'s render begins `const out: string[] = [""]`) which is not
 * part of the frame and is copied as the blank line it is.
 *
 * `currentLayout`/`terminal` are what `performFrameFreeCopy` needs; neither is
 * a probed capability (see `index.ts`'s comment on `terminal`), so they can be
 * present on a fake regardless of which methods this fixture omits.
 */
function makeFramedFixture(contentRect?: { y: number; clipHeight: number }) {
	const written: string[] = [];
	const scrollView = { name: "transcript" };
	const document = new Container();
	const tool = new FramedToolComponent();
	tool.addChild(new Text("hello", 0, 0));
	document.addChild(tool);
	const lines = document.render(FRAME_WIDTH);
	const contentBox = {
		component: document,
		rect: { x: 0, y: contentRect?.y ?? 0, width: FRAME_WIDTH, height: lines.length },
		clip: { x: 0, y: 0, width: FRAME_WIDTH, height: contentRect?.clipHeight ?? lines.length },
		children: [],
	};
	return {
		written,
		lines,
		// Rows 1..3: the top rule, the body, the bottom rule.
		bounds: {
			start: { row: 1, col: 0, scrollView },
			end: { row: lines.length - 1, col: FRAME_WIDTH },
		} as SelectionBounds,
		previousScreen: [] as string[],
		currentLayout: {
			root: {
				rect: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
				clip: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
				children: [
					{
						scrollView,
						scrollContentLines: lines,
						rect: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
						clip: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
						children: [contentBox],
					},
				],
			},
		},
		terminal: { write: (data: string) => written.push(data) },
	};
}

describe("installMouse frameFreeSelection independent of selectionPendingMode", () => {
	let requestRender: () => void;

	beforeEach(() => {
		requestRender = vi.fn();
	});

	it("still strips a frame from the copy when selectionPendingMode cannot install (no handleViewportInput)", () => {
		// Regression: capabilities.ts declares frameFreeSelection needs only
		// copySelectionToClipboard/getSelectionBounds/getSelectionColumns/flash,
		// none of which is handleViewportInput. A Pi build missing it must still
		// get a frame-free copy, not silently lose the feature because it used
		// to ride along inside selectionPendingMode's install.
		const fixture = makeFramedFixture();
		let predecessorCalls = 0;
		const prototype = {
			selectionBounds: fixture.bounds,
			previousScreen: fixture.previousScreen,
			currentLayout: fixture.currentLayout,
			terminal: fixture.terminal,
			getSelectionBounds() {
				return this.selectionBounds;
			},
			getSelectionColumns: fakeSelectionColumns,
			copySelectionToClipboard() {
				// Pi's own (unstripped) fallback — must not run once the frame-free
				// write has already succeeded.
				predecessorCalls++;
			},
			flash() {},
			routeWheel() {},
			handleSelectionMouseEvent() {},
			applySelection() {},
			getWordSelection() {},
			// handleViewportInput deliberately absent.
		};

		const dispose = installMouse(prototype, {
			// copyOnSelect: false is meaningless without handleViewportInput to
			// arm-and-wait for, but must not be treated as "do nothing" either.
			getConfig: makeConfig(false, true),
			requestRender,
		});

		prototype.copySelectionToClipboard();

		expect(predecessorCalls).toBe(0);
		expect(fixture.written).toHaveLength(1);
		expect(decodeOsc52(fixture.written[0])).toBe("hello");
		dispose();
	});

	it("strips a frame that has scrolled out of the viewport by copy time", () => {
		// Finding B, through the same path a real copy takes: patch installed on
		// copySelectionToClipboard, selection in scroll-view coordinates, text
		// read back off the OSC 52 write.
		//
		// The geometry is what pi-tui's own renderLayoutFrame produces for a
		// scrolled transcript (pinned against the real engine in
		// test/contract/transcript-layout.test.ts): the scroll content box keeps
		// `rect.y === -scrollTop` while `clip` stays pinned to the viewport.
		// Selection rows are content rows fixed at mouse-down, so the ordinary
		// copyOnSelect:false flow — select, scroll, ctrl+c — asks about rows the
		// viewport no longer shows. While ownership came from the layout tree
		// and honoured `clip`, those rows resolved to no box at all and the frame
		// was copied verbatim.
		const fixture = makeFramedFixture({ y: -15, clipHeight: 0 });
		const prototype = {
			selectionBounds: fixture.bounds,
			previousScreen: fixture.previousScreen,
			currentLayout: fixture.currentLayout,
			terminal: fixture.terminal,
			getSelectionBounds() {
				return this.selectionBounds;
			},
			getSelectionColumns: fakeSelectionColumns,
			copySelectionToClipboard() {},
			handleViewportInput(data: string) {
				return data === "\x03" ? undefined : { consume: true };
			},
			flash() {},
			routeWheel() {},
			handleSelectionMouseEvent() {},
			applySelection() {},
			getWordSelection() {},
		};

		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true, true),
			requestRender,
		});

		prototype.copySelectionToClipboard();

		expect(fixture.written).toHaveLength(1);
		expect(decodeOsc52(fixture.written[0])).toBe("hello");
		dispose();
	});

	it("keeps the pending-arm + ctrl+c flow frame-free when both features are enabled", () => {
		// With selectionPendingMode also available, behaviour is unchanged from
		// before this fix: arm on release, real (frame-free) copy on ctrl+c.
		const fixture = makeFramedFixture();
		const prototype = {
			selectionBounds: fixture.bounds,
			previousScreen: fixture.previousScreen,
			currentLayout: fixture.currentLayout,
			terminal: fixture.terminal,
			getSelectionBounds() {
				return this.selectionBounds;
			},
			getSelectionColumns: fakeSelectionColumns,
			copySelectionToClipboard() {},
			handleViewportInput(data: string) {
				return data === "\x03" ? undefined : { consume: true };
			},
			flash() {},
			routeWheel() {},
			handleSelectionMouseEvent() {},
			applySelection() {},
			getWordSelection() {},
		};

		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
			requestRender,
		});

		prototype.copySelectionToClipboard(); // release: armed, nothing written yet
		expect(fixture.written).toEqual([]);
		// The hint's character count is the frame-free length ("hello", not the
		// unstripped 30 characters of the three raw rows).
		expect(activeSelectionHintText()).toBe("5 characters selected, ctrl+c to copy");

		const result = prototype.handleViewportInput("\x03");

		expect(result).toEqual({ consume: true });
		expect(fixture.written).toHaveLength(1);
		expect(decodeOsc52(fixture.written[0])).toBe("hello");
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});
});

describe("installMouse frame-free highlight", () => {
	let requestRender: () => void;

	beforeEach(() => {
		requestRender = vi.fn();
	});

	/**
	 * A stand-in for `applySelection`'s own loop: it asks
	 * `this.getSelectionColumns` once per row inside the selection and uses what
	 * comes back to slice the highlight. See
	 * `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js`; the real
	 * method's shape is pinned in `test/contract/pi-tui-contract.test.ts`.
	 */
	function makeHighlightPrototype(fixture: ReturnType<typeof makeFramedFixture>) {
		const seen: (SelectionColumns | undefined)[] = [];
		const prototype = {
			selectionBounds: fixture.bounds,
			previousScreen: fixture.previousScreen,
			currentLayout: fixture.currentLayout,
			terminal: fixture.terminal,
			getSelectionBounds() {
				return this.selectionBounds;
			},
			getSelectionColumns: fakeSelectionColumns,
			copySelectionToClipboard() {},
			handleViewportInput() {
				return undefined;
			},
			flash() {},
			routeWheel() {},
			handleSelectionMouseEvent() {},
			applySelection(screen: string[]) {
				for (let row = 0; row < screen.length; row++) {
					seen.push(this.getSelectionColumns(screen[row], row, this.selectionBounds));
				}
				return screen;
			},
			getWordSelection() {},
		};
		return { prototype, seen };
	}

	it("stops the highlight short of a frame's verticals, and only there", () => {
		// The highlight path asks in screen rows and frames are owned in content
		// rows, so this also covers the `row - origin.rect.y` conversion: with
		// the content box at y=0 the two coincide, and the next test moves it.
		const fixture = makeFramedFixture();
		const { prototype, seen } = makeHighlightPrototype(fixture);
		const dispose = installMouse(prototype, { getConfig: makeConfig(true, true), requestRender });

		prototype.applySelection([...fixture.lines]);

		// Row 2 is the frame's body: the highlight stops inside both verticals.
		expect(seen[2]).toEqual({ start: 1, end: FRAME_WIDTH - 2 });
		// Row 0 is the tool box's spacer, outside the frame, and rows 1 and 3 are
		// the rules themselves, which carry no verticals to stop at. All three
		// keep whatever Pi's own getSelectionColumns returned.
		expect(seen[0]).toEqual(fakeSelectionColumns(fixture.lines[0], 0, fixture.bounds));
		expect(seen[1]).toEqual(fakeSelectionColumns(fixture.lines[1], 1, fixture.bounds));
		// The shadow is put back, so nothing leaks past the one call.
		expect(prototype.getSelectionColumns).toBe(fakeSelectionColumns);
		dispose();
	});

	it("shrinks the screen row the frame is painted on, not the content row", () => {
		// The one conversion this path needs: content row N is painted at screen
		// row `N + origin.rect.y`. Here the transcript starts three rows down, so
		// the frame's body is content row 2 and screen row 5. Treating the two as
		// interchangeable — which the layout-tree version effectively did —
		// shrinks row 2 instead, mangling a line the frame never touched.
		const fixture = makeFramedFixture({ y: 3, clipHeight: 10 });
		const { prototype, seen } = makeHighlightPrototype(fixture);
		const dispose = installMouse(prototype, { getConfig: makeConfig(true, true), requestRender });

		prototype.applySelection(["dock", "dock", "dock", ...fixture.lines]);

		expect(seen[5]).toEqual({ start: 1, end: FRAME_WIDTH - 2 });
		expect(seen[2]).toEqual(fakeSelectionColumns("dock", 2, fixture.bounds));
		dispose();
	});
});
