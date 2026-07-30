import { describe, expect, it } from "vitest";

import {
	editorVisibleLines,
	scrollEditorBy,
} from "../extensions/starline/fixed-editor/editor-scroll";

/** Rows whose 30% window is exactly 6 visual lines. */
const ROWS = 20;

function makeEditor(lineCount: number, cursorLine = 0, cursorCol = 0) {
	const lines = Array.from({ length: lineCount }, (_, index) => `line ${index}`);
	return {
		state: { lines, cursorLine, cursorCol },
		scrollOffset: 0,
		lastWidth: 40,
		preferredVisualCol: 7 as number | null,
		snappedFromCursorCol: 7 as number | null,
		// One visual line per logical line, which is what an unwrapped input gives.
		buildVisualLineMap: () =>
			lines.map((line, logicalLine) => ({ logicalLine, startCol: 0, length: line.length })),
	};
}

describe("editorVisibleLines", () => {
	it("matches Pi's own window: 30% of rows, never under five", () => {
		expect(editorVisibleLines(20)).toBe(6);
		expect(editorVisibleLines(100)).toBe(30);
		expect(editorVisibleLines(4)).toBe(5);
	});
});

describe("scrollEditorBy", () => {
	it("declines when the whole input already fits, so the transcript can have the wheel", () => {
		const editor = makeEditor(3);
		expect(scrollEditorBy(editor, 3, ROWS)).toBe(false);
		expect(editor.scrollOffset).toBe(0);
	});

	it("declines for anything that is not a Pi editor", () => {
		expect(scrollEditorBy(undefined, 3, ROWS)).toBe(false);
		expect(scrollEditorBy({}, 3, ROWS)).toBe(false);
		expect(scrollEditorBy({ state: { lines: ["a"] } }, 3, ROWS)).toBe(false);
	});

	it("scrolls down and clamps at the end of the content", () => {
		const editor = makeEditor(12);
		expect(scrollEditorBy(editor, 3, ROWS)).toBe(true);
		expect(editor.scrollOffset).toBe(3);
		// 12 visual lines, 6 visible: the last window starts at 6.
		expect(scrollEditorBy(editor, 3, ROWS)).toBe(true);
		expect(editor.scrollOffset).toBe(6);
		expect(scrollEditorBy(editor, 3, ROWS)).toBe(true);
		expect(editor.scrollOffset).toBe(6);
	});

	// Pi re-derives scrollOffset from the caret on every render, so an offset the
	// caret has fallen out of is undone by the next frame.
	it("brings the caret into the new window, or the render would snap back", () => {
		const editor = makeEditor(12, 0, 4);
		scrollEditorBy(editor, 3, ROWS);
		expect(editor.scrollOffset).toBe(3);
		expect(editor.state.cursorLine).toBe(3);
		// The column is kept as far as the target line allows.
		expect(editor.state.cursorCol).toBe(4);
	});

	it("leaves the caret alone when it is already inside the new window", () => {
		const editor = makeEditor(12, 5, 2);
		scrollEditorBy(editor, 3, ROWS);
		expect(editor.scrollOffset).toBe(3);
		expect(editor.state.cursorLine).toBe(5);
		expect(editor.state.cursorCol).toBe(2);
	});

	it("clears the sticky column, so the next up/down press starts from here", () => {
		const editor = makeEditor(12, 0, 4);
		scrollEditorBy(editor, 3, ROWS);
		expect(editor.preferredVisualCol).toBeNull();
		expect(editor.snappedFromCursorCol).toBeNull();
	});

	it("scrolls back up towards the top and clamps there", () => {
		const editor = makeEditor(12, 11, 0);
		editor.scrollOffset = 6;
		expect(scrollEditorBy(editor, -3, ROWS)).toBe(true);
		expect(editor.scrollOffset).toBe(3);
		expect(editor.state.cursorLine).toBe(8);
		expect(scrollEditorBy(editor, -9, ROWS)).toBe(true);
		expect(editor.scrollOffset).toBe(0);
	});

	// Once the pointer is over an editor that scrolls, the wheel belongs to it:
	// chaining on to the transcript at the boundary reads as the box slipping.
	it("still claims the wheel at either boundary", () => {
		const editor = makeEditor(12);
		expect(scrollEditorBy(editor, -3, ROWS)).toBe(true);
		expect(editor.scrollOffset).toBe(0);
	});

	it("declines when the editor throws rather than taking the session down", () => {
		const editor = {
			state: { lines: ["a", "b"] },
			buildVisualLineMap: () => {
				throw new Error("nope");
			},
		};
		expect(scrollEditorBy(editor, 3, ROWS)).toBe(false);
	});
});
