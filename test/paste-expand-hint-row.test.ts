import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import { installPasteCollapse, pasteExpandHintText } from "../extensions/starline/paste-collapse";
import { PolishedEditor } from "../extensions/starline/ui";

/**
 * The "paste again to expand" hint used to be drawn on the editor's bottom
 * border by the fixed editor's compositor. Pi 0.84 supersedes the fixed editor,
 * so the hint has to reach the frame without it — and it cannot go back on the
 * border, because `isHorizontalBorder` needs an unbroken rule to find the frame
 * again. It rides the metadata row instead, which is rendered even when
 * `editorMetadataFormat` is blank.
 */

const HINT = "paste again to expand";
const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

function makeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		getThinkingBorderColor: () => (text: string) => text,
	} as unknown as Theme;
}

function makeEditor(config: PolishedTuiConfig) {
	return new PolishedEditor(
		{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
		{ borderColor: (text: string) => text, selectList: {} } as never,
		{} as never,
		makeTheme(),
		() => config,
		() => ({ modelLabel: "m", providerLabel: "p" }),
		() => "off",
	);
}

const stripTags = (line: string) => line.replace(/\[[0-9;]*m/g, "");

/** Stands in for Pi's editor: the members the shadow reaches for, and no more. */
function armHint(): void {
	const editor = {
		pastes: new Map<number, string>(),
		pasteCounter: 0,
		lastAction: "type-word" as unknown,
		state: { lines: [""], cursorLine: 0, cursorCol: 0 },
		isInPaste: false,
		handlePaste: vi.fn(function (this: unknown, _text: string) {}),
		handleInput: vi.fn(function (this: unknown, _data: string) {}),
		normalizeText: (text: string) => text.replace(/\r\n?/g, "\n").replace(/\t/g, "  "),
		insertTextAtCursorInternal: (text: string) => {
			const state = editor.state;
			const line = state.lines[state.cursorLine] ?? "";
			const merged = line.slice(0, state.cursorCol) + text + line.slice(state.cursorCol);
			const split = merged.split("\n");
			state.lines.splice(state.cursorLine, 1, ...split);
			state.cursorLine += split.length - 1;
			state.cursorCol = (split.at(-1) ?? "").length - (line.length - state.cursorCol);
		},
		setCursorCol: (col: number) => {
			editor.state.cursorCol = col;
		},
		cancelAutocomplete: vi.fn(),
		exitHistoryBrowsing: vi.fn(),
		pushUndoSnapshot: vi.fn(),
	};
	installPasteCollapse(editor, () => 3);
	editor.handlePaste(lines(4));
}

describe("paste expand hint in the editor frame", () => {
	// The metadata template is blanked deliberately: the hint must not depend on
	// it, since blanking it is a supported thing for a user to do.
	const blankMeta = { ...defaultConfig, editorMetadataFormat: "" };

	it("is absent from the frame with nothing armed", () => {
		expect(pasteExpandHintText()).toBeNull();
		const rendered = makeEditor(blankMeta).render(120).map(stripTags).join("\n");
		expect(rendered).not.toContain(HINT);
	});

	it("shows in the frame once a paste collapses, with the template blank", () => {
		armHint();
		expect(pasteExpandHintText()).toBe(HINT);

		const rendered = makeEditor(blankMeta).render(120).map(stripTags).join("\n");
		expect(rendered).toContain(HINT);
	});

	it("leaves both borders unbroken rules so the frame still parses", () => {
		armHint();
		const rendered = makeEditor(blankMeta).render(120).map(stripTags);
		expect(rendered.filter((line) => /^─+$/.test(line.trim()))).toHaveLength(2);
	});

	it("does not steal the row from a populated metadata template", () => {
		armHint();
		const rendered = makeEditor(defaultConfig).render(120).map(stripTags).join("\n");
		expect(rendered).toContain(HINT);
		expect(rendered).toContain("m");
	});
});
