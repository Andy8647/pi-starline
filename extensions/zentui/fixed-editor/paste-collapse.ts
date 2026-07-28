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

type EditorPasteInternals = {
	handlePaste?: (text: string) => void;
	normalizeText?: (text: string) => string;
	insertTextAtCursorInternal?: (text: string) => void;
	cancelAutocomplete?: () => void;
	exitHistoryBrowsing?: () => void;
	pushUndoSnapshot?: () => void;
	pastes?: unknown;
	pasteCounter?: unknown;
	lastAction?: unknown;
};

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

	const shadow = function (this: unknown, pastedText: string): void {
		try {
			const minLines = getMinLines();
			const pastes = editor.pastes;
			if (!(pastes instanceof Map)) {
				base.call(editor, pastedText);
				return;
			}

			const filtered = cleanPastedText(editor, pastedText);
			if (!shouldCollapse(filtered, minLines)) {
				base.call(editor, pastedText);
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
		} catch {
			// Never let this swallow a paste: fall back to Pi's own handling.
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

	return () => {
		if ((editor as { handlePaste?: unknown }).handlePaste !== shadow) return;
		if (previousOwn) {
			Object.defineProperty(editor, "handlePaste", previousOwn);
			return;
		}
		delete (editor as { handlePaste?: unknown }).handlePaste;
	};
}
