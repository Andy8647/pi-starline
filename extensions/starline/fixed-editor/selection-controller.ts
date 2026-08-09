/**
 * Selection and copy behaviour for the fixed editor.
 *
 * All of the policy lives here so the compositor keeps only a delegation hook:
 * it owns terminal state and painting, this owns what a drag, a click, a right
 * click and ctrl+c mean. See the compositor's own note on why that split
 * matters — those files are kept close to upstream so their fixes merge.
 *
 * @internal
 */

import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type EditorBoxGeometry, findEditorBox, hitTestEditorBox } from "../mouse/editor-hit-test";
import { scrollEditorWindow } from "../mouse/editor-scroll";
import {
	editorScrollOffset,
	editorVisualRowText,
	positionEditorTextCursor,
} from "../mouse/editor-text-cursor";
import { deleteEditorVisualRange } from "../mouse/editor-text-edit";
import { isToggleTarget } from "./expandable";
import { frameContentSpan } from "./frame";
import { pasteExpandHintText } from "./paste-collapse";
import {
	highlightSelection,
	lineRangeAt,
	SelectionState,
	stripAnsi as stripAnsiForText,
	wordRangeAt,
} from "./selection";

export type CopySource = "auto" | "explicit";

export type SelectionControllerConfig = {
	/** Copy on mouse release. When false the highlight stays until ctrl+c. */
	copyOnSelect: boolean;
	/** Show the "copied" toast. Only ever shown for an automatic copy. */
	copyNotice: boolean;
	/** Clicking in the editor text moves the cursor there. */
	editorClickCursor: boolean;
	/** Clicking a tool box's frame or its expand hint toggles that one box. */
	clickToExpandTools: boolean;
};

export type SelectionHost = {
	selection: SelectionState;
	/** Full transcript lines, for text extraction. */
	getRootLines(): string[];
	/** Absolute index of the first visible transcript line. */
	getVisibleRootStart(): number;
	/** Height of the scrollable region, in rows. */
	getVisibleScrollableRows(): number;
	getConfig(): SelectionControllerConfig;
	/** Rendered cluster lines, for locating the editor box. */
	getClusterLines(): string[];
	/** Blank rows inside the editor box, needed to find its text rows. */
	getEditorPaddingY(): number;
	/** Visible column where editor text starts, past the rail or prompt. */
	getEditorTextColumn(): number;
	/** The live editor component, or undefined when it cannot be reached. */
	getEditorComponent(): unknown;
	requestRender(): void;
	/** Suspend mouse reporting so the terminal's own context menu works. */
	pauseMouseReporting(): void;
	/** Show the "copied to clipboard" notice. */
	showCopyNotice(): void;
	/**
	 * Scroll the transcript by `delta` lines, positive being back through
	 * history. Returns how much was actually applied, which is 0 at either end.
	 */
	scrollTranscriptBy(delta: number): number;
	/** Expand or collapse whatever component owns this transcript line. */
	toggleExpandableAt(line: number): boolean;
};

export type MouseEvent = { button: string; action: string; col: number; row: number };

/** Ctrl+C, as the terminal delivers it. */
const ETX = "\x03";

/** Backspace and delete, in the forms a terminal sends them. */
const DELETE_KEYS = new Set(["\x7f", "\b", "\x1b[3~"]);

/** How close together two presses on one cell count as a double or triple click. */
const MULTI_CLICK_MS = 400;

/**
 * Auto-scroll while a drag sits on the top or bottom row of the transcript.
 *
 * A terminal clamps the rows it reports to the screen, so dragging past the
 * edge looks exactly like dragging along it — and a trackpad held still at the
 * edge reports nothing at all. Hence a repeating timer rather than a response
 * to movement.
 */
const AUTO_SCROLL_MS = 60;
const AUTO_SCROLL_STEP = 1;

/**
 * Whether this input is somebody typing text, as opposed to a key that means
 * something. Control bytes and escapes are out, which also keeps a bracketed
 * paste out — that goes through Pi's own paste path, not this one.
 */
