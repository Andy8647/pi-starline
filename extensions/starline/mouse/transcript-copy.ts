/**
 * Strips decoration out of a transcript selection before it reaches the
 * clipboard.
 *
 * Pi's `copyActiveSelectionToClipboard` copies *rendered* rows. In the transcript
 * those rows carry chrome that two components paint around their content:
 *
 * - pi-tidy's "rail" user messages (`user-message.ts` there; Starline drew
 *   them itself before 0.9): a full-width `─` rule above and below, every
 *   content row prefixed with `│ ` (`│ hello`), and padding rows that are the
 *   bare `│`. With tidy's icons on, the first text row also carries the user
 *   icon (`│  hello`) and the rows after it hang two cells further in; both
 *   come off too.
 * - pi-tidy's tool box frames (`frame.ts`; `pi-toolbox` before the rename):
 *   rounded corners (`╭──╮` / `╰──╯`, the top one possibly labelled, as a
 *   "frame" user message's `╭─  ─╮` is) and every content row wrapped in
 *   verticals (`│ hello │`).
 * - pi-coding-agent's `DynamicBorder` (bash boxes) paints the same full-width
 *   `─` rule — but bash content rows start with a space, not the rail
 *   (`bash-execution.js` renders them with paddingX=1), so the pair below never
 *   forms and a bash box copies verbatim.
 *
 * The clipboard should hold the content, not the chrome. The frame-free
 * selection task that was cut from 0.3.0 tried to do this by *inferring* where
 * a frame was from rendered text alone, and every discriminator it tried
 * produced a new edge case — a frame is not a structural concept in Pi. This
 * module therefore recognises only the exact markers above: a rounded-corner
 * pair of equal width, and a full-width rule pair whose every inner row
 * carries the rail. Anything else — a markdown table with
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

/**
 * pi-tidy's user message rail. Fixed there (its `USER_RAIL_GLYPH`) so this
 * side can recognise it without reading tidy's settings.
 */
const USER_RAIL_GLYPH = "│";
const USER_RAIL_PREFIX = `${USER_RAIL_GLYPH} `;
/** pi-tidy's user icon (its `MESSAGE_ICONS.user`), and the indent that hangs under it. */
const USER_ICON_PREFIX = `${USER_RAIL_PREFIX}\u{f007} `;
const USER_HANG_PREFIX = `${USER_RAIL_PREFIX}  `;

/** A content row or a bare padding row of a rail message. */
function isRailRow(text: string): boolean {
	return text.startsWith(USER_RAIL_PREFIX) || text.trimEnd() === USER_RAIL_GLYPH;
}

/** A full-width rule: a rail message's border, `DynamicBorder`. */
const RULE_ROW_RE = /^─+$/;
/**
 * pi-tidy's rounded frame edges; the top one may carry a label (`╭─  ─╮`,
 * a "frame" user message). Square corners are content (tables).
 */
const FRAME_OPEN_RE = /^╭(?:─ [^─]+ )?─*╮$/;
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
 * Decide what each row of one rail message sheds. Padding rows lose the bare
 * rail. When the first text row leads with the user icon, it loses the icon
 * too, and the rows hanging under it lose the indent that lines them up.
 */
function claimRailMessage(
	lines: readonly string[],
	cache: string[],
	first: number,
	end: number,
	claimed: Map<number, string>,
): void {
	let iconed: boolean | undefined;
	for (let row = first; row < end; row++) {
		const text = strippedRow(lines, cache, row);
		if (!text.startsWith(USER_RAIL_PREFIX) || text.trim() === USER_RAIL_GLYPH) {
			claimed.set(row, USER_RAIL_GLYPH);
			continue;
		}
		if (iconed === undefined) {
			iconed = text.startsWith(USER_ICON_PREFIX);
			claimed.set(row, iconed ? USER_ICON_PREFIX : USER_RAIL_PREFIX);
			continue;
		}
		claimed.set(
			row,
			iconed && text.startsWith(USER_HANG_PREFIX) ? USER_HANG_PREFIX : USER_RAIL_PREFIX,
		);
	}
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
): CleanedRows {
	const cache: string[] = new Array(lines.length);
	/** Rows to drop: paired frame edges and paired border rules. */
	const dropped = new Set<number>();
	/** pi-toolbox frame content rows: strip one `│` from each side. */
	const frameContent = new Set<number>();
	/** Rail user message rows, and the prefix each one sheds. */
	const railContent = new Map<number, string>();

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
	// one row between them are a rail user message's borders, and the rows
	// between carry the rail. Any inner row *without* the rail breaks the
	// candidate: it is what keeps an assistant's own `---` rules, and the text
	// between two of them, from being eaten — those rows are content.
	let lastRule: { row: number; width: number } | undefined;
	for (let row = 0; row < lines.length; row++) {
		if (dropped.has(row)) continue;
		const text = strippedRow(lines, cache, row);
		if (RULE_ROW_RE.test(text)) {
			const width = visibleWidth(text);
			if (lastRule && lastRule.width === width && row - lastRule.row >= 2) {
				dropped.add(lastRule.row);
				dropped.add(row);
				claimRailMessage(lines, cache, lastRule.row + 1, row, railContent);
			}
			lastRule = { row, width };
		} else if (!isRailRow(text)) {
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
		const prefix = railContent.get(row);
		if (prefix !== undefined && text.startsWith(prefix)) {
			rows.push({ text: text.slice(prefix.length), leftTrim: visibleWidth(prefix) });
			changed = true;
			continue;
		}
		rows.push({ text, leftTrim: 0 });
	}
	return { rows, changed };
}
