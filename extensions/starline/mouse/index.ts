/**
 * Installs the mouse feature set on Pi's live renderer prototype.
 *
 * This is the first module that actually touches Pi rather than describing
 * what it would do to it. `installMouse` probes what the running Pi build
 * exposes, logs once if something is missing, and installs each feature gated
 * on exactly its own declared requirement (`capabilities.ts`). Today that is
 * six features across five patches. Three of those methods carry two features
 * each, and in every case the two share a single patch, because the patch
 * registry holds one behaviour per adapter key and a second registration would
 * silently replace the first:
 *
 * `selectionPendingMode`, across two patches:
 * - `copySelectionToClipboard` — the method Pi calls itself on mouse
 *   release. Wrapped to arm a pending state instead of copying immediately
 *   when `copyOnSelect` is off, calling through for every other caller
 *   (including its own ctrl+c path below).
 * - `handleViewportInput` — watched for a bare `ctrl+c` (`\x03`); with a
 *   selection pending it performs the real copy by calling back through
 *   `copySelectionToClipboard` (guarded so that call is recognised as the
 *   real thing and not re-armed), then clears the pending state. Anything
 *   else — including `ctrl+c` with nothing pending — calls through to Pi's
 *   own handler, which is what keeps `ctrl+c` interrupting.
 *
 * `pathAwareWords`, one patch:
 * - `getWordSelection` — Pi's own double-click word lookup, replaced with
 *   `wordRangeAt` (`word-select.ts`, ported from pi issue #7746) so a path or
 *   a kebab-case identifier selects whole instead of stopping at `/` or `-`.
 *   The installed 0.84.1 build predates #7746, so this substitutes Pi's
 *   entire word-selection rule rather than layering path handling on top of
 *   it — that is what #7746 itself proposes, not scope creep introduced
 *   here. Calls through when `wordRangeAt` declines (column past the end of
 *   the line) or when `mouse.pathAwareWords` is off.
 *
 * `clickToExpandTools`, one patch:
 * - `handleSelectionMouseEvent` — watched for a left-button press that landed
 *   on a tool box's `ctrl+o to expand` hint row. On a hit it toggles that one
 *   box and consumes the press, so the click does not also drop a selection
 *   anchor into the box it just opened; every other press, including one
 *   anywhere else inside the same box, calls through and starts a selection as
 *   usual. `tool-box.ts` carries the reasoning for why the hint row is the
 *   only target and why resolution goes through the component tree.
 *
 * `editorWheelScroll`, one patch:
 * - `routeWheel` — Pi's own wheel routing, which knows only about scroll views
 *   and therefore always scrolls the transcript. Wrapped so a notch that landed
 *   on the input box scrolls the *draft* instead, when the draft is taller than
 *   the box. `editor-mouse.ts` carries how the box is located (not where the
 *   plan for this said it would be) and how the live editor is reached; the
 *   scroll itself is `editor-scroll.ts` — see its header for why it lives in
 *   its own module. Every other notch calls through.
 *
 * `editorClickToCaret`, across two shared patches:
 * - `handleSelectionMouseEvent` — a left-button press inside the input box moves
 *   the caret to the character under it, then calls through, so Pi still drops
 *   its selection anchor there and a drag from that point still selects and
 *   highlights as it always did. `editor-caret.ts` carries the screen-to-buffer
 *   arithmetic and why the box's rectangle is not the text.
 * - `handleViewportInput` — backspace or delete over a live selection inside the
 *   input box removes the whole range instead of one character, through the
 *   editor's own `handleForwardDelete` under a single undo snapshot. It runs
 *   *after* the ctrl+c branch and refuses ctrl+c and ctrl+d outright, so the
 *   interrupt and exit chords cannot be swallowed by it from either direction.
 *   Every backspace it does not act on falls through and deletes one character.
 *
 * `editorBufferCopy`, sharing the `copySelectionToClipboard` patch:
 * - A selection lying inside the input box is copied from the *draft* rather
 *   than from the rendered rows. That is the one place this module builds
 *   clipboard bytes itself, and the reason is that the rendered rows are not
 *   the draft: they carry the rail glyph down the left, the padding each row is
 *   filled out to, and a hard newline wherever the draft happened to wrap.
 *
 * `transcriptCleanCopy`, sharing the same patch:
 * - A selection in the transcript is copied with the chrome two components
 *   paint around their content removed: Starline's user message rails and
 *   border rules, and `pi-toolbox`'s rounded tool box frames. The cleaning
 *   itself is `transcript-copy.ts`, which recognises only those exact markers
 *   and passes everything else through untouched; a selection with no
 *   recognised decoration falls back to Pi's verbatim copy, so nothing that
 *   was clean before changes.
 *
 * Everywhere else the clipboard gets exactly what Pi's own
 * `copySelectionToClipboard` puts there — see `installMouse` for why frame-free
 * selection is not part of this.
 */
