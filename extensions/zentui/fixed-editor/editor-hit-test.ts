/**
 * Locate the editor box inside the rendered cluster, and map a click in it to
 * editor-text coordinates.
 *
 * The cluster is a picture by the time it reaches here — status, widgets, the
 * framed editor and the footer, already rendered to lines. Finding the box
 * means recognising its two horizontal rules; everything between them is laid
 * out by renderPolishedFrame, so the row arithmetic mirrors what it emitted.
 *
 * @internal
 */

import { visibleWidth } from "@earendil-works/pi-tui";

const RULE_GLYPHS = new Set(["─", "━", "═"]);

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");
}

/** A full-width run of box-drawing rule, which is how the editor frames itself. */
export function isEditorRule(line: string): boolean {
	const plain = stripAnsi(line).trim();
	if (plain.length < 4) return false;
	for (const char of plain) {
		if (!RULE_GLYPHS.has(char)) return false;
	}
	return true;
}

export type EditorBoxGeometry = {
	/** Cluster line index of the first editor text row. */
	firstTextRow: number;
	/** Cluster line index of the last editor text row. */
	lastTextRow: number;
	/** Visible column where editor text starts, past the rail or prompt. */
	textColumn: number;
};

/**
 * Find the editor box in the cluster.
 *
 * Scanning up from the bottom finds the editor's own rules first: everything
 * below it (the footer) is text, and its content rows all carry the rail, so
 * they cannot be mistaken for a rule.
 *
 * Layout between the rules, per renderPolishedFrame:
 *   rule, [pad], ...text, [pad], metadata, rule
 */
export function findEditorBox(
	clusterLines: string[],
	paddingY: number,
	textColumn: number,
): EditorBoxGeometry | null {
	let bottom = -1;
	for (let index = clusterLines.length - 1; index >= 0; index--) {
		if (isEditorRule(clusterLines[index] ?? "")) {
			bottom = index;
			break;
		}
	}
	if (bottom < 0) return null;

	let top = -1;
	for (let index = bottom - 1; index >= 0; index--) {
		if (isEditorRule(clusterLines[index] ?? "")) {
			top = index;
			break;
		}
	}
	if (top < 0) return null;

	const pad = paddingY > 0 ? 1 : 0;
	const firstTextRow = top + 1 + pad;
	// Below the text: the padding row, then the metadata row, then the rule.
	const lastTextRow = bottom - 2 - pad;
	if (lastTextRow < firstTextRow) return null;

	return { firstTextRow, lastTextRow, textColumn };
}

/**
 * Map a cluster row/column onto the editor's visual grid, or null when the
 * point is outside the text area. Columns are visible columns, so the caller
 * still has to resolve wide characters against the actual line.
 */
export function hitTestEditorBox(
	box: EditorBoxGeometry,
	clusterRow: number,
	clusterCol: number,
): { visualRow: number; visualCol: number } | null {
	if (clusterRow < box.firstTextRow || clusterRow > box.lastTextRow) return null;
	const visualCol = clusterCol - box.textColumn;
	if (visualCol < 0) return null;
	return { visualRow: clusterRow - box.firstTextRow, visualCol };
}

/**
 * Visible column where the editor's own text begins, past the chrome that
 * renderPolishedFrame prefixes to every content row.
 */
export function editorTextColumn(options: {
	copyFriendly: boolean;
	railIcon: string;
	promptIcon: string;
}): number {
	if (options.copyFriendly) {
		return options.promptIcon ? visibleWidth(options.promptIcon) + 1 : 0;
	}
	// The rail is always drawn, and always followed by a space, even when the
	// glyph itself is empty.
	return visibleWidth(options.railIcon) + 1;
}

/**
 * Index into `line` at `targetCol` visible columns past `fromIndex`.
 * Walks by code point so wide glyphs and astral characters land correctly.
 */
export function displayColumnToStringIndex(
	line: string,
	fromIndex: number,
	targetCol: number,
): number {
	let col = 0;
	let index = Math.max(0, Math.min(fromIndex, line.length));
	while (index < line.length && col < targetCol) {
		const codePoint = line.codePointAt(index) ?? 0;
		const char = String.fromCodePoint(codePoint);
		col += Math.max(1, visibleWidth(char));
		index += char.length;
	}
	return index;
}
