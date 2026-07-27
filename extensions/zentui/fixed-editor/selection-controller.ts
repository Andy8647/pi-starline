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

import type { SelectionState } from "./selection";

export type CopySource = "auto" | "explicit";

export type SelectionControllerConfig = {
	/** Copy on mouse release. When false the highlight stays until ctrl+c. */
	copyOnSelect: boolean;
	/** Show the "copied" toast. Only ever shown for an automatic copy. */
	copyNotice: boolean;
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
	/** Set between press and release, to tell a click from a drag. */
	private pressPoint: { line: number; col: number } | null = null;
	private dragged = false;

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
		if (!this.selection.active) return "";
		return this.selection.getSelectedText(this.host.getRootLines());
	}

	/**
	 * Hint for the editor's bottom border, or "" when there is nothing to say.
	 * Only shown while a finished selection is waiting for ctrl+c — with
	 * copyOnSelect on, the copy has already happened and needs no prompt.
	 */
	hintText(): string {
		if (this.host.getConfig().copyOnSelect) return "";
		if (this.selection.isDragging) return "";
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
		this.pressPoint = null;
		this.dragged = false;
	}

	/** Drop the highlight, if any. Returns whether anything changed. */
	clearSelection(): boolean {
		const had = this.selection.active;
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

		if (this.selection.active) {
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

		// The cluster region (editor, footer) does not take part in selection yet.
		if (event.row > this.host.getVisibleScrollableRows()) return;

		const line = this.host.getVisibleRootStart() + event.row - 1;
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
			this.selection.extend(line, col + 1);
			this.host.requestRender();
			return;
		}

		if (event.action === "release" && this.selection.isDragging) {
			this.finishDrag(line, col);
		}
	}

	private finishDrag(line: number, col: number): void {
		this.selection.extend(line, col + 1);
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
