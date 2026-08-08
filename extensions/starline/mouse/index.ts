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
import type { PolishedTuiConfig } from "../config";
import { installPrototypePatch } from "../prototype-patch-registry";
import { disabledFeatureWarning, enabledFeatures, probeCapabilities } from "./capabilities";
import { SelectionPendingState, selectionHintText } from "./selection-state";

const CTRL_C = "\x03";

type SelectionPoint = { scrollView?: unknown; row: number; col: number };
type SelectionBounds = { start: SelectionPoint; end: SelectionPoint };

/** The slice of `TuiAltScreen` this module reads or wraps. */
type MouseCapablePrototype = {
	getSelectionBounds(this: unknown): SelectionBounds | undefined;
	copySelectionToClipboard(this: unknown): void;
	handleViewportInput(this: unknown, data: string): { consume: boolean } | undefined;
	flash(this: unknown, message: string, durationMs?: number): void;
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
 * A same-row selection reports its exact width. A multi-row one does not,
 * because the text of the other rows lives in Pi's private layout/previous-
 * screen bookkeeping, and duplicating that lookup here would turn this
 * wrapper into a second copy of `copySelectionToClipboard`'s own logic. The
 * hint is cosmetic — the real copy on ctrl+c always goes through Pi's own
 * method, so it is always exact regardless of what this estimate says.
 */
function estimateSelectionLength(bounds: SelectionBounds): number {
	if (bounds.start.row === bounds.end.row) {
		return Math.max(0, bounds.end.col - bounds.start.col);
	}
	return Math.max(1, bounds.end.col);
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
			if (copyOnSelect || performingRealCopy) {
				return Reflect.apply(predecessor, receiver, args);
			}
			const bounds = (receiver as MouseCapablePrototype).getSelectionBounds();
			if (!bounds) return undefined;
			state.arm(estimateSelectionLength(bounds));
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
				performingRealCopy = true;
				try {
					copyWithNotice(receiver as MouseCapablePrototype, deps.getConfig().mouse.copyNotice);
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
		console.error(warning);
	}

	if (!enabled.has("selectionPendingMode")) return () => {};
	return installSelectionPendingMode(prototype as MouseCapablePrototype, deps);
}
