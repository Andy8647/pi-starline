import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { defaultConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import { PolishedEditor } from "../extensions/starline/ui";

/**
 * Third-party statuses can be placed on the editor's metadata row instead of the
 * footer (`extensionStatuses.placements[key] = "editor"`). The row is where the
 * copy/paste hints already live, so a status there shares their slot and styling
 * rather than the footer's pill chrome.
 */

const STATUS_TEXT = "in main.ts";

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

function makeEditor(
	config: PolishedTuiConfig,
	statuses: ReadonlyMap<string, string>,
): PolishedEditor {
	return new PolishedEditor(
		{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
		{ borderColor: (text: string) => text, selectList: {} } as never,
		{} as never,
		makeTheme(),
		() => config,
		() => ({ modelLabel: "m", providerLabel: "p" }),
		() => "off",
		() => statuses,
	);
}

function configWithPlacement(placements: Record<string, "editor" | "right">): PolishedTuiConfig {
	return {
		...defaultConfig,
		editorMetadataFormat: "",
		extensionStatuses: {
			...defaultConfig.extensionStatuses,
			placements,
		},
	};
}

const stripTags = (line: string) => line.replace(/\[[0-9;]*m/g, "");

describe("third-party statuses on the editor row", () => {
	it("shows an editor-placed status in the metadata row", () => {
		const rendered = makeEditor(
			configWithPlacement({ "pi-ide": "editor" }),
			new Map([["pi-ide", STATUS_TEXT]]),
		)
			.render(120)
			.map(stripTags)
			.join("\n");

		expect(rendered).toContain(STATUS_TEXT);
	});

	it("leaves footer-placed statuses out of the editor row", () => {
		const rendered = makeEditor(
			configWithPlacement({ "pi-ide": "right" }),
			new Map([["pi-ide", STATUS_TEXT]]),
		)
			.render(120)
			.map(stripTags)
			.join("\n");

		expect(rendered).not.toContain(STATUS_TEXT);
	});

	it("joins several editor statuses in key order", () => {
		const rendered = makeEditor(
			configWithPlacement({ alpha: "editor", zeta: "editor" }),
			new Map([
				["zeta", "zeta"],
				["alpha", "alpha"],
			]),
		)
			.render(120)
			.map(stripTags)
			.join("\n");

		expect(rendered).toContain("alpha ⋅ zeta");
	});

	it("shows nothing when no status is placed on the editor", () => {
		const rendered = makeEditor(configWithPlacement({}), new Map([["pi-ide", STATUS_TEXT]]))
			.render(120)
			.map(stripTags)
			.join("\n");

		expect(rendered).not.toContain(STATUS_TEXT);
	});
});
