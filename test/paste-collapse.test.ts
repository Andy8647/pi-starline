import { describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/zentui/config";
import {
	installPasteCollapse,
	shouldCollapse,
	supportsPasteCollapse,
} from "../extensions/zentui/fixed-editor/paste-collapse";

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

/** Stands in for Pi's editor: the members the shadow reaches for, and no more. */
function makeEditor() {
	const inserted: string[] = [];
	const editor = {
		pastes: new Map<number, string>(),
		pasteCounter: 0,
		lastAction: "type-word" as unknown,
		handlePaste: vi.fn(function (this: unknown, _text: string) {}),
		normalizeText: (text: string) => text.replace(/\r\n?/g, "\n").replace(/\t/g, "  "),
		insertTextAtCursorInternal: (text: string) => {
			inserted.push(text);
		},
		cancelAutocomplete: vi.fn(),
		exitHistoryBrowsing: vi.fn(),
		pushUndoSnapshot: vi.fn(),
	};
	return { editor, inserted };
}

describe("pasteCollapseLines config", () => {
	it("defaults to 11, which is Pi's own behaviour", () => {
		expect(defaultConfig.pasteCollapseLines).toBe(11);
		expect(mergeConfig({}).pasteCollapseLines).toBe(11);
	});

	it("accepts 2 through 10", () => {
		for (const value of [2, 3, 5, 10]) {
			expect(mergeConfig({ pasteCollapseLines: value }).pasteCollapseLines).toBe(value);
		}
	});

	// Anything outside the range means "leave Pi alone" rather than clamping into
	// a threshold the user did not ask for.
	it("normalises anything else back to 11", () => {
		for (const value of [0, 1, 11, 50, -3, 2.5, "3", null, true]) {
			expect(mergeConfig({ pasteCollapseLines: value }).pasteCollapseLines).toBe(11);
		}
	});
});

describe("shouldCollapse", () => {
	it("collapses at or above the configured line count", () => {
		expect(shouldCollapse(lines(3), 3)).toBe(true);
		expect(shouldCollapse(lines(5), 3)).toBe(true);
	});

	it("leaves shorter pastes inline", () => {
		expect(shouldCollapse(lines(2), 3)).toBe(false);
		expect(shouldCollapse("one line", 3)).toBe(false);
	});

	// Above Pi's own threshold Pi collapses it itself; taking over would double up.
	it("defers to Pi above its own thresholds", () => {
		expect(shouldCollapse(lines(11), 3)).toBe(false);
		expect(shouldCollapse(`${"x".repeat(1001)}\n\n`, 3)).toBe(false);
	});

	it("does nothing outside the 2..10 range", () => {
		expect(shouldCollapse(lines(5), 11)).toBe(false);
		expect(shouldCollapse(lines(5), 1)).toBe(false);
	});

	// Pi reformats pasted paths; leave those entirely to it.
	it("leaves pasted paths alone", () => {
		for (const prefix of ["/", "~", "."]) {
			expect(shouldCollapse(`${prefix}some/path\nsecond\nthird`, 3)).toBe(false);
		}
	});
});

describe("supportsPasteCollapse", () => {
	it("accepts an editor with everything it needs", () => {
		expect(supportsPasteCollapse(makeEditor().editor)).toBe(true);
	});

	it("rejects anything missing a piece", () => {
		const { editor } = makeEditor();
		expect(supportsPasteCollapse(undefined)).toBe(false);
		expect(supportsPasteCollapse({})).toBe(false);
		expect(supportsPasteCollapse({ ...editor, pastes: {} })).toBe(false);
		expect(supportsPasteCollapse({ ...editor, normalizeText: undefined })).toBe(false);
		expect(supportsPasteCollapse({ ...editor, insertTextAtCursorInternal: undefined })).toBe(false);
	});
});

describe("installPasteCollapse", () => {
	it("does not patch an editor it cannot drive", () => {
		expect(installPasteCollapse({}, () => 3)).toBeUndefined();
	});

	it("collapses a paste Pi would have left inline", () => {
		const { editor, inserted } = makeEditor();
		installPasteCollapse(editor, () => 3);
		editor.handlePaste(lines(4));

		expect(inserted).toEqual(["[paste #1 +4 lines]"]);
		expect(editor.pastes.get(1)).toBe(lines(4));
		expect(editor.pasteCounter).toBe(1);
	});

	it("keeps ids climbing across pastes", () => {
		const { editor, inserted } = makeEditor();
		installPasteCollapse(editor, () => 3);
		editor.handlePaste(lines(4));
		editor.handlePaste(lines(5));

		expect(inserted).toEqual(["[paste #1 +4 lines]", "[paste #2 +5 lines]"]);
		expect(editor.pastes.get(2)).toBe(lines(5));
	});

	it("mirrors the bookkeeping Pi does around its own collapse", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 3);
		editor.handlePaste(lines(4));

		expect(editor.cancelAutocomplete).toHaveBeenCalled();
		expect(editor.exitHistoryBrowsing).toHaveBeenCalled();
		expect(editor.pushUndoSnapshot).toHaveBeenCalled();
		expect(editor.lastAction).toBeNull();
	});

	// What is stored has to be what Pi would have stored, or the marker expands
	// to the wrong text on submit.
	it("stores text cleaned the way Pi cleans it", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 3);
		editor.handlePaste("a\r\nb\tc\r\nde\n");

		expect(editor.pastes.get(1)).toBe("a\nb  c\nde\n");
	});

	it("decodes the CSI-u control re-encoding some terminals apply", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 2);
		// ESC [ 106 ; 5 u is Ctrl+J, a newline.
		editor.handlePaste("a\x1b[106;5ub\x1b[106;5uc");

		expect(editor.pastes.get(1)).toBe("a\nb\nc");
	});

	it("hands back to Pi when it would not collapse", () => {
		const base = makeEditor();
		const original = base.editor.handlePaste;
		installPasteCollapse(base.editor, () => 3);
		base.editor.handlePaste("one line");

		expect(original).toHaveBeenCalledWith("one line");
		expect(base.inserted).toEqual([]);
	});

	it("hands back to Pi above Pi's own threshold", () => {
		const base = makeEditor();
		const original = base.editor.handlePaste;
		installPasteCollapse(base.editor, () => 3);
		base.editor.handlePaste(lines(20));

		expect(original).toHaveBeenCalled();
		expect(base.inserted).toEqual([]);
	});

	it("hands back to Pi at the default threshold", () => {
		const base = makeEditor();
		const original = base.editor.handlePaste;
		installPasteCollapse(base.editor, () => 11);
		base.editor.handlePaste(lines(4));

		expect(original).toHaveBeenCalled();
		expect(base.inserted).toEqual([]);
	});

	// A thrown paste is a lost paste, which is the one outcome worth guarding.
	it("falls back to Pi rather than swallowing a paste that throws", () => {
		const base = makeEditor();
		const original = base.editor.handlePaste;
		installPasteCollapse(base.editor, () => {
			throw new Error("config blew up");
		});
		expect(() => base.editor.handlePaste(lines(4))).not.toThrow();
		expect(original).toHaveBeenCalledWith(lines(4));
	});

	it("restores Pi's handler when disposed", () => {
		const { editor, inserted } = makeEditor();
		const original = editor.handlePaste;
		const dispose = installPasteCollapse(editor, () => 3);
		dispose?.();

		editor.handlePaste(lines(4));
		expect(original).toHaveBeenCalled();
		expect(inserted).toEqual([]);
	});

	it("reads the threshold at paste time, not install time", () => {
		const { editor, inserted } = makeEditor();
		let minLines = 11;
		installPasteCollapse(editor, () => minLines);

		editor.handlePaste(lines(4));
		expect(inserted).toEqual([]);

		minLines = 3;
		editor.handlePaste(lines(4));
		expect(inserted).toEqual(["[paste #1 +4 lines]"]);
	});
});
