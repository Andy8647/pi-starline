/**
 * Types for Starline's editor hint API: put a line of your own on the right end
 * of the editor's top rule.
 *
 * The hint shares that rule with Starline's own hints (vim mode, paste, terminal
 * selection), so it is a single short sentence, not a place to render a view. It
 * costs no rows: an empty rule is drawn whether or not anyone speaks.
 *
 * The API is found on `globalThis`, not imported, so an extension can use it
 * without depending on Starline at runtime:
 *
 *     import type { EditorHintApi } from "pi-starline/types/editor-hint-api";
 *     const api = (globalThis as Record<symbol, unknown>)[
 *       Symbol.for("pi-starline.editor-hint-api.v1")
 *     ] as EditorHintApi | undefined;
 *
 * Guide: docs/editor-hints.md in the pi-starline repository.
 */

export type EditorHintApi = {
	version: 1;
	/**
	 * Publish this key's hint. `null` or an empty string removes it; a second call
	 * for the same key replaces the first. Repaints only when the text changed, so
	 * re-publishing the same sentence on a timer is free.
	 *
	 * The text is flattened to one line and stripped of control sequences, and is
	 * cut at 60 columns. Keys are sorted, so several extensions read left to right
	 * in a stable order.
	 */
	setHint(key: string, text: string | null | undefined): void;
};
