import { describe, expect, it } from "vitest";
import {
	SelectionPendingState,
	selectionHintText,
} from "../../extensions/starline/mouse/selection-state";

describe("SelectionPendingState", () => {
	it("starts with nothing pending", () => {
		expect(new SelectionPendingState().pending).toBeUndefined();
	});

	it("arms with a character count", () => {
		const state = new SelectionPendingState();
		state.arm(5);
		expect(state.pending).toEqual({ characters: 5 });
	});

	it("refuses to arm on an empty selection", () => {
		const state = new SelectionPendingState();
		state.arm(0);
		expect(state.pending).toBeUndefined();
	});

	it("clears", () => {
		const state = new SelectionPendingState();
		state.arm(5);
		state.clear();
		expect(state.pending).toBeUndefined();
	});

	it("keeps the external-editor key only while armed", () => {
		const state = new SelectionPendingState();
		state.arm(5, "ctrl+g");
		expect(state.pending).toEqual({ characters: 5, externalEditorKey: "ctrl+g" });
		state.clear();
		expect(state.pending).toBeUndefined();
		// A zero-length arm drops the key with the count.
		state.arm(0, "ctrl+g");
		expect(state.pending).toBeUndefined();
	});
});

describe("selectionHintText", () => {
	it("is null when nothing is pending", () => {
		expect(selectionHintText(new SelectionPendingState())).toBeNull();
	});

	it("pluralises", () => {
		const state = new SelectionPendingState();
		state.arm(1);
		expect(selectionHintText(state)).toBe("1 character selected, ctrl+c to copy");
		state.arm(5);
		expect(selectionHintText(state)).toBe("5 characters selected, ctrl+c to copy");
	});

	it("points an editor selection at the external editor", () => {
		// Editor selections cannot grow past the visible window (no drag-scroll),
		// so the hint carries the way to act on the whole draft.
		const state = new SelectionPendingState();
		state.arm(5, "ctrl+g");
		expect(selectionHintText(state)).toBe(
			"5 characters selected, ctrl+c to copy ⋅ ctrl+g to edit in $EDITOR",
		);
		// An empty key (unbound) shows no suffix.
		state.arm(5, "");
		expect(selectionHintText(state)).toBe("5 characters selected, ctrl+c to copy");
	});
});
