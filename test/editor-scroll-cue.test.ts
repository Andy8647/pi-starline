import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/starline/config";
import { PolishedEditor, WrappedPolishedEditor } from "../extensions/starline/ui";
import { setWorkingIndicator } from "../extensions/starline/working-indicator";

/**
 * Pi caps the input box at 30% of the terminal and paints the draft's scroll
 * position into the borders it draws. Starline redraws both borders, so the cue
 * only survives because the counts are intercepted and re-emitted here.
 */

const ROWS = 20;

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

const config = mergeConfig({ editorMetadataFormat: "", editorPaddingY: 0 });

function makeEditor() {
	return new PolishedEditor(
		{ requestRender() {}, terminal: { rows: ROWS, cols: 120 } } as never,
		{ borderColor: (text: string) => text, selectList: {} } as never,
		{} as never,
		makeTheme(),
		() => config,
		() => ({ modelLabel: "m", providerLabel: "p" }),
		() => "off",
	);
}

const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
const draft = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");

describe("draft scroll cue", () => {
	it("shows Pi's ↑ N more on the top rule once the draft outgrows the box", () => {
		const editor = makeEditor();
		editor.setText(draft(40));
		const top = strip(editor.render(120)[0] ?? "");

		expect(top).toMatch(/↑ \d+ more/);
		expect(top.trimEnd().endsWith("─")).toBe(true);
	});

	it("keeps the count in step with the visible window, not the line count", () => {
		const editor = makeEditor();
		editor.setText(draft(40));
		const top = strip(editor.render(120)[0] ?? "");
		const shown = Number(/↑ (\d+) more/.exec(top)?.[1]);

		// Pi's window is 30% of the rows, never under five: 6 lines at 20 rows, with
		// the cursor on the last one.
		expect(shown).toBe(40 - 6);
	});

	it("drops the cue when the draft fits again", () => {
		const editor = makeEditor();
		editor.setText(draft(40));
		expect(strip(editor.render(120)[0] ?? "")).toMatch(/↑ \d+ more/);

		editor.setText("one line");
		expect(strip(editor.render(120)[0] ?? "")).not.toMatch(/more/);
	});

	it("shares the top rule with a status", () => {
		setWorkingIndicator(undefined);
		const editor = makeEditor();
		editor.setText(draft(40));
		editor.setWorkingStatusIndicator({
			kind: "retry",
			renderInBorder: () => "⣾ Retrying (1/3) in 4s...",
		});
		const top = strip(editor.render(120)[0] ?? "");

		expect(top).toContain("⣾ Retrying (1/3) in 4s...");
		expect(top).toMatch(/↑ \d+ more/);
		expect(top.trimEnd().endsWith("─")).toBe(true);
	});

	it("redraws a wrapped editor's own cue", () => {
		const base = {
			focused: false,
			render: () => ["─── ↑ 3 more ───", "content", "──── ↓ 2 more ─"],
			isShowingAutocomplete: () => false,
			getText: () => "content",
			setText() {},
			handleInput() {},
			invalidate() {},
		};
		const wrapped = new WrappedPolishedEditor(
			base as never,
			makeTheme(),
			() => config,
			() => ({ modelLabel: "m", providerLabel: "p" }),
			() => "off",
		);
		const lines = wrapped.render(120).map(strip);

		expect(lines[0]).toMatch(/↑ 3 more/);
		expect(lines.at(-1)).toMatch(/↓ 2 more/);
	});

	it("keeps Pi's wording and stays inside the width on a narrow frame", () => {
		const editor = makeEditor();
		editor.setText(draft(40));
		for (const width of [60, 40, 30, 24]) {
			const line = strip(editor.render(width)[0] ?? "");
			expect([...line]).toHaveLength(width);
		}
	});

	it("stays a plain rule when the borders have no room for a label", () => {
		setWorkingIndicator(undefined);
		const editor = makeEditor();
		editor.setText(draft(40));
		const line = strip(editor.render(10)[0] ?? "").trim();

		expect(line).toMatch(/^─+$/);
	});
});
