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
	copyOnSelect: boolean;
	copyActiveSelectionToClipboard(): Promise<boolean>;
	getCopyOnSelect(): boolean;
	hasActiveSelection(): boolean;
	getSelectionBounds(): SelectionBounds | undefined;
	getSelectionColumns(line: string, row: number, selection: SelectionBounds): SelectionColumns;
	handleViewportInput(data: string): { consume: boolean } | undefined;
	flash(message: string, durationMs?: number): void;
	hasOverlay(): boolean;
	routeWheel(): void;
	handleSelectionMouseEvent(): void;
	applySelection(): void;
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
		copyOnSelect: false,
		getCopyOnSelect() {
			return this.copyOnSelect;
		},
		hasActiveSelection() {
			return this.selectionBounds !== undefined;
		},
		getSelectionBounds() {
			return this.selectionBounds;
		},
		getSelectionColumns: fakeSelectionColumns,
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

function makeConfig(copyNotice: boolean, transcriptCleanCopy = true): () => PolishedTuiConfig {
	return () =>
		({
			icons: { rail: "│" },
			mouse: {
				copyNotice,
				transcriptCleanCopy,
				enabled: true,
				wheelRouting: true,
				clickToExpandTools: true,
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

	it("does not install without Pi 0.84.4's selection APIs, and still copies clean", () => {
		// Dropping `getCopyOnSelect`/`hasActiveSelection` takes `selectionHint`
		// with it — no hint — while `transcriptCleanCopy` needs neither and
		// still answers the copy.
		const { prototype } = makePrototype();
		const { getCopyOnSelect: _droppedA, hasActiveSelection: _droppedB, ...withoutApi } = prototype;
		const original = withoutApi.copyActiveSelectionToClipboard;

		const dispose = installMouse(withoutApi, {
			getConfig: makeConfig(true),
		});

		expect(withoutApi.copyActiveSelectionToClipboard).not.toBe(original);
		expect(activeSelectionHintText()).toBeNull();
		dispose();
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
 * `copyActiveSelectionToClipboard` here is Pi's own algorithm, transcribed from
 * `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js` — per row,
 * `getSelectionColumns` then slice then `trimEnd`, joined with "\n" and
 * written as OSC 52. That makes the assertions below a comparison against
 * what Pi would really put on the clipboard rather than against a stub.
 */
function makeTranscriptFixture() {
	const written: string[] = [];
	const flashes: string[] = [];
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
		copyOnSelect: false,
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
		getCopyOnSelect() {
			return this.copyOnSelect;
		},
		hasActiveSelection() {
			return this.selectionBounds !== undefined;
		},
		requestRender() {
			this.renders.push("render");
		},
		getSelectionBounds() {
			return this.selectionBounds;
		},
		getSelectionColumns: fakeSelectionColumns,
		async copyActiveSelectionToClipboard() {
			const selection = this.getSelectionBounds();
			if (!selection) return false;
			const rows: string[] = [];
			for (let row = selection.start.row; row <= selection.end.row; row++) {
				const line = lines[row] ?? "";
				const columns = this.getSelectionColumns(line, row, selection);
				rows.push(line.slice(columns.start, columns.end).trimEnd());
			}
			const text = rows.join("\n");
			if (text.length === 0) return false;
			this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
			this.flash("Copied!");
			return true;
		},
		handleViewportInput(data: string) {
			return data === "\x03" ? undefined : { consume: true };
		},
		flash(message: string) {
			flashes.push(message);
		},
		routeWheel() {},
		handleSelectionMouseEvent() {},
		applySelection() {},
	};

	/** What Pi's own copy produces for this selection — frame and all. */
	const piCopyText = lines
		.slice(bounds.start.row, bounds.end.row + 1)
		.map((line) => line.trimEnd())
		.join("\n");

	return { written, flashes, lines, bounds, prototype, piCopyText };
}

describe("installMouse over a real framed transcript", () => {
	it("counts the cleaned text in the hint, matching what the copy key delivers", () => {
		// The hint promises "N characters selected"; N has to be what the copy
		// key actually puts on the clipboard. Over a framed transcript that is
		// the *cleaned* text now — the frame is chrome, and the count must not
		// promise bytes the copy no longer sends.
		const { prototype, written } = makeTranscriptFixture();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true),
		});
		registerReceiver(prototype);

		expect(written).toEqual([]);
		expect(activeSelectionHintText()).toContain("5 characters selected");

		// The copy key's path: Pi's `handleCopyCommand` reaches
		// `copyActiveSelectionToClipboard`, and the clean copy answers it.
		prototype.copyActiveSelectionToClipboard();
		expect(decodeOsc52(written[0])).toBe("hello");
		dispose();
	});

	it("copies a tool box's content without its frame", async () => {
		// transcriptCleanCopy: the border rows are chrome, drawn by pi-toolbox's
		// rounded frame, and the clipboard is better without them. What must
		// survive is the *content* — the text the box actually held.
		const { prototype, written } = makeTranscriptFixture();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true),
		});

		await prototype.copyActiveSelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe("hello");
		dispose();
	});

	it("puts a tool box's border on the clipboard, unmodified, when transcriptCleanCopy is off", async () => {
		// The opt-out: with `mouse.transcriptCleanCopy: false` the copy is
		// exactly what Pi's own would have been, frame and all.
		const { prototype, written, lines, piCopyText } = makeTranscriptFixture();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true, false),
		});

		await prototype.copyActiveSelectionToClipboard();

		const copied = decodeOsc52(written[0]);
		expect(copied.split("\n")).toEqual(lines.slice(1).map((line) => line.trimEnd()));
		expect(copied).toContain("╭");
		expect(copied).toContain("╰");
		expect(copied).toContain("│hello");
		expect(copied).toBe(piCopyText);
		dispose();
	});

	it("gates the clean copy's notice flash on copyNotice", async () => {
		const { prototype, flashes } = makeTranscriptFixture();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false),
		});

		await prototype.copyActiveSelectionToClipboard();

		expect(flashes).toEqual([]);
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
		async copyActiveSelectionToClipboard() {
			const selection = this.getSelectionBounds();
			if (!selection) return false;
			const rows: string[] = [];
			for (let row = selection.start.row; row <= selection.end.row; row++) {
				const line = lines[row] ?? "";
				const columns = this.getSelectionColumns(line, row, selection);
				rows.push(line.slice(columns.start, columns.end).trimEnd());
			}
			const text = rows.join("\n");
			if (text.length === 0) return false;
			this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
			return true;
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

	it("copies a user message as its text, without rail or border rules", async () => {
		// The headline case from real use: a drag across a user message box
		// copied the rail, the rules and the padding. Now it copies the message.
		const lines = [
			"previous answer line",
			...userBox(["fix the flaky test", "and the other one"]),
			"next answer line",
		];
		const { prototype, written } = makeLineFixture(lines, wholeTranscript(lines));
		const dispose = installMouse(prototype, { getConfig: makeConfig(true) });

		await prototype.copyActiveSelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe(
			"previous answer line\nfix the flaky test\nand the other one\nnext answer line",
		);
		dispose();
	});

	it("cleans a mid-box drag whose range contains no border row", async () => {
		const box = userBox(["one", "two", "three"]);
		const lines = [...box, "after"];
		const bounds = {
			start: { row: 2, col: 0, scrollView: { name: "transcript" } },
			end: { row: 3, col: WIDTH },
		} as SelectionBounds;
		const { prototype, written } = makeLineFixture(lines, bounds);
		const dispose = installMouse(prototype, { getConfig: makeConfig(true) });

		await prototype.copyActiveSelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe("two\nthree");
		dispose();
	});

	it("slices a mid-row start out of the content, not out of the rail", async () => {
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
		const dispose = installMouse(prototype, { getConfig: makeConfig(true) });

		await prototype.copyActiveSelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe("de");
		dispose();
	});

	it("falls back to Pi's verbatim copy for a selection with no chrome", async () => {
		// A markdown table — square corners — is content. Nothing about it may
		// change on the way to the clipboard.
		const lines = ["┌─ one ─┬─ two ─┐", "│ a     │ b     │", "└─ ─── ─┴─ ─── ─┘"];
		const { prototype, written } = makeLineFixture(lines, wholeTranscript(lines));
		const dispose = installMouse(prototype, { getConfig: makeConfig(true) });

		await prototype.copyActiveSelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe(lines.join("\n"));
		dispose();
	});

	it("leaves screen-space selections to Pi", async () => {
		// No scroll view on the anchor: the selection is over the dock or the
		// status area, not the transcript, and stays byte-for-byte Pi's.
		const lines = ["─".repeat(WIDTH), "│ dock row".padEnd(WIDTH), "─".repeat(WIDTH)];
		const bounds = {
			start: { row: 0, col: 0 },
			end: { row: 2, col: WIDTH },
		} as SelectionBounds;
		const { prototype, written } = makeLineFixture(lines, bounds);
		const dispose = installMouse(prototype, { getConfig: makeConfig(true) });

		await prototype.copyActiveSelectionToClipboard();

		expect(decodeOsc52(written[0])).toBe(lines.map((line) => line.trimEnd()).join("\n"));
		dispose();
	});

	it("consumes a pure-decoration drag without writing the clipboard", async () => {
		// Selecting just a user box's border rules cleans to nothing — Pi's own
		// copy has the same `text.length === 0` shape, it just gets there after
		// building a string of rules.
		const lines = ["plain", ...userBox(["content"]), "plain"];
		const bounds = {
			start: { row: 1, col: 0, scrollView: { name: "transcript" } },
			end: { row: 1, col: WIDTH },
		} as SelectionBounds;
		const { prototype, written } = makeLineFixture(lines, bounds);
		const dispose = installMouse(prototype, { getConfig: makeConfig(true) });

		await prototype.copyActiveSelectionToClipboard();

		expect(written).toEqual([]);
		dispose();
	});
});

describe("installMouse gating for editorClickToCaret", () => {
	it("patches handleViewportInput when editorClickToCaret is the only editor feature enabled", () => {
		// A Pi build that has moved copyActiveSelectionToClipboard disables
		// editorBufferCopy and transcriptCleanCopy (both require it), but NOT
		// editorClickToCaret. The range-delete half of editorClickToCaret lives
		// on the handleViewportInput patch inside installCopying, so the gating
		// must install it even when those features are off — otherwise the
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
