/**
 * Wheel scrolling inside the editor box.
 *
 * Pi's editor keeps no scroll command of its own: its `scrollOffset` is
 * re-derived from the caret on every render — see the editor component, which
 * pulls the offset back whenever the caret would fall outside the window of
 * `max(5, rows * 0.3)` visual lines. So moving the offset alone is undone by
 * the very next frame; the caret has to come along, exactly as it would if you
 * had held the arrow keys instead. That is what this does.
 *
 * Everything is probed before use and the whole thing is wrapped: when the
 * editor is not the shape we expect, this reports failure and the wheel falls
 * back to scrolling the transcript.
 *
 * The `editorWheelScroll` patch in `mouse/index.ts` drives it; it lives in its
 * own module because `editor-caret.ts` shares the visual-line map it builds.
 *
 * @internal
 */

type VisualLine = { logicalLine: number; startCol: number; length: number };

type ScrollableEditor = {
	state: { lines: string[]; cursorLine?: number; cursorCol?: number };
	buildVisualLineMap: (width: number) => VisualLine[];
	scrollOffset?: number;
	lastWidth?: number;
	preferredVisualCol?: number | null;
	snappedFromCursorCol?: number | null;
};

/** How many visual lines the editor shows, per its own render. */
export function editorVisibleLines(terminalRows: number): number {
	return Math.max(5, Math.floor(terminalRows * 0.3));
}

function asScrollableEditor(value: unknown): ScrollableEditor | null {
	if (typeof value !== "object" || value === null) return null;
	const editor = value as ScrollableEditor;
	if (typeof editor.buildVisualLineMap !== "function") return null;
	if (!editor.state || !Array.isArray(editor.state.lines)) return null;
	return editor;
}

/** Which visual row the caret sits on, or -1 when it cannot be placed. */
function cursorVisualRow(visualLines: VisualLine[], line: number, col: number): number {
	let fallback = -1;
	for (let row = 0; row < visualLines.length; row++) {
		const visual = visualLines[row];
		if (!visual || visual.logicalLine !== line) continue;
		fallback = row;
		if (col >= visual.startCol && col <= visual.startCol + visual.length) return row;
	}
	return fallback;
}

/**
 * Scroll the editor by `delta` visual lines: negative shows earlier lines,
 * positive later ones. Returns false when there is nothing to scroll — no
 * scrollable content, or an editor we cannot read — so the caller can let the
 * transcript have the wheel instead.
 *
 * Reaching the top or bottom of scrollable content still returns true: once the
 * pointer is over an editor that scrolls, the wheel belongs to it, and chaining
 * on to the transcript at the boundary would make the box feel like it slipped.
 */
export function scrollEditorBy(value: unknown, delta: number, terminalRows: number): boolean {
	return scrollEditorWindow(value, delta, editorVisibleLines(terminalRows));
}

/**
 * The same, for a caller that already knows how many rows the box shows — the
 * box's own geometry, rather than Pi's formula for it.
 */
export function scrollEditorWindow(value: unknown, delta: number, visibleLines: number): boolean {
	const editor = asScrollableEditor(value);
	if (!editor) return false;
	if (visibleLines < 1) return false;

	try {
		const width = Math.max(1, editor.lastWidth ?? 80);
		const visualLines = editor.buildVisualLineMap(width);
		if (!Array.isArray(visualLines) || visualLines.length === 0) return false;

		const maxOffset = visualLines.length - visibleLines;
		// The whole input fits: there is no scrolling to be done here.
		if (maxOffset <= 0) return false;

		const current = Math.max(0, Math.min(editor.scrollOffset ?? 0, maxOffset));
		const next = Math.max(0, Math.min(current + delta, maxOffset));
		if (next === current) return true;
		editor.scrollOffset = next;

		// Drag the caret into the new window, or the next render snaps back.
		const cursorLine = editor.state.cursorLine ?? 0;
		const cursorCol = editor.state.cursorCol ?? 0;
		const row = cursorVisualRow(visualLines, cursorLine, cursorCol);
		if (row < 0) return true;

		const first = next;
		const last = next + visibleLines - 1;
		if (row >= first && row <= last) return true;

		const targetRow = row < first ? first : last;
		const target = visualLines[targetRow];
		if (!target) return true;
		// Keep the column where it was, as far as the target line allows.
		const offsetInLine = Math.max(0, cursorCol - (visualLines[row]?.startCol ?? 0));
		editor.state.cursorLine = target.logicalLine;
		editor.state.cursorCol = target.startCol + Math.min(offsetInLine, target.length);
		// Clear the sticky column, or the next up/down press jumps back to
		// wherever the caret used to be rather than where it was just put.
		editor.preferredVisualCol = null;
		editor.snappedFromCursorCol = null;
		return true;
	} catch {
		return false;
	}
}
