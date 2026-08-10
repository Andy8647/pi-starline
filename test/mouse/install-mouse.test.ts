import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
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
	requestRender(): void;
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

function makePrototype(): { prototype: FakeAltScreen; calls: string[]; renders: string[] } {
	const calls: string[] = [];
	// Kept out of `calls` so the exact-sequence assertions below stay about what
	// Pi's own methods did, not about repaints.
	const renders: string[] = [];
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
		requestRender() {
			renders.push("render");
		},
	};
	return { prototype, calls, renders };
}

function makeConfig(
	copyOnSelect: boolean,
	copyNotice: boolean,
	transcriptCleanCopy = true,
): () => PolishedTuiConfig {
	return () =>
		({
			icons: { rail: "│" },
			mouse: {
				copyOnSelect,
				copyNotice,
				transcriptCleanCopy,
				enabled: true,
				wheelRouting: true,
				clickToExpandTools: true,
				pathAwareWords: true,
			},
		}) as PolishedTuiConfig;
}

describe("installMouse selectionPendingMode", () => {
	it("arms instead of copying on release when copyOnSelect is false", () => {
		const { prototype, calls, renders } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
		});

		prototype.copySelectionToClipboard();

		expect(calls).toEqual([]); // no real copy happened
		expect(activeSelectionHintText()).toBe("5 characters selected, ctrl+c to copy");
		// Asked its own receiver to repaint, so the hint reaches the screen now
		// rather than waiting for an unrelated frame.
		expect(renders).toEqual(["render"]);
		dispose();
	});

	it("calls through to the real copy when copyOnSelect is true", () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true, true),
		});

		prototype.copySelectionToClipboard();

		expect(calls).toEqual(["copy", "flash:Copied!"]);
		dispose();
	});

	it("ctrl+c with a pending selection performs the real copy and clears", () => {
		const { prototype, calls } = makePrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
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
 * A selection over a real, framed tool box, in the layout Pi really builds.
 *
 * The transcript is pi-tui's own `Container` holding one framed expandable
 * component, and the rows come from calling `render` on it — not from a
 * hand-written array, and not from a layout tree with a box per message, which
 * pi-tui never produces (pinned in `test/contract/transcript-layout.test.ts`).
 *
 * The frame is the point of the fixture: `transcriptCleanCopy` must take it
 * off on the way to the clipboard, and the `transcriptCleanCopy: false`
 * opt-out must leave it on.
 *
 * `copySelectionToClipboard` here is Pi's own algorithm, transcribed from
 * `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js` — per row,
 * `getSelectionColumns` then slice then `trimEnd`, joined with "\n" and
 * written as OSC 52. That makes the assertions below a comparison against
 * what Pi would really put on the clipboard rather than against a stub.
 */
function makeTranscriptFixture() {
	const written: string[] = [];
	const scrollView = { name: "transcript" };
	const document = new Container();
	const tool = new FramedToolComponent();
	tool.addChild(new Text("hello", 0, 0));
	document.addChild(tool);
	const lines = document.render(FRAME_WIDTH);
	const contentBox = {
		component: document,
		rect: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
		children: [],
	};
	// Rows 1..3: the top rule, the body, the bottom rule. Row 0 is the tool
	// box's own blank spacer.
	const bounds = {
		start: { row: 1, col: 0, scrollView },
		end: { row: lines.length - 1, col: FRAME_WIDTH },
	} as SelectionBounds;

	const prototype = {
		selectionBounds: bounds as SelectionBounds | undefined,
		previousScreen: [] as string[],
		currentLayout: {
			root: {
				rect: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
				children: [
					{
						scrollView,
						scrollContentLines: lines,
						rect: { x: 0, y: 0, width: FRAME_WIDTH, height: lines.length },
						children: [contentBox],
					},
				],
			},
		},
		terminal: { write: (data: string) => written.push(data) },
		renders: [] as string[],
		hasOverlay() {
			return false;
		},
		requestRender() {
			this.renders.push("render");
		},
		getSelectionBounds() {
			return this.selectionBounds;
		},
		getSelectionColumns: fakeSelectionColumns,
		copySelectionToClipboard() {
			const selection = this.getSelectionBounds();
			if (!selection) return;
			const rows: string[] = [];
			for (let row = selection.start.row; row <= selection.end.row; row++) {
				const line = lines[row] ?? "";
				const columns = this.getSelectionColumns(line, row, selection);
				rows.push(line.slice(columns.start, columns.end).trimEnd());
			}
			const text = rows.join("\n");
			if (text.length === 0) return;
			this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
			this.flash("Copied!");
		},
		handleViewportInput(data: string) {
			return data === "\x03" ? undefined : { consume: true };
		},
		flash(_message: string) {},
		routeWheel() {},
		handleSelectionMouseEvent() {},
		applySelection() {},
		getWordSelection() {},
	};

	/** What Pi's own copy produces for this selection — frame and all. */
	const piCopyText = lines
		.slice(bounds.start.row, bounds.end.row + 1)
		.map((line) => line.trimEnd())
		.join("\n");

	return { written, lines, bounds, prototype, piCopyText };
}

describe("installMouse over a real framed transcript", () => {
	it("arms with the exact character count of the cleaned text ctrl+c delivers", () => {
		// The hint promises "N characters selected"; N has to be what ctrl+c
		// actually puts on the clipboard. Over a framed transcript that is the
		// *cleaned* text now — the frame is chrome, and the count must not
		// promise bytes the copy no longer sends.
		const { prototype, written } = makeTranscriptFixture();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
		});

		prototype.copySelectionToClipboard(); // release: arms, copies nothing

		expect(written).toEqual([]);
		expect(activeSelectionHintText()).toBe("5 characters selected, ctrl+c to copy");

		prototype.handleViewportInput("\x03");
		expect(decodeOsc52(written[0])).toBe("hello");
		dispose();
	});

	it("copies a tool box's content without its frame", () => {
		// transcriptCleanCopy: the border rows are chrome, drawn by pi-toolbox's
		// rounded frame, and the clipboard is better without them. What must
		// survive is the *content* — the text the box actually held.
		const { prototype, written } = makeTranscriptFixture();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true, true),
		});

		prototype.copySelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe("hello");
		dispose();
	});

	it("puts a tool box's border on the clipboard, unmodified, when transcriptCleanCopy is off", () => {
		// The opt-out: with `mouse.transcriptCleanCopy: false` the copy is
		// exactly what Pi's own would have been, frame and all.
		const { prototype, written, lines, piCopyText } = makeTranscriptFixture();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true, true, false),
		});

		prototype.copySelectionToClipboard();

		const copied = decodeOsc52(written[0]);
		expect(copied.split("\n")).toEqual(lines.slice(1).map((line) => line.trimEnd()));
		expect(copied).toContain("╭");
		expect(copied).toContain("╰");
		expect(copied).toContain("│hello");
		expect(copied).toBe(piCopyText);
		dispose();
	});

	it("arms nothing when the pending mode cannot install, and still copies clean", () => {
		// Dropping `handleViewportInput` takes `selectionPendingMode` with it —
		// no arm, no hint — while `transcriptCleanCopy` needs no key
		// interception and still answers the copy. (This fixture never stubs
		// `getSelectionSourceLine`, so `pathAwareWords` was never going to
		// install here either; see capabilities.test.ts for that gating.)
		const { prototype, written } = makeTranscriptFixture();
		const { handleViewportInput: _dropped, ...withoutViewportInput } = prototype;

		const dispose = installMouse(withoutViewportInput, {
			getConfig: makeConfig(false, true),
		});

		withoutViewportInput.copySelectionToClipboard();
		expect(activeSelectionHintText()).toBeNull();
		expect(decodeOsc52(written[0])).toBe("hello");
		dispose();
	});
});

