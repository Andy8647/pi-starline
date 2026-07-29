/**
 * Move Pi's editor cursor to a point the user clicked.
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
 * Zentui may itself wrap the editor in a decorator. So walk down through
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

/**
 * Resolve a visual row/column of the rendered editor to a point in its text.
 * Returns null when the point is out of range or the editor cannot be read.
 */
export function resolveEditorTextPoint(
	value: unknown,
	visualRow: number,
	visualCol: number,
	fallbackWidth = 80,
): EditorTextPoint | null {
	const editor = asEditorInternals(value);
	if (!editor?.state?.lines) return null;

	try {
		const width = Math.max(1, editor.lastWidth ?? fallbackWidth);
		const visualLines = editor.buildVisualLineMap?.(width);
		if (!Array.isArray(visualLines)) return null;

		// Visual rows are relative to what is on screen; the map is absolute.
		const row = visualRow + (editor.scrollOffset ?? 0);
		const visual = visualLines[row];
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
