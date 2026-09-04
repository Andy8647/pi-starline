/**
 * What of Pi's renderer this build can actually reach.
 *
 * Pi's TUI internals carry no stability contract, so every method Starline
 * patches is probed before it is trusted. The probe is deliberately structural —
 * the method exists, is a function, and can be replaced and put back. Signature
 * drift is caught by `test/contract/pi-tui-contract.test.ts` in CI rather than
 * guessed at here: default parameters make `fn.length` a liar.
 *
 * `requestRender` is the one entry a feature only ever *calls* on the receiver,
 * never patches. It is probed all the same, and by the same structural test: a
 * feature that installs and then cannot ask for a repaint leaves its own state
 * on screen a frame late or not at all, which is precisely the half-working
 * install this table exists to prevent. The check being stricter than a plain
 * call needs (it also demands writable and configurable) costs nothing, because
 * a class method declared the ordinary way is both.
 *
 * Since 0.84.4 the peer floor guarantees `copyActiveSelectionToClipboard`,
 * `getCopyOnSelect` and `hasActiveSelection` exist; the probe still runs so a
 * future Pi that moves them degrades feature-by-feature instead of breaking
 * the whole install.
 */

export type MouseCapability =
	| "handleViewportInput"
	| "routeWheel"
	| "handleSelectionMouseEvent"
	| "copyActiveSelectionToClipboard"
	| "getCopyOnSelect"
	| "hasActiveSelection"
	| "getSelectionBounds"
	| "getSelectionColumns"
	| "flash"
	| "hasOverlay"
	| "requestRender";

export type MouseFeature =
	| "selectionHint"
	| "clickToExpandTools"
	| "editorWheelScroll"
	| "editorClickToCaret"
	| "editorBufferCopy"
	| "transcriptCleanCopy";

const CAPABILITIES: readonly MouseCapability[] = [
	"handleViewportInput",
	"routeWheel",
	"handleSelectionMouseEvent",
	"copyActiveSelectionToClipboard",
	"getCopyOnSelect",
	"hasActiveSelection",
	"getSelectionBounds",
	"getSelectionColumns",
	"flash",
	"hasOverlay",
	"requestRender",
];

/**
 * Every capability a feature needs before it may install.
 *
 * There is no `frameFreeSelection` entry, deliberately: the feature is cut
 * (see `installMouse` in `index.ts`). A feature listed here is one
 * `installMouse` installs, and a table that claims a feature nothing installs
 * is worse than no table.
 */
