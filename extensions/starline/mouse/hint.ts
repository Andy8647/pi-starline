/**
 * The right-hand side of the editor's metadata row.
 *
 * Both hints share one slot. `ui.ts` renders that row whether or not
 * `editorMetadataFormat` has anything in it, which is why 0.2.2 moved the paste
 * hint here off the editor border — blanking the template must not hide it.
 */
export function composeHints(
	pasteHint: string | null,
	selectionHint: string | null,
): string | null {
	if (pasteHint && selectionHint) return `${pasteHint} ⋅ ${selectionHint}`;
	return pasteHint ?? selectionHint ?? null;
}
