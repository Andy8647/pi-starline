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

	arm(characters: number): void {
		this.characters = characters > 0 ? characters : 0;
	}

	clear(): void {
		this.characters = 0;
	}

	get pending(): { characters: number } | undefined {
		return this.characters > 0 ? { characters: this.characters } : undefined;
	}
}

export function selectionHintText(state: SelectionPendingState): string | null {
	const pending = state.pending;
	if (!pending) return null;
	const noun = pending.characters === 1 ? "character" : "characters";
	return `${pending.characters} ${noun} selected, ctrl+c to copy`;
}
