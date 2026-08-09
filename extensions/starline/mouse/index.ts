/**
 * Installs the mouse feature set on Pi's live renderer prototype.
 *
 * This is the first module that actually touches Pi rather than describing
 * what it would do to it. `installMouse` probes what the running Pi build
 * exposes, logs once if something is missing, and installs each feature gated
 * on exactly its own declared requirement (`capabilities.ts`). Today that is
 * three features:
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
 * What Starline never does here is rewrite the text: the clipboard gets
 * exactly what Pi's own `copySelectionToClipboard` puts there. See
 * `installMouse` for why frame-free selection is not part of this.
 */
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "../config";
import { installPrototypePatch } from "../prototype-patch-registry";
import { disabledFeatureWarning, enabledFeatures, probeCapabilities } from "./capabilities";
import { type BoxLike, scrollContentLinesFor } from "./hit-test";
import { SelectionPendingState, selectionHintText } from "./selection-state";
import { type ExpandTarget, expandKeyText, expandTargetAt } from "./tool-box";
import { wordRangeAt } from "./word-select";

const CTRL_C = "\x03";

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
	 * `TuiBase.requestRender(force = false)` (`tui.js:495`), inherited by
	 * `TuiAltScreen` and public. The only method here this module calls rather
	 * than patches — see `capabilities.ts`.
	 */
	requestRender(this: unknown, force?: boolean): void;
	previousScreen?: readonly string[];
	// Not probed capabilities (see capabilities.ts): plain instance fields
	// this module only ever reads.
	currentLayout?: { root: BoxLike };
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
 * `fixed-editor/paste-collapse.ts`. `ui.ts` composes this with the paste hint
 * on every render; there is nothing to wire when no mouse install is active.
 */
let activeState: SelectionPendingState | undefined;

export function activeSelectionHintText(): string | null {
	return activeState ? selectionHintText(activeState) : null;
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
 * pending hint needs to say how many characters ctrl+c would put there, and
 * the only exact answer is the text Pi itself would build. Rows come back
 * verbatim — no frame stripping, no rule-row dropping — so the count and the
 * eventual clipboard cannot disagree.
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
 * Installs `selectionPendingMode`: arm on release, copy on ctrl+c.
 *
 * Two patches, both belonging to this one feature. The
 * `copySelectionToClipboard` patch decides whether a release copies now or
 * arms and waits; the `handleViewportInput` patch is what a waiting selection
 * is eventually released by. Neither touches the *text* — the real copy is
 * always predecessor's, so what lands on the clipboard is Pi's own bytes.
 */
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
			const typedReceiver = receiver as MouseCapablePrototype;
			if (deps.getConfig().mouse.copyOnSelect || performingRealCopy) {
				// The real copy, whether Pi triggered it directly on release
				// (`copyOnSelect: true`) or this module is driving it itself for
				// ctrl+c below. Predecessor writes the clipboard, unmodified.
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
			state.arm(selectionText(typedReceiver, bounds).length);
			typedReceiver.requestRender();
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
			return Reflect.apply(predecessor, receiver, args);
		},
	);

	return () => {
		cleanupCopy();
		cleanupViewportInput();
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
 * Installs `clickToExpandTools` on `handleSelectionMouseEvent`.
 *
 * A thin wrapper: it either finds a hint row under the press and consumes it,
 * or calls through to Pi untouched. Consuming is what keeps the click from
 * also dropping a selection anchor into the box it just opened; every other
 * press — including a press anywhere else inside the same box — still starts a
 * selection, because copying text out of tool output is the common case and
 * must not be stolen.
 */
function installClickToExpandTools(
	prototype: MouseCapablePrototype,
	deps: InstallMouseDeps,
): () => void {
	return installPrototypePatch(
		prototype,
		"handleSelectionMouseEvent",
		"mouse-selection-event",
		({ predecessor, receiver, args }) => {
			const typedReceiver = receiver as MouseCapablePrototype;
			const target = pressExpandTarget(typedReceiver, args[0], deps);
			if (!target) return Reflect.apply(predecessor, receiver, args);
			target.component.setExpanded(target.expanded);
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
	// lost its borders. Copying now goes through Pi's own text, untouched.
	//
	// What would bring it back: `pi-toolbox` publishing its frame geometry —
	// which rows it drew a border on, at which columns — so Starline reads a
	// fact instead of inferring one. Nothing short of that.
	if (enabled.has("selectionPendingMode")) {
		cleanups.push(installSelectionPendingMode(typedPrototype, deps));
	}
	if (enabled.has("pathAwareWords")) {
		cleanups.push(installPathAwareWords(typedPrototype, deps));
	}
	if (enabled.has("clickToExpandTools")) {
		cleanups.push(installClickToExpandTools(typedPrototype, deps));
	}

	if (cleanups.length === 0) return () => {};
	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}
