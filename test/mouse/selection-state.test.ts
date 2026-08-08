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
});
