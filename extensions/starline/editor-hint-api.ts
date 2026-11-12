/**
 * The bridge other extensions use to put a hint on the right end of the editor's
 * top rule.
 *
 * Starline already writes there — the vim mode, `paste again to expand`, `N
 * characters selected, ctrl+x to copy`. This is the slot for a fact another
 * extension owns, so that fact costs the editor no row of its own.
 * `pi-ide-context` uses it to say what the next prompt will carry:
 * `5 lines selected in index.ts`.
 *
 * The handshake is a global symbol rather than an import, for the same reason the
 * pill API uses one: an extension cannot depend on a package Starline may be
 * loaded twice from, and load order is not guaranteed. Publish from the extension
 * body and call from anywhere after that; calling it when Starline is absent
 * costs one `undefined` check.
 *
 *     const api = globalThis[Symbol.for("pi-starline.editor-hint-api.v1")];
 *     api?.setHint("pi-ide", "5 lines selected in index.ts");
 *     api?.setHint("pi-ide", null); // nothing to say any more
 *
 * Hints are pushed, not pulled: Starline never asks anyone for content, and a key
 * that is cleared or overwritten leaves nothing behind. Types for other
 * extensions are in `types/editor-hint-api.d.ts`; the guide is
 * `docs/editor-hints.md`.
 */

import type { EditorHintApi } from "../../types/editor-hint-api";
import { sanitizeExtensionStatusText } from "./extension-status";

export const EDITOR_HINT_API_SYMBOL = Symbol.for("pi-starline.editor-hint-api.v1");

export type { EditorHintApi } from "../../types/editor-hint-api";

/**
 * One rule is the whole budget, and it shares it with Starline's own hints and
 * with the vim mode. Long enough for a sentence, short enough that the rule is
 * still a rule; anything past this is dropped rather than wrapped.
 */
const MAX_HINT_WIDTH = 60;

const hints = new Map<string, string>();

/** The repaint Starline binds once a session exists; a bridge may call earlier. */
let repaint: (() => void) | undefined;

export function setEditorHintRepaint(fn: (() => void) | undefined): void {
	repaint = fn;
}

/**
 * Publish (or, with an empty `text`, remove) one extension's hint.
 *
 * Text is flattened onto one line and stripped of control sequences the same way
 * a status is, because this is someone else's string landing on a border: a
 * newline or an escape here would break the frame, not just look wrong. Nerd Font
 * glyphs are plain characters and pass through, so a hint can carry an icon.
 */
export function setExternalEditorHint(key: string, text: string | null | undefined): void {
	const name = key.trim();
	if (!name) return;
	const cleaned = text
		? [...sanitizeExtensionStatusText(text)].slice(0, MAX_HINT_WIDTH).join("")
		: "";
	const previous = hints.get(name);
	if (cleaned) hints.set(name, cleaned);
	else hints.delete(name);
	// Only a change repaints: a bridge that re-publishes the same hint every second
	// must not cost a frame every second.
	if (previous !== (cleaned || undefined)) repaint?.();
}

/** Every external hint, in key order so two extensions never swap between frames. */
export function externalEditorHints(): string[] {
	return [...hints].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, text]) => text);
}

/** Session end: nothing a bridge said outlives the session that said it. */
export function clearExternalEditorHints(): void {
	if (hints.size === 0) return;
	hints.clear();
	repaint?.();
}

/**
 * Publish the API on `globalThis`, replacing any earlier object.
 *
 * The newest Starline wins, as with the pill API: this runs when the extension
 * loads, which is before any `session_start`, so bridges always register on the
 * object published by the Starline that is actually running.
 */
export function publishEditorHintApi(): void {
	const api: EditorHintApi = {
		version: 1,
		setHint: setExternalEditorHint,
	};
	(globalThis as Record<PropertyKey, unknown>)[EDITOR_HINT_API_SYMBOL] = api;
}
