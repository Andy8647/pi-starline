import { describe, expect, it } from "vitest";
import { cleanTranscriptRows } from "../../extensions/starline/mouse/transcript-copy";

/** pi-tidy's "rail" user message: full-width rules, rail + space rows. */
function starlineUserBox(lines: readonly string[], width: number): string[] {
	const rule = "─".repeat(width);
	const body = lines.map((line) => `│ ${line}`.padEnd(width));
	return [rule, ...body, rule];
}

/** `drawToolboxFrame`'s shape: rounded corners, verticals on both sides. */
function toolboxFrame(lines: readonly string[], width: number): string[] {
	const inner = width - 2;
	return [
		`╭${"─".repeat(inner)}╮`,
		...lines.map((line) => `│${line.padEnd(inner)}│`),
		`╰${"─".repeat(inner)}╯`,
	];
}

describe("cleanTranscriptRows", () => {
	it("strips the rail and drops the borders of a starline user box", () => {
		const lines = ["some earlier output", ...starlineUserBox(["hello world", "second line"], 20)];
		const { rows, changed } = cleanTranscriptRows(lines, 1, 4);
		expect(changed).toBe(true);
		expect(rows).toEqual([
			null,
			{ text: "hello world".padEnd(18), leftTrim: 2 },
			{ text: "second line".padEnd(18), leftTrim: 2 },
			null,
		]);
	});

	it("strips rails on a mid-box selection whose edges it never saw", () => {
		// The drag starts on the second content row: the selection contains no
		// border row at all, but the rows are still the box's. Classification
		// scans the whole buffer, so the answer does not depend on the drag
		// happening to include an edge.
		const box = starlineUserBox(["one", "two", "three"], 20);
		const lines = [...box, "after"];
		const { rows, changed } = cleanTranscriptRows(lines, 2, 3);
		expect(changed).toBe(true);
		expect(rows).toEqual([
			{ text: "two".padEnd(18), leftTrim: 2 },
			{ text: "three".padEnd(18), leftTrim: 2 },
		]);
	});

	it("strips both verticals of a pi-toolbox frame and keeps a table's pipes", () => {
		const lines = toolboxFrame(["$ run", "│ a │ b │"], 20);
		const { rows, changed } = cleanTranscriptRows(lines, 0, lines.length - 1);
		expect(changed).toBe(true);
		expect(rows[0]).toBeNull();
		expect(rows[rows.length - 1]).toBeNull();
		// One vertical comes off each side; the table's own pipes stay.
		expect(rows[2]).toEqual({ text: "│ a │ b │".padEnd(18).slice(0, 18), leftTrim: 1 });
	});

	it("leaves a markdown table — square corners — byte-identical", () => {
		// pi-tui's own table rendering: ┌─┬─┐ / │ · │ / ├─┼─┤ / └─┴─┘. None of
		// the recognised markers match, so the caller falls back to Pi's
		// verbatim copy and the table survives whole — the regression the cut
		// frame-free task kept producing.
		const lines = [
			"┌─ one ─┬─ two ─┐",
			"│ a     │ b     │",
			"├─ ─── ─┼─ ─── ─┤",
			"└─ ─── ─┴─ ─── ─┘",
		];
		const { rows, changed } = cleanTranscriptRows(lines, 0, 3);
		expect(changed).toBe(false);
		expect(rows.map((row) => row?.text)).toEqual(lines);
	});

	it("leaves a blockquote gutter alone", () => {
		// A blockquote renders as `│ text` with no closing vertical and no rule
		// pair around it — starting with the rail glyph is not enough to be
		// chrome.
		const lines = ["│ quoted text", "│ more quoted"];
		const { changed } = cleanTranscriptRows(lines, 0, 1);
		expect(changed).toBe(false);
	});

	it("does not pair an assistant's own rules across plain content", () => {
		// Two markdown horizontal rules with ordinary text between them: the
		// text carries no rail, which breaks the candidate, so nothing is
		// dropped.
		const lines = ["─".repeat(20), "plain paragraph", "─".repeat(20)];
		const { rows, changed } = cleanTranscriptRows(lines, 0, 2);
		expect(changed).toBe(false);
		expect(rows.every((row) => row !== null)).toBe(true);
	});

	it("takes tidy's bare padding rows as part of the message and empties them", () => {
		// `userMessagePaddingY` rows are the rail alone, with no space after it.
		const lines = ["─".repeat(20), "│", "│ hello", "│", "─".repeat(20)];
		const { rows, changed } = cleanTranscriptRows(lines, 0, 4);
		expect(changed).toBe(true);
		expect(rows).toEqual([
			null,
			{ text: "", leftTrim: 1 },
			{ text: "hello", leftTrim: 2 },
			{ text: "", leftTrim: 1 },
			null,
		]);
	});

	it("takes tidy's user icon and the indent hanging under it off as well", () => {
		const lines = [
			"─".repeat(20),
			"│ \u{f007} first",
			"│   second",
			"│     indented",
			"─".repeat(20),
		];
		const { rows, changed } = cleanTranscriptRows(lines, 0, 4);
		expect(changed).toBe(true);
		expect(rows).toEqual([
			null,
			{ text: "first", leftTrim: 4 },
			{ text: "second", leftTrim: 4 },
			// Only the hang comes off; the text's own indent stays.
			{ text: "  indented", leftTrim: 4 },
			null,
		]);
	});

	it("leaves the indent alone in a message without the icon", () => {
		const lines = ["─".repeat(20), "│ first", "│   indented", "─".repeat(20)];
		const { rows } = cleanTranscriptRows(lines, 0, 3);
		expect(rows[2]).toEqual({ text: "  indented", leftTrim: 2 });
	});

	it("requires equal widths to pair rules", () => {
		const lines = ["─".repeat(20), "│ content", "─".repeat(12)];
		const { changed } = cleanTranscriptRows(lines, 0, 2);
		expect(changed).toBe(false);
	});

	it("unwraps a frame whose top edge carries a label", () => {
		const lines = ["╭─ \u{f007} you ─────╮", "│ hello there │", "╰─────────────╯"];
		const { rows, changed } = cleanTranscriptRows(lines, 0, 2);
		expect(changed).toBe(true);
		expect(rows).toEqual([null, { text: " hello there ", leftTrim: 1 }, null]);
	});

	it("requires equal widths to pair rounded frame edges", () => {
		const lines = ["╭────────╮", "│ inner  │", "╰──╯"];
		const { rows, changed } = cleanTranscriptRows(lines, 0, 2);
		expect(changed).toBe(false);
		expect(rows[1]?.text).toBe("│ inner  │");
	});

	it("drops a selection that is pure decoration down to nothing", () => {
		const lines = starlineUserBox(["content"], 20);
		const { rows, changed } = cleanTranscriptRows(lines, 0, 2);
		expect(changed).toBe(true);
		expect(rows.filter((row) => row !== null)).toEqual([
			{ text: "content".padEnd(18), leftTrim: 2 },
		]);
	});

	it("keeps rows outside every box verbatim within a cleaned selection", () => {
		const lines = ["plain before", ...starlineUserBox(["boxed"], 20), "plain after"];
		const { rows, changed } = cleanTranscriptRows(lines, 0, 4);
		expect(changed).toBe(true);
		expect(rows[0]).toEqual({ text: "plain before", leftTrim: 0 });
		expect(rows[4]).toEqual({ text: "plain after", leftTrim: 0 });
	});

	it("strips a row spanning two adjacent user boxes without eating the gap", () => {
		// Box 1's bottom rule and box 2's top rule are adjacent; the pass must
		// not pair box 1's bottom with box 2's top across zero content rows.
		const lines = [...starlineUserBox(["first"], 20), ...starlineUserBox(["second"], 20)];
		const { rows, changed } = cleanTranscriptRows(lines, 0, lines.length - 1);
		expect(changed).toBe(true);
		expect(rows).toEqual([
			null,
			{ text: "first".padEnd(18), leftTrim: 2 },
			null,
			null,
			{ text: "second".padEnd(18), leftTrim: 2 },
			null,
		]);
	});

	it("leaves a bash box verbatim: its rows carry no rail", () => {
		// `BashExecutionComponent` wraps its output in DynamicBorder's full-width
		// rules, but its content rows start with a space (paddingX=1), not the
		// rail — so no rule pair forms and the whole box copies as Pi rendered
		// it. This pins that: a table in bash output must never lose a border
		// to cleaning (the failure the cut frame-free task kept producing).
		const lines = ["─".repeat(20), " $ ls", " │ a │ b │", "─".repeat(20)];
		const { rows, changed } = cleanTranscriptRows(lines, 0, 3);
		expect(changed).toBe(false);
		expect(rows.map((row) => row?.text)).toEqual(lines);
	});

	it("handles selections past the end of the buffer", () => {
		const lines = starlineUserBox(["short"], 10);
		const { rows } = cleanTranscriptRows(lines, 1, 8);
		expect(rows[0]).toEqual({ text: "short".padEnd(8), leftTrim: 2 });
		expect(rows[rows.length - 1]).toEqual({ text: "", leftTrim: 0 });
	});

	it("cleans content with wide characters without splitting them", () => {
		// The rail trim is by whole prefix, and `leftTrim` is a *column* count —
		// the caller subtracts it before Pi's grapheme-aligned slicing, so a CJK
		// draft survives exactly.
		const lines = starlineUserBox(["你好世界"], 20);
		const { rows } = cleanTranscriptRows(lines, 1, 1);
		expect(rows[0]?.text.startsWith("你好世界")).toBe(true);
		expect(rows[0]?.leftTrim).toBe(2);
	});
});