function isTypedText(data: string): boolean {
	return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

export class SelectionController {
	private readonly host: SelectionHost;
	/**
	 * Selection inside the editor box, in the editor's own coordinates: absolute
	 * visual rows — indices into its whole text, not into the rows on screen —
	 * paired with screen columns, which the box's chrome fixes in place. Anchoring
	 * to the text rather than to the rows is what lets the box scroll under a
	 * drag. Kept separate from the transcript selection so the two never overlap;
	 * starting one drops the other.
	 */
	private readonly editorSelection = new SelectionState();
	/** Which area the live selection belongs to. */
	private area: "transcript" | "editor" = "transcript";
	/** Set between press and release, to tell a click from a drag. */
	private pressPoint: { line: number; col: number } | null = null;
	private dragged = false;
	/** Editor-box geometry captured at press, so a drag keeps the same frame. */
	private editorBox: EditorBoxGeometry | null = null;
	/** Last press, for telling a second and third click from two separate ones. */
	private lastPress: {
		area: "transcript" | "editor";
		line: number;
		col: number;
		at: number;
		count: number;
	} | null = null;
	/** Set by a double or triple click, so the release that follows leaves it alone. */
	private multiClick = false;
	/**
	 * Live end of a transcript drag, in absolute transcript coordinates. Scrolling
	 * moves the text under the pointer, and this is what gets moved with it.
	 */
	private lastDragPoint: { line: number; col: number } | null = null;
	private autoScrollTimer: ReturnType<typeof setInterval> | null = null;
	private autoScrollDelta = 0;
	private autoScrollArea: "transcript" | "editor" = "transcript";
	/** Column of the live editor drag, for the rows the edge timer brings in. */
	private lastEditorDragCol: number | null = null;

	constructor(host: SelectionHost) {
		this.host = host;
	}

	private get selection(): SelectionState {
		return this.host.selection;
	}

	/**
	 * Text of the current selection, or "" when there is none. Extraction goes
	 * through SelectionState so OSC 8 hyperlink targets keep coming along with
	 * the visible text.
	 */
	private selectedText(): string {
		if (this.area === "editor") {
			if (!this.editorSelection.active) return "";
			const span = this.editorSelection.span;
			if (!span) return "";
			// Rows are absolute, so this reaches text the box has scrolled past.
			const rows: string[] = [];
			for (let row = span.start.line; row <= span.end.line; row++) {
				rows[row] = this.editorRowText(row) ?? "";
			}
			return this.editorSelection.getSelectedText(rows, this.editorTextColumn());
		}
		if (!this.selection.active) return "";
		return this.selection.getSelectedText(this.host.getRootLines());
	}

	/** The editor's scroll position, which maps its rows onto the box's. */
	private editorScrollOffset(): number {
		return editorScrollOffset(this.host.getEditorComponent());
	}

	/**
	 * One row of the editor as text, padded out to where the box puts it so that
	 * screen columns line up with it.
	 *
	 * Straight from the editor's buffer, which is the only place a row that has
	 * scrolled out of the box still exists. When the editor cannot be read at all
	 * this falls back to the rendered row, which is as far as a selection could
	 * reach before and keeps a Pi that has moved its internals working.
	 */
	private editorRowText(absoluteRow: number): string | undefined {
		const pad = " ".repeat(this.editorTextColumn());
		const text = editorVisualRowText(this.host.getEditorComponent(), absoluteRow);
		if (text !== null) return pad + text;
		const box = this.editorBox;
		if (!box) return undefined;
		const clusterRow = absoluteRow - this.editorScrollOffset() + box.firstTextRow;
		return this.host.getClusterLines()[clusterRow];
	}

	/**
	 * The absolute editor row a cluster row shows, or null when that cluster row
	 * is not part of the editor's text.
	 */
	private editorRowAt(clusterRow: number, box: EditorBoxGeometry): number | null {
		if (clusterRow < box.firstTextRow || clusterRow > box.lastTextRow) return null;
		return clusterRow - box.firstTextRow + this.editorScrollOffset();
	}

	private get activeSelection(): SelectionState {
		return this.area === "editor" ? this.editorSelection : this.selection;
	}

	/**
	 * Where the editor's text starts, past the box's rail. Selection stops there:
	 * the chrome is not text, so it should neither light up nor be copied.
	 */
	private editorTextColumn(): number {
		return this.editorBox?.textColumn ?? this.host.getEditorTextColumn();
	}

	/**
	 * Paint the editor-box selection onto cluster lines.
	 *
	 * The selection is in editor rows and the cluster is in screen rows, so each
	 * line is looked up by the editor row it is currently showing. Rows outside
	 * the box are left alone: the frame and the footer are not text, and a
	 * selection that runs past what the box shows must not spill onto them.
	 */
	highlightCluster(lines: string[]): string[] {
		if (!this.editorSelection.active) return lines;
		const minCol = this.editorTextColumn();
		const box = this.editorBox;
		if (!box) return lines;
		return lines.map((line, index) => {
			const row = this.editorRowAt(index, box);
			if (row === null) return line;
			// The span is the cluster line's; the row is the editor's.
			return highlightSelection(
				line,
				row,
				this.editorSelection,
				minCol,
				frameContentSpan(lines, index),
			);
		});
	}

	/**
	 * Hint for the editor's bottom border, or "" when there is nothing to say.
	 *
	 * Two things can want the border: a collapsed paste offering to expand, and a
	 * finished selection waiting for ctrl+c. Both can be true at once, so they
	 * share the line. The selection half is skipped with copyOnSelect on — the
	 * copy has already happened and needs no prompt.
	 */
	hintText(): string {
		const parts: string[] = [];

		const pasteHint = pasteExpandHintText();
		if (pasteHint) parts.push(pasteHint);

		const selectionHint = this.selectionHintText();
		if (selectionHint) parts.push(selectionHint);

		return parts.join(" ⋅ ");
	}

	private selectionHintText(): string {
		if (this.host.getConfig().copyOnSelect) return "";
		if (this.activeSelection.isDragging) return "";
		const count = this.selectedText().length;
		if (count === 0) return "";
		return `${count} character${count === 1 ? "" : "s"} selected, ctrl+c to copy`;
	}

	/**
	 * Delete the text the editor selection covers, as backspace or delete would
	 * on a selection anywhere else. Returns false when the span cannot be mapped
	 * back onto the editor's text, in which case the key goes through to Pi
	 * untouched and deletes a character as it always did.
	 */
	private deleteEditorSelection(): boolean {
		const span = this.editorSelection.span;
		const box = this.editorBox;
		if (!span || !box) return false;

		// Rows are already the editor's own; only the columns need the chrome
		// taken off them. The exclusive end can sit one past the last cell of a
		// row, which is still a valid text position.
		const textCol = (col: number) => Math.max(0, Math.max(col, box.textColumn) - box.textColumn);
		const start = { visualRow: span.start.line, visualCol: textCol(span.start.col) };
		const end = { visualRow: span.end.line, visualCol: textCol(span.end.col) };

		if (!deleteEditorVisualRange(this.host.getEditorComponent(), start, end)) return false;

		this.clear();
		this.host.requestRender();
		return true;
	}

	/**
	 * How many clicks this press makes, counting a repeat only when it lands on
	 * the same cell soon enough. Wraps back to one after three, the way a
	 * terminal's own click counter does.
	 */
	private clickCount(area: "transcript" | "editor", line: number, col: number): number {
		const now = Date.now();
		const last = this.lastPress;
		const repeat =
			last !== null &&
			last.area === area &&
			last.line === line &&
			last.col === col &&
			now - last.at <= MULTI_CLICK_MS;
		const count = repeat ? ((last?.count ?? 0) % 3) + 1 : 1;
		this.lastPress = { area, line, col, at: now, count };
		return count;
	}

	/**
	 * Select the word (double click) or the whole line (triple click) that was
	 * clicked. Returns false when there is nothing there to select, in which case
	 * the press goes on to behave like a normal one.
	 */
	private selectAtClick(
		area: "transcript" | "editor",
		line: number,
		col: number,
		count: number,
	): boolean {
		const raw = area === "editor" ? this.editorRowText(line) : this.host.getRootLines()[line];
		if (raw === undefined) return false;
		const minCol = area === "editor" ? this.editorTextColumn() : 0;
		const plain = stripAnsiForText(raw);
		const range = count === 2 ? wordRangeAt(plain, col, minCol) : lineRangeAt(plain, minCol);
		if (!range) return false;

		const selection = area === "editor" ? this.editorSelection : this.selection;
		const box = this.editorBox;
		this.clear();
		this.editorBox = area === "editor" ? box : null;
		this.area = area;
		selection.start(line, range.startCol);
		selection.extend(line, range.endCol);
		selection.setDragging(false);
		this.multiClick = true;
		this.dragged = false;
		this.pressPoint = null;

		if (this.host.getConfig().copyOnSelect) {
			const text = this.selectedText();
			this.clear();
			this.host.requestRender();
			this.copy(text, "auto");
			return true;
		}
		this.host.requestRender();
		return true;
	}

	private copy(text: string, source: CopySource): void {
		if (!text) return;
		void copyToClipboard(text);
		// An explicit copy needs no toast: the hint disappearing is the feedback.
		if (source === "auto" && this.host.getConfig().copyNotice) this.host.showCopyNotice();
	}

	private clear(): void {
		this.stopAutoScroll();
		this.lastEditorDragCol = null;
		this.selection.clear();
		this.editorSelection.clear();
		this.pressPoint = null;
		this.lastDragPoint = null;
		this.dragged = false;
		this.editorBox = null;
	}

	/** Drop the highlight, if any. Returns whether anything changed. */
	clearSelection(): boolean {
		const had = this.selection.active || this.editorSelection.active;
		this.clear();
		return had;
	}

	/** Whether a transcript drag is in progress, so scrolling should keep it. */
	isDragging(): boolean {
		return this.area === "transcript" && this.selection.isDragging;
	}

	/**
	 * Follow the text after the transcript scrolled under an active drag by
	 * `applied` lines. The anchor is already an absolute transcript line and does
	 * not move; the live end does, because the pointer stayed on the same screen
	 * row while different text came to sit under it.
	 */
	shiftDragEnd(applied: number): void {
		if (!this.isDragging()) return;
		const point = this.lastDragPoint;
		if (!point) return;
		const line = Math.max(0, point.line - applied);
		this.lastDragPoint = { line, col: point.col };
		if (this.pressPoint && (this.pressPoint.line !== line || this.pressPoint.col !== point.col)) {
			this.dragged = true;
		}
		this.selection.extend(line, point.col);
		this.host.requestRender();
	}

	/** Stop the edge timer. Safe to call at any time. */
	private stopAutoScroll(): void {
		if (!this.autoScrollTimer) return;
		clearInterval(this.autoScrollTimer);
		this.autoScrollTimer = null;
		this.autoScrollDelta = 0;
	}

	/** Release the edge timer. Call when the compositor goes away. */
	dispose(): void {
		this.stopAutoScroll();
	}

	/**
	 * Start, keep or stop the edge timer for whichever area is being dragged in.
	 * A delta of 0 means the pointer is off the edge, so the scrolling stops.
	 */
	private updateAutoScroll(area: "transcript" | "editor", delta: number): void {
		if (delta === 0) {
			this.stopAutoScroll();
			return;
		}
		this.autoScrollArea = area;
		this.autoScrollDelta = delta;
		this.autoScrollStep();
		if (this.autoScrollTimer || !this.autoScrollStillDragging()) return;
		this.autoScrollTimer = setInterval(() => this.autoScrollStep(), AUTO_SCROLL_MS);
		// Never let the timer be the reason the process stays up.
		const timer = this.autoScrollTimer as { unref?: () => void };
		timer.unref?.();
	}

	/** Whether the drag the timer was started for is still going. */
	private autoScrollStillDragging(): boolean {
		return this.autoScrollArea === "editor"
			? this.area === "editor" && this.editorSelection.isDragging
			: this.isDragging();
	}

	private autoScrollStep(): void {
		if (!this.autoScrollStillDragging()) {
			this.stopAutoScroll();
			return;
		}
		if (this.autoScrollArea === "editor") {
			this.editorAutoScrollStep();
			return;
		}
		const applied = this.host.scrollTranscriptBy(this.autoScrollDelta);
		if (applied === 0) {
			// Either end of the transcript: nothing more to reveal.
			this.stopAutoScroll();
			return;
		}
		this.shiftDragEnd(applied);
	}

	/**
	 * One notch of scrolling inside the box, extending the selection to the row
	 * that comes into view at the edge.
	 *
	 * The box's own height is the window to scroll by — Pi derives the same number
	 * from the terminal height, but the geometry is here and cannot disagree with
	 * what was rendered. Nothing has to be shifted afterwards: the selection is in
	 * the editor's coordinates, so the anchor stays exactly where it was.
	 */
	private editorAutoScrollStep(): void {
		const box = this.editorBox;
		if (!box) {
			this.stopAutoScroll();
			return;
		}
		const visibleLines = box.lastTextRow - box.firstTextRow + 1;
		const before = this.editorScrollOffset();
		if (!scrollEditorWindow(this.host.getEditorComponent(), this.autoScrollDelta, visibleLines)) {
			this.stopAutoScroll();
			return;
		}
		const after = this.editorScrollOffset();
		if (after === before) {
			// Either end of the text: nothing more to reveal.
			this.stopAutoScroll();
			return;
		}
		const edgeRow = this.autoScrollDelta < 0 ? box.firstTextRow : box.lastTextRow;
		const row = this.editorRowAt(edgeRow, box);
		if (row !== null) {
			const col = this.lastEditorDragCol ?? box.textColumn;
			this.dragged = true;
			this.editorSelection.extend(row, col);
		}
		this.host.requestRender();
	}

	/** Whether a click here means "toggle the box that owns this cell". */
	private isToggleTargetPoint(line: number, col: number): boolean {
		if (!this.host.getConfig().clickToExpandTools) return false;
		const raw = this.host.getRootLines()[line];
		return raw !== undefined && isToggleTarget(raw, col);
	}

	/**
	 * A plain click on a tool box's frame or its expand hint toggles that box.
	 * Returns false for anything else, so the click stays the no-op it was.
	 */
	private tryToggleExpandable(line: number, col: number): boolean {
		if (!this.isToggleTargetPoint(line, col)) return false;
		return this.host.toggleExpandableAt(line);
	}

	/**
	 * Handle a key. Returns true when the key was consumed.
	 *
	 * ctrl+c copies a pending selection, and otherwise falls through to Pi's
	 * normal ctrl+c. Backspace and delete remove an editor selection; typing
	 * replaces one. Any other key that reaches the editor dismisses the
	 * highlight, which would otherwise linger over text that has moved on.
	 */
	handleKey(data: string): boolean {
		if (this.area === "editor" && this.editorSelection.active) {
			if (DELETE_KEYS.has(data) && this.deleteEditorSelection()) return true;
			// Typing over a selection replaces it: cut it out, then let the key
			// through to Pi, which inserts at the caret the deletion just left
			// where the selection started.
			if (isTypedText(data) && this.deleteEditorSelection()) return false;
		}

		if (data === ETX) {
			const text = this.selectedText();
			if (!text) return false;
			this.copy(text, "explicit");
			this.clear();
			this.host.requestRender();
			return true;
		}

		if (this.selection.active || this.editorSelection.active) {
			this.clear();
			this.host.requestRender();
		}
		return false;
	}

	/**
	 * Handle a left/right mouse event in the scrollable region. Wheel events are
	 * the compositor's business and never reach here.
	 */
	handleMouse(event: MouseEvent): void {
		if (event.button === "right" && event.action === "press") {
			this.handleRightClick(event);
			return;
		}
		if (event.button !== "left") return;

		// Below the transcript is the cluster: the editor box and the footer.
		const scrollableRows = this.host.getVisibleScrollableRows();
		// A drag that wanders down into the cluster is still a transcript drag:
		// it pins to the bottom row and scrolls, rather than handing the pointer
		// to the editor box halfway through a selection.
		const escapingDrag = this.isDragging() && event.action !== "press";
		// The mirror of that: a drag inside the box keeps the pointer even when it
		// wanders up over the transcript, where it counts as the box's top edge.
		const editorDrag = this.area === "editor" && this.editorSelection.isDragging;
		if ((event.row > scrollableRows && !escapingDrag) || (editorDrag && event.action !== "press")) {
			this.handleEditorMouse(event, scrollableRows);
			return;
		}

		if (this.area === "editor") this.clear();
		this.area = "transcript";
		const row = Math.min(Math.max(event.row, 1), Math.max(1, scrollableRows));
		const line = this.host.getVisibleRootStart() + row - 1;
		// Rows above a short transcript map before its first line; nothing to select.
		if (line < 0) return;
		const col = Math.max(0, event.col - 1);

		if (event.action === "press") {
			const count = this.clickCount("transcript", line, col);
			// A second click on a toggle row is another toggle, not a word select:
			// clicking a box shut right after opening it has to work.
			const toggleTarget = this.isToggleTargetPoint(line, col);
			if (count > 1 && !toggleTarget && this.selectAtClick("transcript", line, col, count)) return;
			this.multiClick = false;
			this.selection.start(line, col);
			this.pressPoint = { line, col };
			this.lastDragPoint = { line, col };
			this.dragged = false;
			this.host.requestRender();
			return;
		}

		if (this.multiClick) {
			// The release closing a double or triple click must not collapse it.
			if (event.action === "release") this.multiClick = false;
			return;
		}

		if (event.action === "drag" && this.selection.isDragging) {
			if (this.pressPoint && (this.pressPoint.line !== line || this.pressPoint.col !== col)) {
				this.dragged = true;
			}
			this.lastDragPoint = { line, col };
			this.selection.extend(line, col);
			this.host.requestRender();
			this.updateAutoScroll(
				"transcript",
				row <= 1 ? AUTO_SCROLL_STEP : row >= scrollableRows ? -AUTO_SCROLL_STEP : 0,
			);
			return;
		}

		if (event.action === "release" && this.selection.isDragging) {
			this.stopAutoScroll();
			this.finishDrag(line, col);
		}
	}

	/**
	 * Mouse inside the cluster. Dragging selects the editor's text; a press with
	 * no movement is a click, which moves the caret. The footer and the box
	 * chrome are inert.
	 */
	private handleEditorMouse(event: MouseEvent, scrollableRows: number): void {
		const clusterRow = event.row - scrollableRows - 1;
		const clusterCol = Math.max(0, event.col - 1);

		if (event.action === "press") {
			const box = findEditorBox(
				this.host.getClusterLines(),
				this.host.getEditorPaddingY(),
				this.host.getEditorTextColumn(),
			);
			const point = box ? hitTestEditorBox(box, clusterRow, clusterCol) : null;
			if (!box || !point) {
				// Chrome or footer: drop any highlight, but do not start one.
				if (this.clearSelection()) this.host.requestRender();
				return;
			}

			this.clear();
			this.area = "editor";
			this.editorBox = box;

			const pressRow = point.visualRow + this.editorScrollOffset();
			const count = this.clickCount("editor", pressRow, clusterCol);
			if (count > 1 && this.selectAtClick("editor", pressRow, clusterCol, count)) return;
			this.multiClick = false;

			this.editorSelection.start(pressRow, clusterCol);
			this.pressPoint = { line: pressRow, col: clusterCol };
			this.dragged = false;
			this.host.requestRender();
			return;
		}

		if (this.multiClick) {
			if (event.action === "release") this.multiClick = false;
			return;
		}

		if (this.area !== "editor" || !this.editorBox) return;
		// Keep the drag inside the text area: never past the chrome on the left,
		// never onto a row that is not editor text.
		const box = this.editorBox;
		const col = Math.max(box.textColumn, clusterCol);
		const clampedRow = Math.min(Math.max(clusterRow, box.firstTextRow), box.lastTextRow);
		const row = this.editorRowAt(clampedRow, box) ?? 0;

		if (event.action === "drag" && this.editorSelection.isDragging) {
			if (this.pressPoint && (this.pressPoint.line !== row || this.pressPoint.col !== col)) {
				this.dragged = true;
			}
			this.lastEditorDragCol = col;
			this.editorSelection.extend(row, col);
			this.host.requestRender();
			this.updateEditorAutoScroll(clusterRow, box);
			return;
		}

		if (event.action === "release" && this.editorSelection.isDragging) {
			this.stopAutoScroll();
			this.finishEditorDrag(row, col, clusterRow, clusterCol);
		}
	}

	/**
	 * Keep scrolling the box while a drag is held past the rows it shows, so a
	 * selection can run through a draft taller than the box.
	 *
	 * Past, not on: the box has chrome above and below it, so a pointer that has
	 * left the text is something we can actually see — unlike the transcript,
	 * where the terminal clamps its reports at the screen edge and sitting on the
	 * edge row is the only signal there is. Dragging along the first or last row
	 * of the box therefore selects, as it would anywhere else, and it takes the
	 * frame, the footer or the transcript above to start pulling.
	 */
	private updateEditorAutoScroll(clusterRow: number, box: EditorBoxGeometry): void {
		const delta =
			clusterRow < box.firstTextRow
				? -AUTO_SCROLL_STEP
				: clusterRow > box.lastTextRow
					? AUTO_SCROLL_STEP
					: 0;
		this.updateAutoScroll("editor", delta);
	}

	private finishEditorDrag(row: number, col: number, clusterRow: number, clusterCol: number): void {
		this.editorSelection.extend(row, col);
		this.editorSelection.setDragging(false);

		if (this.dragged) {
			const text = this.selectedText();
			if (this.host.getConfig().copyOnSelect) {
				this.clear();
				this.host.requestRender();
				this.copy(text, "auto");
				return;
			}
			this.pressPoint = null;
			this.dragged = false;
			this.host.requestRender();
			return;
		}

		// No movement: this was a click, so move the caret instead.
		this.clear();
		this.moveCaretTo(clusterRow, clusterCol);
		this.host.requestRender();
	}

	private moveCaretTo(clusterRow: number, clusterCol: number): void {
		if (!this.host.getConfig().editorClickCursor) return;
		const box = findEditorBox(
			this.host.getClusterLines(),
			this.host.getEditorPaddingY(),
			this.host.getEditorTextColumn(),
		);
		if (!box) return;
		const point = hitTestEditorBox(box, clusterRow, clusterCol);
		if (!point) return;
		positionEditorTextCursor(this.host.getEditorComponent(), point.visualRow, point.visualCol);
	}

	private finishDrag(line: number, col: number): void {
		this.selection.extend(line, col);
		this.selection.setDragging(false);

		// A press with no movement is a click, not an empty selection. The frame
		// and the expand hint of a tool box make it a toggle; everywhere else it
		// stays the no-op it has always been.
		if (!this.dragged) {
			this.clear();
			if (this.tryToggleExpandable(line, col)) return;
			this.host.requestRender();
			return;
		}

		const text = this.selectedText();
		if (this.host.getConfig().copyOnSelect) {
			this.clear();
			this.host.requestRender();
			this.copy(text, "auto");
			return;
		}

		// Keep the highlight so ctrl+c has something to copy.
		this.pressPoint = null;
		this.dragged = false;
		this.host.requestRender();
	}

	/**
	 * Right click inside a selection copies it outright. Outside one it falls
	 * through to the terminal's native context menu, as before.
	 */
	private handleRightClick(event: MouseEvent): void {
		const line = this.host.getVisibleRootStart() + event.row - 1;
		const insideSelection =
			line >= 0 &&
			event.row <= this.host.getVisibleScrollableRows() &&
			this.selection.getRangeForLine(line) !== null;

		const text = this.selectedText();
		if (insideSelection && text) {
			this.copy(text, "explicit");
			this.clear();
			this.host.requestRender();
			return;
		}

		this.clear();
		this.host.pauseMouseReporting();
		this.host.requestRender();
	}
}

/** Box-drawing glyphs that make up a horizontal rule. */
const RULE_GLYPHS = new Set(["─", "━", "-", "═"]);

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");
}