import {
	getKeybindings,
	matchesKey,
	sliceByColumn,
	stripTerminalSequences,
} from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "../config";
import { installPrototypePatch } from "../prototype-patch-registry";
import {
	disabledFeatureWarning,
	enabledFeatures,
	type MouseFeature,
	probeCapabilities,
} from "./capabilities";
import {
	activeEditorViewport,
	deleteEditorSelection,
	editorSelectionTextFor,
	moveEditorCaretTo,
} from "./editor-caret";
import { activeEditor, wheelTarget } from "./editor-mouse";
import { scrollEditorBy } from "./editor-scroll";
import { editorVisualRowCount } from "./editor-text-cursor";
import { type BoxLike, scrollContentLinesFor } from "./hit-test";
import { externalEditorName, SelectionPendingState, selectionHintText } from "./selection-state";
import { type ExpandTarget, expandKeyText, expandTargetAt, keyTextFor } from "./tool-box";
import { cleanTranscriptRows } from "./transcript-copy";
import { wordRangeAt } from "./word-select";

const CTRL_C = "\x03";
/** Pi's exit chord, and `tui.editor.deleteCharForward`'s second default key. */
const CTRL_D = "\x04";

/**
 * Whether `data` is the ctrl+c chord, in whatever encoding the terminal sent
 * it. Pi 0.84 pushes the Kitty keyboard protocol (and falls back to xterm
 * modifyOtherKeys) on every capable terminal, and under either protocol the
 * chord arrives as an escape sequence — `\x1b[99;5u` or `\x1b[27;5;99~` —
 * never as the bare `\x03` a plain legacy terminal sends. The pending copy
 * must recognise all three, or ctrl+c falls through to Pi's own binding
 * (`app.clear`, clear the editor) exactly when it was about to copy. Pi's
 * own key matcher is the authority here: it parses every protocol this
 * build negotiates, and its `ctrl+c` arm accepts the raw control character
 * too, so a legacy terminal keeps working unchanged.
 */
function isCtrlC(data: unknown): boolean {
	if (typeof data !== "string" || data.length === 0) return false;
	try {
		return matchesKey(data, "ctrl+c");
	} catch {
		// A pi-tui build that has moved `matchesKey` must not break the copy:
		// fall back to the raw byte, which is what this branch has always read.
		return data === CTRL_C;
	}
}

/** Opens the draft in `$EDITOR` — the hint an editor selection's hint carries. */
const EXTERNAL_EDITOR_KEYBINDING = "app.editor.external";

/**
 * SGR mouse bits, as `parseSgrMouseEvent` decodes them
 * (`tui-alt-screen.js:390`). `button & 3` is the button — 0 is left — bit 32
 * marks a motion (drag) report and bit 64 a wheel notch. `release` is the
 * `m`/`M` terminator.
 */
const BUTTON_MASK = 3;
const LEFT_BUTTON = 0;
const MOTION_BIT = 32;
const WHEEL_BIT = 64;

type MouseEventLike = { button: number; x: number; y: number; release?: boolean };

/** `parseWheelEvent`'s output (`tui-alt-screen.js:345`): -1 is up, 1 is down. */
type WheelEventLike = { direction: number; x: number; y: number };

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
	flash(this: unknown, message: string, durationMs?: number): void;
	getWordSelection(this: unknown, point: SelectionPoint): SelectionBounds | undefined;
	getSelectionSourceLine(this: unknown, point: SelectionPoint): string;
	hasOverlay(this: unknown): boolean;
	/**
	 * `TuiAltScreen.routeWheel(event)` (`tui-alt-screen.js:375`). `event` is
	 * `parseWheelEvent`'s output — `{ direction: -1 | 1, x, y }`, zero-based —
	 * and the method returns nothing.
	 */
	routeWheel(this: unknown, event: WheelEventLike): void;
	/**
	 * `TuiBase.requestRender(force = false)` (`tui.js:495`), inherited by
	 * `TuiAltScreen` and public. The only method here this module calls rather
	 * than patches — see `capabilities.ts`.
	 */
	requestRender(this: unknown, force?: boolean): void;
	previousScreen?: readonly string[];
	// Not probed capabilities (see capabilities.ts): plain instance fields
	// this module only ever reads.
	currentLayout?: { root: BoxLike };
	/**
	 * `TuiAltScreen.selectionAnchor` / `.selectionFocus` (`tui-alt-screen.js:45`).
	 * Plain instance fields, which Pi assigns and clears throughout its own
	 * selection handling; the range delete clears them the same way once the text
	 * they described is gone.
	 */
	selectionAnchor?: unknown;
	selectionFocus?: unknown;
	/**
	 * `TuiBase.terminal` (`tui.js:101`); `rows` is a getter on it, and `write` is
	 * how `copySelectionToClipboard` reaches the clipboard — it emits OSC 52
	 * through the terminal rather than through any renderer method.
	 */
	terminal?: { rows?: number; write?: (data: string) => void };
	/**
	 * How many lines one notch moves, `max(1, options.wheelScrollLines ?? 1)`
	 * (`tui-alt-screen.js:73`). Read so the editor scrolls by the same amount
	 * the transcript would have.
	 */
	wheelScrollLines?: number;
};

/**
 * Repaints go through the receiver, not through a callback the caller supplies.
 *
 * The renderer these patches run inside is the thing that needs to repaint, and
 * `TuiAltScreen` calls `this.requestRender()` all through its own mouse handling
 * for exactly this. Routing it back out to the extension instead made the hint
 * depend on whatever repaint path the extension happened to own — which, until
 * this was fixed, was the footer's, so with `features.statusLine` off the
 * pending hint never appeared until some unrelated frame came along. The hint
 * lives in the editor's metadata row; it was never the footer's to schedule.
 */
