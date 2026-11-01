import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { mergeConfig } from "../extensions/starline/config";
import { PolishedEditor } from "../extensions/starline/ui";

/**
 * Pi paints the editor border for the mode it is in: `bashMode` while a draft
 * starts with `!`, a `thinking*` key otherwise. Starline drops Pi's border rows
 * and draws its own, so the bash painter has to be carried across — the
 * regression behind issue #33, where `!` stopped colouring the box.
 */

const ROWS = 20;

/** `<token>text` makes it obvious which painter reached the rule. */
const bashBrush = (text: string) => `<bashMode>${text}`;
const thinkingBrush = (text: string) => `<thinkingMax>${text}`;

function makeTheme(options: { bash?: boolean } = {}): Theme {
	return {
		fg: (color: string, text: string) => `<${color}>${text}`,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		getThinkingBorderColor: () => thinkingBrush,
		...(options.bash === false ? {} : { getBashModeBorderColor: () => bashBrush }),
	} as unknown as Theme;
}

function makeEditor(
	painter: (text: string) => string,
	parsed: unknown = {},
	theme: Theme = makeTheme(),
) {
	const config = mergeConfig({ editorPaddingY: 0, ...(parsed as Record<string, unknown>) });
	const editor = new PolishedEditor(
		{ requestRender() {}, terminal: { rows: ROWS, cols: 120 } } as never,
		{ borderColor: (text: string) => text, selectList: {} } as never,
		{} as never,
		theme,
		() => config,
	);
	editor.borderColor = painter;
	editor.setText("hello");
	return editor;
}

describe("editor border follows Pi's bash-mode painter", () => {
	it("paints both rules with Pi's painter while the draft is a bash command", () => {
		const lines = makeEditor(bashBrush).render(120);
		expect(lines[0]).toContain("<bashMode>─");
		expect(lines.at(-1)).toContain("<bashMode>─");
	});

	it("takes the colour only while bash mode is on", () => {
		const editor = makeEditor(thinkingBrush);
		const normal = editor.render(120);
		expect(normal[0]).toContain("<borderMuted>─");
		expect(normal.join("\n")).not.toContain("<thinkingMax>");

		editor.borderColor = bashBrush;
		expect(editor.render(120)[0]).toContain("<bashMode>─");
	});

	it("lets an explicit colors.editorBorder win over bash mode", () => {
		// A fixed colour is the user asking for one look; the mode colour would
		// silently override it the moment the draft starts with `!`.
		const lines = makeEditor(bashBrush, { colors: { editorBorder: "accent" } }).render(120);
		expect(lines[0]).toContain("<accent>─");
		expect(lines.at(-1)).toContain("<accent>─");
		expect(lines.join("\n")).not.toContain("<bashMode>");
	});

	it("keeps Starline's border when the theme has no bash painter", () => {
		// Peer floor is older than Pi 1.4's Theme; the frame must not depend on it.
		const lines = makeEditor(bashBrush, {}, makeTheme({ bash: false })).render(120);
		expect(lines[0]).toContain("<borderMuted>─");
		expect(lines.join("\n")).not.toContain("<bashMode>");
	});
});