function isHorizontalRule(line: string): boolean {
	const plain = stripAnsi(line).trim();
	if (plain.length < 4) return false;
	for (const char of plain) {
		if (!RULE_GLYPHS.has(char)) return false;
	}
	return true;
}

/**
 * Write a hint onto the editor's bottom border.
 *
 * Scanning upward finds that border first: everything below it in the cluster
 * (the footer) is text, not a rule. Returns the lines unchanged when there is
 * no hint or no rule to write it on, so this can never make the frame worse.
 */
export function overlayHintOnBorder(lines: string[], hint: string, width: number): string[] {
	if (!hint) return lines;

	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index] ?? "";
		if (!isHorizontalRule(line)) continue;

		const label = ` ${hint} `;
		const labelWidth = visibleWidth(label);
		// Leave the corners intact; skip the overlay when it will not fit.
		if (labelWidth + 4 > width) return lines;

		const plain = stripAnsi(line);
		const rule = plain[0] ?? "─";
		const leading = 2;
		const trailing = Math.max(0, width - leading - labelWidth);
		const styled = line.slice(0, line.indexOf(plain[0] ?? ""));
		const next = [...lines];
		next[index] = `${styled}${rule.repeat(leading)}${label}${rule.repeat(trailing)}`;
		return next;
	}

	return lines;
}
