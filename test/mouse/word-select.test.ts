import { sliceByColumn } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { wordRangeAt } from "../../extensions/starline/mouse/word-select";

/**
 * Ported from pi commit `56419be51`
 * (`packages/tui/test/tui-alt-screen.test.ts`, `feat/word-selection-path-chars`),
 * which drove a real double click through `TuiAltScreen` and read the clipboard
 * back. `wordRangeAt` is the pure column-range half of that behaviour — same
 * cases, minus the TUI harness around them. `column` is a terminal column, not
 * a string index (see the wide-character case below), so text is recovered
 * with `sliceByColumn` rather than `line.slice`.
 */
function wordAt(line: string, column: number): string | undefined {
	const range = wordRangeAt(line, column);
	if (!range) return undefined;
	return sliceByColumn(line, range.start, range.end - range.start, true);
}

describe("wordRangeAt", () => {
	it("keeps paths and kebab-case whole on double click", () => {
		expect(wordAt("see src/fixed-editor/a.ts here", 8)).toBe("src/fixed-editor/a.ts");
		expect(wordAt("2026-08-07", 1)).toBe("2026-08-07");
		// Clicking a separator takes the path it belongs to, not the separator.
		expect(wordAt("see src/fixed-editor/a.ts here", 7)).toBe("src/fixed-editor/a.ts");
	});

	it("includes a separator that opens a word", () => {
		expect(wordAt("/Users/andy/Projects", 3)).toBe("/Users/andy/Projects");
		expect(wordAt("/usr/local/bin", 2)).toBe("/usr/local/bin");
		// Clicking the leading separator itself takes the whole path too.
		expect(wordAt("/usr/local/bin", 0)).toBe("/usr/local/bin");
		expect(wordAt("--flag", 4)).toBe("--flag");
		expect(wordAt("-x", 1)).toBe("-x");
		// Whitespace before the run counts the same as the start of the line,
		// and the word before it stays out.
		expect(wordAt("see /usr/bin here", 6)).toBe("/usr/bin");
		expect(wordAt("foo -bar", 5)).toBe("-bar");
	});

	it("does not join a dash that has no word after it", () => {
		expect(wordAt("trailing- rest", 3)).toBe("trailing");
		expect(wordAt("foo/ x", 1)).toBe("foo");
		// A dash used as prose punctuation has whitespace, not a word, beside it.
		expect(wordAt("a - b", 4)).toBe("b");
		expect(wordAt("a -- b", 5)).toBe("b");
	});

	it("does not join a URL scheme across the colon", () => {
		expect(wordAt("see http://a.com/b here", 5)).toBe("http");
		// The `//` is preceded by `:`, so it opens nothing and stays out of the host.
		expect(wordAt("see http://a.com/b here", 12)).toBe("a.com/b");
	});

	it("counts columns, not code points, when joining across a wide character", () => {
		// "你好" spans columns 0-3, so column 1 is inside it.
		expect(wordAt("你好/世界 rest", 1)).toBe("你好/世界");
	});
});
