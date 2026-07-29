import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import { PolishedEditor, WrappedPolishedEditor } from "../extensions/starline/ui";

describe("box padding config", () => {
	it("defaults to one blank row, which is upstream's look", () => {
		expect(defaultConfig.editorPaddingY).toBe(1);
		expect(defaultConfig.userMessagePaddingY).toBe(1);
	});

	it("accepts 0", () => {
		const config = mergeConfig({ editorPaddingY: 0, userMessagePaddingY: 0 });
		expect(config.editorPaddingY).toBe(0);
		expect(config.userMessagePaddingY).toBe(0);
	});

	// Only 0 and 1 are meaningful: the frame is parsed back by position, and the
	// parser assumes at most one padding row on each side.
	it("rejects anything other than 0 or 1", () => {
		for (const value of [2, -1, 1.5, "1", true, null]) {
			expect(mergeConfig({ editorPaddingY: value }).editorPaddingY).toBe(1);
			expect(mergeConfig({ userMessagePaddingY: value }).userMessagePaddingY).toBe(1);
		}
	});

	it("is independent per box", () => {
		expect(mergeConfig({ editorPaddingY: 0 }).userMessagePaddingY).toBe(1);
		expect(mergeConfig({ userMessagePaddingY: 0 }).editorPaddingY).toBe(1);
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
		() => ({ modelLabel: "m", providerLabel: "p" }),
		() => "off",
	);
}

// The fake theme tags with [name]; real SGR resets ride along too.
const stripTags = (line: string) =>
	line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\[[^\]]*\]/g, "");

describe("editorPaddingY in the rendered frame", () => {
	const blankMeta = { ...defaultConfig, editorMetadataFormat: "" };

	it("keeps the two blank rows by default", () => {
		expect(makeEditor(blankMeta).render(120)).toHaveLength(6);
	});

	it("drops both blank rows at 0, saving two lines", () => {
		expect(makeEditor({ ...blankMeta, editorPaddingY: 0 }).render(120)).toHaveLength(4);
	});

	it("still draws exactly two borders either way", () => {
		for (const editorPaddingY of [0, 1]) {
			const lines = makeEditor({ ...blankMeta, editorPaddingY }).render(120);
			expect(lines.filter((line) => /^─+$/.test(stripTags(line).trim()))).toHaveLength(2);
		}
	});

	it("keeps the typed text", () => {
		const editor = makeEditor({ ...blankMeta, editorPaddingY: 0 });
		editor.setText("typed text");
		expect(editor.render(120).join("\n")).toContain("typed text");
	});
});

/**
 * splitPolishedFrame parses the frame back by position, so the padding the
 * renderer emits and the padding the parser assumes have to agree. When they
 * disagree the wrapper fails to unwrap the inner frame and its content ends up
 * rendered twice.
 */
describe("padding stays symmetric between render and unwrap", () => {
	for (const editorPaddingY of [0, 1]) {
		it(`keeps one copy of the typed text at padding ${editorPaddingY}`, () => {
			const config = { ...defaultConfig, editorMetadataFormat: "the-meta", editorPaddingY };
			const inner = makeEditor(config);
			inner.setText("typed text");
			const wrapped = new WrappedPolishedEditor(
				inner as never,
				makeTheme(),
				() => config,
				() => ({ modelLabel: "m2", providerLabel: "p2" }),
				() => "off",
			);
			expect(
				wrapped
					.render(120)
					.join("\n")
					.match(/typed text/g),
			).toHaveLength(1);
		});
	}
});
