/**
 * Installs the mouse feature set on Pi's live renderer prototype.
 *
 * This is the first module that actually touches Pi rather than describing
 * what it would do to it. `installMouse` probes what the running Pi build
 * exposes, logs once if something is missing, and for `selectionPendingMode`
 * wraps two of Pi's `TuiAltScreen` methods through `installPrototypePatch`:
 *
 * - `copySelectionToClipboard` — the method Pi calls itself on mouse release.
 *   With `copyOnSelect` off, this wrapper intercepts that call, arms the
 *   pending state instead of copying, and calls through for every other
 *   caller (including its own ctrl+c path below).
 * - `handleViewportInput` — watched for a bare `ctrl+c` (`\x03`). With a
 *   selection pending it performs the real copy by calling back through
 *   `copySelectionToClipboard` (guarded so that call is recognised as the
 *   real thing and not re-armed), then clears the pending state. Anything
 *   else — including `ctrl+c` with nothing pending — calls through to Pi's
 *   own handler, which is what keeps `ctrl+c` interrupting.
 */
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "../config";
import { installPrototypePatch } from "../prototype-patch-registry";
import { disabledFeatureWarning, enabledFeatures, probeCapabilities } from "./capabilities";
import { type BoxLike, boxesAt, scrollContentLinesFor } from "./hit-test";
import { copyableLines, isRuleRow } from "./selection-copy";
import { SelectionPendingState, selectionHintText } from "./selection-state";

const CTRL_C = "\x03";

type SelectionPoint = { scrollView?: unknown; row: number; col: number; boundary?: boolean };
type SelectionBounds = { start: SelectionPoint; end: SelectionPoint };
type SelectionColumns = { start: number; end: number };

/** The slice of `TuiAltScreen` this module reads or wraps. */
type MouseCapablePrototype = {
	getSelectionBounds(this: unknown): SelectionBounds | undefined;
	getSelectionColumns(
		this: unknown,
		line: string,
		row: number,
		selection: SelectionBounds,
	): SelectionColumns;
	copySelectionToClipboard(this: unknown): void;
	handleViewportInput(this: unknown, data: string): { consume: boolean } | undefined;
	applySelection(
		this: unknown,
		screen: readonly string[],
		layout?: { root: BoxLike },
	): readonly string[];
	flash(this: unknown, message: string, durationMs?: number): void;
	previousScreen?: readonly string[];
	currentLayout?: { root: BoxLike };
	// Not a probed capability (see capabilities.ts): a plain instance field
	// this module only ever reads, the same way it already reads
	// `previousScreen` and `currentLayout` without gating on them.
	terminal?: { write(data: string): void };
};

export type InstallMouseDeps = {
	getConfig: () => PolishedTuiConfig;
	requestRender: () => void;
};

/** Logged at most once per process — see `disabledFeatureWarning`. */
let hasWarned = false;

/**
 * Reader for the pending-selection state of whichever `installMouse` call is
 * currently active, mirroring `pasteExpandHintText`'s pattern in
 * `fixed-editor/paste-collapse.ts`. `ui.ts` composes this with the paste hint
 * on every render; there is nothing to wire when no mouse install is active.
 */
let activeState: SelectionPendingState | undefined;

export function activeSelectionHintText(): string | null {
	return activeState ? selectionHintText(activeState) : null;
}

/**
 * The child laid out behind a scroll view, in the same tree walk
 * `scrollContentLinesFor` already does in `hit-test.ts` — mirrored here
 * rather than imported because that helper returns the rendered lines, and
 * this call site needs the box itself: its `rect.y` is where content row 0
 * of those lines sits in the same coordinate space every other box in the
 * tree uses (see `layoutComponent`'s "scroll" branch in pi-tui's
 * `layout.js`, which lays the child out at `y - scrollTop` and then
 * translates it back by the same amount, leaving `rect.y` at
 * `viewportY - scrollTop`). That is what makes `frameRowsIn` below able to
 * hit-test a scrolled-content row without re-deriving Pi's own scroll math.
 */
