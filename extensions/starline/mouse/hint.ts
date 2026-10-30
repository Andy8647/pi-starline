/**
 * The hints on the right end of the editor's top rule.
 *
 * Both hints share one slot. They sat on the bottom border until 0.2.2, then on
 * a metadata row under the text until 0.9, which kept the box a row taller than
 * its text; the top rule holds them without adding a row.
 */
export function composeHints(
	pasteHint: string | null,
	selectionHint: string | null,
): string | null {
	if (pasteHint && selectionHint) return `${pasteHint} ⋅ ${selectionHint}`;
	return pasteHint ?? selectionHint ?? null;
}
