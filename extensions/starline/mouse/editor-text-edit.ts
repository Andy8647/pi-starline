/**
 * Delete a selected range from Pi's editor.
 *
 * Pi's editor has no selection of its own, so it has nothing to delete from and
 * no API for doing it. `setText` is not a way in either: it clears the paste map
 * and counter, which would turn every collapsed `[paste #N]` marker in the box
 * into text that expands to nothing on submit. So the range is spliced out of
 * `state.lines` directly, the same way the paste expansion does it, with an undo
 * snapshot pushed first so ctrl+z still puts it back.
 *
 * Everything is probed before use: an editor that does not look like Pi's is
 * left alone and the key falls through to Pi.
 *
 * @internal
 */

import {
	type EditorInternals,
	type EditorTextPoint,
	resolveEditorTextPointAt,
} from "./editor-text-cursor";

function asEditorInternals(value: unknown): EditorInternals | null {
	if (typeof value !== "object" || value === null) return null;
	const editor = value as EditorInternals;
	if (typeof editor.buildVisualLineMap !== "function") return null;
	if (!editor.state || !Array.isArray(editor.state.lines)) return null;
	return editor;
}

function comparePoints(a: EditorTextPoint, b: EditorTextPoint): number {
	return a.line === b.line ? a.index - b.index : a.line - b.line;
}

/**
 * Delete the text between two points of the editor, given as absolute visual
 * row/column pairs — rows counted through the editor's whole text rather than
 * from the top of the box, which is how a selection stores them so that
 * scrolling cannot move it. `end` is exclusive. Returns false without touching
 * anything when the range cannot be resolved or comes out empty.
 */
export function deleteEditorVisualRange(
	value: unknown,
	start: { visualRow: number; visualCol: number },
	end: { visualRow: number; visualCol: number },
	fallbackWidth = 80,
): boolean {
	const editor = asEditorInternals(value);
	const lines = editor?.state?.lines;
	if (!editor?.state || !lines) return false;

	try {
		const a = resolveEditorTextPointAt(editor, start.visualRow, start.visualCol, fallbackWidth);
		const b = resolveEditorTextPointAt(editor, end.visualRow, end.visualCol, fallbackWidth);
		if (!a || !b) return false;

		const [from, to] = comparePoints(a, b) <= 0 ? [a, b] : [b, a];
		if (comparePoints(from, to) === 0) return false;
		if (from.line >= lines.length || to.line >= lines.length) return false;

		editor.cancelAutocomplete?.call(editor);
		editor.exitHistoryBrowsing?.call(editor);
		editor.lastAction = null;
		editor.pushUndoSnapshot?.call(editor);

		const head = (lines[from.line] ?? "").slice(0, from.index);
		const tail = (lines[to.line] ?? "").slice(to.index);
		const next = [...lines.slice(0, from.line), head + tail, ...lines.slice(to.line + 1)];
		editor.state.lines = next.length === 0 ? [""] : next;

		editor.state.cursorLine = from.line;
		if (typeof editor.setCursorCol === "function") {
			editor.setCursorCol.call(editor, from.index);
		} else {
			editor.state.cursorCol = from.index;
		}
		// The sticky column belongs to wherever the cursor used to be.
		editor.preferredVisualCol = null;
		editor.snappedFromCursorCol = null;

		// Anything watching the text — autocomplete, hints — hears about it the
		// same way it would for a keystroke. Paste entries whose marker was inside
		// the deleted range are left in the map: they are unreachable, and Pi only
		// ever expands markers it finds in the text.
		editor.onChange?.call(editor, editor.state.lines.join("\n"));
		return true;
	} catch {
		return false;
	}
}
