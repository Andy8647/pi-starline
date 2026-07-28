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
import { pasteExpandHintText } from "./paste-collapse";
import { highlightSelection, SelectionState } from "./selection";

export type CopySource = "auto" | "explicit";

export type SelectionControllerConfig = {
	/** Copy on mouse release. When false the highlight stays until ctrl+c. */
	copyOnSelect: boolean;
	/** Show the "copied" toast. Only ever shown for an automatic copy. */
	copyNotice: boolean;
	/** Clicking in the editor text moves the cursor there. */
	editorClickCursor: boolean;
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
};

export type MouseEvent = { button: string; action: string; col: number; row: number };

/** Ctrl+C, as the terminal delivers it. */
const ETX = "\x03";

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

	private copy(text: string, source: CopySource): void {
		if (!text) return;
		void copyToClipboard(text);
		// An explicit copy needs no toast: the hint disappearing is the feedback.
		if (source === "auto" && this.host.getConfig().copyNotice) this.host.showCopyNotice();
	}

	private clear(): void {
		this.selection.clear();
		this.editorSelection.clear();
		this.pressPoint = null;
		this.dragged = false;
		this.editorBox = null;
	}

	/** Drop the highlight, if any. Returns whether anything changed. */
	clearSelection(): boolean {
		const had = this.selection.active || this.editorSelection.active;
		this.clear();
		return had;
	}

	/**
	 * Handle a key. Returns true when the key was consumed.
	 *
	 * ctrl+c copies a pending selection, and otherwise falls through to Pi's
	 * normal ctrl+c. Any other key that reaches the editor dismisses the
	 * highlight, which would otherwise linger over text that has moved on.
	 */
	handleKey(data: string): boolean {
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
		if (event.row > scrollableRows) {
			this.handleEditorMouse(event, scrollableRows);
			return;
		}

		if (this.area === "editor") this.clear();
		this.area = "transcript";
		const line = this.host.getVisibleRootStart() + event.row - 1;
		// Rows above a short transcript map before its first line; nothing to select.
		if (line < 0) return;
		const col = Math.max(0, event.col - 1);

		if (event.action === "press") {
			this.selection.start(line, col);
			this.pressPoint = { line, col };
			this.dragged = false;
			this.host.requestRender();
			return;
		}

		if (event.action === "drag" && this.selection.isDragging) {
			if (this.pressPoint && (this.pressPoint.line !== line || this.pressPoint.col !== col)) {
				this.dragged = true;
			}
			this.selection.extend(line, col);
			this.host.requestRender();
			return;
		}

		if (event.action === "release" && this.selection.isDragging) {
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
			this.editorSelection.start(clusterRow, clusterCol);
			this.pressPoint = { line: clusterRow, col: clusterCol };
			this.dragged = false;
			this.host.requestRender();
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

		// A press with no movement is a click, not an empty selection.
		if (!this.dragged) {
			this.clear();
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
