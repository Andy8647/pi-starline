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

import { type EditorBoxGeometry, findEditorBox, hitTestEditorBox } from "./editor-hit-test";
import { positionEditorTextCursor } from "./editor-text-cursor";
import { deleteEditorVisualRange } from "./editor-text-edit";
import { isToggleTarget } from "./expandable";
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
	 * Selection inside the editor box, over rendered cluster lines rather than
	 * transcript lines. Kept separate from the transcript selection so the two
	 * never overlap; starting one drops the other.
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
			return this.editorSelection.getSelectedText(
				this.host.getClusterLines(),
				this.editorTextColumn(),
			);
		}
		if (!this.selection.active) return "";
		return this.selection.getSelectedText(this.host.getRootLines());
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
	 * Paint the editor-box selection onto cluster lines. Only ever highlights
	 * inside the box, because that is the only place the selection can reach.
	 */
	highlightCluster(lines: string[]): string[] {
		if (!this.editorSelection.active) return lines;
		const minCol = this.editorTextColumn();
		return lines.map((line, index) =>
			highlightSelection(line, index, this.editorSelection, minCol),
		);
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

		const start = hitTestEditorBox(box, span.start.line, Math.max(span.start.col, box.textColumn));
		// The exclusive end can sit one past the last cell of a row, which is
		// still a valid text position — hit-testing only rejects columns left of
		// the text, and rows are already clamped to the box.
		const end = hitTestEditorBox(box, span.end.line, Math.max(span.end.col, box.textColumn));
		if (!start || !end) return false;

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
		const raw =
			area === "editor" ? this.host.getClusterLines()[line] : this.host.getRootLines()[line];
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
	 * Keep scrolling while the drag sits on an edge row, and stop as soon as it
	 * moves off one or the transcript runs out.
	 */
	private updateAutoScroll(row: number, scrollableRows: number): void {
		const delta = row <= 1 ? AUTO_SCROLL_STEP : row >= scrollableRows ? -AUTO_SCROLL_STEP : 0;
		if (delta === 0) {
			this.stopAutoScroll();
			return;
		}
		this.autoScrollDelta = delta;
		this.autoScrollStep();
		if (this.autoScrollTimer || !this.isDragging()) return;
		this.autoScrollTimer = setInterval(() => this.autoScrollStep(), AUTO_SCROLL_MS);
		// Never let the timer be the reason the process stays up.
		const timer = this.autoScrollTimer as { unref?: () => void };
		timer.unref?.();
	}

	private autoScrollStep(): void {
		if (!this.isDragging()) {
			this.stopAutoScroll();
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
		if (event.row > scrollableRows && !escapingDrag) {
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
			this.updateAutoScroll(row, scrollableRows);
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

			const count = this.clickCount("editor", clusterRow, clusterCol);
			if (count > 1 && this.selectAtClick("editor", clusterRow, clusterCol, count)) return;
			this.multiClick = false;

			this.editorSelection.start(clusterRow, clusterCol);
			this.pressPoint = { line: clusterRow, col: clusterCol };
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
		const row = Math.min(Math.max(clusterRow, box.firstTextRow), box.lastTextRow);

		if (event.action === "drag" && this.editorSelection.isDragging) {
			if (this.pressPoint && (this.pressPoint.line !== row || this.pressPoint.col !== col)) {
				this.dragged = true;
			}
			this.editorSelection.extend(row, col);
			this.host.requestRender();
			return;
		}

		if (event.action === "release" && this.editorSelection.isDragging) {
			this.finishEditorDrag(row, col, clusterRow, clusterCol);
		}
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