export type InstallMouseDeps = {
	getConfig: () => PolishedTuiConfig;
};

/** Logged at most once per process — see `disabledFeatureWarning`. */
let hasWarned = false;

/**
 * Reader for the pending-selection state of whichever `installMouse` call is
 * currently active, mirroring `pasteExpandHintText`'s pattern in
 * `../paste-collapse.ts`. `ui.ts` composes this with the paste hint
 * on every render; there is nothing to wire when no mouse install is active.
 */
let activeState: SelectionPendingState | undefined;

export function activeSelectionHintText(): string | null {
	return activeState ? selectionHintText(activeState, externalEditorName()) : null;
}

/**
 * The "ctrl+g to edit in $EDITOR" hint while the draft outgrows the box.
 *
 * An editor selection cannot grow past the visible window — there is no
 * drag-scroll — so when the draft has more visual rows than the box shows,
 * some of it is unreachable by mouse no matter how you drag. That is exactly
 * when the external editor is the way to act on the whole draft, so the hint
 * is offered whenever the draft outgrows the box, not only while a selection
 * is live. Refreshed on every `handleViewportInput` call (keystrokes and
 * mouse events both land there), read by `ui.ts` when nothing else owns the
 * metadata row's right side.
 */
let externalEditorHint: string | null = null;

export function externalEditorHintText(): string | null {
	return externalEditorHint;
}