const REQUIREMENTS: Record<MouseFeature, readonly MouseCapability[]> = {
	// Derived from Pi 0.84.4's own select-without-copy state: the hint shows
	// only while the renderer is NOT auto-copying (`getCopyOnSelect` false) and
	// something is actually selected (`hasActiveSelection`). The character
	// count is computed from the live selection through `getSelectionBounds`
	// and `getSelectionColumns`, matching the columns the copy itself would
	// slice — the hint promises what ctrl+x delivers. No release interception,
	// no pending state: Pi's `copyOnSelect: false` already keeps the selection
	// highlighted, and the hint rides Pi's own repaints.
	selectionHint: [
		"getCopyOnSelect",
		"hasActiveSelection",
		"getSelectionBounds",
		"getSelectionColumns",
	],
	// The press it acts on arrives through `handleSelectionMouseEvent`, and it
	// asks `hasOverlay` the same question Pi's own press path asks before
	// resolving a scroll view (`tui-alt-screen.js:684`) — without it, a click on
	// a dialog would toggle whatever tool box happens to sit behind it. It
	// consumes the press rather than calling through, so Pi never reaches its own
	// repaint for that event: `requestRender` is the only thing that draws the
	// box it just toggled.
	clickToExpandTools: ["handleSelectionMouseEvent", "hasOverlay", "requestRender"],
	// The notch arrives through `routeWheel`, which it consumes on an editor hit
	// rather than calling through — so Pi never reaches its own repaint for that
	// event and `requestRender` is the only thing that draws the scrolled box. It
	// asks `hasOverlay` for the same reason click-to-expand does: an overlay is
	// composited on top of a layout that still contains the editor
	// (`tui.js:123`), so without it a notch aimed at a dialog would scroll the
	// draft hidden behind it.
	editorWheelScroll: ["routeWheel", "hasOverlay", "requestRender"],
	// Two behaviours, one feature. The press arrives through
	// `handleSelectionMouseEvent`; backspace and delete over a live selection
	// arrive through `handleViewportInput`, which is why that is listed even
	// though the caret alone would not need it. Range delete then reads the
	// selection through `getSelectionBounds` to find out whether it is the
	// editor's, and — because it *consumes* the key, so Pi's `handleInput` never
	// reaches its own `requestImmediateRender` (`tui.js:620`) — `requestRender`
	// is the only thing that draws the shortened draft.
	//
	// `hasOverlay` for the same reason the features above ask it: an overlay is
	// composited over a layout that still contains the editor, so without it a
	// click on a dialog would move the caret in the box behind it, and a
	// backspace would delete from it.
	//
	// The consequence of listing `handleViewportInput` is deliberate and worth
	// naming: a Pi that has moved that method loses click-to-caret entirely, not
	// just the range delete. That is this table's rule — never install half a
	// feature — and the alternative, a caret that installs while its delete
	// silently does not, is exactly the half-working install the rule exists to
	// prevent.
	editorClickToCaret: [
		"handleSelectionMouseEvent",
		"handleViewportInput",
		"getSelectionBounds",
		"hasOverlay",
		"requestRender",
	],
	// It wraps `copyActiveSelectionToClipboard` — the method Pi 0.84.4's
	// Ctrl+X handler reaches (`handleCopyCommand` with `preferSelection`), so
	// the clean copy answers exactly the copies that key performs — and reads
	// the selection through `getSelectionBounds` to find out whether it is the
	// editor's. `hasOverlay` again: a selection dropped on a dialog must not be
	// read as text from the draft behind it.
	//
	// The clipboard write goes through `terminal.write`, which is not listed
	// because it is not on this prototype — `terminal` is a plain instance field
	// holding somebody else's object, the same class of thing as `currentLayout`.
	// It is checked at the call site instead, and a terminal that cannot be
	// written to makes the copy fall through to Pi rather than disabling the
	// feature at install time.
	editorBufferCopy: ["copyActiveSelectionToClipboard", "getSelectionBounds", "hasOverlay", "flash"],
	// Shares the `copyActiveSelectionToClipboard` patch with the two features
	// above it. It reads the selection through `getSelectionBounds` to find the
	// rows, through `getSelectionColumns` to slice the cleaned text along the
	// same grapheme-aligned columns Pi would have used, asks `hasOverlay` before
	// trusting those rows (an overlay is composited over a layout that still
	// contains the transcript), and raises its own "Copied!" through `flash`
	// when it answers the copy itself. The clipboard write goes through
	// `terminal.write`, unlisted for the same reason as editorBufferCopy's — it
	// is an instance field, checked at the call site instead.
	transcriptCleanCopy: [
		"copyActiveSelectionToClipboard",
		"getSelectionBounds",
		"getSelectionColumns",
		"hasOverlay",
		"flash",
	],
};

function isPatchable(prototype: object, name: string): boolean {
	try {
		let current: object | null = prototype;
		while (current) {
			const descriptor = Object.getOwnPropertyDescriptor(current, name);
			if (descriptor) {
				if (typeof descriptor.value !== "function") return false;
				return descriptor.writable === true && descriptor.configurable === true;
			}
			current = Object.getPrototypeOf(current);
		}
		return false;
	} catch {
		// A prototype that throws on inspection is one we do not touch.
		return false;
	}
}

export function probeCapabilities(prototype: object): ReadonlySet<MouseCapability> {
	const found = new Set<MouseCapability>();
	for (const capability of CAPABILITIES) {
		if (isPatchable(prototype, capability)) found.add(capability);
	}
	return found;
}

export function enabledFeatures(
	available: ReadonlySet<MouseCapability>,
): ReadonlySet<MouseFeature> {
	const enabled = new Set<MouseFeature>();
	for (const [feature, needed] of Object.entries(REQUIREMENTS) as [
		MouseFeature,
		readonly MouseCapability[],
	][]) {
		if (needed.every((capability) => available.has(capability))) enabled.add(feature);
	}
	return enabled;
}

/**
 * One line naming everything that will not run, or null when all is well. Pi
 * prints this once per process — a line per feature would be noise on a build
 * where Pi has moved on.
 */
export function disabledFeatureWarning(enabled: ReadonlySet<MouseFeature>): string | null {
	const disabled = (Object.keys(REQUIREMENTS) as MouseFeature[]).filter(
		(feature) => !enabled.has(feature),
	);
	if (disabled.length === 0) return null;
	return `[starline] This Pi build does not expose what these mouse features need, so they are off: ${disabled.join(", ")}. Everything else still works.`;
}
