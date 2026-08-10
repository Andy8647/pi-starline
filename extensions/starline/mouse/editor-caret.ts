/**
 * Where the draft's text is on screen, and how to read it back out.
 *
 * Two features share this module because they share one arithmetic problem:
 * turning a screen cell into a position in the editor's own buffer.
 * `editorClickToCaret` needs it for a single press; `editorBufferCopy` needs it
 * for the two ends of a selection.
 *
 * ## Why the box's rectangle is not the text
 *
 * `editorBoxFor` (`editor-mouse.ts`) finds the box covering the editor's rows,
 * but those rows are a *frame*: Starline's `renderPolishedFrame` draws a rule,
 * an optional padding row, the text rows each prefixed with the rail, another
 * padding row, the metadata row and a closing rule — and pi-tui's own
 * `Editor.render` supplies the rules and, when focused, the reverse-video
 * cursor cell inside them. So the first text row is `rect.y + 1 + paddingY`,
 * and the first text *column* is past the rail, which is what the
 * `editorTextColumn` helper (moved here from the fixed editor) measures.
 *
 * The bottom of the text cannot be read off the rectangle at all: the box's
 * height also covers the autocomplete list, which appears and disappears under
 * the frame. It comes instead from the editor itself — how many visual lines it
 * has, less how far it is scrolled, capped by Pi's own window of
 * `max(5, rows * 0.3)`.
 *
 * ## Why positions are logical, not visual
 *
 * A screen row is a *visual* line — the editor's word wrapping has already been
 * applied to it. The buffer knows those rows are one logical line. Mapping
 * through to logical `{ line, column }` before slicing is what keeps a copied
 * wrapped paragraph one paragraph instead of a stack of hard-wrapped fragments,
 * and it is the half of `editorBufferCopy` that shows up on every draft rather
 * than only on tall ones.
 */

import type { PolishedTuiConfig } from "../config";
import { editorTextColumn } from "./editor-hit-test";
import { activeEditor, editorBoxFor, pointerOverEditor } from "./editor-mouse";
import { editorVisibleLines } from "./editor-scroll";
import {
	editorScrollOffset,
	editorVisualRowCount,
	resolveEditorTextPointAt,
} from "./editor-text-cursor";
import type { BoxLike } from "./hit-test";

/** A position in the editor's own buffer: which logical line, and where in it. */
export type CaretPosition = { line: number; column: number };

/** Where the editor's text rows are on screen, and what they are showing. */
export type EditorViewport = {
	/** Screen row of the first text row. */
	contentTop: number;
	/** How many text rows the box is showing right now. */
	contentRows: number;
	/** Screen column of the box's left edge. */
	left: number;
	/** Columns the rail or prompt takes before the text starts. */
	textColumn: number;
	/** The absolute visual row drawn at `contentTop`. */
	scrollOffset: number;
	/** Screen rows the box itself occupies, borders and metadata included. */
	boxTop: number;
	boxBottom: number;
};

export type EditorViewportOptions = {
	/** `config.editorPaddingY` — 0 or 1 blank rows inside the frame. */
	paddingY: number;
	/** `editorTextColumn(...)`, passed in so the mapping stays a pure function. */
	textColumn: number;
	/** The terminal's row count, for Pi's own visible-line formula. */
	terminalRows: number;
};

export function editorViewport(
	editor: unknown,
	box: BoxLike | undefined,
	options: EditorViewportOptions,
): EditorViewport | undefined {
	if (!box) return undefined;
	const visualRows = editorVisualRowCount(editor);
	// Zero means either an empty map or an editor this module cannot read; both
	// leave nothing to map a click onto.
	if (visualRows === 0) return undefined;

	const scrollOffset = Math.min(editorScrollOffset(editor), visualRows - 1);
	const contentTop = box.rect.y + 1 + (options.paddingY > 0 ? 1 : 0);
	const contentRows = Math.min(
		visualRows - scrollOffset,
		editorVisibleLines(options.terminalRows),
		// A dock squeezed against the top of the viewport draws fewer rows than
		// the editor rendered. Never claim a row the box does not cover.
		box.rect.y + box.rect.height - contentTop,
	);
	if (contentRows <= 0) return undefined;

	return {
		contentTop,
		contentRows,
		left: box.rect.x,
		textColumn: Math.max(0, options.textColumn),
		scrollOffset,
		boxTop: box.rect.y,
		boxBottom: box.rect.y + box.rect.height - 1,
	};
}

