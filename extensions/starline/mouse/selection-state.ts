import { basename } from "node:path";

/**
 * The selection hint is derived state, not owned state.
 *
 * Pi 0.84.4 owns "select without copying" (`fullscreenCopyOnSelect`), so
 * Starline no longer intercepts the release to arm a pending copy — the hint
 * is computed on demand from the live renderer instead: an active selection
 * that the renderer is not auto-copying. `selectionHintText` is the pure
 * rendering of that state; `index.ts` gathers the pieces.
 */
export function selectionHintText(
	characters: number,
	copyKey: string,
	externalEditorKey: string | undefined,
	editorName: string | null = null,
): string | null {
	if (characters <= 0) return null;
	const noun = characters === 1 ? "character" : "characters";
	const base =
		copyKey.length > 0
			? `${characters} ${noun} selected, ${copyKey} to copy`
			: `${characters} ${noun} selected`;
	return externalEditorKey
		? `${base} ⋅ ${externalEditorKey} to edit in ${editorName ?? "$EDITOR"}`
		: base;
}

/**
 * The user's external editor, for the "edit in …" hints.
 *
 * `$EDITOR` is a shell variable; the hint must say what it expands to, or a
 * reader stares at a literal `$EDITOR`. `$VISUAL` outranks `$EDITOR` (the
 * usual convention: VISUAL is the full-screen one), the first word of the
 * value is the command, and its basename is what reads well in a hint —
 * "nvim", not "/opt/homebrew/bin/nvim". Null when neither variable is set;
 * callers keep the literal `$EDITOR` then, which is itself the hint that
 * nothing is configured.
 */
export function externalEditorName(env: NodeJS.ProcessEnv = process.env): string | null {
	const value = env.VISUAL || env.EDITOR;
	if (!value) return null;
	const command = value.trim().split(/\s+/)[0];
	if (!command) return null;
	return basename(command);
}
