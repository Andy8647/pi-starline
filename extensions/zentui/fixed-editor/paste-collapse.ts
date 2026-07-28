/**
 * Collapse pasted text at a lower line count than Pi's built-in threshold.
 *
 * Pi collapses a paste into a `[paste #N +L lines]` marker at more than ten
 * lines (or a thousand characters), hardcoded. `pasteCollapseLines` takes over
 * the range Pi leaves inline and collapses it the same way, so everything
 * downstream — expansion on submit, deleting the marker, renumbering — keeps
 * working because what we store is indistinguishable from what Pi stores.
 *
 * That last point is the whole risk. If our copy of Pi's cleaning drifts, the
 * marker still looks right but the text behind it is wrong, and the damage only
 * shows up on submit. So the cleaning below mirrors Pi's exactly, and anything
 * Pi would have handled differently is handed straight back to it.
 *
 * Ported from pi-powerline-footer, where this has been in daily use.
 *
 * @internal
 */

/** Pi's own bounds. Below the floor there is nothing to take over. */
const MIN_COLLAPSE_LINES = 2;
const MAX_COLLAPSE_LINES = 10;
/** Pi collapses above these itself. */
const PI_LINE_THRESHOLD = 10;
const PI_CHAR_THRESHOLD = 1000;

/** Label shown on the editor box border while a collapsed paste can be expanded. */
export const PASTE_EXPAND_HINT = "paste again to expand";

type EditorState = { lines?: unknown; cursorLine?: unknown; cursorCol?: unknown };

type EditorPasteInternals = {
	handlePaste?: (text: string) => void;
	handleInput?: (data: string) => unknown;
	normalizeText?: (text: string) => string;
	insertTextAtCursorInternal?: (text: string) => void;
	cancelAutocomplete?: () => void;
	exitHistoryBrowsing?: () => void;
	pushUndoSnapshot?: () => void;
	setCursorCol?: (col: number) => void;
	pastes?: unknown;
	pasteCounter?: unknown;
	lastAction?: unknown;
	state?: EditorState;
	isInPaste?: unknown;
};

/** A collapsed paste that re-pasting the same text would expand in place. */
type ArmedPaste = { id: number; content: string };

function asPasteInternals(value: unknown): EditorPasteInternals | null {
	if (typeof value !== "object" || value === null) return null;
	const editor = value as EditorPasteInternals;
	if (typeof editor.handlePaste !== "function") return null;
	if (typeof editor.normalizeText !== "function") return null;
	if (typeof editor.insertTextAtCursorInternal !== "function") return null;
	if (!(editor.pastes instanceof Map)) return null;
	return editor;
}

/** Whether this editor exposes enough to lower the collapse threshold. */
export function supportsPasteCollapse(value: unknown): boolean {
	return asPasteInternals(value) !== null;
}

/**
 * Reproduce Pi's pre-collapse cleaning: decode the CSI-u control re-encoding
 * some terminals apply inside a bracketed paste, normalise line endings and
 * tabs, then drop non-printables except newlines.
 */
function cleanPastedText(editor: EditorPasteInternals, pastedText: string): string {
	const decoded = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
		const codePoint = Number(code);
		if (codePoint >= 97 && codePoint <= 122) return String.fromCharCode(codePoint - 96);
		if (codePoint >= 65 && codePoint <= 90) return String.fromCharCode(codePoint - 64);
		return match;
	});
	const normalized = editor.normalizeText?.call(editor, decoded) ?? decoded;
	return normalized
		.split("")
		.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
		.join("");
}

/** Whether we should collapse a paste Pi would have left inline. */
export function shouldCollapse(text: string, minLines: number): boolean {
	if (minLines < MIN_COLLAPSE_LINES || minLines > MAX_COLLAPSE_LINES) return false;
	// A path Pi may reformat; leave those alone entirely.
	if (/^[/~.]/.test(text)) return false;
	const lineCount = text.split("\n").length;
	if (lineCount > PI_LINE_THRESHOLD || text.length > PI_CHAR_THRESHOLD) return false;
	return lineCount >= minLines;
}