function scrollContentOrigin(root: BoxLike | undefined, scrollView: unknown): BoxLike | undefined {
	if (!root) return undefined;
	const scrollBox = root as BoxLike & { scrollView?: unknown };
	if (scrollBox.scrollView === scrollView) return root.children?.[0];
	for (const child of root.children ?? []) {
		const found = scrollContentOrigin(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

/** The visible column of the first non-space character, or 0 for a blank line. */
function probeColumn(line: string): number {
	const index = stripTerminalSequences(line).search(/\S/);
	return index >= 0 ? index : 0;
}

/**
 * The box that owns the row at `screenY`, when that box is frame-shaped: its
 * own top and bottom rows (read back through `lineAt`, in whatever row space
 * `origin`'s rect coordinates share with it) are nothing but box-drawing
 * rules. Ownership itself comes entirely from the layout tree via `boxesAt`
 * — the text check only confirms the box we already found is a frame rather
 * than, say, the whole transcript. Walked innermost-first so a frame nested
 * inside another frame is judged by the one immediately around the row.
 *
 * This is why a markdown table can never trigger a strip: a table's rows are
 * plain lines from the `Markdown` component (see
 * `node_modules/@earendil-works/pi-tui/dist/components/markdown.js`), never
 * wrapped in a box whose own top and bottom rows are rules, so no ancestor in
 * `path` ever matches here.
 */
function frameBoxAt(
	origin: BoxLike,
	x: number,
	screenY: number,
	lineAt: (row: number) => string | undefined,
): BoxLike | undefined {
	const path = boxesAt(origin, x, screenY);
	for (let index = path.length - 1; index >= 0; index--) {
		const box = path[index];
		if (box.rect.height < 2) continue;
		const top = box.rect.y;
		const bottom = box.rect.y + box.rect.height - 1;
		if (isRuleRow(lineAt(top) ?? "") && isRuleRow(lineAt(bottom) ?? "")) return box;
	}
	return undefined;
}

/**
 * Which rows of a `bounds.start.row..bounds.end.row` extraction are body
 * rows of a box frame, as indices into that extraction (0-based, matching
 * what `copyableLines` expects). `sourceLines` and `origin` share one row
 * space: `sourceLines[row]` is the text at `origin.rect.y + row`.
 */
function frameRowsIn(
	rowStart: number,
	rowEnd: number,
	sourceLines: readonly string[],
	origin: BoxLike,
): ReadonlySet<number> {
	const owned = new Set<number>();
	const lineAt = (screenY: number) => sourceLines[screenY - origin.rect.y];
	for (let row = rowStart; row <= rowEnd; row++) {
		const line = sourceLines[row] ?? "";
		const screenY = origin.rect.y + row;
		if (frameBoxAt(origin, probeColumn(line), screenY, lineAt)) owned.add(row - rowStart);
	}
	return owned;
}

/**
 * The exact text `copySelectionToClipboard` would produce, built the same way
 * it builds it: per row, through the receiver's own `getSelectionColumns`,
 * then `sliceByColumn` and `stripTerminalSequences` (both exported by
 * pi-tui), joined with "\n" — see `copySelectionToClipboard` in
 * `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js`. Reusing Pi's
 * own helpers instead of re-deriving the column math is what keeps this exact
 * rather than an estimate. The scroll-view case needs the box behind
 * `bounds.start.scrollView`; `getScrollViewBox` that finds it is not exported
 * from pi-tui's published entry point, so `scrollContentLinesFor` mirrors its
 * (trivial) tree walk in `hit-test.ts`.
 *
 * Frame rows are then found from the layout tree (`frameRowsIn`) and taken
 * out through `copyableLines`, so a tool box's border never rides along —
 * see `selection-copy.ts`.
 */
function selectionText(receiver: MouseCapablePrototype, bounds: SelectionBounds): string {
	const scrollView = bounds.start.scrollView;
	const sourceLines = scrollView
		? scrollContentLinesFor(receiver.currentLayout?.root, scrollView)
		: receiver.previousScreen;
	if (!sourceLines) return "";
	const rows: string[] = [];
	for (let row = bounds.start.row; row <= bounds.end.row; row++) {
		const line = sourceLines[row] ?? "";
		const columns = receiver.getSelectionColumns(line, row, bounds);
		rows.push(
			stripTerminalSequences(
				sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
			).trimEnd(),
		);
	}
	const origin = scrollView
		? scrollContentOrigin(receiver.currentLayout?.root, scrollView)
		: receiver.currentLayout?.root;
	const framed = origin
		? frameRowsIn(bounds.start.row, bounds.end.row, sourceLines, origin)
		: new Set<number>();
	return copyableLines(rows, framed).join("\n");
}

/**
 * Performs the real copy with frame-free text, writing the clipboard escape
 * exactly the way `copySelectionToClipboard` does (see the same source
 * reference as `selectionText` above) rather than calling predecessor for
 * it. That duplication is necessary, not incidental: predecessor's own
 * per-row loop always emits one line per row, so a frame's rule rows — which
 * `copyableLines` drops outright — cannot be produced by adjusting selection
 * columns alone. `receiver.flash` is called rather than predecessor's, so a
 * `copyNotice: false` shadow already in place (see `copyWithNotice`) is
 * still honoured.
 *
 * Returns false, doing nothing, when there is no text or the receiver does
 * not expose a terminal to write to — the caller falls back to predecessor's
 * own (unstripped) copy in that case, rather than silently dropping it.
 */
function performFrameFreeCopy(receiver: MouseCapablePrototype, bounds: SelectionBounds): boolean {
	const text = selectionText(receiver, bounds);
	const terminal = receiver.terminal;
	if (text.length === 0 || typeof terminal?.write !== "function") return false;
	terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	receiver.flash("Copied!");
	return true;
}

/**
 * Runs `copySelectionToClipboard` (Pi's real one, reached through the
 * receiver so the `mouse-copy` patch's re-entrancy guard applies) with its
 * own "Copied!" flash suppressed when `copyNotice` is off.
 *
 * Pi's copy method flashes unconditionally — see
 * `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js`. Respecting
 * `copyNotice: false` therefore means shadowing `flash` on the receiver for
 * the duration of this one call and restoring it immediately after, the same
 * shadow-and-restore shape `installPasteCollapse` already uses on `handlePaste`.
 * `receiver` here is Pi's own instance (the wrapper runs inside Pi's own
 * method call, not through the extension-facing Proxy), so a plain
 * assignment is safe.
 */
function copyWithNotice(receiver: MouseCapablePrototype, showNotice: boolean): void {
	if (showNotice) {
		receiver.copySelectionToClipboard();
		return;
	}
	const originalFlash = receiver.flash;
	receiver.flash = () => {};
	try {
		receiver.copySelectionToClipboard();
	} finally {
		receiver.flash = originalFlash;
	}
}

function installSelectionPendingMode(
	prototype: MouseCapablePrototype,
	deps: InstallMouseDeps,
): () => void {
	const state = new SelectionPendingState();
	const previousState = activeState;
	activeState = state;

	// Set while this module is driving `copySelectionToClipboard` itself (the
	// ctrl+c path below), so the `mouse-copy` patch calls through instead of
	// re-arming the state it is itself in the middle of clearing.
	let performingRealCopy = false;

	const cleanupCopy = installPrototypePatch(
		prototype,
		"copySelectionToClipboard",
		"mouse-copy",
		({ predecessor, receiver, args }) => {
			const copyOnSelect = deps.getConfig().mouse.copyOnSelect;
			const typedReceiver = receiver as MouseCapablePrototype;
			if (copyOnSelect || performingRealCopy) {
				// The real copy, whether Pi triggered it directly on release
				// (`copyOnSelect: true`) or this module is driving it itself for
				// ctrl+c below. Either way the text must be frame-free, which
				// predecessor's own text-building does not know how to be — see
				// `performFrameFreeCopy`. Falls back to predecessor verbatim when
				// there is nothing to copy or no terminal to write it to, so an
				// empty/collapsed selection still gets predecessor's own no-op.
				const bounds = typedReceiver.getSelectionBounds();
				if (bounds && performFrameFreeCopy(typedReceiver, bounds)) return undefined;
				return Reflect.apply(predecessor, receiver, args);
			}
			const bounds = typedReceiver.getSelectionBounds();
			if (!bounds) {
				// A collapsed or empty selection (e.g. a plain click after a prior
				// drag) still reaches this call — Pi runs it unconditionally on
				// every release and relies on its own `if (!selection) return;`
				// guard. Any stale arm from an earlier selection must not survive
				// this: left in place, it would make a later ctrl+c consume the
				// key for a no-op copy instead of falling through to interrupt.
				if (state.pending) {
					state.clear();
					deps.requestRender();
				}
				return undefined;
			}
			state.arm(selectionText(typedReceiver, bounds).length);
			deps.requestRender();
			return undefined;
		},
	);

	const cleanupViewportInput = installPrototypePatch(
		prototype,
		"handleViewportInput",
		"mouse-viewport-input",
		({ predecessor, receiver, args }) => {
			const data = args[0];
			if (data === CTRL_C && state.pending) {
				const typedReceiver = receiver as MouseCapablePrototype;
				// `state.pending` can be stale: Pi clears its own selection
				// through paths this module never sees (e.g. starting a new drag
				// overwrites `selectionAnchor`/`selectionFocus` directly, with no
				// call to `copySelectionToClipboard`). Re-read the real bounds
				// before deciding: a copy that would be a no-op must not consume
				// ctrl+c, or an in-flight interrupt gets swallowed for nothing.
				if (!typedReceiver.getSelectionBounds()) {
					state.clear();
					deps.requestRender();
					return Reflect.apply(predecessor, receiver, args);
				}
				performingRealCopy = true;
				try {
					copyWithNotice(typedReceiver, deps.getConfig().mouse.copyNotice);
				} finally {
					performingRealCopy = false;
				}
				state.clear();
				deps.requestRender();
				return { consume: true };
			}
			return Reflect.apply(predecessor, receiver, args);
		},
	);

	return () => {
		cleanupCopy();
		cleanupViewportInput();
		if (activeState === state) activeState = previousState;
	};
}

/** The single visible character at a terminal column, ANSI stripped. */
function charAtColumn(line: string, column: number): string {
	return stripTerminalSequences(sliceByColumn(line, column, 1, true));
}

/**
 * The columns a frame's own verticals occupy on `line`, precisely: `box`'s
 * `rect.x` and `rect.x + rect.width - 1` are exactly where the layout tree
 * says this box's border sits, so — unlike `stripFrameColumns`, which works
 * on already-sliced text and can just look at the ends of the string — this
 * reads the *full* row at those absolute columns. Goes through `sliceByColumn`
 * rather than plain string indexing because `rect.x` is a terminal-cell
 * column, and a wide or multi-code-unit character earlier on the line would
 * put those two out of step.
 */
function frameEdgeColumns(line: string, box: BoxLike): { left: number; right: number } | undefined {
	const leftCol = box.rect.x;
	const rightCol = box.rect.x + box.rect.width - 1;
	if (rightCol <= leftCol) return undefined;
	if (charAtColumn(line, leftCol) !== "│" || charAtColumn(line, rightCol) !== "│") return undefined;
	const left = charAtColumn(line, leftCol + 1) === " " ? leftCol + 2 : leftCol + 1;
	const right = charAtColumn(line, rightCol - 1) === " " ? rightCol - 1 : rightCol;
	return { left, right };
}

/**
 * Keeps a frame's border out of the highlight `applySelection` paints.
 *
 * `applySelection` (`node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js`)
 * builds the highlighted screen itself, inline, from a call to
 * `this.getSelectionColumns(line, row, screenSelection, minColumn, maxColumn)`
 * per row — there is no separate step to intercept for "which columns get
 * inverted". So rather than re-render anything, this shadows
 * `getSelectionColumns` on the receiver for the one call, shrinking the
 * range it returns on frame-owned rows so predecessor's own highlighting
 * naturally stops short of the border. Shadow-and-restore is the same shape
 * `copyWithNotice` already uses on `flash`.
 *
 * `args[1]` is the `layout` parameter `applySelection` was actually called
 * with (defaulting to `this.currentLayout` only when omitted) — `doRender`
 * passes the layout it just computed, which can be a step ahead of
 * `receiver.currentLayout` at this point in the render, so that is read in
 * preference to it.
 */
function installFrameFreeHighlight(prototype: MouseCapablePrototype): () => void {
	return installPrototypePatch(
		prototype,
		"applySelection",
		"mouse-apply-selection",
		({ predecessor, receiver, args }) => {
			const typedReceiver = receiver as MouseCapablePrototype;
			const layoutArg = (args[1] as { root: BoxLike } | undefined) ?? typedReceiver.currentLayout;
			const root = layoutArg?.root;
			const screen = args[0] as readonly string[] | undefined;
			if (!root || !screen) return Reflect.apply(predecessor, receiver, args);

			const lineAt = (row: number) => screen[row];
			const originalGetSelectionColumns = typedReceiver.getSelectionColumns;
			typedReceiver.getSelectionColumns = function frameFreeGetSelectionColumns(
				this: unknown,
				line: string,
				row: number,
				...rest: unknown[]
			): SelectionColumns {
				const columns = Reflect.apply(originalGetSelectionColumns, this, [
					line,
					row,
					...rest,
				]) as SelectionColumns;
				const box = frameBoxAt(root, probeColumn(line), row, lineAt);
				const edges = box && frameEdgeColumns(line, box);
				if (!edges) return columns;
				return {
					start: Math.max(columns.start, edges.left),
					end: Math.min(columns.end, edges.right),
				};
			};
			try {
				return Reflect.apply(predecessor, receiver, args);
			} finally {
				typedReceiver.getSelectionColumns = originalGetSelectionColumns;
			}
		},
	);
}

/**
 * Probes Pi, warns once about whatever this build cannot support, and
 * installs the mouse features that are available. Returns a disposer that
 * removes every patch this call installed.
 */
export function installMouse(prototype: object, deps: InstallMouseDeps): () => void {
	const available = probeCapabilities(prototype);
	const enabled = enabledFeatures(available);

	const warning = disabledFeatureWarning(enabled);
	if (warning && !hasWarned) {
		hasWarned = true;
		console.warn(warning);
	}

	const typedPrototype = prototype as MouseCapablePrototype;
	const cleanups: Array<() => void> = [];
	// `selectionPendingMode`'s own requirements are a superset of
	// `frameFreeSelection`'s single one (`copySelectionToClipboard`), so
	// frame-free copying rides along whenever pending mode installs — see
	// `performFrameFreeCopy`'s call sites inside `installSelectionPendingMode`.
	if (enabled.has("selectionPendingMode")) {
		cleanups.push(installSelectionPendingMode(typedPrototype, deps));
	}
	// Highlighting is a nicety on top of copying (capabilities.ts), so it is
	// gated on nothing but its own capability, independent of every feature
	// flag above.
	if (available.has("applySelection")) {
		cleanups.push(installFrameFreeHighlight(typedPrototype));
	}

	if (cleanups.length === 0) return () => {};
	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}