/**
 * The buffer position under a screen cell, or undefined when the cell is not
 * one of the editor's text rows.
 *
 * Only the row is rejected out of range; the column is clamped. A press on the
 * rail lands on column 0 rather than on a negative one, and a press past the
 * end of a line lands on its end — both are what every editor does with a click
 * in the margin, and both are what a selection's own ends need when the drag
 * ran off the side of the box.
 */
export function caretPositionAt(
	editor: unknown,
	viewport: EditorViewport,
	x: number,
	y: number,
): CaretPosition | undefined {
	const row = y - viewport.contentTop;
	if (row < 0 || row >= viewport.contentRows) return undefined;
	const column = Math.max(0, x - viewport.left - viewport.textColumn);
	const point = resolveEditorTextPointAt(editor, viewport.scrollOffset + row, column);
	return point ? { line: point.line, column: point.index } : undefined;
}

/** The editor's buffer, however this editor exposes it. */
function editorLines(value: unknown): readonly string[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const editor = value as {
		getLines?: () => string[];
		state?: { lines?: string[] };
	};
	try {
		if (typeof editor.getLines === "function") {
			const lines = editor.getLines();
			if (Array.isArray(lines)) return lines;
		}
	} catch {
		// An editor whose accessor throws is one we fall back to reading directly.
	}
	const lines = editor.state?.lines;
	return Array.isArray(lines) ? lines : undefined;
}

