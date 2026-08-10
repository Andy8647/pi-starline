/**
 * The one piece of selection state Starline owns.
 *
 * Pi holds the anchor, the focus and the granularity; this holds only whether a
 * released selection is still waiting to be copied. Keeping it this small is
 * what the 0.2.0 controller could not do, because back then Pi had no selection
 * at all.
 */
export class SelectionPendingState {
	private characters = 0;
	/**
	 * `keyText("app.editor.external")`, resolved at arm time, when the pending
	 * selection is the editor's. Editor selections cannot grow past the visible
	 * window (there is no drag-scroll), so the hint points at the external
	 * editor as the way to act on the whole draft.
	 */
	private externalEditorKey: string | undefined;

	arm(characters: number, externalEditorKey?: string): void {
		this.characters = characters > 0 ? characters : 0;
		this.externalEditorKey = this.characters > 0 ? externalEditorKey : undefined;
	}

	clear(): void {
		this.characters = 0;
		this.externalEditorKey = undefined;
	}

	get pending(): { characters: number; externalEditorKey?: string } | undefined {
		return this.characters > 0
			? { characters: this.characters, externalEditorKey: this.externalEditorKey }
			: undefined;
	}
}

export function selectionHintText(state: SelectionPendingState): string | null {
	const pending = state.pending;
	if (!pending) return null;
	const noun = pending.characters === 1 ? "character" : "characters";
	const base = `${pending.characters} ${noun} selected, ctrl+c to copy`;
	return pending.externalEditorKey
		? `${base} ⋅ ${pending.externalEditorKey} to edit in $EDITOR`
		: base;
}
