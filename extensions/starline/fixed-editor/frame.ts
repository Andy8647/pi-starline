/**
 * Which cells of a rendered line are a box frame rather than text.
 *
 * Tool boxes, the input box and previous messages are all drawn as frames, and
 * a frame is chrome: it should neither light up under a selection nor come
 * along when one is copied. Pulling it out of a line means knowing where the
 * frame ends and the content starts.
 *
 * A leading vertical is not enough to go on. Pi's markdown draws tables the
 * same way — `│ a │ b │` between `┌─┬─┐` and `├─┼─┤` — and a table's pipes are
 * its content, not chrome around it. So a line only counts as framed when the
 * run it belongs to is capped by a *rule*: a row of nothing but frame glyphs,
 * which a table's T-junctioned borders are not. That one distinction separates
 * every box from every table, with no need to know who drew either.
 *
 * @internal
 */

import { visibleWidth } from "@earendil-works/pi-tui";

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// Lazy: a greedy match would run from one hyperlink's opener to the next
// one's terminator and swallow the visible text in between.
const OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;

function stripAnsi(line: string): string {
	return line.replace(OSC_RE, "").replace(ANSI_RE, "");
}

/**
 * Glyphs a frame's own rules are made of. Deliberately without the T-junctions
 * (`┬ ┴ ├ ┤ ┼`): those are how a table divides its columns, and a table is
 * content.
 */
const RULE_GLYPHS = new Set(["╭", "╮", "╰", "╯", "┌", "┐", "└", "┘", "─", "━", "═", "│", "┃"]);

/** The verticals of a frame, which run down every row of a box. */
const VERTICAL_GLYPHS = new Set(["│", "┃", "┆", "┊"]);

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Visible columns of a plain line, one entry per column. */
function columnsOf(plain: string): string[] {
	const cells: string[] = [];
	for (const { segment } of graphemeSegmenter.segment(plain)) {
		const width = Math.max(1, visibleWidth(segment));
		for (let i = 0; i < width; i++) cells.push(segment);
	}
	return cells;
}

/**
 * A rule row of a box frame: nothing on it but frame glyphs.
 *
 * Body rows carry text between their two verticals and a blank padding row
 * carries spaces, so neither is mistaken for the frame itself. Nor is a table's
 * border, which is what the missing T-junctions above are for.
 */
export function isFrameRuleRow(line: string): boolean {
	const plain = stripAnsi(line).trim();
	if (plain.length < 4) return false;
	for (const char of plain) {
		if (!RULE_GLYPHS.has(char)) return false;
	}
	return true;
}

/** The grapheme at a visible column, or "" past the end of the line. */
function cellAt(plain: string, col: number): string {
	let at = 0;
	for (const { segment } of graphemeSegmenter.segment(plain)) {
		const width = Math.max(1, visibleWidth(segment));
		if (col < at + width) return segment;
		at += width;
	}
	return "";
}

/** Whether the cell at a visible column is one of a frame's verticals. */
export function isFrameEdgeCell(line: string, col: number): boolean {
	if (col < 0) return false;
	return VERTICAL_GLYPHS.has(cellAt(stripAnsi(line), col));
}

/**
 * The columns of a line that carry content, `end` exclusive.
 *
 * `endCol` is `Infinity` when nothing cuts the line short: the span says where
 * chrome begins, not how wide the line is, and a caller may be working on text
 * that has grown since it was rendered — an OSC 8 hyperlink carries its URL
 * into the copy, which no column of the rendered line accounts for.
 */
export type ContentSpan = { startCol: number; endCol: number; framed: boolean };

/** Index of the first cell that is not a space, or -1 for a blank line. */
function firstInk(cells: string[]): number {
	for (let i = 0; i < cells.length; i++) {
		if (cells[i] !== " ") return i;
	}
	return -1;
}

/** Index of the last cell that is not a space, or -1 for a blank line. */
function lastInk(cells: string[]): number {
	for (let i = cells.length - 1; i >= 0; i--) {
		if (cells[i] !== " ") return i;
	}
	return -1;
}

