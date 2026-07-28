/**
 * Drag-to-select state, highlight rendering, and text extraction.
 *
 * The selection operates on raw transcript lines (ANSI-styled strings).
 * Highlight uses SGR 7 (inverse video) / SGR 27 (inverse off).
 *
 * @internal
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/** ANSI / OSC escape sequence patterns for stripping. */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

function stripAnsi(line: string): string {
	return line.replace(OSC_RE, "").replace(ANSI_RE, "");
}

/** OSC 8 hyperlink: \x1b]8;;params ST TEXT \x1b]8;; ST
 * Supports both ST (\x1b\\) and BEL (\x07) terminators. */
const OSC8_RE = /\x1b\]8;;([^\x1b\x07]*)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;;(?:\x07|\x1b\\)/g;

/**
 * Replace OSC 8 hyperlinks with their URL before stripping.
 * Format: \x1b]8;;[key=val;]URL\x1b\\TEXT\x1b]8;;\x1b\\
 * If the URL differs from the visible text, both are included.
 */
function extractOsc8Links(line: string): string {
	return line.replace(OSC8_RE, (_match, params: string, text: string) => {
		const parts = params.split(";");
		const url = parts[parts.length - 1] ?? "";
		const visible = stripAnsi(text);
		if (!url) return visible;
		if (visible && visible !== url) return `${visible} ${url}`;
		return url;
	});
}

/** Background laid over the selected run. Foreground styling is left alone. */
const HIGHLIGHT_BG = "\x1b[48;5;238m";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Slice text by visible column boundaries (grapheme-aware). */
function sliceColumns(text: string, startCol: number, endCol: number): string {
	let col = 0;
	let result = "";
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const width = Math.max(0, visibleWidth(segment));
		if (col >= startCol && col < endCol) result += segment;
		col += width;
	}
	return result;
}

function comparePoints(a: { line: number; col: number }, b: { line: number; col: number }): number {
	return a.line === b.line ? a.col - b.col : a.line - b.line;
}

/** Track an in-progress drag selection over transcript lines. */
export class SelectionState {
	private anchor: { line: number; col: number } | null = null;
	private focus: { line: number; col: number } | null = null;
	private dragging = false;

	start(line: number, col: number): void {
		this.anchor = { line, col };
		this.focus = { line, col };
		this.dragging = true;
	}

	extend(line: number, col: number): void {
		this.focus = { line, col };
	}

	clear(): void {
		this.anchor = null;
		this.focus = null;
		this.dragging = false;
	}

	get active(): boolean {
		return this.anchor !== null && this.focus !== null;
	}

	get isDragging(): boolean {
		return this.dragging;
	}

	setDragging(value: boolean): void {
		this.dragging = value;
	}

	/**
	 * Normalized (start ≤ end) selection bounds, with `end` exclusive.
	 *
	 * Anchor and focus are both *cell* coordinates — the cell the pointer was
	 * over. Whichever ends up later gets its column pushed one past itself, so
	 * the cell under the pointer is inside the selection whichever way the drag
	 * went. Doing it here rather than at extend time is what makes a backward
	 * drag symmetric: adding one at extend time only ever included the far end of
	 * a forward drag, and dropped a character at each end of a backward one.
	 */
	private get bounds(): {
		start: { line: number; col: number };
		end: { line: number; col: number };
	} | null {
		if (!this.anchor || !this.focus) return null;
		const forward = comparePoints(this.anchor, this.focus) <= 0;
		const start = forward ? this.anchor : this.focus;
		const end = forward ? this.focus : this.anchor;
		return { start, end: { line: end.line, col: end.col + 1 } };
	}

	/**
	 * Get column range for a given line index, or null if line is not selected.
	 *
	 * `minCol` keeps a selection out of chrome to the left of the text — the
	 * editor box's rail, which is neither selectable nor worth copying. Rows that
	 * end before it are not selected at all.
	 */
	getRangeForLine(lineIndex: number, minCol = 0): { startCol: number; endCol: number } | null {
		const b = this.bounds;
		if (!b) return null;
		if (lineIndex < b.start.line || lineIndex > b.end.line) return null;
		const startCol = Math.max(minCol, lineIndex === b.start.line ? b.start.col : 0);
		const endCol = lineIndex === b.end.line ? b.end.col : Number.POSITIVE_INFINITY;
		if (endCol <= startCol) return null;
		return { startCol, endCol };
	}