function refreshExternalEditorHint(
	receiver: MouseCapablePrototype,
	config: PolishedTuiConfig,
): void {
	externalEditorHint = null;
	try {
		const viewport = activeEditorViewport(receiver, config);
		if (!viewport) return;
		const visualRows = editorVisualRowCount(viewport.editor);
		if (visualRows > viewport.viewport.contentRows) {
			externalEditorHint = `${keyTextFor(EXTERNAL_EDITOR_KEYBINDING)} to edit in ${
				externalEditorName() ?? "$EDITOR"
			}`;
		}
	} catch {
		// Best effort: an editor this module cannot read offers no hint.
	}
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
 * This is a *measurement*, not a copy: nothing here writes a clipboard. The
 * pending hint needs to say how many characters ctrl+c would put there. Rows
 * come back verbatim — no frame stripping, no rule-row dropping — so this is
 * the count for a selection Pi's own copy would answer. When
 * `transcriptCleanCopy` would answer the copy instead, `pendingSelectionText`
 * counts the cleaned text — the hint's promise and the clipboard's bytes are
 * kept in agreement there, by counting whichever text the copy will send.
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
	return rows.join("\n");
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

/**
 * Writes the draft's own text to the clipboard for a selection that lies inside
 * the input box, and reports whether it did — `false` means this selection was
 * not the editor's and Pi's own copy must run instead.
 *
 * This is the one place in the module that builds clipboard bytes rather than
 * letting predecessor build them, and it is deliberate: Pi copies *rendered*
 * rows, so a selection in the input box picks up the rail glyph, the padding
 * the frame fills each row out to, and a newline wherever the draft happened to
 * wrap. None of that is in the draft. The bytes go out the same way Pi's own
 * copy sends them — OSC 52 through `terminal.write`, see
 * `copySelectionToClipboard` in
 * `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js` — so nothing
 * downstream can tell the two copies apart.
 *
 * The flash is unconditional, exactly as Pi's is. `copyNotice: false` is
 * honoured by `copyWithNotice`, which shadows `flash` around the whole call;
 * checking the setting here as well would suppress the notice twice on one path
 * and not at all on the other.
 */
function editorTextForSelection(
	receiver: MouseCapablePrototype,
	config: PolishedTuiConfig,
	bounds: SelectionBounds,
): string | undefined {
	try {
		// An overlay is composited over a layout that still contains the editor,
		// so without this a selection dropped on a dialog would be read as text
		// from the draft hidden behind it. Both callers ask it, or the hint could
		// count one text while the copy sends another.
		if (receiver.hasOverlay()) return undefined;
		return editorSelectionTextFor(receiver, config, bounds);
	} catch {
		return undefined;
	}
}

function copyEditorSelection(receiver: MouseCapablePrototype, config: PolishedTuiConfig): boolean {
	try {
		const bounds = receiver.getSelectionBounds();
		if (!bounds) return false;
		const text = editorTextForSelection(receiver, config, bounds);
		// undefined is "not the editor's"; "" is the editor's and empty, which is
		// still ours to answer — falling through would have Pi copy the rail out
		// of a blank row.
		if (text === undefined) return false;
		if (text.length === 0) return true;
		const write = receiver.terminal?.write;
		if (typeof write !== "function") return false;
		write.call(receiver.terminal, `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		receiver.flash("Copied!");
		return true;
	} catch {
		// Reading the editor and the layout is best effort. Anything this trips
		// over means Pi's own copy should run.
		return false;
	}
}

/**
 * The transcript's text for this selection with the painted chrome removed,
 * or undefined when there is nothing to clean — in which case Pi's verbatim
 * copy runs, so a selection over plain rows takes exactly the path it always
 * did.
 *
 * Only scroll-view selections are cleaned. A screen-space selection
 * (`bounds.start.scrollView` unset) is over the dock or an overlay, where
 * rows are not transcript content; both stay Pi's. The overlay guard is the
 * same one every feature here asks: an overlay is composited over a layout
 * that still contains the transcript, so without it a selection dropped on a
 * dialog would be read as text from the scrollback behind it.
 *
 * Column mapping: `leftTrim` columns came off the left of a cleaned row, so
 * the selection's start and end columns shift by the same amount on the rows
 * they touch. The shifted bounds go through the receiver's own
 * `getSelectionColumns`, which aligns both ends to grapheme cell ranges
 * (`tui-alt-screen.js:716`) — the end column can no more cut a grapheme here
 * than it can in Pi's own copy.
 */
function transcriptSelectionText(
	receiver: MouseCapablePrototype,
	config: PolishedTuiConfig,
	bounds: SelectionBounds,
): string | undefined {
	const scrollView = bounds.start.scrollView;
	if (!scrollView) return undefined;
	if (receiver.hasOverlay()) return undefined;
	const sourceLines = scrollContentLinesFor(receiver.currentLayout?.root, scrollView);
	if (!sourceLines) return undefined;
	const cleaned = cleanTranscriptRows(
		sourceLines,
		bounds.start.row,
		bounds.end.row,
		config.icons.rail,
	);
	if (!cleaned.changed) return undefined;
	const adjusted: SelectionBounds = {
		start: bounds.start,
		end: bounds.end,
	};
	const rows: string[] = [];
	for (let i = 0; i < cleaned.rows.length; i++) {
		const entry = cleaned.rows[i];
		if (entry === null) continue;
		const row = bounds.start.row + i;
		if (entry.leftTrim > 0) {
			if (row === bounds.start.row) {
				adjusted.start = { ...bounds.start, col: Math.max(0, bounds.start.col - entry.leftTrim) };
			}
			if (row === bounds.end.row) {
				adjusted.end = { ...bounds.end, col: Math.max(0, bounds.end.col - entry.leftTrim) };
			}
		}
		const columns = receiver.getSelectionColumns(entry.text, row, adjusted);
		rows.push(
			sliceByColumn(
				entry.text,
				columns.start,
				Math.max(0, columns.end - columns.start),
				true,
			).trimEnd(),
		);
	}
	return rows.join("\n");
}

/**
 * Writes the transcript's cleaned text to the clipboard for a selection that
 * carried recognised chrome, and reports whether it did — `false` means
 * there was nothing to clean and Pi's own copy must run instead. The bytes
 * go out the same way Pi's own copy sends them (OSC 52 through
 * `terminal.write`), for the same reason `copyEditorSelection` does: nothing
 * downstream can tell the two copies apart.
 *
 * A selection over pure decoration cleans to "" and is consumed without a
 * clipboard write — Pi's own copy has the same shape (`if (text.length === 0)
 * return`), it just gets there after building a string of rails.
 */
function copyTranscriptSelection(
	receiver: MouseCapablePrototype,
	config: PolishedTuiConfig,
): boolean {
	try {
		const bounds = receiver.getSelectionBounds();
		if (!bounds) return false;
		const text = transcriptSelectionText(receiver, config, bounds);
		if (text === undefined) return false;
		if (text.length === 0) return true;
		const write = receiver.terminal?.write;
		if (typeof write !== "function") return false;
		write.call(receiver.terminal, `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		receiver.flash("Copied!");
		return true;
	} catch {
		// Cleaning reads the layout and the selection, both best effort.
		// Anything this trips over means Pi's own copy should run.
		return false;
	}
}

/**
 * Whether `data` is the backspace or delete the range delete acts on.
 *
 * The question is asked of Pi's own keybinding registry, against the two
 * bindings Pi's editor itself dispatches on (`editor.js:599-606`), so a user who
 * has rebound either gets the key they bound rather than a hardcoded byte. A
 * registry that disagrees — this repo has two copies of pi-tui, though
 * production resolves both to Pi's, see `expandKeyText` in `tool-box.ts` — makes
 * this return false, which falls through to Pi's own one-character delete. That
 * is the safe direction to be wrong in.
 *
 * ctrl+c and ctrl+d are refused outright, before the registry is consulted at
 * all. `tui.editor.deleteCharForward` binds `ctrl+d` by default, and ctrl+c and
 * ctrl+d are Pi's interrupt and exit chords; consuming either because a
 * selection happens to be live would break a global key to save a keystroke.
 * The ctrl+c branch above already returns before this is reached, but stating
 * it here means the guarantee does not depend on branch order.
 */
function isRangeDeleteKey(data: unknown): boolean {
	if (typeof data !== "string" || data.length === 0) return false;
	if (data === CTRL_C || data === CTRL_D) return false;
	try {
		const keybindings = getKeybindings();
		return (
			keybindings.matches(data, "tui.editor.deleteCharBackward") ||
			keybindings.matches(data, "tui.editor.deleteCharForward")
		);
	} catch {
		// A build that has moved the registry is one where backspace keeps its
		// ordinary meaning; it is never a reason to break a keystroke.
		return false;
	}
}

/**
 * Removes the draft text a live editor selection covers, and clears the
 * selection that described it.
 *
 * Returns false for every selection that is not the input box's, which leaves
 * the key to Pi and an ordinary backspace deleting one character.
 */
function deleteSelectedRange(receiver: MouseCapablePrototype, config: PolishedTuiConfig): boolean {
	try {
		if (!config.editorClickCursor) return false;
		// The same overlay question the rest of this feature asks: a selection
		// dropped on a dialog must not delete the draft behind it.
		if (receiver.hasOverlay()) return false;
		const bounds = receiver.getSelectionBounds();
		if (!bounds) return false;
		if (!deleteEditorSelection(receiver, config, bounds)) return false;
		// The highlight described text that is gone. Pi clears these two fields
		// itself all through its own selection handling; leaving them set would
		// paint a selection over whatever moved up to fill the gap.
		receiver.selectionAnchor = undefined;
		receiver.selectionFocus = undefined;
		return true;
	} catch {
		// Driving the editor is best effort. Anything this trips over means the
		// key was an ordinary backspace.
		return false;
	}
}

/**
 * The text a copy of this selection would put on the clipboard, for the pending
 * hint's character count.
 *
 * It has to ask the same two paths the copy itself asks, in the same order, or
 * the hint promises a number ctrl+c does not deliver.
 */
function pendingSelectionText(
	receiver: MouseCapablePrototype,
	config: PolishedTuiConfig,
	bounds: SelectionBounds,
	bufferCopy: boolean,
	cleanCopy: boolean,
): { text: string; inEditor: boolean } {
	const buffered = bufferCopy ? editorTextForSelection(receiver, config, bounds) : undefined;
	if (buffered !== undefined) return { text: buffered, inEditor: true };
	// The count the hint shows must be the number ctrl+c actually delivers, so
	// a selection the copy would clean is counted after cleaning.
	if (cleanCopy && config.mouse.transcriptCleanCopy) {
		try {
			const cleaned = transcriptSelectionText(receiver, config, bounds);
			if (cleaned !== undefined) return { text: cleaned, inEditor: false };
		} catch {
			// A cleaning failure falls back to the verbatim count, which is what
			// the copy itself falls back to as well.
		}
	}
	return { text: selectionText(receiver, bounds), inEditor: false };
}

/**
 * Installs the two features that live on `copySelectionToClipboard`.
 *
 * `selectionPendingMode` — arm on release, copy on ctrl+c — spans two patches:
 * the copy patch decides whether a release copies now or arms and waits, and
 * the `handleViewportInput` patch is what a waiting selection is eventually
 * released by.
 *
 * `editorBufferCopy` sits in front of the real copy on that same method. They
 * share one patch rather than taking a key each because
 * `installPrototypePatch` holds exactly one behaviour per adapter key: a second
 * registration under `mouse-copy` would silently replace the first, and two
 * different keys would leave the order they run in — and which of them gets to
 * consume the call — implicit. Here the precedence is written down: the buffer
 * copy answers first, and only when it declines does the pending mode or
 * predecessor see the call.
 *
 * Either feature can be off. With `selectionPendingMode` unavailable there is
 * no state and every call is a real copy; with `editorBufferCopy` unavailable
 * the clipboard is Pi's own bytes, exactly as before.
 */
function installCopying(
	prototype: MouseCapablePrototype,
	deps: InstallMouseDeps,
	features: ReadonlySet<MouseFeature>,
): () => void {
	const bufferCopy = features.has("editorBufferCopy");
	const cleanCopy = features.has("transcriptCleanCopy");
	const rangeDelete = features.has("editorClickToCaret");
	const pendingMode = features.has("selectionPendingMode");
	const state = pendingMode ? new SelectionPendingState() : undefined;
	const previousState = activeState;
	if (state) activeState = state;

	// Set while this module is driving `copySelectionToClipboard` itself (the
	// ctrl+c path below), so the `mouse-copy` patch performs the copy instead of
	// re-arming the state it is itself in the middle of clearing.
	let performingRealCopy = false;

	const cleanups: Array<() => void> = [];

	// Only installed when a feature that answers `copySelectionToClipboard` is
	// on. With just `editorClickToCaret` the method is not ours to touch, and a
	// Pi that has moved it must not make this install throw.
	if (pendingMode || bufferCopy || cleanCopy) {
		cleanups.push(
			installPrototypePatch(
				prototype,
				"copySelectionToClipboard",
				"mouse-copy",
				({ predecessor, receiver, args }) => {
					const typedReceiver = receiver as MouseCapablePrototype;
					const config = deps.getConfig();
					if (!state || config.mouse.copyOnSelect || performingRealCopy) {
						// The real copy, whether Pi triggered it directly on release
						// (`copyOnSelect: true`), this module is driving it itself for
						// ctrl+c below, or pending mode is not installed at all.
						if (bufferCopy && copyEditorSelection(typedReceiver, config)) return undefined;
						if (
							cleanCopy &&
							config.mouse.transcriptCleanCopy &&
							copyTranscriptSelection(typedReceiver, config)
						) {
							return undefined;
						}
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
							typedReceiver.requestRender();
						}
						return undefined;
					}
					const pendingText = pendingSelectionText(
						typedReceiver,
						config,
						bounds,
						bufferCopy,
						cleanCopy,
					);
					state.arm(
						pendingText.text.length,
						// An editor selection cannot grow past the visible window —
						// there is no drag-scroll — so the hint for one points at the
						// external editor, the way to act on the whole draft. ""
						// (unbound) simply shows no suffix.
						pendingText.inEditor ? keyTextFor(EXTERNAL_EDITOR_KEYBINDING) : undefined,
					);
					typedReceiver.requestRender();
					return undefined;
				},
			),
		);
	}

	if (!state && !rangeDelete) {
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	}

	cleanups.push(
		installPrototypePatch(
			prototype,
			"handleViewportInput",
			"mouse-viewport-input",
			({ predecessor, receiver, args }) => {
				const data = args[0];
				// Keystrokes and mouse events both land here, so this is the one
				// place that sees every draft change; keep the outgrew-the-box
				// hint current with it.
				refreshExternalEditorHint(receiver as MouseCapablePrototype, deps.getConfig());
				// ---- Branch 1: ctrl+c, `selectionPendingMode`'s. ----------------
				//
				// This branch is FIRST, and deliberately so. The one outcome that
				// must never regress is a bare ctrl+c with nothing pending reaching
				// Pi and interrupting; evaluating its branch before any other means
				// no feature added to this method later can intercept it by being
				// installed in a different order. `isRangeDeleteKey` refuses ctrl+c
				// and ctrl+d outright as well, so the guarantee holds structurally
				// from both directions rather than by ordering alone.
				if (state && isCtrlC(data) && state.pending) {
					const typedReceiver = receiver as MouseCapablePrototype;
					// `state.pending` can be stale: Pi clears its own selection
					// through paths this module never sees (e.g. starting a new
					// drag overwrites `selectionAnchor`/`selectionFocus` directly,
					// with no call to `copySelectionToClipboard`). Re-read the real
					// bounds before deciding: a copy that would be a no-op must not
					// consume ctrl+c, or an in-flight interrupt gets swallowed for
					// nothing.
					if (!typedReceiver.getSelectionBounds()) {
						state.clear();
						typedReceiver.requestRender();
						return Reflect.apply(predecessor, receiver, args);
					}
					performingRealCopy = true;
					try {
						copyWithNotice(typedReceiver, deps.getConfig().mouse.copyNotice);
					} finally {
						performingRealCopy = false;
					}
					state.clear();
					typedReceiver.requestRender();
					return { consume: true };
				}
				// ---- Branch 2: backspace and delete, `editorClickToCaret`'s. ----
				//
				// The two branches key off disjoint input — ctrl+c above, backspace
				// and delete here — so they compose rather than compete. Range
				// delete consumes the key only when it really removed something;
				// every other backspace falls through and goes on deleting one
				// character, which is the behaviour it must not break.
				if (rangeDelete && isRangeDeleteKey(data)) {
					const typedReceiver = receiver as MouseCapablePrototype;
					if (deleteSelectedRange(typedReceiver, deps.getConfig())) {
						// Pi's `handleInput` returns as soon as a listener consumes,
						// so the focused editor never sees the key and Pi never
						// reaches its own `requestImmediateRender` (`tui.js:620`).
						// Redrawing the changed draft is this branch's job.
						state?.clear();
						typedReceiver.requestRender();
						return { consume: true };
					}
				}
				return Reflect.apply(predecessor, receiver, args);
			},
		),
	);

	return () => {
		for (const cleanup of cleanups) cleanup();
		if (activeState === state) activeState = previousState;
	};
}

/**
 * Installs `pathAwareWords` on `getWordSelection`.
 *
 * The receiver's own `getSelectionSourceLine` gives the raw line under the
 * point; `stripTerminalSequences` is applied the same way predecessor itself
 * applies it (see `getWordSelection` in
 * `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js`), so
 * `wordRangeAt` sees the same plain text Pi's own segmenter would. `col` is
 * the only thing the wrapper changes on the way out — `row`, `scrollView`
 * and any other point field ride through unmodified, which is what keeps a
 * scroll-view selection landing in the right place.
 */
function installPathAwareWords(
	prototype: MouseCapablePrototype,
	deps: InstallMouseDeps,
): () => void {
	return installPrototypePatch(
		prototype,
		"getWordSelection",
		"mouse-word-selection",
		({ predecessor, receiver, args }) => {
			if (!deps.getConfig().mouse.pathAwareWords) {
				return Reflect.apply(predecessor, receiver, args);
			}
			const typedReceiver = receiver as MouseCapablePrototype;
			const point = args[0] as SelectionPoint;
			const line = stripTerminalSequences(typedReceiver.getSelectionSourceLine(point));
			const range = wordRangeAt(line, point.col);
			if (!range) return Reflect.apply(predecessor, receiver, args);
			return {
				start: { ...point, col: range.start },
				end: { ...point, col: range.end, boundary: true },
			};
		},
	);
}

/**
 * A left-button press: not a release, not a drag, not another button.
 *
 * Pi's own handler returns immediately unless `(button & 3) === 0`, treats
 * `release` as the end of a drag and bit 32 as motion during one. Only the
 * press opens a selection, so only the press is the one this feature may take
 * instead.
 *
 * Bit 64 is excluded too, even though `handleInput` peels wheel reports off
 * before this method is reached (`parseWheelEvent` claims anything with bit 64
 * and a direction of 0 or 1): a notch of scroll that landed on a hint row
 * would otherwise expand a box the pointer was only passing over, and that
 * depends on a dispatch order in a file this package does not own.
 *
 * The shape is checked rather than assumed — this runs on whatever Pi passes,
 * and a malformed event must fall through, never throw.
 */
function isLeftButtonPress(event: unknown): event is MouseEventLike {
	if (typeof event !== "object" || event === null) return false;
	const candidate = event as Partial<MouseEventLike>;
	if (typeof candidate.button !== "number") return false;
	if (typeof candidate.x !== "number" || typeof candidate.y !== "number") return false;
	if (candidate.release) return false;
	if ((candidate.button & (MOTION_BIT | WHEEL_BIT)) !== 0) return false;
	return (candidate.button & BUTTON_MASK) === LEFT_BUTTON;
}

/**
 * The box a press should toggle, or undefined for every press that should go
 * on being a press.
 *
 * Everything is resolved here, inside the one call: the layout is read as it
 * is right now, the component tree is built and dropped, and nothing is
 * carried to the release. A tool that is still running re-renders between the
 * two, so an answer kept that long would be about rows that have moved.
 */
function pressExpandTarget(
	receiver: MouseCapablePrototype,
	event: unknown,
	deps: InstallMouseDeps,
): ExpandTarget | undefined {
	try {
		if (!deps.getConfig().mouse.clickToExpandTools) return undefined;
		if (!isLeftButtonPress(event)) return undefined;
		// Pi resolves no scroll view while an overlay is up, so neither does this
		// — a click on a dialog must not reach the transcript behind it.
		if (receiver.hasOverlay()) return undefined;
		return expandTargetAt(
			{ root: receiver.currentLayout?.root, keyText: expandKeyText() },
			event.x,
			event.y,
		);
	} catch {
		// Resolution is a best-effort read of Pi's internals. Anything it trips
		// over means this press was an ordinary press.
		return undefined;
	}
}

/**
 * Puts the caret where a press landed, when the press landed in the input box.
 *
 * Nothing is consumed: the press goes on to Pi, which drops its selection
 * anchor there exactly as it always did, so a drag from that point still
 * highlights and still copies. That is also what pays for the repaint — Pi's
 * own press branch ends in `requestRender()` unconditionally
 * (`tui-alt-screen.js:699`), so this feature never has to ask for one itself,
 * and `requestRender` is correspondingly absent from its requirements.
 */
function moveCaretForPress(
	receiver: MouseCapablePrototype,
	event: unknown,
	deps: InstallMouseDeps,
): void {
	try {
		const config = deps.getConfig();
		if (!config.editorClickCursor) return;
		if (!isLeftButtonPress(event)) return;
		// Pi resolves no scroll view while an overlay is up, so neither does this
		// — a click on a dialog must not move a caret in the box behind it.
		if (receiver.hasOverlay()) return;
		moveEditorCaretTo(receiver, config, event.x, event.y);
	} catch {
		// Moving the caret is a best-effort read of Pi's internals and of an
		// editor this module did not necessarily build. Anything it trips over
		// means this press was an ordinary press.
	}
}

/**
 * Installs the two features that live on `handleSelectionMouseEvent`.
 *
 * They share one patch because `installPrototypePatch` holds exactly one
 * behaviour per adapter key — a second registration under
 * `mouse-selection-event` would silently replace the first, and giving them a
 * key each would leave the order they run in implicit, which matters here
 * because only one of them may consume the press. Written as one patch the
 * precedence is explicit and testable:
 *
 * 1. `clickToExpandTools` gets the press first, and *consumes* it when it lands
 *    on a tool box's hint row. That is what keeps the click from also dropping
 *    a selection anchor into the box it just opened.
 * 2. `editorClickToCaret` gets every press expand did not take, moves the caret
 *    if the press was inside the input box, and never consumes.
 * 3. Pi gets the press either way, unless expand took it.
 *
 * The two cannot collide in practice — the hint rows are in the transcript and
 * the caret rows are in the dock — but the ordering is what makes that a fact
 * rather than a hope, and either feature may be off without disturbing the
 * other.
 */
function installSelectionMouse(
	prototype: MouseCapablePrototype,
	deps: InstallMouseDeps,
	features: ReadonlySet<MouseFeature>,
): () => void {
	const expandTools = features.has("clickToExpandTools");
	const clickToCaret = features.has("editorClickToCaret");
	return installPrototypePatch(
		prototype,
		"handleSelectionMouseEvent",
		"mouse-selection-event",
		({ predecessor, receiver, args }) => {
			const typedReceiver = receiver as MouseCapablePrototype;
			if (expandTools) {
				const target = pressExpandTarget(typedReceiver, args[0], deps);
				if (target) {
					target.component.setExpanded(target.expanded);
					typedReceiver.requestRender();
					return undefined;
				}
			}
			if (clickToCaret) moveCaretForPress(typedReceiver, args[0], deps);
			return Reflect.apply(predecessor, receiver, args);
		},
	);
}

/**
 * The shape `parseWheelEvent` produces, checked rather than assumed — this runs
 * on whatever Pi hands `routeWheel`, and anything unrecognised must fall
 * through to Pi's own routing, never throw.
 */
function isWheelEvent(event: unknown): event is WheelEventLike {
	if (typeof event !== "object" || event === null) return false;
	const candidate = event as Partial<WheelEventLike>;
	return (
		typeof candidate.direction === "number" &&
		typeof candidate.x === "number" &&
		typeof candidate.y === "number"
	);
}

/**
 * Scrolls the input box for this notch, or reports that the notch was not the
 * input box's — in which case Pi routes it as it always did.
 *
 * Pi does not scroll the editor: the editor's `scrollOffset` is re-derived from
 * the caret on every render, pulled back whenever the caret would fall outside
 * the visible window (`components/editor.js:392-401`). So a scroll here is an
 * offset *and* a caret move, which is what `scrollEditorBy` does — the same
 * function that has been in daily use since pi-powerline-footer, so a notch
 * behaves the way it always has.
 *
 * The window it scrolls within is Pi's own `max(5, rows * 0.3)`, taken from the
 * terminal rather than from the box's rect: the rect includes Starline's border
 * and metadata rows, and guessing how many of those there are would put the
 * boundary in the wrong place. Without a row count there is nothing to compute
 * it from, so the notch falls through.
 */
function scrollEditorForWheel(
	receiver: MouseCapablePrototype,
	event: unknown,
	deps: InstallMouseDeps,
): boolean {
	try {
		if (!deps.getConfig().mouse.wheelRouting) return false;
		if (!isWheelEvent(event)) return false;
		// An overlay is composited over a layout that still contains the editor,
		// so the box is still "under" a pointer aimed at the dialog on top of it.
		if (receiver.hasOverlay()) return false;
		const editor = activeEditor();
		if (!editor) return false;
		const rows = receiver.terminal?.rows;
		if (typeof rows !== "number") return false;
		if (
			wheelTarget(receiver.currentLayout?.root, editor.component, event.x, event.y) !== "editor"
		) {
			return false;
		}
		const lines = event.direction * Math.max(1, receiver.wheelScrollLines ?? 1);
		return scrollEditorBy(editor.scrollable, lines, rows);
	} catch {
		// Routing is a best-effort read of Pi's internals and of an editor this
		// module did not necessarily build. Anything it trips over means this
		// notch was the transcript's.
		return false;
	}
}

/**
 * Installs `editorWheelScroll` on `routeWheel`.
 *
 * A thin wrapper with one job: a notch that landed on a draft taller than the
 * input box scrolls the box and is consumed; everything else calls through and
 * scrolls the transcript exactly as before. "Everything else" includes a notch
 * over the transcript, a notch over an overlay, a draft that fits entirely, an
 * editor this module cannot read, and `mouse.wheelRouting` being off.
 *
 * Reaching the top or bottom of a draft that *does* scroll is deliberately not
 * in that list: the notch stays with the box. Chaining on to the transcript at
 * the boundary would make the box feel like it slipped out from under the
 * pointer — see `editor-scroll.ts`.
 */
function installEditorWheelScroll(
	prototype: MouseCapablePrototype,
	deps: InstallMouseDeps,
): () => void {
	return installPrototypePatch(
		prototype,
		"routeWheel",
		"mouse-wheel",
		({ predecessor, receiver, args }) => {
			const typedReceiver = receiver as MouseCapablePrototype;
			if (!scrollEditorForWheel(typedReceiver, args[0], deps)) {
				return Reflect.apply(predecessor, receiver, args);
			}
			// Pi's own `routeWheel` repaints at the end of every notch; consuming
			// the event means reaching that repaint is now this wrapper's job.
			typedReceiver.requestRender();
			return undefined;
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
	// Frame-free selection is deliberately not installed, and is not a feature
	// in `capabilities.ts` either. It rewrote the clipboard text to drop a tool
	// box's border, which meant *inferring* where a frame was from the rendered
	// rows — and a frame is not a structural concept in Pi. It is a visual
	// convention `pi-toolbox` paints, so every discriminator (rule-capped
	// edges, `setExpanded`, blank-row trimming, verticals) was a guess that a
	// new component could falsify: `BashExecutionComponent` is rule-capped and
	// expandable and draws no frame, so any box-drawn table inside bash output
	// lost its borders.
	//
	// `transcriptCleanCopy` is the narrower successor that lesson produced: it
	// removes only the exact markers two named renderers are known to paint
	// (Starline's rail + full-width rule pairs, pi-toolbox's equal-width
	// rounded-corner pairs), never inferred ones — a square-cornered markdown
	// table, a blockquote gutter and bash output all pass through verbatim,
	// and a selection with no recognised marker falls back to Pi's own copy
	// untouched. The full frame-geometry version still wants what is written
	// below: `pi-toolbox` publishing which rows it drew a border on, at which
	// columns, so Starline reads a fact instead of inferring one.
	if (
		enabled.has("selectionPendingMode") ||
		enabled.has("editorBufferCopy") ||
		enabled.has("editorClickToCaret") ||
		enabled.has("transcriptCleanCopy")
	) {
		cleanups.push(installCopying(typedPrototype, deps, enabled));
	}
	if (enabled.has("pathAwareWords")) {
		cleanups.push(installPathAwareWords(typedPrototype, deps));
	}
	if (enabled.has("clickToExpandTools") || enabled.has("editorClickToCaret")) {
		cleanups.push(installSelectionMouse(typedPrototype, deps, enabled));
	}
	if (enabled.has("editorWheelScroll")) {
		cleanups.push(installEditorWheelScroll(typedPrototype, deps));
	}

	if (cleanups.length === 0) return () => {};
	return () => {
		externalEditorHint = null;
		for (const cleanup of cleanups) cleanup();
	};
}
