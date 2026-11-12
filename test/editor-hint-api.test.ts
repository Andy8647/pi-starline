import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import {
	clearExternalEditorHints,
	EDITOR_HINT_API_SYMBOL,
	type EditorHintApi,
	externalEditorHints,
	publishEditorHintApi,
	setEditorHintRepaint,
	setExternalEditorHint,
} from "../extensions/starline/editor-hint-api";
import { PolishedEditor } from "../extensions/starline/ui";

/** Stands in for whatever Starline's own hints are saying; the frame test sets it. */
let pasteHint: string | null = null;
vi.mock("../extensions/starline/paste-collapse", () => ({
	pasteExpandHintText: () => pasteHint,
}));

afterEach(() => {
	clearExternalEditorHints();
	setEditorHintRepaint(undefined);
	pasteHint = null;
	delete (globalThis as Record<PropertyKey, unknown>)[EDITOR_HINT_API_SYMBOL];
});

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

function topRule(config: PolishedTuiConfig = defaultConfig, width = 120): string {
	const editor = new PolishedEditor(
		{ requestRender() {}, terminal: { rows: 24, cols: width } } as never,
		{ borderColor: (text: string) => text, selectList: {} } as never,
		{} as never,
		makeTheme(),
		() => config,
	);
	return (editor.render(width)[0] ?? "").replace(/\[[0-9;]*m/g, "");
}

describe("the published editor hint API", () => {
	it("is published once, under a versioned symbol", () => {
		publishEditorHintApi();
		const api = (globalThis as Record<PropertyKey, unknown>)[
			EDITOR_HINT_API_SYMBOL
		] as EditorHintApi;
		expect(api.version).toBe(1);
		expect(api.setHint).toBeTypeOf("function");
	});

	it("lets the newest Starline replace an older object, as the pill API does", () => {
		const stale = { version: 1, setHint: vi.fn() };
		(globalThis as Record<PropertyKey, unknown>)[EDITOR_HINT_API_SYMBOL] = stale;
		publishEditorHintApi();
		const api = (globalThis as Record<PropertyKey, unknown>)[
			EDITOR_HINT_API_SYMBOL
		] as EditorHintApi;
		expect(api).not.toBe(stale);
	});

	it("replaces a key's hint rather than stacking them", () => {
		setExternalEditorHint("pi-ide", "5 lines selected in index.ts");
		setExternalEditorHint("pi-ide", "2 lines selected in index.ts");
		expect(externalEditorHints()).toEqual(["2 lines selected in index.ts"]);
	});

	it("clears on null, undefined or an empty string", () => {
		for (const empty of [null, undefined, ""]) {
			setExternalEditorHint("pi-ide", "5 lines selected in index.ts");
			setExternalEditorHint("pi-ide", empty);
			expect(externalEditorHints()).toEqual([]);
		}
	});

	it("ignores a blank key, which would otherwise be a slot nobody can clear", () => {
		setExternalEditorHint("  ", "5 lines selected in index.ts");
		expect(externalEditorHints()).toEqual([]);
	});

	it("reads several keys in a stable order", () => {
		setExternalEditorHint("pi-ide", "5 lines selected in index.ts");
		setExternalEditorHint("aaa-other", "other");
		expect(externalEditorHints()).toEqual(["other", "5 lines selected in index.ts"]);
	});

	it("flattens control sequences, because this string lands on a border", () => {
		setExternalEditorHint("pi-ide", "5 lines\nselected\x1b[31m in index.ts");
		expect(externalEditorHints()).toEqual(["5 lines selected in index.ts"]);
	});

	it("cuts past 60 columns", () => {
		setExternalEditorHint("pi-ide", "x".repeat(200));
		expect(externalEditorHints()[0]).toHaveLength(60);
	});

	it("repaints only when the text changed", () => {
		const repaint = vi.fn();
		setEditorHintRepaint(repaint);
		setExternalEditorHint("pi-ide", "5 lines selected in index.ts");
		expect(repaint).toHaveBeenCalledTimes(1);
		setExternalEditorHint("pi-ide", "5 lines selected in index.ts");
		expect(repaint).toHaveBeenCalledTimes(1);
		setExternalEditorHint("pi-ide", "2 lines selected in index.ts");
		expect(repaint).toHaveBeenCalledTimes(2);
	});

	it("drops every hint at session end", () => {
		const repaint = vi.fn();
		setEditorHintRepaint(repaint);
		setExternalEditorHint("pi-ide", "5 lines selected in index.ts");
		clearExternalEditorHints();
		expect(externalEditorHints()).toEqual([]);
		expect(repaint).toHaveBeenCalledTimes(2);
	});
});

describe("an external hint in the editor frame", () => {
	it("is absent from the frame when nobody published one", () => {
		expect(topRule()).not.toContain("selected in index.ts");
	});

	it("rides the right end of the top rule, adding no row", () => {
		setExternalEditorHint("pi-ide", "5 lines selected in index.ts");
		expect(topRule()).toMatch(/^─+ 5 lines selected in index\.ts ──$/);
	});

	it("comes before Starline's own hints, so the rule's truncation cannot eat it", () => {
		setExternalEditorHint("pi-ide", "5 lines selected in index.ts");
		pasteHint = "paste again to expand";
		expect(topRule()).toMatch(/^─+ 5 lines selected in index\.ts ⋅ paste again to expand ──$/);
	});

	it("still ends in a rule on a terminal too narrow for it", () => {
		setExternalEditorHint("pi-ide", "5 lines selected in index.ts");
		expect(topRule(defaultConfig, 40)).toMatch(/─$/);
	});
});
