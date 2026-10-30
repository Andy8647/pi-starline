import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import { PolishedEditor, WrappedPolishedEditor } from "../extensions/starline/ui";

describe("box padding config", () => {
	it("defaults to one blank row, which is upstream's look", () => {
		expect(defaultConfig.editorPaddingY).toBe(1);
	});

	it("accepts 0", () => {
		expect(mergeConfig({ editorPaddingY: 0 }).editorPaddingY).toBe(0);
	});

	// Only 0 and 1 are meaningful: a frame from elsewhere is parsed back by
	// position, and the parser assumes at most one padding row on each side.
	it("rejects anything other than 0 or 1", () => {
		for (const value of [2, -1, 1.5, "1", true, null]) {
			expect(mergeConfig({ editorPaddingY: value }).editorPaddingY).toBe(1);
		}
	});
});

describe("editorMinRows config", () => {
	it("defaults to 1, the height of the text alone", () => {
		expect(defaultConfig.editorMinRows).toBe(1);
	});

	it("takes whole numbers from 1 and caps them at 10", () => {
		expect(mergeConfig({ editorMinRows: 2 }).editorMinRows).toBe(2);
		expect(mergeConfig({ editorMinRows: 40 }).editorMinRows).toBe(10);
		for (const value of [0, -1, 1.5, "2", true, null]) {
			expect(mergeConfig({ editorMinRows: value }).editorMinRows).toBe(1);
		}
	});
});

function makeTheme(): Theme {
	return {
		fg: (color: string, text: string) => `[${color}]${text}`,
		bold: (text: string) => `[bold]${text}`,
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

// The fake theme tags with [name]; real SGR resets ride along too.
const stripTags = (line: string) =>
	line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\[[^\]]*\]/g, "");

const isRule = (line: string) => /^─+$/.test(stripTags(line).trim());

describe("editorPaddingY in the rendered frame", () => {
	it("keeps the two blank rows by default", () => {
		expect(makeEditor(defaultConfig).render(120)).toHaveLength(5);
	});

	it("drops both blank rows at 0, leaving the rules and the text", () => {
		expect(makeEditor({ ...defaultConfig, editorPaddingY: 0 }).render(120)).toHaveLength(3);
	});

	it("still draws exactly two borders either way", () => {
		for (const editorPaddingY of [0, 1]) {
			const lines = makeEditor({ ...defaultConfig, editorPaddingY }).render(120);
			expect(lines.filter(isRule)).toHaveLength(2);
		}
	});

	it("keeps the typed text", () => {
		const editor = makeEditor({ ...defaultConfig, editorPaddingY: 0 });
		editor.setText("typed text");
		expect(editor.render(120).join("\n")).toContain("typed text");
	});
});

describe("editorMinRows in the rendered frame", () => {
	it("follows a short draft with blank railed rows", () => {
		const editor = makeEditor({ ...defaultConfig, editorPaddingY: 0, editorMinRows: 2 });
		editor.setText("one line");
		const lines = editor.render(120);
		expect(lines).toHaveLength(4);
		expect(stripTags(lines[1] ?? "")).toContain("one line");
		expect(stripTags(lines[2] ?? "").trim()).toBe("│");
	});

	it("adds nothing once the draft reaches the floor", () => {
		const editor = makeEditor({ ...defaultConfig, editorPaddingY: 0, editorMinRows: 2 });
		editor.setText("one\ntwo\nthree");
		expect(editor.render(120)).toHaveLength(5);
	});

	it("sits inside the padding, which stays at the frame's edges", () => {
		const editor = makeEditor({ ...defaultConfig, editorPaddingY: 1, editorMinRows: 3 });
		const lines = editor.render(120);
		expect(lines).toHaveLength(7);
		expect(lines.filter(isRule)).toHaveLength(2);
	});
});

/**
 * A wrapper takes an inner Starline frame apart again. The inner editor answers
 * from what it drew; a copy of its lines goes through the positional parse,
 * which has to agree with the renderer about padding. When they disagree the
 * wrapper fails to unwrap the inner frame and its content is drawn twice.
 */
describe("padding stays symmetric between render and unwrap", () => {
	for (const editorPaddingY of [0, 1]) {
		it(`keeps one copy of the typed text at padding ${editorPaddingY}`, () => {
			const config = { ...defaultConfig, editorPaddingY };
			const inner = makeEditor(config);
			inner.setText("typed text");
			const wrapped = new WrappedPolishedEditor(inner as never, makeTheme(), () => config);
			expect(
				wrapped
					.render(120)
					.join("\n")
					.match(/typed text/g),
			).toHaveLength(1);
		});

		it(`parses a copy of the frame by position at padding ${editorPaddingY}`, () => {
			const config = { ...defaultConfig, editorPaddingY };
			const inner = makeEditor(config);
			inner.setText("typed text");
			// A copy is not the array the editor returned, so the positional parse runs.
			const base = {
				render: (width: number) => [...inner.render(width)],
				invalidate() {},
				handleInput() {},
				getText: () => inner.getText(),
				setText() {},
				[Symbol.for("pi-starline.polished-frame")]: (lines: string[]) =>
					(inner as unknown as Record<symbol, (lines: string[]) => unknown>)[
						Symbol.for("pi-starline.polished-frame")
					]?.(lines),
			};
			const wrapped = new WrappedPolishedEditor(base as never, makeTheme(), () => config);
			const lines = wrapped.render(120);
			expect(lines.join("\n").match(/typed text/g)).toHaveLength(1);
			expect(lines.filter(isRule)).toHaveLength(2);
			expect(lines).toHaveLength(3 + 2 * editorPaddingY);
		});
	}
});
