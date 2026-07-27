/**
 * Editor cursor styling.
 *
 * Pi's editor draws its cursor in software, as a reverse-video run around the
 * grapheme under the cursor (`\x1b[7m` … `\x1b[0m`), emitted right after the
 * zero-width CURSOR_MARKER that tells the TUI where to put the real terminal
 * cursor. Restyling is therefore a string rewrite over the rendered lines —
 * no editor internals involved.
 *
 * - `block`     leave it alone (upstream behaviour)
 * - `underline` draw an underline instead of the reverse block
 * - `terminal`  remove it, letting the real terminal cursor show through, so
 *               its shape and blink follow the terminal's own configuration
 */

export type EditorCursorStyle = "block" | "underline" | "terminal";

export function parseEditorCursorStyle(value: unknown): EditorCursorStyle {
	return value === "underline" || value === "terminal" || value === "block" ? value : "block";
}

/**
 * Reverse-video run containing no further escapes. The single-grapheme check
 * happens in the replacer: a longer run is deliberate styling somewhere else in
 * the line (a selection highlight, say) and must not be rewritten.
 */
const REVERSE_RUN = /\x1b\[7m([^\x1b]*)\x1b\[0m/g;

const graphemeSegmenter =
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: undefined;

function isSingleGrapheme(text: string): boolean {
	if (text.length === 0) return false;
	if (!graphemeSegmenter) return [...text].length === 1;
	const iterator = graphemeSegmenter.segment(text)[Symbol.iterator]();
	const first = iterator.next();
	return !first.done && first.value.segment === text;
}

/** Restyle the software cursor in one rendered line. */
export function applyEditorCursorStyle(line: string, style: EditorCursorStyle): string {
	if (style === "block" || !line.includes("\x1b[7m")) return line;
	return line.replace(REVERSE_RUN, (match, run: string) => {
		if (!isSingleGrapheme(run)) return match;
		return style === "underline" ? `\x1b[4m${run}\x1b[0m` : run;
	});
}

/** Restyle the software cursor across rendered editor lines. */
export function applyEditorCursorStyleToLines(lines: string[], style: EditorCursorStyle): string[] {
	if (style === "block") return lines;
	return lines.map((line) => applyEditorCursorStyle(line, style));
}