	/**
	 * Extract selected text from raw lines.
	 * @param lines Full array of transcript lines (ANSI-styled).
	 * @param minCol First selectable column, past any chrome on the left.
	 * @returns Stripped text, or "" if selection is empty.
	 */
	getSelectedText(lines: string[], minCol = 0): string {
		const b = this.bounds;
		if (!b) return "";
		if (b.start.line === b.end.line && b.start.col === b.end.col) return "";

		const selected: string[] = [];
		for (let i = b.start.line; i <= b.end.line; i++) {
			const plain = stripAnsi(extractOsc8Links(lines[i] ?? ""));
			const range = this.getRangeForLine(i, minCol);
			if (!range) {
				selected.push("");
				continue;
			}
			const { startCol, endCol } = range;
			selected.push(sliceColumns(plain, startCol, endCol));
		}
		return selected
			.join("\n")
			.replace(/[ \t]+$/gm, "")
			.trimEnd();
	}
}

/**
 * Apply inverse-video highlight to a rendered line for the current selection.
 * Preserves all original ANSI styling (colors, bold, etc.) — only layers
 * a subtle background tint (SGR 48; 256-color dark gray) on top of the
 * selected range so original foreground colors remain visible.
 *
 * A line may carry its own resets (`\x1b[0m`), which clear the tint along with
 * everything else. Inside the selected run the tint is therefore re-asserted
 * after every escape sequence: without it, one reset mid-line leaves the rest of
 * a selected row looking unselected.
 *
 * @param line The raw ANSI-styled line.
 * @param lineIndex The absolute transcript line index.
 * @param selection Current selection state.
 * @param minCol First selectable column, past any chrome on the left.
 */
export function highlightSelection(
	line: string,
	lineIndex: number,
	selection: SelectionState,
	minCol = 0,
): string {
	const range = selection.getRangeForLine(lineIndex, minCol);
	if (!range) return line;

	const maxCol = visibleWidth(line);
	const startCol = Math.max(0, Math.min(range.startCol, maxCol));
	const endCol = Math.max(startCol + 1, Math.min(range.endCol, maxCol));
	if (startCol >= endCol) return line;

	let result = "";
	let col = 0;
	let inverseOn = false;
	let i = 0;

	while (i < line.length) {
		// Close the run as soon as the columns say so, before anything else is
		// emitted: an escape sequence sitting right past the end must not be
		// dragged inside the highlight.
		if (inverseOn && col >= endCol) {
			result += "\x1b[49m";
			inverseOn = false;
		}

		// Escape sequence — pass through, does not consume visible columns. The
		// tint goes back on after it, since the sequence may have reset it.
		if (line[i] === "\x1b") {
			if (line[i + 1] === "[") {
				// CSI: \x1b[...final-byte
				let j = i + 2;
				while (j < line.length && !/[@-~]/.test(line[j] ?? "")) j++;
				j++;
				result += line.slice(i, j);
				if (inverseOn) result += HIGHLIGHT_BG;
				i = j;
				continue;
			}
			if (line[i + 1] === "]") {
				// OSC: \x1b]...BEL or \x1b]...ST
				let j = i + 2;
				while (
					j < line.length &&
					line[j] !== "\x07" &&
					!(line[j] === "\x1b" && line[j + 1] === "\\")
				)
					j++;
				if (line[j] === "\x07") j++;
				else j += 2;
				result += line.slice(i, j);
				if (inverseOn) result += HIGHLIGHT_BG;
				i = j;
				continue;
			}
			// Other escape: ESC + single char
			result += line.slice(i, i + 2);
			if (inverseOn) result += HIGHLIGHT_BG;
			i += 2;
			continue;
		}

		// Visible character.
		const char = line[i] ?? "";
		const w = visibleWidth(char);
		if (!inverseOn && col < endCol && col + w > startCol) {
			result += HIGHLIGHT_BG;
			inverseOn = true;
		}
		result += char;
		col += w;
		i++;
	}

	if (inverseOn) result += "\x1b[49m";
	return result;
}
