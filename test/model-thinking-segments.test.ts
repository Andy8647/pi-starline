import { describe, expect, it } from "vitest";
import { defaultConfig, FOOTER_FORMAT_VARIABLES, mergeConfig } from "../extensions/starline/config";
import { thinkingThemeKey } from "../extensions/starline/footer";
import { parseFooterFormat } from "../extensions/starline/footer-format";

describe("thinkingThemeKey", () => {
	it("maps each level to its theme colour key", () => {
		expect(thinkingThemeKey("minimal")).toBe("thinkingMinimal");
		expect(thinkingThemeKey("low")).toBe("thinkingLow");
		expect(thinkingThemeKey("medium")).toBe("thinkingMedium");
		expect(thinkingThemeKey("high")).toBe("thinkingHigh");
		expect(thinkingThemeKey("xhigh")).toBe("thinkingXhigh");
	});

	it("is case-insensitive", () => {
		expect(thinkingThemeKey("HIGH")).toBe("thinkingHigh");
		expect(thinkingThemeKey("XHigh")).toBe("thinkingXhigh");
	});

	it("falls back to thinkingOff for off and for anything unrecognised", () => {
		expect(thinkingThemeKey("off")).toBe("thinkingOff");
		expect(thinkingThemeKey("")).toBe("thinkingOff");
		expect(thinkingThemeKey("turbo")).toBe("thinkingOff");
	});

	it("only names keys the style layer accepts as theme colours", () => {
		const keys = ["off", "minimal", "low", "medium", "high", "xhigh"].map(thinkingThemeKey);
		// Mirrors themeColorTokens in style.ts — a typo here would silently render
		// unstyled text instead of the level colour.
		expect(new Set(keys)).toEqual(
			new Set([
				"thinkingOff",
				"thinkingMinimal",
				"thinkingLow",
				"thinkingMedium",
				"thinkingHigh",
				"thinkingXhigh",
			]),
		);
	});
});

describe("model and thinking as footer segments", () => {
	it("are off by default, so the footer is unchanged from upstream", () => {
		expect(defaultConfig.footerSegments.model).toBe(false);
		expect(defaultConfig.footerSegments.thinking).toBe(false);
	});

	it("can be switched on", () => {
		const config = mergeConfig({ footerSegments: { model: true, thinking: true } });
		expect(config.footerSegments.model).toBe(true);
		expect(config.footerSegments.thinking).toBe(true);
	});

	it("ignores non-boolean values", () => {
		expect(mergeConfig({ footerSegments: { model: "yes" } }).footerSegments.model).toBe(false);
	});

	it("are usable as footerFormat variables", () => {
		expect(FOOTER_FORMAT_VARIABLES).toContain("model");
		expect(FOOTER_FORMAT_VARIABLES).toContain("thinking");
	});

	it("parse out of a footerFormat string", () => {
		const names = parseFooterFormat("$model $thinking $cwd")
			.filter((token) => token.kind === "var")
			.map((token) => (token.kind === "var" ? token.name : ""));
		expect(names).toEqual(["model", "thinking", "cwd"]);
	});
});

describe("model and thinking colours", () => {
	it("give the model segment a concrete default", () => {
		expect(defaultConfig.colors.model).toBe("bold blue");
	});

	it("leave the thinking colour unset so it derives from the level", () => {
		expect(defaultConfig.colors.thinking).toBeUndefined();
	});

	it("accept an explicit override", () => {
		const config = mergeConfig({ colors: { model: "#cba6f7", thinking: "bold syntaxKeyword" } });
		expect(config.colors.model).toBe("#cba6f7");
		expect(config.colors.thinking).toBe("bold syntaxKeyword");
	});

	it("reject an unsupported spec and keep the default", () => {
		expect(mergeConfig({ colors: { model: "chartreuse" } }).colors.model).toBe("bold blue");
		expect(mergeConfig({ colors: { thinking: "chartreuse" } }).colors.thinking).toBeUndefined();
	});

	it("resolve palette references like every other colour", () => {
		const config = mergeConfig({
			palette: { mauve: "#cba6f7" },
			colors: { model: "bold bg:$mauve" },
		});
		expect(config.colors.model).toBe("bold bg:#cba6f7");
	});
});
