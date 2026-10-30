import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import { installPasteCollapse, pasteExpandHintText } from "../extensions/starline/paste-collapse";
import { PolishedEditor } from "../extensions/starline/ui";

/**
 * The "paste again to expand" hint used to be drawn on the editor's bottom
 * border by the fixed editor's compositor, then (Pi 0.84 to Starline 0.8) on a
 * metadata row under the text. That row kept the box a row taller than its
 * text, so 0.9 moved the hint to the right end of the top rule.
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
	it("is absent from the frame with nothing armed", () => {
		expect(pasteExpandHintText()).toBeNull();
		const rendered = makeEditor(defaultConfig).render(120).map(stripTags).join("\n");
		expect(rendered).not.toContain(HINT);
	});

	it("shows at the right end of the top rule once a paste collapses", () => {
		armHint();
		expect(pasteExpandHintText()).toBe(HINT);

		const rendered = makeEditor(defaultConfig).render(120).map(stripTags);
		expect(rendered[0]).toMatch(new RegExp(`^─+ ${HINT} ──$`));
		expect(rendered.filter((line) => line.includes(HINT))).toHaveLength(1);
	});

	it("does not make the box taller", () => {
		armHint();
		const rendered = makeEditor({ ...defaultConfig, editorPaddingY: 0 }).render(120);
		expect(rendered).toHaveLength(3);
		expect(rendered.map(stripTags).filter((line) => /^─+$/.test(line.trim()))).toHaveLength(1);
	});
});
