import { describe, expect, it } from "vitest";
import {
	DEFAULT_EDITOR_METADATA_FORMAT,
	expandPaletteInRecord,
	expandPaletteRefs,
	mergeConfig,
	normalizePalette,
} from "../extensions/starline/config";

const tokyoNightStorm = {
	bg: "#24283b",
	fg: "#c0caf5",
	blue: "#7aa2f7",
	purple: "#bb9af7",
	green: "#9ece6a",
};

describe("normalizePalette", () => {
	it("keeps string entries with identifier-shaped names", () => {
		expect(normalizePalette({ blue: "#7aa2f7", "off-white": "#eee", _x: "#000" })).toEqual({
			blue: "#7aa2f7",
			"off-white": "#eee",
			_x: "#000",
		});
	});

	it("drops non-string values and unusable names", () => {
		expect(normalizePalette({ ok: "#fff", n: 1, nested: { a: "b" }, "9lives": "#000" })).toEqual({
			ok: "#fff",
		});
	});

	it("treats a non-record as an empty palette", () => {
		for (const value of [undefined, null, "blue", 42, ["#fff"]]) {
			expect(normalizePalette(value)).toEqual({});
		}
	});
});

describe("expandPaletteRefs", () => {
	it("expands bare and braced references", () => {
		expect(expandPaletteRefs("bg:$blue", tokyoNightStorm)).toBe("bg:#7aa2f7");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the braced form is the syntax under test
		expect(expandPaletteRefs("bg:${blue}", tokyoNightStorm)).toBe("bg:#7aa2f7");
	});

	it("expands several references in one spec", () => {
		expect(expandPaletteRefs("bold bg:$purple fg:$bg", tokyoNightStorm)).toBe(
			"bold bg:#bb9af7 fg:#24283b",
		);
	});

	it("resolves references that point at other palette entries", () => {
		const palette = { base: "#24283b", surface: "$base", chrome: "$surface" };
		expect(expandPaletteRefs("bg:$chrome", palette)).toBe("bg:#24283b");
	});

	it("leaves unknown references literal so the typo stays visible", () => {
		expect(expandPaletteRefs("bg:$nope", tokyoNightStorm)).toBe("bg:$nope");
	});

	it("leaves specs without references untouched", () => {
		expect(expandPaletteRefs("bold #cba6f7", tokyoNightStorm)).toBe("bold #cba6f7");
		expect(expandPaletteRefs("", tokyoNightStorm)).toBe("");
	});

	it("survives a direct cycle", () => {
		const palette = { a: "$b", b: "$a" };
		expect(expandPaletteRefs("bg:$a", palette)).toBe("bg:$a");
	});

	it("survives a longer cycle", () => {
		const palette = { a: "$b", b: "$c", c: "$a" };
		expect(expandPaletteRefs("bg:$a", palette)).toBe("bg:$a");
	});

	it("survives self-reference", () => {
		expect(expandPaletteRefs("bg:$a", { a: "$a" })).toBe("bg:$a");
	});
});

describe("expandPaletteInRecord", () => {
	it("expands every string value", () => {
		expect(expandPaletteInRecord({ cwd: "bg:$blue", cost: "bg:$green" }, tokyoNightStorm)).toEqual({
			cwd: "bg:#7aa2f7",
			cost: "bg:#9ece6a",
		});
	});

	it("leaves non-string values alone", () => {
		const record = { cwd: "bg:$blue", nested: { a: 1 }, flag: true };
		expect(expandPaletteInRecord(record, tokyoNightStorm)).toEqual({
			cwd: "bg:#7aa2f7",
			nested: { a: 1 },
			flag: true,
		});
	});

	it("returns the record unchanged when the palette is empty", () => {
		const record = { cwd: "bg:$blue" };
		expect(expandPaletteInRecord(record, {})).toBe(record);
	});
});

describe("mergeConfig palette integration", () => {
	it("expands palette references in colors", () => {
		const config = mergeConfig({
			palette: tokyoNightStorm,
			colors: { cwd: "bold bg:$blue fg:$bg", gitBranch: "bold bg:$purple fg:$bg" },
		});
		expect(config.colors.cwd).toBe("bold bg:#7aa2f7 fg:#24283b");
		expect(config.colors.gitBranch).toBe("bold bg:#bb9af7 fg:#24283b");
	});

	it("rejects a colour whose reference did not resolve, keeping the default", () => {
		const config = mergeConfig({ palette: tokyoNightStorm, colors: { cwd: "bg:$missing" } });
		expect(config.colors.cwd).toBe(mergeConfig({}).colors.cwd);
	});

	it("leaves colors alone when no palette is declared", () => {
		expect(mergeConfig({ colors: { cwd: "bold #7aa2f7" } }).colors.cwd).toBe("bold #7aa2f7");
	});

	/**
	 * footerFormat and editorMetadataFormat use `$name` for their own format
	 * variables. Palette expansion must never reach them.
	 */
	it("does not touch format strings", () => {
		const config = mergeConfig({
			palette: { blue: "#7aa2f7", model: "#ff0000", cwd: "#00ff00" },
			footerFormat: "$cwd $git_branch $model",
			editorMetadataFormat: "$model  $provider",
		});
		expect(config.footerFormat).toBe("$cwd $git_branch $model");
		expect(config.editorMetadataFormat).toBe("$model  $provider");
	});

	it("keeps the editor metadata default when none is given", () => {
		expect(mergeConfig({ palette: tokyoNightStorm }).editorMetadataFormat).toBe(
			DEFAULT_EDITOR_METADATA_FORMAT,
		);
	});
});

describe("palette in extensionStatuses.colors", () => {
	// Expansion has to happen before validation, or a $ref reads as an unsupported
	// spec and the colour is dropped — which showed up as every status pill
	// falling back to the same grey.
	it("expands references there too", () => {
		const config = mergeConfig({
			palette: { yellow: "#f9e2af", sky: "#89dceb" },
			extensionStatuses: {
				colors: { "provider-balance": "bg:$yellow", "mcp-status": "bg:$sky" },
			},
		});
		expect(config.extensionStatuses.colors).toEqual({
			"provider-balance": "bg:#f9e2af",
			"mcp-status": "bg:#89dceb",
		});
	});

	it("drops a colour whose reference did not resolve", () => {
		const config = mergeConfig({
			palette: { yellow: "#f9e2af" },
			extensionStatuses: { colors: { balance: "bg:$missing" } },
		});
		expect(config.extensionStatuses.colors).toEqual({});
	});

	it("accepts plain values with no palette declared", () => {
		expect(
			mergeConfig({ extensionStatuses: { colors: { balance: "bg:#f9e2af" } } }).extensionStatuses
				.colors,
		).toEqual({ balance: "bg:#f9e2af" });
	});
});
