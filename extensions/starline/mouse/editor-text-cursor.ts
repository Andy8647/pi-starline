/**
 * Map between the editor's rendered rows and its own text: resolve a row and
 * column to a point in the buffer, read a row's text back out, and move the
 * cursor to a point the user clicked.
 *
 * Pi's editor lays its text out onto visual lines and keeps that mapping to
 * itself, and offers a way to read the cursor but not to move it. So this
 * reaches into the live editor instance for both. Everything is probed before
 * use and the whole thing is wrapped: when the shape is not what we expect —
 * a Pi upgrade, a different editor implementation — it reports failure and the
 * click falls back to doing nothing, rather than taking the editor down.
 *
 * Ported from pi-powerline-footer, where this has been in daily use.
 *
 * @internal
 */

import { displayColumnToStringIndex } from "./editor-hit-test";

type VisualLine = { logicalLine: number; startCol: number; length: number };

export type EditorInternals = {
	state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
	buildVisualLineMap?: (width: number) => VisualLine[];
	scrollOffset?: number;
	lastWidth?: number;
	preferredVisualCol?: number | null;
	snappedFromCursorCol?: number | null;
	setCursorCol?: (col: number) => void;
	pushUndoSnapshot?: () => void;
	cancelAutocomplete?: () => void;
	exitHistoryBrowsing?: () => void;
	onChange?: (text: string) => void;
	lastAction?: unknown;
};

/** A point in the editor's own text: which logical line, and where in it. */
export type EditorTextPoint = { line: number; index: number };

function asEditorInternals(value: unknown): EditorInternals | null {
	if (typeof value !== "object" || value === null) return null;
	const editor = value as EditorInternals;
	if (typeof editor.buildVisualLineMap !== "function") return null;
	if (!editor.state || !Array.isArray(editor.state.lines)) return null;
	return editor;
}

/** Whether this editor exposes enough for click-to-position to work at all. */
export function supportsEditorTextCursor(value: unknown): boolean {
	return asEditorInternals(value) !== null;
}

/**
 * Find the object that actually holds the editor state.
 *
 * What the compositor tracks is the *container* Pi puts the editor in, and
 * Starline may itself wrap the editor in a decorator. So walk down through
 * children and wrapped bases until something answers the probe. The visited
 * set keeps a cyclic component graph from looping.
 */
export function resolveEditorInternals(root: unknown): unknown {
	const seen = new Set<unknown>();
	const queue: unknown[] = [root];

	while (queue.length > 0) {
		const node = queue.shift();
		if (typeof node !== "object" || node === null || seen.has(node)) continue;
		seen.add(node);
		if (supportsEditorTextCursor(node)) return node;

		const record = node as { base?: unknown; children?: unknown };
		if (record.base) queue.push(record.base);
		if (Array.isArray(record.children)) queue.push(...record.children);
	}

	return undefined;
}

/** The editor's visual line map, or null when it cannot be read. */
function visualLineMap(editor: EditorInternals, fallbackWidth: number): VisualLine[] | null {
	const width = Math.max(1, editor.lastWidth ?? fallbackWidth);
	const visualLines = editor.buildVisualLineMap?.(width);
	return Array.isArray(visualLines) ? visualLines : null;
}

/**
 * Resolve an absolute visual row/column of the editor to a point in its text.
 *
 * Absolute means an index into the editor's whole visual line map, not into the
 * rows currently on screen. Selection works in these coordinates so that
 * scrolling the box does not move the text a selection is anchored to.
 *
 * Returns null when the point is out of range or the editor cannot be read.
 */
export function resolveEditorTextPointAt(
	value: unknown,
	absoluteRow: number,
	visualCol: number,
	fallbackWidth = 80,
): EditorTextPoint | null {
	const editor = asEditorInternals(value);
	if (!editor?.state?.lines) return null;

	try {
		const visualLines = visualLineMap(editor, fallbackWidth);
		const visual = visualLines?.[absoluteRow];
		if (!visual) return null;

		const text = editor.state.lines[visual.logicalLine] ?? "";
		const index = displayColumnToStringIndex(text, visual.startCol, visualCol);
		return {
			line: visual.logicalLine,
			index: Math.max(visual.startCol, Math.min(index, visual.startCol + visual.length)),
		};
	} catch {
		return null;
	}
}

/**
 * Resolve a visual row/column of the *rendered* editor to a point in its text —
 * a row as counted from the top of the box, which is what a click gives.
 * Returns null when the point is out of range or the editor cannot be read.
 */
export function resolveEditorTextPoint(
	value: unknown,
	visualRow: number,
	visualCol: number,
	fallbackWidth = 80,
): EditorTextPoint | null {
	const editor = asEditorInternals(value);
	if (!editor) return null;
	return resolveEditorTextPointAt(
		value,
		visualRow + (editor.scrollOffset ?? 0),
		visualCol,
		fallbackWidth,
	);
}

/**
 * Plain text of one absolute visual row of the editor, or null when the row is
 * out of range or the editor cannot be read.
 *
 * This is the editor's own buffer, not the rendered row: it carries no cursor
 * highlight and no frame, and it is there whether the row is on screen or
 * scrolled out of the box — which is what lets a selection reach past what the
 * box shows.
 */
export function editorVisualRowText(
	value: unknown,
	absoluteRow: number,
	fallbackWidth = 80,
): string | null {
	const editor = asEditorInternals(value);
	if (!editor?.state?.lines) return null;

	try {
		const visualLines = visualLineMap(editor, fallbackWidth);
		const visual = visualLines?.[absoluteRow];
		if (!visual) return null;
		const text = editor.state.lines[visual.logicalLine] ?? "";
		return text.slice(visual.startCol, visual.startCol + visual.length);
	} catch {
		return null;
	}
}

/** How many visual rows the editor's text lays out to, or 0 when unreadable. */
export function editorVisualRowCount(value: unknown, fallbackWidth = 80): number {
	const editor = asEditorInternals(value);
	if (!editor) return 0;
	try {
		return visualLineMap(editor, fallbackWidth)?.length ?? 0;
	} catch {
		return 0;
	}
}

/** The editor's current scroll position, in visual rows from the top. */
export function editorScrollOffset(value: unknown): number {
	const editor = asEditorInternals(value);
	const offset = editor?.scrollOffset;
	return typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, offset) : 0;
}

/**
 * Place the cursor at a visual row/column of the editor's own text.
 * Returns false when the point is out of range or the editor cannot be driven.
 */
export function positionEditorTextCursor(
	value: unknown,
	visualRow: number,
	visualCol: number,
	fallbackWidth = 80,
): boolean {
	const editor = asEditorInternals(value);
	if (!editor?.state) return false;
	const point = resolveEditorTextPoint(value, visualRow, visualCol, fallbackWidth);
	if (!point) return false;

	editor.state.cursorLine = point.line;
	editor.state.cursorCol = point.index;
	// Clear the sticky column, or the next up/down press jumps back to
	// wherever the cursor used to be rather than where it was just put.
	editor.preferredVisualCol = null;
	editor.snappedFromCursorCol = null;
	return true;
}
