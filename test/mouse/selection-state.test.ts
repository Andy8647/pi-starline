import { describe, expect, it } from "vitest";
import {
	externalEditorName,
	selectionHintText,
} from "../../extensions/starline/mouse/selection-state";

describe("selectionHintText", () => {
	it("is null for an empty selection", () => {
		expect(selectionHintText(0, "ctrl+x", undefined)).toBeNull();
	});

	it("pluralises", () => {
		expect(selectionHintText(1, "ctrl+x", undefined)).toBe("1 character selected, ctrl+x to copy");
		expect(selectionHintText(5, "ctrl+x", undefined)).toBe("5 characters selected, ctrl+x to copy");
	});

	it("quotes whatever key is bound to app.message.copy", () => {
		expect(selectionHintText(5, "ctrl+x", undefined)).toBe("5 characters selected, ctrl+x to copy");
	});

	it("drops the key suffix when the copy binding is unbound", () => {
		expect(selectionHintText(5, "", undefined)).toBe("5 characters selected");
	});

	it("points an editor selection at the external editor", () => {
		// Editor selections cannot grow past the visible window (no drag-scroll),
		// so the hint carries the way to act on the whole draft.
		// The resolved editor name is injected; null keeps the literal $EDITOR,
		// which is itself the hint that nothing is configured.
		expect(selectionHintText(5, "ctrl+x", "ctrl+g", "nvim")).toBe(
			"5 characters selected, ctrl+x to copy ⋅ ctrl+g to edit in nvim",
		);
		expect(selectionHintText(5, "ctrl+x", "ctrl+g")).toBe(
			"5 characters selected, ctrl+x to copy ⋅ ctrl+g to edit in $EDITOR",
		);
		// An empty key (unbound) shows no suffix.
		expect(selectionHintText(5, "ctrl+x", "")).toBe("5 characters selected, ctrl+x to copy");
	});
});

describe("externalEditorName", () => {
	it("reads VISUAL before EDITOR and strips the path", () => {
		expect(externalEditorName({ EDITOR: "/opt/homebrew/bin/nvim" } as NodeJS.ProcessEnv)).toBe(
			"nvim",
		);
		expect(
			externalEditorName({
				EDITOR: "code",
				VISUAL: "/usr/bin/vim",
			} as NodeJS.ProcessEnv),
		).toBe("vim");
	});

	it("takes the first word of a compound value", () => {
		expect(externalEditorName({ EDITOR: "code --wait" } as NodeJS.ProcessEnv)).toBe("code");
	});

	it("is null when neither variable is set", () => {
		expect(externalEditorName({} as NodeJS.ProcessEnv)).toBeNull();
	});
});
