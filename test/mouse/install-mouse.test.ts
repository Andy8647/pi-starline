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
 * A selection over a real, framed tool box, in the layout Pi really builds.
 *
 * The transcript is pi-tui's own `Container` holding one framed expandable
 * component, and the rows come from calling `render` on it — not from a
 * hand-written array, and not from a layout tree with a box per message, which
 * pi-tui never produces (pinned in `test/contract/transcript-layout.test.ts`).
 *
 * The frame is the point of the fixture now that frame-free selection is cut:
 * these rows must reach the clipboard with their border on.
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
	let requestRender: () => void;

	beforeEach(() => {
		requestRender = vi.fn();
	});

	it("arms with the exact character count of the text Pi itself would copy", () => {
		// The hint promises "N characters selected"; N has to be what ctrl+c
		// actually puts on the clipboard. Starline no longer rewrites that text,
		// so the count is the length of Pi's own — asserted against the bytes
		// Pi's copy writes, not against a number written down here.
		const { prototype, written, piCopyText } = makeTranscriptFixture();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(false, true),
			requestRender,
		});

		prototype.copySelectionToClipboard(); // release: arms, copies nothing

		expect(written).toEqual([]);
		expect(activeSelectionHintText()).toBe(
			`${piCopyText.length} characters selected, ctrl+c to copy`,
		);

		prototype.handleViewportInput("\x03");
		expect(decodeOsc52(written[0])).toBe(piCopyText);
		expect(decodeOsc52(written[0]).length).toBe(piCopyText.length);
		dispose();
	});

	it("puts a tool box's border on the clipboard, unmodified", () => {
		// Frame-free selection is cut: nothing strips a border, drops a rule row
		// or shortens a line on the way out. This is the assertion that would go
		// red if any of it came back without a decision.
		const { prototype, written, lines, piCopyText } = makeTranscriptFixture();
		const dispose = installMouse(prototype, {
			getConfig: makeConfig(true, true),
			requestRender,
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

	it("patches nothing at all when selectionPendingMode cannot install", () => {
		// selectionPendingMode is now the only feature `installMouse` installs,
		// so a build without handleViewportInput gets no patch anywhere —
		// in particular none on copySelectionToClipboard, which used to be
		// patched independently for frame-free copying.
		const { prototype } = makeTranscriptFixture();
		const { handleViewportInput: _dropped, ...withoutViewportInput } = prototype;
		const original = withoutViewportInput.copySelectionToClipboard;

		const dispose = installMouse(withoutViewportInput, {
			getConfig: makeConfig(false, true),
			requestRender,
		});

		expect(withoutViewportInput.copySelectionToClipboard).toBe(original);
		expect(activeSelectionHintText()).toBeNull();

		withoutViewportInput.copySelectionToClipboard();
		expect(activeSelectionHintText()).toBeNull();
		dispose();
	});
});