/**
 * A transcript fixture over arbitrary rows, for `transcriptCleanCopy` cases
 * the framed-tool fixture cannot express (user message boxes, tables,
 * screen-space selections). Same wiring as `makeTranscriptFixture`: Pi's own
 * copy algorithm as predecessor, OSC 52 captured in `written`.
 */
function makeLineFixture(lines: readonly string[], bounds: SelectionBounds) {
	const written: string[] = [];
	const prototype = {
		selectionBounds: bounds as SelectionBounds | undefined,
		previousScreen: lines as string[],
		currentLayout: {
			root: {
				rect: { x: 0, y: 0, width: 40, height: lines.length },
				children: [
					{
						scrollView: bounds.start.scrollView,
						scrollContentLines: lines,
						rect: { x: 0, y: 0, width: 40, height: lines.length },
						children: [],
					},
				],
			},
		},
		terminal: { write: (data: string) => written.push(data) },
		hasOverlay() {
			return false;
		},
		getSelectionBounds() {
			return this.selectionBounds;
		},
		getSelectionColumns: fakeSelectionColumns,
		copySelectionToClipboard() {
			const selection = this.getSelectionBounds();
			if (!selection) return;
			const rows: string[] = [];
			for (let row = selection.start.row; row <= selection.end.row; row++) {
				const line = lines[row] ?? "";
				const columns = this.getSelectionColumns(line, row, selection);
				rows.push(line.slice(columns.start, columns.end).trimEnd());
			}
			const text = rows.join("\n");
			if (text.length === 0) return;
			this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		},
		handleViewportInput(_data: string) {
			return undefined;
		},
		flash(_message: string) {},
		requestRender() {},
	};
	return { prototype, written };
}

