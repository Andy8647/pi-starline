import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/starline/config";
import {
	applyEditorCursorStyle,
	applyEditorCursorStyleToLines,
	parseEditorCursorStyle,
} from "../extensions/starline/editor-cursor";

// What Pi's editor emits: the zero-width cursor marker, then a reverse-video
// run around the grapheme under the cursor.
const MARKER = "\x1b_pi:c\x07";
const onChar = `hello ${MARKER}\x1b[7mw\x1b[0morld`;
const atEnd = `hello${MARKER}\x1b[7m \x1b[0m`;

describe("parseEditorCursorStyle", () => {
	it("defaults to block", () => {
		expect(parseEditorCursorStyle(undefined)).toBe("block");
		expect(parseEditorCursorStyle("beam")).toBe("block");
		expect(parseEditorCursorStyle(1)).toBe("block");
	});

	it("accepts the three styles", () => {
		expect(parseEditorCursorStyle("block")).toBe("block");
		expect(parseEditorCursorStyle("underline")).toBe("underline");
		expect(parseEditorCursorStyle("terminal")).toBe("terminal");
	});
});

describe("applyEditorCursorStyle", () => {
	it("leaves the line untouched in block mode", () => {
		expect(applyEditorCursorStyle(onChar, "block")).toBe(onChar);
	});

	it("swaps the reverse block for an underline", () => {
		expect(applyEditorCursorStyle(onChar, "underline")).toBe(`hello ${MARKER}\x1b[4mw\x1b[0morld`);
		expect(applyEditorCursorStyle(atEnd, "underline")).toBe(`hello${MARKER}\x1b[4m \x1b[0m`);
	});

	it("removes the software cursor in terminal mode", () => {
		expect(applyEditorCursorStyle(onChar, "terminal")).toBe(`hello ${MARKER}world`);
		expect(applyEditorCursorStyle(atEnd, "terminal")).toBe(`hello${MARKER} `);
	});

	// The cursor marker drives both the caret centring in the fixed editor and
	// the hardware cursor placement. Losing it would break both.
	it("preserves the cursor marker in every mode", () => {
		for (const style of ["block", "underline", "terminal"] as const) {
			expect(applyEditorCursorStyle(onChar, style)).toContain(MARKER);
		}
	});

	it("leaves multi-character reverse runs alone", () => {
		const highlight = "a \x1b[7mabc\x1b[0m b";
		expect(applyEditorCursorStyle(highlight, "underline")).toBe(highlight);
		expect(applyEditorCursorStyle(highlight, "terminal")).toBe(highlight);
	});

	it("handles graphemes wider than one code unit", () => {
		expect(applyEditorCursorStyle("\x1b[7m🎉\x1b[0m", "underline")).toBe("\x1b[4m🎉\x1b[0m");
		expect(applyEditorCursorStyle("\x1b[7m🎉\x1b[0m", "terminal")).toBe("🎉");
		// A flag is one grapheme made of two regional indicators.
		expect(applyEditorCursorStyle("\x1b[7m🇯🇵\x1b[0m", "terminal")).toBe("🇯🇵");
	});

	it("leaves a line with no cursor alone", () => {
		const plain = "\x1b[38;2;1;2;3mjust text\x1b[39m";
		expect(applyEditorCursorStyle(plain, "underline")).toBe(plain);
	});

	it("leaves an empty reverse run alone", () => {
		const empty = "\x1b[7m\x1b[0m";
		expect(applyEditorCursorStyle(empty, "terminal")).toBe(empty);
	});
});

describe("applyEditorCursorStyleToLines", () => {
	it("returns the same array in block mode", () => {
		const lines = [onChar, "other"];
		expect(applyEditorCursorStyleToLines(lines, "block")).toBe(lines);
	});

	it("maps every line otherwise", () => {
		expect(applyEditorCursorStyleToLines([onChar, "plain"], "terminal")).toEqual([
			`hello ${MARKER}world`,
			"plain",
		]);
	});
});

describe("editorCursor config", () => {
	it("defaults to block", () => {
		expect(defaultConfig.editorCursor).toBe("block");
	});

	it("parses the configured value", () => {
		expect(mergeConfig({ editorCursor: "terminal" }).editorCursor).toBe("terminal");
		expect(mergeConfig({ editorCursor: "underline" }).editorCursor).toBe("underline");
		expect(mergeConfig({ editorCursor: "beam" }).editorCursor).toBe("block");
	});

	// The powerline fork replaced a dead editorCursorBlink option with this one;
	// SGR blink is ignored by Ghostty and others, so it was not carried over.
	it("does not resurrect editorCursorBlink", () => {
		expect("editorCursorBlink" in defaultConfig).toBe(false);
	});
});
