/**
 * Strips decoration out of a transcript selection before it reaches the
 * clipboard.
 *
 * Pi's `copySelectionToClipboard` copies *rendered* rows. In the transcript
 * those rows carry chrome that two components paint around their content:
 *
 * - Starline's own user messages (`user-message.ts`): a full-width `─` rule
 *   above and below, and every content row prefixed with the configured rail
 *   glyph plus a space (`│ hello`).
 * - `pi-toolbox`'s tool box frames (`frame.ts`): rounded corners
 *   (`╭──╮` / `╰──╯`) and every content row wrapped in verticals
 *   (`│ hello │`).
 * - pi-coding-agent's `DynamicBorder` (bash boxes) paints the same full-width
 *   `─` rule — but bash content rows start with a space, not the rail
 *   (`bash-execution.js` renders them with paddingX=1), so under the default
 *   rail the pair below never forms and a bash box copies verbatim. Only in
 *   `copyFriendly` mode (empty rail prefix), where the rule pair alone
 *   decides, do its borders come off. Its content is never touched either
 *   way.
 *
 * The clipboard should hold the content, not the chrome. The frame-free
 * selection task that was cut from 0.3.0 tried to do this by *inferring* where
 * a frame was from rendered text alone, and every discriminator it tried
 * produced a new edge case — a frame is not a structural concept in Pi. This
 * module therefore recognises only the exact markers above: a rounded-corner
 * pair of equal width, and a full-width rule pair whose every inner row
 * carries the configured rail prefix. Anything else — a markdown table with
 * its square `┌┬┐` corners, a blockquote's `│ ` gutter, a horizontal rule the
 * assistant actually wrote — is content and passes through byte-identical.
 *
 * Everything here is a pure function over strings; the Pi-facing wiring
 * (selection bounds, column mapping, the OSC 52 write) lives in `index.ts`.
 */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/**
 * One entry per selected row. `null` drops the row entirely — it was pure
 * decoration (a frame edge or border rule). Otherwise `text` is the row's
 * ANSI-free content and `leftTrim` the number of *visible columns* removed
 * from its left edge, which the caller subtracts from the selection columns
 * so a drag that started mid-row still lands on the same character.
 */
export type CleanedRow = { text: string; leftTrim: number } | null;

export type CleanedRows = {
	rows: CleanedRow[];
	/**
	 * False when no selected row carried any recognised decoration. The caller
	 * falls back to Pi's verbatim copy in that case, so a selection with
	 * nothing to clean takes exactly the path it always did.
	 */
	changed: boolean;
};

/** A full-width rule: Starline's user message border, `DynamicBorder`. */
const RULE_ROW_RE = /^─+$/;
/** pi-toolbox's rounded frame edges. Square corners are content (tables). */
const FRAME_OPEN_RE = /^╭─*╮$/;
const FRAME_CLOSE_RE = /^╰─*╯$/;

function strippedRow(lines: readonly string[], cache: string[], row: number): string {
	let text = cache[row];
	if (text === undefined) {
		text = stripTerminalSequences(lines[row] ?? "");
		cache[row] = text;
	}
	return text;
}

/**
 * Classifies every row of `lines`, then cleans the rows in
 * `[startRow, endRow]`. The scan covers the whole buffer rather than the
 * selection because a drag that starts inside a box never contains the box's
 * own edges; whether a row is framed is a property of rows the selection may
 * not touch.
 */
export function cleanTranscriptRows(
	lines: readonly string[],
	startRow: number,
	endRow: number,
	railGlyph: string,
): CleanedRows {
	const cache: string[] = new Array(lines.length);
	/** Rows to drop: paired frame edges and paired border rules. */
	const dropped = new Set<number>();
	/** pi-toolbox frame content rows: strip one `│` from each side. */
	const frameContent = new Set<number>();
	/** Starline user message rows: strip the rail prefix. */
	const railContent = new Set<number>();

	// Pass 1 — rounded frames. Edges pair strictly by equal width, inner rows
	// are content. A rounded box drawn inside bash output can mis-pair, but the
	// rows it would swallow are inside a real frame and get cleaned anyway.
	const openEdges: Array<{ row: number; width: number }> = [];
	const framePairs: Array<[number, number]> = [];
	for (let row = 0; row < lines.length; row++) {
		const text = strippedRow(lines, cache, row);
		if (FRAME_OPEN_RE.test(text)) {
			openEdges.push({ row, width: visibleWidth(text) });
		} else if (FRAME_CLOSE_RE.test(text)) {
			const open = openEdges[openEdges.length - 1];
			if (open && open.width === visibleWidth(text)) {
				openEdges.pop();
				framePairs.push([open.row, row]);
			}
		}
	}
	for (const [open, close] of framePairs) {
		dropped.add(open);
		dropped.add(close);
		for (let row = open + 1; row < close; row++) frameContent.add(row);
	}

	// Pass 2 — full-width rule pairs. Two rules of equal width with at least
	// one row between them are a Starline user message's borders, and the rows
	// between carry the rail. Any inner row *without* the rail prefix breaks
	// the candidate: it is what keeps an assistant's own `---` rules, and the
	// text between two of them, from being eaten — those rows are content.
	//
	// With an empty rail prefix (the `copyFriendly` render drops the rail)
	// nothing can break a candidate, so any two equal-width rules pair. That
	// also matches a markdown `---` pair, which then loses its rules from the
	// copy — accepted: a horizontal rule is closer to chrome than to content,
	// and the alternative is leaving real borders in every copyFriendly copy.
	const railPrefix = railGlyph.length > 0 ? `${railGlyph} ` : "";
	let lastRule: { row: number; width: number } | undefined;
	for (let row = 0; row < lines.length; row++) {
		if (dropped.has(row)) continue;
		const text = strippedRow(lines, cache, row);
		if (RULE_ROW_RE.test(text)) {
			const width = visibleWidth(text);
			if (lastRule && lastRule.width === width && row - lastRule.row >= 2) {
				dropped.add(lastRule.row);
				dropped.add(row);
				for (let inner = lastRule.row + 1; inner < row; inner++) railContent.add(inner);
			}
			lastRule = { row, width };
		} else if (railPrefix.length > 0 && !text.startsWith(railPrefix)) {
			lastRule = undefined;
		}
	}

	const rows: CleanedRow[] = [];
	let changed = false;
	for (let row = startRow; row <= endRow; row++) {
		if (dropped.has(row)) {
			rows.push(null);
			changed = true;
			continue;
		}
		const text = strippedRow(lines, cache, row);
		if (frameContent.has(row) && text.startsWith("│") && text.endsWith("│") && text.length >= 2) {
			rows.push({ text: text.slice(1, -1), leftTrim: 1 });
			changed = true;
			continue;
		}
		if (railContent.has(row) && railPrefix.length > 0 && text.startsWith(railPrefix)) {
			rows.push({ text: text.slice(railPrefix.length), leftTrim: visibleWidth(railPrefix) });
			changed = true;
			continue;
		}
		rows.push({ text, leftTrim: 0 });
	}
	return { rows, changed };
}