describe("installMouse transcriptCleanCopy", () => {
	const WIDTH = 24;
	const userBox = (body: readonly string[]) => [
		"─".repeat(WIDTH),
		...body.map((line) => `│ ${line}`.padEnd(WIDTH)),
		"─".repeat(WIDTH),
	];
	const wholeTranscript = (lines: readonly string[]): SelectionBounds =>
		({
			start: { row: 0, col: 0, scrollView: { name: "transcript" } },
			end: { row: lines.length - 1, col: WIDTH },
		}) as SelectionBounds;

	it("copies a user message as its text, without rail or border rules", () => {
		// The headline case from real use: a drag across a user message box
		// copied the rail, the rules and the padding. Now it copies the message.
		const lines = [
			"previous answer line",
			...userBox(["fix the flaky test", "and the other one"]),
			"next answer line",
		];
		const { prototype, written } = makeLineFixture(lines, wholeTranscript(lines));
		const dispose = installMouse(prototype, { getConfig: makeConfig(true, true) });

		prototype.copySelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe(
			"previous answer line\nfix the flaky test\nand the other one\nnext answer line",
		);
		dispose();
	});

	it("cleans a mid-box drag whose range contains no border row", () => {
		const box = userBox(["one", "two", "three"]);
		const lines = [...box, "after"];
		const bounds = {
			start: { row: 2, col: 0, scrollView: { name: "transcript" } },
			end: { row: 3, col: WIDTH },
		} as SelectionBounds;
		const { prototype, written } = makeLineFixture(lines, bounds);
		const dispose = installMouse(prototype, { getConfig: makeConfig(true, true) });

		prototype.copySelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe("two\nthree");
		dispose();
	});

	it("slices a mid-row start out of the content, not out of the rail", () => {
		// A drag over columns 5..7 of a rail row covers columns 3..5 of the
		// content once the rail comes off — `leftTrim` shifts the columns, and
		// the receiver's column math (exclusive-end here) does the slicing.
		// Without the shift the slice would land two characters to the right.
		const lines = userBox(["abcdefgh"]);
		const bounds = {
			start: { row: 1, col: 5, scrollView: { name: "transcript" } },
			end: { row: 1, col: 7, scrollView: { name: "transcript" } },
		} as SelectionBounds;
		const { prototype, written } = makeLineFixture(lines, bounds);
		const dispose = installMouse(prototype, { getConfig: makeConfig(true, true) });

		prototype.copySelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe("de");
		dispose();
	});

	it("falls back to Pi's verbatim copy for a selection with no chrome", () => {
		// A markdown table — square corners — is content. Nothing about it may
		// change on the way to the clipboard.
		const lines = ["┌─ one ─┬─ two ─┐", "│ a     │ b     │", "└─ ─── ─┴─ ─── ─┘"];
		const { prototype, written } = makeLineFixture(lines, wholeTranscript(lines));
		const dispose = installMouse(prototype, { getConfig: makeConfig(true, true) });

		prototype.copySelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe(lines.join("\n"));
		dispose();
	});

	it("leaves screen-space selections to Pi", () => {
		// No scroll view on the anchor: the selection is over the dock or the
		// status area, not the transcript, and stays byte-for-byte Pi's.
		const lines = ["─".repeat(WIDTH), "│ dock row".padEnd(WIDTH), "─".repeat(WIDTH)];
		const bounds = {
			start: { row: 0, col: 0 },
			end: { row: 2, col: WIDTH },
		} as SelectionBounds;
		const { prototype, written } = makeLineFixture(lines, bounds);
		const dispose = installMouse(prototype, { getConfig: makeConfig(true, true) });

		prototype.copySelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe(lines.map((line) => line.trimEnd()).join("\n"));
		dispose();
	});

	it("consumes a pure-decoration drag without writing the clipboard", () => {
		// Selecting just a user box's border rules cleans to nothing — Pi's own
		// copy has the same `text.length === 0` shape, it just gets there after
		// building a string of rules.
		const lines = ["plain", ...userBox(["content"]), "plain"];
		const bounds = {
			start: { row: 1, col: 0, scrollView: { name: "transcript" } },
			end: { row: 1, col: WIDTH },
		} as SelectionBounds;
		const { prototype, written } = makeLineFixture(lines, bounds);
		const dispose = installMouse(prototype, { getConfig: makeConfig(true, true) });

		prototype.copySelectionToClipboard();

		expect(written).toEqual([]);
		dispose();
	});
});

type WordSelectionPoint = { row: number; col: number; scrollView?: unknown };
type WordSelectionRange = { start: WordSelectionPoint; end: WordSelectionPoint };

type WordSelectionPrototype = {
	previousScreen: string[];
	getSelectionSourceLine(point: WordSelectionPoint): string;
	getWordSelection(point: WordSelectionPoint): WordSelectionRange | undefined;
};