/**
 * Match one paste placeholder for `id`: `[paste #3 +42 lines]` or
 * `[paste #3 1234 chars]`. Mirrors the marker Pi writes when it collapses.
 */
function pasteMarkerRegex(id: number): RegExp {
	return new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`);
}

function editorLines(editor: EditorPasteInternals): string[] | null {
	const lines = editor.state?.lines;
	return Array.isArray(lines) ? (lines as string[]) : null;
}

/**
 * Replace `armed`'s marker with the text behind it, in place.
 *
 * Refuses unless the stored text still is what was armed: Pi renumbers paste ids
 * when a marker is deleted (`editor.ts` handleBackspace), so the armed id can
 * come to point at somebody else's paste. Expanding then would swap in the wrong
 * content silently, which is worse than not expanding at all.
 */
function expandPasteInPlace(editor: EditorPasteInternals, armed: ArmedPaste): boolean {
	const pastes = editor.pastes;
	if (!(pastes instanceof Map)) return false;
	if (pastes.get(armed.id) !== armed.content) return false;

	const lines = editorLines(editor);
	if (!lines) return false;

	const text = lines.join("\n");
	const match = pasteMarkerRegex(armed.id).exec(text);
	if (!match) return false;

	editor.pushUndoSnapshot?.call(editor);

	const result =
		text.slice(0, match.index) + armed.content + text.slice(match.index + match[0].length);
	const resultLines = result.split("\n");
	if (!editor.state) return false;
	editor.state.lines = resultLines.length === 0 ? [""] : resultLines;

	// Cursor lands at the end of the text that just appeared.
	const before = result.slice(0, match.index + armed.content.length);
	const cursorLine = before.match(/\n/g)?.length ?? 0;
	const cursorCol = before.length - (before.lastIndexOf("\n") + 1);
	editor.state.cursorLine = Math.min(cursorLine, Math.max(0, resultLines.length - 1));
	if (typeof editor.setCursorCol === "function") {
		editor.setCursorCol.call(editor, cursorCol);
	} else {
		editor.state.cursorCol = cursorCol;
	}

	// The marker is gone from the text, so its entry can only mislead. Leave
	// pasteCounter alone: decrementing it would collide with markers still there.
	pastes.delete(armed.id);
	return true;
}

/** Hint reader for the currently installed editor, if any. */
let activeHint: (() => string | null) | null = null;

/**
 * The "paste again to expand" label while a collapsed paste is armed, else null.
 * Read by the selection controller, which puts it on the editor box border.
 */
export function pasteExpandHintText(): string | null {
	return activeHint?.() ?? null;
}

/**
 * Shadow the editor's paste handler so pastes collapse earlier.
 *
 * Returns a disposer, or undefined when the editor does not expose what this
 * needs — in which case nothing is patched and Pi's own threshold stands.
 */
export function installPasteCollapse(
	value: unknown,
	getMinLines: () => number,
): (() => void) | undefined {
	const editor = asPasteInternals(value);
	if (!editor) return undefined;

	const base = editor.handlePaste;
	if (typeof base !== "function") return undefined;

	// Pi keeps handlePaste on the prototype, where deleting our shadow reveals it
	// again. Somebody else may keep it on the instance, where deleting would take
	// the real handler with it — so restore whatever was actually there.
	const previousOwn = Object.getOwnPropertyDescriptor(editor, "handlePaste");

	/** The collapsed paste that an identical re-paste would expand. */
	let armed: ArmedPaste | null = null;
	/** Set by the shadow so the input wrapper can tell a paste from a keystroke. */
	let sawPaste = false;

	const counterOf = (): number =>
		typeof editor.pasteCounter === "number" ? editor.pasteCounter : 0;

	/**
	 * Hand the paste to Pi, then arm the hint if Pi collapsed it itself (above its
	 * own hardcoded threshold, which is where most real pastes land).
	 */
	const delegate = (pastedText: string, filtered: string | null): void => {
		const before = counterOf();
		base.call(editor, pastedText);
		const after = counterOf();
		const pastes = editor.pastes;
		const stored = after > before && pastes instanceof Map ? pastes.get(after) : undefined;
		armed = typeof stored === "string" ? { id: after, content: stored } : null;
		// Nothing to compare a re-paste against if the cleaning drifted.
		if (armed && filtered !== null && filtered !== armed.content) armed = null;
	};

	const shadow = function (this: unknown, pastedText: string): void {
		sawPaste = true;
		try {
			const minLines = getMinLines();
			const pastes = editor.pastes;
			if (!(pastes instanceof Map)) {
				base.call(editor, pastedText);
				return;
			}

			const filtered = cleanPastedText(editor, pastedText);

			// The same text pasted twice in a row expands the marker instead of
			// stacking a second one.
			if (armed && armed.content === filtered && expandPasteInPlace(editor, armed)) {
				armed = null;
				return;
			}

			if (!shouldCollapse(filtered, minLines)) {
				delegate(pastedText, filtered);
				return;
			}

			// Mirror what Pi does around its own collapse, so undo and
			// autocomplete behave the same either way.
			editor.cancelAutocomplete?.call(editor);
			editor.exitHistoryBrowsing?.call(editor);
			editor.lastAction = null;
			editor.pushUndoSnapshot?.call(editor);

			const counter = typeof editor.pasteCounter === "number" ? editor.pasteCounter : 0;
			const id = counter + 1;
			editor.pasteCounter = id;
			pastes.set(id, filtered);
			const lineCount = filtered.split("\n").length;
			editor.insertTextAtCursorInternal?.call(editor, `[paste #${id} +${lineCount} lines]`);
			armed = { id, content: filtered };
		} catch {
			// Never let this swallow a paste: fall back to Pi's own handling.
			armed = null;
			base.call(editor, pastedText);
		}
	};

	// An own property shadows the prototype method for this instance only.
	Object.defineProperty(editor, "handlePaste", {
		configurable: true,
		enumerable: false,
		writable: true,
		value: shadow,
	});

	// Anything that is not a paste puts the offer away. Pi feeds a bracketed paste
	// in over several calls with isInPaste set, so only the tail of one counts.
	const baseInput = editor.handleInput;
	const previousOwnInput = Object.getOwnPropertyDescriptor(editor, "handleInput");
	const inputShadow =
		typeof baseInput === "function"
			? function (this: unknown, data: string): unknown {
					sawPaste = false;
					const result = baseInput.call(editor, data);
					if (!sawPaste && editor.isInPaste !== true) armed = null;
					return result;
				}
			: null;
	if (inputShadow) {
		Object.defineProperty(editor, "handleInput", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: inputShadow,
		});
	}

	activeHint = () => {
		if (!armed) return null;
		// Self-clearing: the marker may have been deleted since it was armed.
		const lines = editorLines(editor);
		if (!lines || !pasteMarkerRegex(armed.id).test(lines.join("\n"))) {
			armed = null;
			return null;
		}
		return PASTE_EXPAND_HINT;
	};
	const ownHint = activeHint;

	return () => {
		armed = null;
		if (activeHint === ownHint) activeHint = null;
		if (inputShadow && (editor as { handleInput?: unknown }).handleInput === inputShadow) {
			if (previousOwnInput) {
				Object.defineProperty(editor, "handleInput", previousOwnInput);
			} else {
				delete (editor as { handleInput?: unknown }).handleInput;
			}
		}
		if ((editor as { handlePaste?: unknown }).handlePaste !== shadow) return;
		if (previousOwn) {
			Object.defineProperty(editor, "handlePaste", previousOwn);
			return;
		}
		delete (editor as { handlePaste?: unknown }).handlePaste;
	};
}
