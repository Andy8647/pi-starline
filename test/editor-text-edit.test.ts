import { describe, expect, it, vi } from "vitest";
import { deleteEditorVisualRange } from "../extensions/starline/mouse/editor-text-edit";

/**
 * Stands in for Pi's editor: the members the splice reaches for, plus a visual
 * line map that wraps at `width`, the way Pi's own does.
 */
function makeEditor(lines: string[], width = 10) {
	const editor = {
		state: { lines: [...lines], cursorLine: 0, cursorCol: 0 },
		lastWidth: width,
		scrollOffset: 0,
		preferredVisualCol: 3 as number | null,
		snappedFromCursorCol: 3 as number | null,
		lastAction: "type-word" as unknown,
		pushUndoSnapshot: vi.fn(),
		cancelAutocomplete: vi.fn(),
		exitHistoryBrowsing: vi.fn(),
		onChange: vi.fn(),
		setCursorCol: (col: number) => {
			editor.state.cursorCol = col;
		},
		buildVisualLineMap: (w: number) => {
			const map: { logicalLine: number; startCol: number; length: number }[] = [];
			editor.state.lines.forEach((line, logicalLine) => {
				if (line.length === 0) {
					map.push({ logicalLine, startCol: 0, length: 0 });
					return;
				}
				for (let startCol = 0; startCol < line.length; startCol += w) {
					map.push({ logicalLine, startCol, length: Math.min(w, line.length - startCol) });
				}
			});
			return map;
		},
	};
	return editor;
}

const text = (editor: ReturnType<typeof makeEditor>) => editor.state.lines.join("\n");

describe("deleteEditorVisualRange", () => {
	it("cuts a range out of one line", () => {
		const editor = makeEditor(["hello world"], 20);
		expect(
			deleteEditorVisualRange(
				editor,
				{ visualRow: 0, visualCol: 5 },
				{ visualRow: 0, visualCol: 11 },
			),
		).toBe(true);
		expect(text(editor)).toBe("hello");
		expect(editor.state.cursorLine).toBe(0);
		expect(editor.state.cursorCol).toBe(5);
	});

	it("joins the ends when the range spans logical lines", () => {
		const editor = makeEditor(["first", "second", "third"], 20);
		deleteEditorVisualRange(editor, { visualRow: 0, visualCol: 2 }, { visualRow: 2, visualCol: 3 });
		expect(text(editor)).toBe("fird");
		expect(editor.state.cursorCol).toBe(2);
	});

	// Rows on screen are visual, not logical: a wrapped line is several rows.
	it("resolves wrapped rows through the visual line map", () => {
		const editor = makeEditor(["abcdefghijklmnopqrst"], 10);
		deleteEditorVisualRange(editor, { visualRow: 1, visualCol: 2 }, { visualRow: 1, visualCol: 6 });
		expect(text(editor)).toBe("abcdefghijklqrst");
	});

	// Rows are absolute — indices into the editor's whole text, which is how a
	// selection stores them so that scrolling the box cannot move it.
	it("counts rows through the whole text, not from the top of the box", () => {
		const editor = makeEditor(["one", "two", "three"], 20);
		editor.scrollOffset = 1;
		deleteEditorVisualRange(editor, { visualRow: 0, visualCol: 0 }, { visualRow: 0, visualCol: 3 });
		expect(text(editor)).toBe("\ntwo\nthree");
	});

	it("works whichever way round the two points come", () => {
		const editor = makeEditor(["hello world"], 20);
		deleteEditorVisualRange(
			editor,
			{ visualRow: 0, visualCol: 11 },
			{ visualRow: 0, visualCol: 5 },
		);
		expect(text(editor)).toBe("hello");
	});

	it("pushes an undo snapshot and announces the change", () => {
		const editor = makeEditor(["hello world"], 20);
		deleteEditorVisualRange(editor, { visualRow: 0, visualCol: 0 }, { visualRow: 0, visualCol: 6 });
		expect(editor.pushUndoSnapshot).toHaveBeenCalledTimes(1);
		expect(editor.cancelAutocomplete).toHaveBeenCalled();
		expect(editor.exitHistoryBrowsing).toHaveBeenCalled();
		expect(editor.lastAction).toBeNull();
		expect(editor.onChange).toHaveBeenCalledWith("world");
		// The sticky column belonged to where the cursor was before.
		expect(editor.preferredVisualCol).toBeNull();
		expect(editor.snappedFromCursorCol).toBeNull();
	});

	it("refuses an empty range and leaves everything alone", () => {
		const editor = makeEditor(["hello"], 20);
		expect(
			deleteEditorVisualRange(
				editor,
				{ visualRow: 0, visualCol: 2 },
				{ visualRow: 0, visualCol: 2 },
			),
		).toBe(false);
		expect(text(editor)).toBe("hello");
		expect(editor.pushUndoSnapshot).not.toHaveBeenCalled();
	});

	it("refuses a row that is not in the text", () => {
		const editor = makeEditor(["hello"], 20);
		expect(
			deleteEditorVisualRange(
				editor,
				{ visualRow: 0, visualCol: 0 },
				{ visualRow: 9, visualCol: 0 },
			),
		).toBe(false);
		expect(text(editor)).toBe("hello");
	});

	it("refuses an editor it cannot drive", () => {
		expect(
			deleteEditorVisualRange({}, { visualRow: 0, visualCol: 0 }, { visualRow: 0, visualCol: 1 }),
		).toBe(false);
		expect(
			deleteEditorVisualRange(
				undefined,
				{ visualRow: 0, visualCol: 0 },
				{ visualRow: 0, visualCol: 1 },
			),
		).toBe(false);
	});

	it("never lets the editor end up with no lines at all", () => {
		const editor = makeEditor(["only"], 20);
		deleteEditorVisualRange(editor, { visualRow: 0, visualCol: 0 }, { visualRow: 0, visualCol: 4 });
		expect(editor.state.lines).toEqual([""]);
	});
});