/**
 * A minimal stand-in for the slice of `TuiAltScreen` `pathAwareWords` touches
 * — just the two methods `capabilities.ts` requires for it, wired the same
 * way Pi's own `getWordSelection`/`getSelectionSourceLine` are (source line
 * comes from `previousScreen`; predecessor's `getWordSelection` is a crude
 * stand-in for Pi's real pre-#7746 rule — runs of letters/digits only, so it
 * splits at `/` and `-` the same way the real, unpatched segmenter does —
 * which is what makes a call-through distinguishable from the patched
 * `wordRangeAt` answer by its *value*, not just by identity).
 */
function makeWordSelectionPrototype(): WordSelectionPrototype {
	return {
		previousScreen: ["see src/fixed-editor/a.ts here"],
		getSelectionSourceLine(point) {
			return this.previousScreen[point.row] ?? "";
		},
		getWordSelection(point) {
			const line = this.previousScreen[point.row] ?? "";
			const isWord = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9]/.test(ch);
			if (!isWord(line[point.col])) return undefined;
			let start = point.col;
			while (start > 0 && isWord(line[start - 1])) start--;
			let end = point.col;
			while (end < line.length && isWord(line[end])) end++;
			return { start: { ...point, col: start }, end: { ...point, col: end } };
		},
	};
}

describe("installMouse pathAwareWords", () => {
	it("keeps a path whole where predecessor would have split it", () => {
		const prototype = makeWordSelectionPrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
		});

		// Column 9 is inside "fixed" (of "src/fixed-editor/a.ts"). Predecessor's
		// letters-and-digits-only rule would stop there, at the `/` and `-` on
		// either side; the patched one keeps the whole path.
		const range = prototype.getWordSelection({ row: 0, col: 9 });
		expect(range).toEqual({
			start: { row: 0, col: 4, scrollView: undefined },
			end: { row: 0, col: 25, scrollView: undefined, boundary: true },
		});
		dispose();
	});

	it("calls through to predecessor when mouse.pathAwareWords is off", () => {
		const prototype = makeWordSelectionPrototype();
		const dispose = installMouse(prototype, {
			getConfig: () =>
				({
					mouse: {
						copyOnSelect: false,
						copyNotice: true,
						enabled: true,
						wheelRouting: true,
						clickToExpandTools: true,
						pathAwareWords: false,
					},
				}) as PolishedTuiConfig,
		});

		const range = prototype.getWordSelection({ row: 0, col: 9 });
		// Predecessor's cruder rule: just "fixed", stopping at `/` and `-`, and
		// with no `boundary` field — the tell that this is predecessor's shape.
		expect(range).toEqual({ start: { row: 0, col: 8 }, end: { row: 0, col: 13 } });
		dispose();
	});

	it("calls through when wordRangeAt declines (column past the end of the line)", () => {
		const prototype = makeWordSelectionPrototype();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
		});

		const range = prototype.getWordSelection({ row: 0, col: 999 });
		expect(range).toBeUndefined();
		dispose();
	});

	it("does not install when getSelectionSourceLine is missing", () => {
		const { getSelectionSourceLine: _dropped, ...withoutSourceLine } = makeWordSelectionPrototype();
		const original = withoutSourceLine.getWordSelection;

		const dispose = installMouse(withoutSourceLine, {
			getConfig: makeConfig(false, true),
		});

		expect(withoutSourceLine.getWordSelection).toBe(original);
		dispose();
	});

	it("dispose restores predecessor", () => {
		const prototype = makeWordSelectionPrototype();
		const original = prototype.getWordSelection;
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
		});

		dispose();

		expect(prototype.getWordSelection).toBe(original);
	});
});

describe("installMouse gating for editorClickToCaret", () => {
	it("patches handleViewportInput when editorClickToCaret is the only editor feature enabled", () => {
		// A Pi build that has moved copySelectionToClipboard disables
		// selectionPendingMode and editorBufferCopy (both require it), but NOT
		// editorClickToCaret. The range-delete half of editorClickToCaret lives
		// on the handleViewportInput patch inside installCopying, so the gating
		// must install it even when those two features are off — otherwise the
		// caret installs while its delete silently never exists, exactly the
		// half-working install the capability table's rule forbids.
		const { prototype, calls } = makePrototype();
		const extended = prototype as FakeAltScreen & {
			hasOverlay: () => boolean;
		};
		extended.hasOverlay = () => false;
		// The capability probe looks at the object itself and its prototype
		// chain; removing the method makes isPatchable report it missing.
		delete (extended as Partial<FakeAltScreen>).copySelectionToClipboard;

		const originalViewportInput = prototype.handleViewportInput;
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
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