/** How far up to look for the rule that caps a run of framed rows. */
const MAX_FRAME_SCAN = 500;

/**
 * Whether this line is a row of a framed box, judged by the run it sits in:
 * every line above it with a vertical in the same column belongs to the same
 * box, and the row that ends the run has to be a rule.
 *
 * An answer already worked out for a row above ends the walk early, which is
 * what keeps a screenful of one tall box from costing a scan per line: the
 * lines are asked for in order, so all but the first find the row above them
 * already decided.
 */
function isFramedRow(
	lines: string[],
	cache: Map<number, ContentSpan | null>,
	index: number,
	col: number,
): boolean {
	const limit = Math.max(0, index - MAX_FRAME_SCAN);
	for (let above = index - 1; above >= limit; above--) {
		const line = lines[above];
		if (line === undefined) return false;
		if (!isFrameEdgeCell(line, col)) return isFrameRuleRow(line);
		const known = cache.get(above);
		if (known !== undefined) return known !== null && known.framed;
	}
	return false;
}

/**
 * Content span of one line, or null when the line is nothing but frame — a
 * rule, which a selection should skip rather than copy as box drawing.
 *
 * Indentation is left alone: only a frame's own verticals and the single
 * padding cell it puts after one are taken off, so a line that merely starts
 * with spaces keeps them.
 */
const UNFRAMED: ContentSpan = { startCol: 0, endCol: Number.POSITIVE_INFINITY, framed: false };

function computeSpan(
	lines: string[],
	cache: Map<number, ContentSpan | null>,
	index: number,
): ContentSpan | null {
	const line = lines[index];
	if (line === undefined) return UNFRAMED;
	if (isFrameRuleRow(line)) return null;

	const cells = columnsOf(stripAnsi(line));
	const ink = firstInk(cells);
	// A blank line is content: it is the paragraph break inside a box.
	if (ink < 0) return UNFRAMED;

	const cell = cells[ink] ?? "";
	if (!VERTICAL_GLYPHS.has(cell) || !isFramedRow(lines, cache, index, ink)) return UNFRAMED;

	// Past the vertical, and past the one cell of padding a frame puts after it.
	let startCol = ink + 1;
	if (cells[startCol] === " ") startCol++;

	const end = lastInk(cells);
	// The closing vertical, when the frame has one. Trailing padding on the way
	// out is trimmed by the caller either way.
	const endCol =
		end >= startCol && VERTICAL_GLYPHS.has(cells[end] ?? "") ? end : Number.POSITIVE_INFINITY;

	return { startCol, endCol: Math.max(startCol, endCol), framed: true };
}

/** A frame's closing vertical, at the end of text taken off a framed row. */
const TRAILING_FRAME_RE = /[ \t]*[│┃┆┊][ \t]*$/;

/**
 * Take a frame's closing vertical off extracted text.
 *
 * Columns cannot do this job on the way out: extraction expands OSC 8
 * hyperlinks into `text url`, so the text has grown and no longer lines up with
 * the row it was rendered as. The glyph at the end of it does not move.
 */
export function stripTrailingFrame(text: string): string {
	return text.replace(TRAILING_FRAME_RE, "");
}

/**
 * Spans are asked for once per visible line per frame, so they are memoised
 * against the array they were computed from. Pi hands out a fresh array every
 * render, which is exactly when the answers stop being valid.
 */
const spanCache = new WeakMap<string[], Map<number, ContentSpan | null>>();

/**
 * Content span of `lines[index]`, or null when the line is all frame.
 *
 * `lines` is the whole rendered block the line belongs to, not just the part on
 * screen: the rule that proves a box is a box can be anywhere above.
 */
export function frameContentSpan(lines: string[], index: number): ContentSpan | null {
	let cache = spanCache.get(lines);
	if (!cache) {
		cache = new Map();
		spanCache.set(lines, cache);
	}
	const hit = cache.get(index);
	if (hit !== undefined) return hit;
	const span = computeSpan(lines, cache, index);
	cache.set(index, span);
	return span;
}