function comparePositions(a: CaretPosition, b: CaretPosition): number {
	return a.line === b.line ? a.column - b.column : a.line - b.line;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

/**
 * The draft's own text between two buffer positions, whole lines in between.
 *
 * `to` may come before `from` — a drag upwards produces exactly that — so the
 * two ends are ordered here rather than at every call site. Lines past the end
 * of the buffer contribute nothing: this runs on positions resolved from an
 * earlier frame, and the draft may have changed since.
 */
export function editorSelectionText(
	editor: unknown,
	from: CaretPosition,
	to: CaretPosition,
): string {
	const lines = editorLines(editor);
	if (!lines || lines.length === 0) return "";

	const [start, end] = comparePositions(from, to) <= 0 ? [from, to] : [to, from];
	if (start.line >= lines.length) return "";

	const last = Math.min(end.line, lines.length - 1);
	const rows: string[] = [];
	for (let line = Math.max(0, start.line); line <= last; line++) {
		const text = lines[line] ?? "";
		const begin = line === start.line ? clamp(start.column, 0, text.length) : 0;
		const finish = line === end.line ? clamp(end.column, 0, text.length) : text.length;
		rows.push(text.slice(begin, Math.max(begin, finish)));
	}
	return rows.join("\n");
}

/** The shape of `TuiAltScreen.getSelectionBounds()`, as much as is read here. */
export type SelectionBoundsLike = {
	start: { scrollView?: unknown; row: number; col: number };
	end: { scrollView?: unknown; row: number; col: number; boundary?: boolean };
};

/**
 * The buffer position for one end of a screen selection, with one concession
 * `caretPositionAt` does not make: a drag that ran off the text rows but is
 * still inside the box clamps to the text instead of declining. Releasing on
 * the bottom border (or the metadata row) means "through the end of the
 * visible text", and releasing on the top border means "from its start" —
 * the column on a border row selects no text, so it is discarded. A row
 * outside the box altogether — the transcript above, the footer below —
 * still declines: that selection is not purely the editor's, and Pi copies
 * it as screen text exactly as before.
 *
 * The end column follows Pi's own rule in `getSelectionColumns`: a character
 * selection covers the glyph under `end.col`, so the exclusive end is one
 * column further right, while a word or line selection arrives with
 * `boundary: true` and already points past its last glyph. Converting a column
 * rather than an index is what keeps that correct for wide glyphs —
 * `displayColumnToStringIndex` walks by display width, so asking for the column
 * after a two-cell glyph lands after the glyph, exactly as
 * `getGraphemeCellRange` would.
 */
function selectionEndPosition(
	editor: unknown,
	viewport: EditorViewport,
	point: { row: number; col: number; boundary?: boolean },
	isEnd: boolean,
): CaretPosition | undefined {
	const lastRow = viewport.contentTop + viewport.contentRows - 1;
	let row = point.row;
	let col = isEnd ? (point.boundary ? point.col : point.col + 1) : point.col;
	if (row < viewport.contentTop) {
		if (row < viewport.boxTop) return undefined;
		row = viewport.contentTop;
		col = 0;
	} else if (row > lastRow) {
		if (row > viewport.boxBottom) return undefined;
		row = lastRow;
		col = viewport.left + viewport.textColumn + Number.MAX_SAFE_INTEGER;
	}
	return caretPositionAt(editor, viewport, col, row);
}

/**
 * The buffer range a screen selection covers, or undefined when the selection
 * is not the editor's to interpret. "Not the editor's" is: a selection
 * anchored in a scroll view (the transcript owns those), one reaching outside
 * the box itself (see `selectionEndPosition` for the clamp applied inside
 * it), or one over an editor this module cannot read. Each falls through to
 * Pi untouched.
 */
export function editorSelectionRange(
	editor: unknown,
	viewport: EditorViewport,
	bounds: SelectionBoundsLike,
): { from: CaretPosition; to: CaretPosition } | undefined {
	if (bounds.start.scrollView || bounds.end.scrollView) return undefined;
	const from = selectionEndPosition(editor, viewport, bounds.start, false);
	if (!from) return undefined;
	const to = selectionEndPosition(editor, viewport, bounds.end, true);
	if (!to) return undefined;
	return { from, to };
}

/**
 * The slice of Pi's renderer this module reads. Both entries are plain instance
 * fields, not methods, so neither is a probed capability — see
 * `capabilities.ts`.
 */
export type CaretReceiver = {
	currentLayout?: { root: BoxLike };
	terminal?: { rows?: number };
};

/**
 * The live editor, its box and the mapping into it, resolved fresh.
 *
 * Nothing here is cached. The box moves whenever the transcript grows, the
 * scroll offset moves whenever the caret does, and the row count moves whenever
 * the draft is edited — an answer kept even until the next event would be about
 * rows that have moved.
 */
export function activeEditorViewport(
	receiver: CaretReceiver,
	config: PolishedTuiConfig,
): { editor: unknown; viewport: EditorViewport } | undefined {
	const active = activeEditor();
	if (!active) return undefined;
	const rows = receiver.terminal?.rows;
	if (typeof rows !== "number") return undefined;
	const box = editorBoxFor(receiver.currentLayout?.root, active.component);
	if (!box) return undefined;
	const viewport = editorViewport(active.scrollable, box, {
		paddingY: config.editorPaddingY,
		textColumn: editorTextColumn({
			copyFriendly: config.features.copyFriendly,
			railIcon: config.icons.rail,
			promptIcon: config.icons.editorPrompt,
		}),
		terminalRows: rows,
	});
	return viewport ? { editor: active.scrollable, viewport } : undefined;
}

/**
 * Put the caret where the pointer is. Returns false when the press was not the
 * input box's, which is every press this feature must leave alone.
 *
 * The point has to be *painted* by the box, not merely inside its rectangle,
 * which is why this asks `pointerOverEditor` — the same question the wheel asks
 * — rather than testing the rect: a dock squeezed out of the viewport must not
 * claim rows it is not drawing.
 */
export function moveEditorCaretTo(
	receiver: CaretReceiver,
	config: PolishedTuiConfig,
	x: number,
	y: number,
): boolean {
	try {
		const active = activeEditor();
		if (!active) return false;
		if (!pointerOverEditor(receiver.currentLayout?.root, active.component, x, y)) return false;
		const resolved = activeEditorViewport(receiver, config);
		if (!resolved) return false;
		const position = caretPositionAt(resolved.editor, resolved.viewport, x, y);
		if (!position) return false;
		return setEditorCaret(resolved.editor, position);
	} catch {
		// Everything above reads Pi's layout and an editor this module did not
		// necessarily build. Anything it trips over means the press was an
		// ordinary press.
		return false;
	}
}

type CaretWritableEditor = {
	state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
	preferredVisualCol?: number | null;
	snappedFromCursorCol?: number | null;
};

/**
 * Move the caret to a buffer position.
 *
 * The sticky column is cleared alongside it, the same way `scrollEditorBy`
 * clears it: `preferredVisualCol` and `snappedFromCursorCol` describe where the
 * caret used to be, and left in place they make the next up or down press jump
 * back there instead of moving from where the click just put it.
 */
function setEditorCaret(value: unknown, position: CaretPosition): boolean {
	if (typeof value !== "object" || value === null) return false;
	const editor = value as CaretWritableEditor;
	const lines = editor.state?.lines;
	if (!editor.state || !Array.isArray(lines)) return false;
	if (position.line < 0 || position.line >= lines.length) return false;
	editor.state.cursorLine = position.line;
	editor.state.cursorCol = clamp(position.column, 0, (lines[position.line] ?? "").length);
	editor.preferredVisualCol = null;
	editor.snappedFromCursorCol = null;
	return true;
}

/**
 * The slice of Pi's `Editor` the range delete drives.
 *
 * Every entry is a real method on `Editor`
 * (`node_modules/@earendil-works/pi-tui/dist/components/editor.js`), probed
 * before use because the editor may be somebody else's.
 */
type EditableEditor = {
	state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
	snappedFromCursorCol?: number | null;
	/** `getText()` (editor.js:826) — the join of `state.lines`. */
	getText?: () => string;
	/** `setCursorCol(col)` (editor.js:1158); also clears `preferredVisualCol`. */
	setCursorCol?: (col: number) => void;
	/** `handleForwardDelete()` (editor.js:1410) — one grapheme, or one line join. */
	handleForwardDelete?: () => void;
	/** `pushUndoSnapshot()` (editor.js:1702). */
	pushUndoSnapshot?: () => void;
};

/**
 * Delete a buffer range through the editor's own editing methods.
 *
 * ## Why `handleForwardDelete` in a loop
 *
 * Pi's `Editor` has no range delete. Its editing surface is
 * `handleBackspace`, `handleForwardDelete`, `deleteToStartOfLine`,
 * `deleteToEndOfLine`, `deleteWordBackwards` and `deleteWordForward`, and none
 * of them takes two positions. So a range is deleted by putting the caret at
 * its start and deleting forward until the range's worth of characters is gone.
 *
 * `handleForwardDelete` is the right one of the six. It is grapheme-aware, so a
 * flag or a combining sequence goes in one piece; it joins the next line when
 * the caret is at the end of one, so a multi-line range needs no special case;
 * and — unlike the `deleteTo…` and `deleteWord…` family — it does **not** push
 * to the kill ring, so deleting a selection cannot silently clobber what the
 * user has yanked.
 *
 * ## Why one undo snapshot
 *
 * Each of those calls would push its own snapshot, leaving `ctrl+z` to walk the
 * range back a letter at a time. So one snapshot is pushed up front through the
 * editor's own `pushUndoSnapshot`, and the editor's own is shadowed for the
 * duration of the loop and put back in a `finally` — the same shadow-and-restore
 * shape `copyWithNotice` uses on `flash` and `installPasteCollapse` uses on
 * `handlePaste`. This is a plain assignment on Starline's own editor instance,
 * never on anything reached through Pi's renderer Proxy.
 *
 * The loop is bounded twice over: by the character count of the range, and by a
 * no-progress check, so an editor that stops deleting cannot spin.
 */
function deleteEditorRange(value: unknown, start: CaretPosition, length: number): boolean {
	if (typeof value !== "object" || value === null) return false;
	const editor = value as EditableEditor;
	const lines = editor.state?.lines;
	if (!editor.state || !Array.isArray(lines)) return false;
	if (typeof editor.getText !== "function") return false;
	if (typeof editor.setCursorCol !== "function") return false;
	if (typeof editor.handleForwardDelete !== "function") return false;
	if (start.line < 0 || start.line >= lines.length) return false;

	const target = editor.getText().length - length;
	editor.pushUndoSnapshot?.call(editor);

	const hadOwnSnapshot = Object.hasOwn(editor, "pushUndoSnapshot");
	const ownSnapshot = editor.pushUndoSnapshot;
	editor.pushUndoSnapshot = () => {};
	try {
		editor.state.cursorLine = start.line;
		editor.setCursorCol.call(editor, clamp(start.column, 0, (lines[start.line] ?? "").length));
		// The sticky column belongs to wherever the caret used to be.
		editor.snappedFromCursorCol = null;

		let guard = length + 1;
		while (guard-- > 0) {
			const before = editor.getText().length;
			if (before <= target) break;
			editor.handleForwardDelete.call(editor);
			// Nothing left to delete forward (the end of the last line) — stop
			// rather than spin.
			if (editor.getText().length >= before) break;
		}
	} finally {
		if (hadOwnSnapshot) editor.pushUndoSnapshot = ownSnapshot;
		else delete editor.pushUndoSnapshot;
	}
	return true;
}

/**
 * Delete the draft text a screen selection covers, and report whether it did.
 *
 * `false` means the selection was not the editor's to delete — a selection in
 * the transcript, one reaching outside the text rows, one over an editor this
 * module cannot drive, or one that resolves to no characters. Every one of those
 * has to leave the key to Pi, so an ordinary backspace goes on deleting one
 * character.
 */
export function deleteEditorSelection(
	receiver: CaretReceiver,
	config: PolishedTuiConfig,
	bounds: SelectionBoundsLike,
): boolean {
	try {
		const resolved = activeEditorViewport(receiver, config);
		if (!resolved) return false;
		const range = editorSelectionRange(resolved.editor, resolved.viewport, bounds);
		if (!range) return false;
		const text = editorSelectionText(resolved.editor, range.from, range.to);
		if (text.length === 0) return false;
		const start = comparePositions(range.from, range.to) <= 0 ? range.from : range.to;
		return deleteEditorRange(resolved.editor, start, text.length);
	} catch {
		// Driving somebody else's editor is best effort. Anything this trips over
		// leaves the key to Pi.
		return false;
	}
}

/**
 * The draft's own text for a selection that lies inside the input box, or
 * undefined when the selection is somebody else's.
 *
 * One function for both callers: the copy itself, and the pending-mode hint
 * that has to promise the same character count the copy will deliver.
 */
export function editorSelectionTextFor(
	receiver: CaretReceiver,
	config: PolishedTuiConfig,
	bounds: SelectionBoundsLike,
): string | undefined {
	try {
		const resolved = activeEditorViewport(receiver, config);
		if (!resolved) return undefined;
		const range = editorSelectionRange(resolved.editor, resolved.viewport, bounds);
		if (!range) return undefined;
		return editorSelectionText(resolved.editor, range.from, range.to);
	} catch {
		// undefined is "not the editor's", which is the right answer for a
		// selection this module could not read: Pi copies it as it always did.
		return undefined;
	}
}
