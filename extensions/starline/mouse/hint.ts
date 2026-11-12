/**
 * The hints on the right end of the editor's top rule.
 *
 * All of them share one slot. The paste and selection hints sat on the bottom
 * border until 0.2.2, then on a metadata row under the text until 0.9, which kept
 * the box a row taller than its text; the top rule holds them without adding a
 * row. Hints published by other extensions (`editor-hint-api.ts`) join the same
 * slot, leftmost — the rule is truncated from its right end, so a hint Starline
 * cannot shorten has to come first.
 */

export const HINT_SEPARATOR = " \u22c5 ";

/** Left-to-right, skipping the empty ones; null when there is nothing to say. */
export function joinHints(parts: ReadonlyArray<string | null | undefined>): string | null {
	const present = parts.filter((part): part is string => Boolean(part));
	return present.length > 0 ? present.join(HINT_SEPARATOR) : null;
}

export function composeHints(
	pasteHint: string | null,
	selectionHint: string | null,
): string | null {
	return joinHints([pasteHint, selectionHint]);
}
